// A stand-in for code mode in tests (`docs/architecture/agent-capabilities.md` → Code mode): the `program` tool calls a
// tool as a `codemode` script does, through a nested `executeTool`, and answers with what the script got, as JSON text.
// A test installs `programExtension` beside the tools it calls, has its model call `program`, and decodes each result's
// text with `decodeProgramCall`.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off
import { ChordContext, defineEffectTool } from "@cloudpid/effect-durable";
import type { JsonValue } from "@earendil-works/chord";
import {
  defineExtension,
  type JsonObject,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** What a script got of one nested call. */
export const ProgramCall = Schema.Struct({
  isError: Schema.Boolean,
  structuredOutput: Schema.Unknown,
  diagnostics: Schema.Array(Schema.Struct({ message: Schema.String })),
});

export type ProgramCall = typeof ProgramCall.Type;

/** What a `program` result's text says the script got. */
// @effect-diagnostics-next-line schemaSync:off -- a test reads a tool result it holds.
export const decodeProgramCall = Schema.decodeUnknownSync(Schema.fromJsonString(ProgramCall));

/** `value` with each string longer than 1,000 characters as its length, so a long value fits a tool result. */
export const summarized = (value: JsonValue | undefined): JsonValue | undefined => {
  if (Predicate.isString(value))
    return value.length > 1000 ? `<${value.length} characters>` : value;

  if (Array.isArray(value)) return value.map((item) => summarized(item) ?? null);

  if (!Predicate.isObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, summarized(item) ?? null]),
  );
};

/** The `program` tool: calls `tool` with `args` as a script does, and answers with what the script got. */
export const Program = defineEffectTool({
  name: "program",
  description: "Call a tool the way a program does",
  parameters: Schema.Struct({
    tool: Schema.String,
    args: Schema.Record(Schema.String, Schema.Json),
  }),
  execute: Effect.fnUntraced(function* ({ tool, args }, api: ToolExecutionApi) {
    const chord = yield* ChordContext;

    // SAFETY: the decoded arguments are JSON.
    const result = yield* Effect.promise(() => api.executeTool(tool, args as JsonObject, chord));

    const got = yield* Schema.encodeEffect(Schema.fromJsonString(ProgramCall))({
      isError: result.isError === true,
      structuredOutput: summarized(result.structuredOutput),
      diagnostics: result.diagnostics.map(({ message }) => ({ message })),
    }).pipe(Effect.orDie);

    return { output: [{ type: "text", text: got }] };
  }),
});

/** An extension that brings only `program`. */
export const programExtension = defineExtension({
  name: "program",
  tools: [Effect.runSync(Program)],
});
