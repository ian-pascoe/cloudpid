// What the model and scripts get for an MCP tool's call (`docs/architecture/mcp-in-a-session.md` → Calls and results): a
// completed `tools/call` result as text, images and a Result Spill for what the model cannot be shown, its
// `structuredContent` as the value a script gets, and an error for a request that ended without one.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off -- conversions of plain values.
import {
  isJsonObject,
  mayHaveRun,
  type McpHostCompleted,
  type McpHostRequestResult,
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
import { type ModelContent, modelContent } from "./blocks.ts";
import type { McpDetails } from "./details.ts";
import {
  type Ended,
  engineLostEnd,
  RESULT_LIMIT_BYTES,
  tooLargeEnd,
  unreadableEnd,
} from "./ended.ts";
import { headWithin } from "./head.ts";
import { type Spill, refusingSpill } from "./spill.ts";
import { MODEL_VALUE_BUDGET, SCRIPT_VALUE_BUDGET, scriptValueOf } from "./value.ts";

/** `value` as the `JsonValue` a result carries: the two describe the same values, `Schema.Json`'s arrays only read-only. */
// SAFETY: a `Schema.Json` is JSON; its arrays are only read-only where `JsonValue`'s are mutable.
const jsonOf = (value: Schema.Json): JsonValue => value as JsonValue;

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
  /** Writes a Result Spill; none for a script's call (`codemode`), which gets its value whole and no spill. */
  readonly spill: Spill | undefined;
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

/** The text blocks of `content` as one text, in order. */
const textsOf = (content: ReadonlyArray<ModelContent>): string =>
  Arr.join(
    Arr.flatMap(content, (block) => (block.type === "text" ? [block.text] : [])),
    "\n",
  );

/** pi's message for a failed call that says nothing. */
const failedLine = (details: McpDetails): string =>
  `MCP tool ${details.server}/${details.tool} returned an error`;

/** The invalid `structuredContent`'s first problems, as one line. */
const invalidMessage = (structured: Extract<McpStructuredOutput, { valid: false }>): string =>
  `The server's structuredContent does not match the tool's outputSchema, so it was dropped: ${Arr.join(Arr.take(structured.errors, 3), "; ").slice(0, 400)}`;

/**
 * A `tools/call` result as the model and scripts get it. The model gets the content as text and images, or the
 * `structuredContent` as JSON when there is none; text over the limits (`./head.ts`) is cut to its head here, so what
 * goes on to pi-durable and its hooks is never the whole of a large result, and goes whole to a Result Spill; binary data
 * goes to one too. A script gets the whole result as its value (`./value.ts`) and no spill. The engine's check of
 * `structuredContent` against the tool's `outputSchema` (`structured`) decides whether the value is given: when it is
 * invalid there is none, so a script's call fails with `invalid_structured_output` and the model's keeps its text.
 */
export const resultFor = async (
  value: Schema.Json,
  structured: McpStructuredOutput | undefined,
  call: McpResultContext,
): Promise<ToolExecutionResult<JsonValue>> => {
  const decoded = decodeCallTool(value);

  if (Option.isNone(decoded) || !isJsonObject(value))
    return failedWith(unreadableEnd.message, call.details);

  const { content, isError = false } = decoded.value;
  const { structuredContent } = value;
  const nested = call.spill === undefined;
  const mapped = await modelContent(content, call.spill ?? refusingSpill);
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

  const whole = textsOf(shown);
  const head = headWithin(whole);
  let output: ReadonlyArray<ModelContent> = shown;

  if (head !== undefined) {
    // The text as its head in one block; the images follow.
    output = [textOf(head), ...Arr.filter(shown, (block) => block.type === "image")];

    if (call.spill !== undefined) {
      const saved = await call.spill(whole, ".txt");

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
  }

  const result: Mutable<ToolExecutionResult<JsonValue>> = { output: [...output], details };

  if (isError) result.isError = true;

  if (structured?.valid === false) {
    details.error = "invalid_structured_output";

    // A script's call fails with the error, saying why; pi-durable reports a model's call, which keeps its text and loses the value.
    if (nested) {
      result.isError = true;
      diagnostics.push({
        severity: "error",
        code: "invalid_structured_output",
        message: invalidMessage(structured),
      });
    }
  } else {
    result.structuredOutput = jsonOf(
      scriptValueOf(value, nested ? SCRIPT_VALUE_BUDGET : MODEL_VALUE_BUDGET),
    );
  }

  if (diagnostics.length > 0) result.diagnostics = diagnostics;

  return result;
};

/** What a call that ended without a result says, and what `details` records of how. */
const describeError = (error: Parameters<typeof mayHaveRun>[0]): Ended =>
  Match.value(error).pipe(
    Match.tag("Cut", (cut): Ended => {
      const message = cut.mayHaveRun
        ? `The call was cut before its answer arrived; it may or may not have run. ${cut.message}`
        : cut.message;

      return cut.lost === "engine" ? { message, cut: engineLostEnd.cut } : { message };
    }),
    Match.tag("TooLarge", (large) => tooLargeEnd(large.limit)),
    Match.tag("TimedOut", (timed): Ended => ({
      message: `The call timed out: ${timed.message}. It may or may not have run.`,
    })),
    Match.orElse((other): Ended => ({
      message: mayHaveRun(other, "tools/call")
        ? `${other.message} It may or may not have run.`
        : other.message,
    })),
  );

/** `details` of a call that `ended` without a result, and what the model reads. */
const endedWith = (ended: Ended, details: McpDetails): ToolExecutionResult<JsonValue> => {
  const kept: Mutable<McpDetails> = { ...details };

  if (ended.cut !== undefined) kept.cut = ended.cut;

  if (ended.error !== undefined) kept.error = ended.error;

  return failedWith(ended.message, kept);
};

/** What the model reads for a request that ended without a result, with `details` saying how it ended. */
export const failureResult = (
  result: Exclude<McpHostRequestResult, McpHostCompleted>,
  details: McpDetails,
): ToolExecutionResult<JsonValue> =>
  Predicate.isTagged(result, "CallFailed")
    ? endedWith(describeError(result.error), details)
    : failedWith(result.message, details);

/** What the model reads when the Session's end of a call was lost: it may have run (`details.cut: "host_lost"`). */
export const hostLostResult = (details: McpDetails): ToolExecutionResult<JsonValue> =>
  endedWith(
    {
      message:
        "The MCP host was lost before the call's answer arrived; it may or may not have run.",
      cut: "host_lost",
    },
    details,
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

/** How each way a result's stream failed ended. */
const STREAM_ENDS = {
  too_large: tooLargeEnd(RESULT_LIMIT_BYTES),
  lost: engineLostEnd,
  unreadable: unreadableEnd,
} as const satisfies Record<"too_large" | "lost" | "unreadable", Ended>;

/** What the model reads of a result whose stream could not be read: the same ends as the engine's, by the same words. */
export const streamFailure = (
  kind: keyof typeof STREAM_ENDS,
  details: McpDetails,
): ToolExecutionResult<JsonValue> => endedWith(STREAM_ENDS[kind], details);
