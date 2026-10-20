// pi-durable's Harness and the faux provider are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off
// A pi-durable Harness over memory storage whose model is pi-ai's faux provider, for driving adapted tools, hooks,
// and sections through real runs.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  type Extension,
  Harness,
  MemoryStorage,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

export const context = BACKGROUND_CONTEXT;

/** A model response that calls tool `name` with `args`. */
export const callTool = (name: string, args: ToolCall["arguments"]): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${name}` })], {
    stopReason: "toolUse",
  });

/** A model response that answers `text`. */
export const answer = (text: string): AssistantMessage => fauxAssistantMessage(text);

/** The system prompt sections and tools a request declared, replayed from its system messages. */
export type Declared = {
  readonly sections: Readonly<Record<string, string | null>>;
  readonly tools: readonly { readonly name: string; readonly parameters: unknown }[];
};

const declared = (messages: readonly Message[]): Declared => {
  const system = Arr.flatMap(messages, (message) => (message.role === "system" ? [message] : []));

  return {
    sections: Object.assign({}, ...Arr.map(system, (message) => message.sections ?? {})),
    tools: Arr.flatMap(system, (message) => message.toolsAdded ?? []),
  };
};

/**
 * Open a Harness with `extensions` installed whose model answers with `responses` in turn, and its root conversation.
 * `requests` records what each model request declared.
 */
export const openFauxHarness = async (
  extensions: readonly Extension[],
  responses: readonly AssistantMessage[],
) => {
  const faux = fauxProvider();
  const models = createModels();
  const registry = createRegistry();
  const requests: Declared[] = [];

  models.setProvider(faux.provider);
  faux.setResponses(
    Arr.map(responses, (response) => (request) => {
      requests.push(declared(request.messages));

      return response;
    }),
  );

  for (const extension of extensions) registry.install(extension);

  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);

  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });

  /** The newest tool result in the root transcript. */
  const lastToolResult = async (): Promise<ToolResultMessage | undefined> => {
    const page = await root.entries({}, 50, undefined, context);
    const entry = Arr.findFirst(page.items, (item) => ToolResultEntry.is(item));
    const message = Option.getOrUndefined(entry)?.model?.[0];

    return message?.role === "toolResult" ? message : undefined;
  };

  /** Submit `content` to the root conversation and wait until its run settles. */
  const prompt = async (content: string) =>
    (await root.submit({ type: "input", content }, context)).wait(context);

  return { harness, root, requests, prompt, lastToolResult };
};

/** The text of a tool result's output. */
export const resultText = (result: ToolResultMessage | undefined): string =>
  Arr.join(
    Arr.map(result?.content ?? [], (block) => (block.type === "text" ? block.text : "")),
    "",
  );
