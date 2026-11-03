// What the model and scripts get for an MCP tool's call (`docs/architecture/mcp-in-a-session.md` → Calls and results): a
// completed `tools/call` result as text, images and a Result Spill for what the model cannot be shown, its
// `structuredContent` as the value a script gets, and an error for a request that ended without one.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off -- conversions of plain values.
import {
  isJsonObject,
  type McpHostCompleted,
  type McpHostRequestResult,
  type McpStructuredOutput,
} from "@cloudpid/mcp/types";
import type { JsonValue } from "@earendil-works/chord";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ToolDiagnostic, ToolExecutionResult } from "@earendil-works/pi-durable";
import { utf8ByteLength } from "@earendil-works/chord/output";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { type ModelContent, modelContent, type Piece } from "./blocks.ts";
import type { McpDetails } from "./details.ts";
import {
  describeError,
  type Ended,
  type StreamFailure,
  streamEnd,
  unreadableMessage,
} from "./ended.ts";
import { headWithin, lineCountOf } from "./head.ts";
import { refusingSpill, type Spill } from "./spill.ts";
import { modelValueOf, scriptValueOf } from "./value.ts";

/** `value` as the `JsonValue` a result carries: the two describe the same values, `Schema.Json`'s arrays only read-only. */
// SAFETY: a `Schema.Json` is JSON; its arrays are only read-only where `JsonValue`'s are mutable.
const jsonOf = (value: Schema.Json): JsonValue => value as JsonValue;

/** A `tools/call` result as far as the Session reads it; `structuredContent` is read as the server sent it. */
const CallToolValue = Schema.Struct({
  content: Schema.Array(Schema.Json).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  isError: Schema.optionalKey(Schema.Boolean),
});

const decodeCallTool = Schema.decodeUnknownOption(CallToolValue);

/**
 * What a call of one result needs besides the result: the details it starts from (its tool's `server`, `tool`, `title`,
 * `hints` and `meta`), and whose call it is. A model's call may spill; a script's (`codemode`) gets its value whole and
 * no spill.
 */
export type McpResultContext = { readonly details: McpDetails } & (
  | { readonly kind: "model"; readonly spill: Spill }
  | { readonly kind: "script" }
);

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

/** pi's message for a failed call that says nothing. */
const failedLine = (details: McpDetails): string =>
  `MCP tool ${details.server}/${details.tool} returned an error`;

/** The invalid `structuredContent`'s first problems, as one line. */
const invalidMessage = (structured: Extract<McpStructuredOutput, { valid: false }>): string =>
  `The server's structuredContent does not match the tool's outputSchema, so it was dropped: ${Arr.join(Arr.take(structured.errors, 3), "; ").slice(0, 400)}`;

/** Whether `piece` is a block of the server's own text, which the limits cut. */
const isServerText = (piece: Piece): boolean => piece.content.type === "text" && !piece.note;

/**
 * What the model is given for `pieces` over the limits: the server's text, joined as pi-durable joins it (with nothing
 * between blocks), cut to its head at the place of its first block; images and notes stay where they were. `undefined`
 * when the text is within the limits. `dropped` is what pi-durable's own cut reports, so the model is told as it is of
 * any tool's output.
 */
const bounded = (pieces: ReadonlyArray<Piece>) => {
  const whole = Arr.join(
    Arr.flatMap(pieces, (piece) =>
      isServerText(piece) && piece.content.type === "text" ? [piece.content.text] : [],
    ),
    "",
  );

  const head = headWithin(whole);

  if (head === undefined) return undefined;

  const first = Arr.findFirstIndex(pieces, isServerText);

  return {
    whole,
    output: Arr.flatMap(pieces, (piece, index): ReadonlyArray<ModelContent> => {
      if (!isServerText(piece)) return [piece.content];

      return Option.contains(first, index) ? [textOf(head)] : [];
    }),
    warning: {
      severity: "warn",
      code: "truncated",
      message: `Output truncated to its beginning: ${lineCountOf(whole) - lineCountOf(head)} lines, ${utf8ByteLength(whole) - utf8ByteLength(head)} bytes dropped`,
    } satisfies ToolDiagnostic,
  };
};

