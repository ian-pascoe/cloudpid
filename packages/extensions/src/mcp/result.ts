// What the model and scripts get for an MCP tool's call (`docs/architecture/mcp-in-a-session.md` → Calls and results): a
// completed `tools/call` result as text, images and a Result Spill for what the model cannot be shown, its
// `structuredContent` as the value a script gets, and an error for a request that ended without one.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off -- conversions of plain values.
import {
  isJsonObject,
  mayHaveRun,
  type McpHostCompleted,
  type McpHostRequestResult,
  type McpProgress,
  type McpStructuredOutput,
} from "@cloudpid/mcp/types";
import type { JsonValue } from "@earendil-works/chord";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ToolDiagnostic, ToolExecutionResult } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { storedBytes } from "../stored-bytes.ts";
import { type ModelContent, modelContent } from "./blocks.ts";
import type { Spill } from "./spill.ts";
import { scriptValueOf } from "./value.ts";

/** `value` as the `JsonValue` a result carries: the two describe the same values, `Schema.Json`'s arrays only read-only. */
// SAFETY: a `Schema.Json` is JSON; its arrays are only read-only where `JsonValue`'s are mutable.
const jsonOf = (value: Schema.Json): JsonValue => value as JsonValue;

/** The four hints of a tool's annotations, which the card shows as badges; they are untrusted and gate nothing. */
export type McpHints = {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
};

/**
 * What an MCP tool's call keeps in `details`. `error` and `cut` say how a call that has no result ended: `cut` that the
 * Session's end (`host_lost`) or the host's end (`engine_lost`) of the call was lost, so it may have run.
 */
export type McpDetails = {
  readonly server: string;
  readonly tool: string;
  readonly title?: string;
  readonly hints?: McpHints;
  readonly meta?: { readonly [key: string]: JsonValue };
  readonly full_output_path?: string;
  readonly progress?: McpProgress;
  readonly error?: "too_large" | "invalid_structured_output";
  readonly cut?: "host_lost" | "engine_lost";
};

/** How much `meta` the card keeps of a tool's `_meta` (stored); a larger one is left out. */
export const MAX_META_BYTES = 16 * 1024;

/** The most text the model is given of one result before pi-durable cuts it: its default limits, which it does not export. */
const MAX_TEXT_BYTES = 50 * 1024;

const MAX_TEXT_LINES = 2000;

const MiB = 1024 * 1024;

/** A `tools/call` result as far as the Session reads it; `structuredContent` is read as the server sent it. */
const CallToolValue = Schema.Struct({
  content: Schema.Array(Schema.Json).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  isError: Schema.optionalKey(Schema.Boolean),
});

const decodeCallTool = Schema.decodeUnknownOption(CallToolValue);

/** What a call of one result needs besides the result. */
export type McpResultContext = {
  /** The details the call starts from: its tool's `server`, `tool`, `title`, `hints` and `meta`. */
  readonly details: McpDetails;
  /** Writes a Result Spill; for a script's call, which holds the whole value, one that saves nothing. */
  readonly spill: Spill;
  /** Whether the call is a script's (`codemode`): it gets its value, and no spill. */
  readonly nested: boolean;
};

/** A call that ended without a result: its message, as an error the model reads. */
export const failedWith = (
  message: string,
  details: McpDetails,
): ToolExecutionResult<JsonValue> => ({
  output: [{ type: "text", text: message }],
  isError: true,
  details,
});

const textOf = (text: string): TextContent => ({ type: "text", text });

/** Whether the model-facing `text` is more than a result may show: over pi-durable's byte or line limit. */
const overLimits = (text: string): boolean =>
  new TextEncoder().encode(text).length > MAX_TEXT_BYTES ||
  text.split("\n").length > MAX_TEXT_LINES;

/** The text blocks of `content` as one, before the images, when together they are over what a result may show. */
const joinedOverLimits = (content: ReadonlyArray<ModelContent>) => {
  const joined = Arr.join(
    Arr.flatMap(content, (block) => (block.type === "text" ? [block.text] : [])),
    "\n",
  );

  return overLimits(joined) ? Option.some(joined) : Option.none();
};

/** pi's message for a failed call that says nothing. */
const failedLine = (details: McpDetails): string =>
  `MCP tool ${details.server}/${details.tool} returned an error`;

/** The invalid `structuredContent`'s first problems, as one line. */
const invalidMessage = (structured: Extract<McpStructuredOutput, { valid: false }>): string =>
  `The server's structuredContent does not match the tool's outputSchema, so it was dropped: ${Arr.join(Arr.take(structured.errors, 3), "; ").slice(0, 400)}`;

/**
 * A `tools/call` result as the model and scripts get it. The model gets the content as text and images, or the
 * `structuredContent` as JSON when there is none; text over pi-durable's limits keeps its head and goes whole to a Result
 * Spill, and binary data goes to one too. A script gets the whole result as its value (`./value.ts`). The engine's check
 * of `structuredContent` against the tool's `outputSchema` (`structured`) decides whether the value is given: when it is
 * invalid there is none, so a script's call fails with `invalid_structured_output` and the model's keeps its text.
 */
