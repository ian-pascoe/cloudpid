// A pi-durable Harness over memory storage, with the web extension over a fake network and a scripted model, for
// driving `web_search` and `web_fetch` through real tool calls. pi-durable's Harness and the faux provider are
// Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off strictEffectProvide:off preferEffectArray:off schemaSync:off preferSchemaOverJson:off
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ChordContext, defineEffectTool } from "@cloudpid/effect-durable";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  Harness,
  type JsonObject,
  MemoryStorage,
  type ToolExecutionApi,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Web } from "../web.ts";
import { WebConfig } from "./config.ts";
import type { WebToolError } from "./errors.ts";
import { fakeResolver, fakeTransport } from "./web.fixture.ts";
import { type WebRequest } from "./transport.ts";

const context = BACKGROUND_CONTEXT;

const ProgramResult = Schema.Struct({
  isError: Schema.Boolean,
  structuredOutput: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const decodeProgramResult = Schema.decodeUnknownSync(Schema.fromJsonString(ProgramResult));

/** A model response that calls tool `name` with `args`. */
export const callTool = (name: string, args: ToolCall["arguments"]): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${name}` })], {
    stopReason: "toolUse",
  });

export const answer = (text: string): AssistantMessage => fauxAssistantMessage(text);

export type Network = {
  /** Answers a request: a response, or a failure. */
  readonly answer: (request: WebRequest) => Response | WebToolError;
  /** Hostnames the guard's resolver knows. */
  readonly hosts?: Readonly<Record<string, readonly string[]>> | undefined;
};

export type Keys = { readonly exa?: string; readonly parallel?: string };

/** The Harness bounds the probe's own output too, so a long \`content\` is reported by its length. */
const shorten = (key: string, value: JsonValue): JsonValue =>
  key === "content" && Schema.is(Schema.String)(value) && value.length > 10_000
    ? `<${value.length} characters>`
    : value;

/**
 * A tool for tests only: it calls `tool` as another tool or a code mode script would, and returns the structured output
 * (and whether the call failed) as JSON text, so a test sees the programs' channel too.
 */
const Probe = defineEffectTool({
  name: "probe",
  description: "Call a tool the way a program does",
  parameters: Schema.Struct({
    tool: Schema.String,
    args: Schema.Record(Schema.String, Schema.Unknown),
  }),
  execute: Effect.fnUntraced(function* ({ tool, args }, api: ToolExecutionApi) {
    const chord = yield* ChordContext;

    const result = yield* Effect.promise(() =>
      // SAFETY: the test passes JSON arguments.
      api.executeTool(tool, args as JsonObject, chord),
    );

    return {
      output: [
        {
          type: "text",
          text: JSON.stringify(
            { isError: result.isError, structuredOutput: result.structuredOutput },
            shorten,
          ),
        },
      ],
    };
  }),
});

/**
 * Open a Harness whose model answers with `responses` in turn, with the web extension over `network` and `keys`.
 * `sent` records every request the tools made.
 */
export const openWebHarness = async (
  network: Network,
  keys: Keys,
  responses: readonly AssistantMessage[],
) => {
  const transport = fakeTransport(network.answer);
  const resolver = fakeResolver(network.hosts ?? { "example.com": ["93.184.216.34"] });

  const layer = Layer.mergeAll(
    transport.layer,
    resolver.layer,
    Layer.succeed(WebConfig, {
      exaApiKey: Option.map(Option.fromUndefinedOr(keys.exa), Redacted.make),
      parallelApiKey: Option.map(Option.fromUndefinedOr(keys.parallel), Redacted.make),
    }),
  );

  const web = await Effect.runPromise(Web.pipe(Effect.provide(layer)));
  const probe = await Effect.runPromise(Probe);

  const faux = fauxProvider();
  const models = createModels();
  const registry = createRegistry();

  models.setProvider(faux.provider);
  faux.setResponses(Arr.map(responses, (response) => () => response));
  registry.install(web);
  registry.install(defineExtension({ name: "probe", tools: [probe] }));

  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);

  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });

  const lastToolResult = async (): Promise<ToolResultMessage | undefined> => {
    const page = await root.entries({}, 50, undefined, context);
    const entry = Arr.findFirst(page.items, (item) => ToolResultEntry.is(item));
    const message = Option.getOrUndefined(entry)?.model?.[0];

    return message?.role === "toolResult" ? message : undefined;
  };

  const prompt = async (content: string) =>
    (await root.submit({ type: "input", content }, context)).wait(context);

  /** Call `tool` with `args` as the model, and give the text it saw and whether it was an error. */
  const call = async (tool: string, args: ToolCall["arguments"]) => {
    faux.setResponses([() => callTool(tool, args), () => answer("done")]);
    await prompt("go");

    const result = await lastToolResult();

    return {
      text: Arr.join(
        Arr.map(result?.content ?? [], (block) => (block.type === "text" ? block.text : "")),
        "",
      ),
      isError: result?.isError === true,
    };
  };

  /** Call `tool` as a program, and give what it received. */
  const callAsProgram = async (tool: string, args: ToolCall["arguments"]) => {
    const { text } = await call("probe", { tool, args });

    return decodeProgramResult(text);
  };

  return { call, callAsProgram, sent: transport.requests, lookups: resolver.lookups, harness };
};