/**
 * A `tools/call` result as the model and scripts get it. The model gets the content as text and images, or the
 * `structuredContent` as JSON when there is none; text over the limits (`./head.ts`) is cut to its head here, as
 * `bash`'s output is, with the same `truncated` warning, so what goes on to pi-durable and its hooks is never the whole
 * of a large result, and goes whole to a Result Spill; binary data goes to one too. A script gets the whole result as
 * its value (`./value.ts`) and no spill. The engine's check of `structuredContent` against the tool's `outputSchema`
 * (`structured`) decides whether the value is given: when it is invalid there is none, so a script's call fails with
 * `invalid_structured_output` and the model's keeps its text.
 */
export const resultFor = async (
  value: Schema.Json,
  structured: McpStructuredOutput | undefined,
  call: McpResultContext,
): Promise<ToolExecutionResult<JsonValue>> => {
  const decoded = decodeCallTool(value);

  if (Option.isNone(decoded) || !isJsonObject(value)) {
    return failedWith(unreadableMessage, call.details);
  }

  const { content, isError = false } = decoded.value;
  const { structuredContent } = value;
  const script = call.kind === "script";
  const mapped = await modelContent(content, call.kind === "model" ? call.spill : refusingSpill);
  const details: Mutable<McpDetails> = { ...call.details };
  const diagnostics: Array<ToolDiagnostic> = [];

  // No content: the structuredContent as JSON, since servers should mirror it as text and do not always.
  const base: ReadonlyArray<Piece> =
    content.length > 0 || structuredContent === undefined
      ? mapped
      : [{ content: textOf(JSON.stringify(structuredContent)), note: false }];

  const hasText = Arr.some(
    base,
    ({ content: block }) => block.type === "text" && block.text !== "",
  );

  const shown: ReadonlyArray<Piece> =
    isError && !hasText
      ? [
          ...Arr.filter(base, ({ content: block }) => block.type === "image"),
          { content: textOf(failedLine(call.details)), note: true },
        ]
      : base.length > 0
        ? base
        : [{ content: textOf(""), note: true }];

  const cut = bounded(shown);
  let output: ReadonlyArray<ModelContent> = Arr.map(shown, (piece) => piece.content);

  if (cut !== undefined) {
    output = cut.output;
    diagnostics.push(cut.warning);

    if (call.kind === "model") {
      const saved = await call.spill(cut.whole, ".txt");

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
    if (script) {
      result.isError = true;
      diagnostics.push({
        severity: "error",
        code: "invalid_structured_output",
        message: invalidMessage(structured),
      });
    }
  } else {
    result.structuredOutput = jsonOf(script ? scriptValueOf(value) : modelValueOf());
  }

  if (diagnostics.length > 0) result.diagnostics = diagnostics;

  return result;
};

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
    : isTaskAnswer(result)
      ? // The host answers with a task only to a call that asked for one (`ctx.allowTask`), which a tool call does not
        // yet; the Session-side tools that follow tasks come with their own ticket.
        failedWith("The MCP host answered with an MCP task the call did not ask for.", details)
      : Predicate.isTagged(result, "AppHtml")
        ? // Only a `ui/html` request is answered so, and a tool call is never one.
          failedWith("The MCP host answered a call with App HTML", details)
        : failedWith(result.message, details);

const isTaskAnswer = (result: McpHostRequestResult) =>
  Predicate.isTagged(result, "Task") ||
  Predicate.isTagged(result, "TaskState") ||
  Predicate.isTagged(result, "TaskAck");

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

/** What the model reads of a result whose stream could not be read: the same ends as the engine's, by the same words. */
export const streamFailure = (
  kind: StreamFailure,
  details: McpDetails,
): ToolExecutionResult<JsonValue> => endedWith(streamEnd(kind), details);