export const resultFor = async (
  value: Schema.Json,
  structured: McpStructuredOutput | undefined,
  call: McpResultContext,
): Promise<ToolExecutionResult<JsonValue>> => {
  const decoded = decodeCallTool(value);

  if (Option.isNone(decoded) || !isJsonObject(value)) {
    return failedWith("The server answered with a result this build cannot read", call.details);
  }

  const { content, isError = false } = decoded.value;
  const { structuredContent } = value;
  const mapped = await modelContent(content, call.spill);
  const details: Mutable<McpDetails> = { ...call.details };
  const diagnostics: Array<ToolDiagnostic> = [];

  // No content: the structuredContent as JSON, since servers should mirror it as text and do not always.
  const base: ReadonlyArray<ModelContent> =
    content.length > 0 || structuredContent === undefined
      ? mapped
      : [textOf(JSON.stringify(structuredContent))];

  const hasText = Arr.some(base, (block) => block.type === "text" && block.text !== "");

  const shown: ReadonlyArray<ModelContent> =
    isError && !hasText
      ? [...Arr.filter(base, (block) => block.type === "image"), textOf(failedLine(call.details))]
      : base.length > 0
        ? base
        : [textOf("")];

  const over = call.nested ? Option.none() : joinedOverLimits(shown);
  let output: ReadonlyArray<ModelContent> = shown;

  if (Option.isSome(over)) {
    const saved = await call.spill(over.value, ".txt");

    // The text as one block, so pi-durable keeps its head; the images follow.
    output = [textOf(over.value), ...Arr.filter(shown, (block) => block.type === "image")];

    if ("path" in saved) {
      details.full_output_path = saved.path;
      diagnostics.push({
        severity: "info",
        code: "full_output",
        message: `Full output: ${saved.path}`,
      });
    } else {
      diagnostics.push({
        severity: "warn",
        code: "full_output",
        message: `Could not save the full output: ${saved.reason}`,
      });
    }
  }

  const result: Mutable<ToolExecutionResult<JsonValue>> = { output: [...output], details };

  if (isError) result.isError = true;

  if (structured?.valid === false) {
    details.error = "invalid_structured_output";
    diagnostics.push({
      // A script's call fails with it; the model's call keeps its text and is only told.
      severity: call.nested ? "error" : "warn",
      code: "invalid_structured_output",
      message: invalidMessage(structured),
    });
  } else {
    result.structuredOutput = jsonOf(scriptValueOf(value));
  }

  if (diagnostics.length > 0) result.diagnostics = diagnostics;

  return result;
};

/** What a call that ended without a result says, and what `details` records of how. */
const describeError = (error: Parameters<typeof mayHaveRun>[0]) =>
  Match.value(error).pipe(
    Match.tag("Cut", (cut) => ({
      message: cut.mayHaveRun
        ? `The call was cut before its answer arrived; it may or may not have run. ${cut.message}`
        : cut.message,
      cut: cut.lost === "engine" ? ("engine_lost" as const) : undefined,
      error: undefined,
    })),
    Match.tag("TooLarge", (large) => ({
      message: `The tool's result was over ${large.limit / MiB} MiB and was dropped; the tool may have run.`,
      cut: undefined,
      error: "too_large" as const,
    })),
    Match.tag("TimedOut", (timed) => ({
      message: `The call timed out: ${timed.message}. It may or may not have run.`,
      cut: undefined,
      error: undefined,
    })),
    Match.orElse((other) => ({
      message: mayHaveRun(other, "tools/call")
        ? `${other.message} It may or may not have run.`
        : other.message,
      cut: undefined,
      error: undefined,
    })),
  );

/** What the model reads for a request that ended without a result, with `details` saying how it ended. */
export const failureResult = (
  result: Exclude<McpHostRequestResult, McpHostCompleted>,
  details: McpDetails,
): ToolExecutionResult<JsonValue> => {
  if (!Predicate.isTagged(result, "CallFailed")) return failedWith(result.message, details);

  const { message, cut, error } = describeError(result.error);
  const ended: Mutable<McpDetails> = { ...details };

  if (cut !== undefined) ended.cut = cut;

  if (error !== undefined) ended.error = error;

  return failedWith(message, ended);
};

/** What the model reads when the Session's end of a call was lost: it may have run (`details.cut: "host_lost"`). */
export const hostLostResult = (details: McpDetails): ToolExecutionResult<JsonValue> =>
  failedWith(
    "The MCP host was lost before the call's answer arrived; it may or may not have run.",
    {
      ...details,
      cut: "host_lost",
    },
  );

/**
 * What a rerun reads of a call the Session had already sent (`name` is the tool's): it may have run, and is never sent
 * again. The words are pi-durable's own for an interrupted call.
 */
export const interruptedResult = (
  name: string,
  details: McpDetails,
): ToolExecutionResult<JsonValue> =>
  failedWith(
    `Tool ${name} was interrupted and may have partially run; it was not sent again.`,
    details,
  );

/** What the model reads of a result whose stream could not be read. */
export const streamFailure = (
  kind: "too_large" | "lost" | "unreadable",
  details: McpDetails,
): ToolExecutionResult<JsonValue> => {
  switch (kind) {
    case "too_large":
      return failedWith(
        "The tool's result was over 16 MiB and was dropped; the tool may have run.",
        {
          ...details,
          error: "too_large",
        },
      );
    case "lost":
      return failedWith(
        "The tool's result was lost on its way from the MCP engine; the tool may have run.",
        { ...details, cut: "engine_lost" },
      );
    case "unreadable":
      return failedWith("The server answered with a result this build cannot read", details);
  }
};

/** How much of `meta` a card keeps: all of it within `MAX_META_BYTES`, else none. */
export const metaWithinBound = (
  meta: Schema.Json | undefined,
): { readonly [key: string]: JsonValue } | undefined =>
  // SAFETY: a JSON object, whose values `JsonValue` describes.
  isJsonObject(meta) && storedBytes(meta) <= MAX_META_BYTES
    ? (meta as { readonly [key: string]: JsonValue })
    : undefined;
