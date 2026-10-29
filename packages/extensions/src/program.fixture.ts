// A stand-in for code mode in tests (`docs/architecture/agent-capabilities.md` → Values for programs): the `program` tool
// calls a tool as a `codemode` script does, through a nested `executeTool`, and answers with what the script got, as
// JSON text; `program_sized` answers with how large the value is and which of its lists were cut, for a value too large
// for a tool result's text. A test installs `programExtension` beside the tools it calls in its own Harness and has its
// model call `program`, decoding each result's text with `decodeProgramCall`, or runs steps in a Harness of their own
// with `runProgram` / `runSized`. pi-durable's Harness and the faux provider are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off
import { ChordContext, defineEffectTool } from "@cloudpid/effect-durable";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  type Extension,
  Harness,
  type JsonObject,
  MemoryStorage,
  type NestedToolExecutionResult,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { storedBytes } from "./stored-bytes.ts";

/** What a script got of one nested call. */
export const ProgramCall = Schema.Struct({
  isError: Schema.Boolean,
  /** Left out for an error result of a tool that declares a schema. */
  structuredOutput: Schema.optionalKey(Schema.Unknown),
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

/**
 * A stand-in tool `name` that calls `tool` with `args` as a script does, and answers with the JSON text `answer` makes
 * of the nested call's result.
 */
const standIn = <
  S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
>(
  name: string,
  description: string,
  answer: S,
  of: (result: NestedToolExecutionResult) => S["Type"],
) =>
  defineEffectTool({
    name,
    description,
    parameters: Schema.Struct({
      tool: Schema.String,
      args: Schema.Record(Schema.String, Schema.Json),
    }),
    execute: Effect.fnUntraced(function* ({ tool, args }, api: ToolExecutionApi) {
      const chord = yield* ChordContext;

      // SAFETY: the decoded arguments are JSON.
      const result = yield* Effect.promise(() => api.executeTool(tool, args as JsonObject, chord));

      const text = yield* Schema.encodeEffect(Schema.fromJsonString(answer))(of(result)).pipe(
        Effect.orDie,
      );

      return { output: [{ type: "text", text }] };
    }),
  });

/** The `program` tool: calls `tool` with `args` as a script does, and answers with what the script got. */
export const Program = standIn(
  "program",
  "Call a tool the way a program does",
  ProgramCall,
  (result) => ({
    isError: result.isError === true,
    structuredOutput: summarized(result.structuredOutput),
    diagnostics: result.diagnostics.map(({ message }) => ({ message })),
  }),
);

/** An extension that brings only `program`. */
export const programExtension = defineExtension({
  name: "program",
  tools: [Effect.runSync(Program)],
});

/** What a script got of a nested call, as the size of its value: for a value too large for a tool result's text. */
export const SizedCall = Schema.Struct({
  isError: Schema.Boolean,
  diagnostics: Schema.Array(Schema.Struct({ message: Schema.String })),
  /** What the value weighs stored. */
  bytes: Schema.Finite,
  /** The value's `*_truncated` booleans, by key. */
  truncated: Schema.Record(Schema.String, Schema.Boolean),
  /** The length of each list in the value, by key. */
  lengths: Schema.Record(Schema.String, Schema.Finite),
});

// @effect-diagnostics-next-line schemaSync:off -- a test reads a tool result it holds.
const decodeSizedCall = Schema.decodeUnknownSync(Schema.fromJsonString(SizedCall));

/** `program_sized`: calls `tool` as `program` does, and answers with how large its value is, not the value. */
const Sized = standIn(
  "program_sized",
  "Call a tool the way a program does, and say how large its value is",
  SizedCall,
  (result) => {
    const value = result.structuredOutput;
    const entries = Predicate.isObject(value) && !Array.isArray(value) ? Object.entries(value) : [];

    return {
      isError: result.isError === true,
      diagnostics: result.diagnostics.map(({ message }) => ({ message })),
      bytes: storedBytes(value),
      truncated: Object.fromEntries(
        entries.flatMap(([key, item]) =>
          key.endsWith("_truncated") && Predicate.isBoolean(item) ? [[key, item]] : [],
        ),
      ),
      lengths: Object.fromEntries(
        entries.flatMap(([key, item]) => (Array.isArray(item) ? [[key, item.length]] : [])),
      ),
    };
  },
);

const sizedExtension = defineExtension({ name: "program-sized", tools: [Effect.runSync(Sized)] });

/** The text of a tool result in a transcript. */
const textOf = (message: Message): string | undefined =>
  message.role === "toolResult"
    ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
    : undefined;

/**
 * Call each of `steps` (a tool and its arguments) as a program does, one after the other, in a Harness of their own
 * with `extensions` installed beside `program`; what the script got of each. `meanwhile` runs beside the calls, as the owner answering the Approval
 * a call waits for; the run ends when both have.
 */
export const runProgram = async (
  extensions: ReadonlyArray<Extension>,
  steps: ReadonlyArray<readonly [string, JsonObject]>,
  options: RunOptions = {},
): Promise<ReadonlyArray<ProgramCall>> =>
  (await runThrough("program", extensions, steps, options)).map((text) => decodeProgramCall(text));

/** As `runProgram`, for calls whose value is too large to read: how large each is, and which of its lists were cut. */
export const runSized = async (
  extensions: ReadonlyArray<Extension>,
  steps: ReadonlyArray<readonly [string, JsonObject]>,
  options: RunOptions = {},
): Promise<ReadonlyArray<typeof SizedCall.Type>> =>
  (await runThrough("program_sized", extensions, steps, options)).map((text) =>
    decodeSizedCall(text),
  );

type RunOptions = {
  /** The calls' environment, for tools that read the Workspace's files: only what they use. */
  readonly env?: Partial<ExecutionEnv>;
  readonly meanwhile?: () => Promise<void>;
};

/** The text each step's call through the stand-in tool `through` gave. */
const runThrough = async (
  through: "program" | "program_sized",
  extensions: ReadonlyArray<Extension>,
  steps: ReadonlyArray<readonly [string, JsonObject]>,
  options: RunOptions,
): Promise<ReadonlyArray<string>> => {
  const faux = fauxProvider();
  const models = createModels();
  const registry = createRegistry();
  const context = BACKGROUND_CONTEXT;
  let next = 0;
  let results: ReadonlyArray<string> = [];

  models.setProvider(faux.provider);
  registry.install(programExtension);
  registry.install(sizedExtension);

  for (const extension of extensions) registry.install(extension);

  faux.setResponses(
    Array.from(
      { length: steps.length + 2 },
      () => (transcript: { messages: readonly Message[] }) => {
        const step = steps[next++];

        if (step === undefined) {
          results = transcript.messages.flatMap((message) => {
            const text = textOf(message);

            return text === undefined ? [] : [text];
          });

          return fauxAssistantMessage("Done.");
        }

        return fauxAssistantMessage(
          [fauxToolCall(through, { tool: step[0], args: step[1] }, { id: `call-${next}` })],
          { stopReason: "toolUse" },
        );
      },
    ),
  );

  const harness = await Harness.open(
    new MemoryStorage(),
    // SAFETY: the tools under test use only what the test gives of the environment.
    { models, registry, env: () => options.env as ExecutionEnv },
    context,
  );

  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });

  const owner = options.meanwhile?.();

  await (await root.submit({ type: "input", content: "Go" }, context)).wait(context);
  await owner;

  return results;
};

/**
 * Answer the Approval requests that wait, in turn, with `answers`, as the owner does on a card; ends when each is
 * answered (or fails after five seconds without a request).
 */
export const answerRequests = async (
  pending: () => Promise<ReadonlyArray<{ readonly id: string }>>,
  answer: (
    id: string,
    answer: { readonly approve: boolean; readonly reason?: string },
  ) => Promise<void>,
  answers: ReadonlyArray<{ readonly approve: boolean; readonly reason?: string }>,
) => {
  for (const given of answers) {
    let request: { readonly id: string } | undefined;

    for (let tries = 0; request === undefined; tries++) {
      if (tries > 500) throw new Error("No request waited for the owner's answer");

      request = (await pending())[0];

      if (request === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await answer(request.id, given);
  }
};
