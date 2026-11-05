// pi-durable's Harness and the faux provider are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off newPromise:off globalTimers:off
// A pi-durable Harness over memory storage whose model is pi-ai's faux provider, for driving adapted tools, hooks,
// sections, and tasks through real runs.
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
  type HarnessSettings,
  MemoryStorage,
  type Storage,
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

/**
 * Open a Harness as `openFauxHarness` does, with `settings`, that `restart` starts again as an evicted Durable Object is:
 * the old instance is cut off from the storage (every call it makes from then on fails, so nothing it still runs is
 * stored), and a new one opens over it, which counts a restart of every task it finds running and resumes them.
 * `harness()` is the current instance.
 */
export const openRestartingHarness = async (
  extensions: readonly Extension[],
  responses: readonly AssistantMessage[],
  settings: HarnessSettings,
) => {
  const faux = fauxProvider();
  const models = createModels();
  const registry = createRegistry();
  const memory = new MemoryStorage();

  models.setProvider(faux.provider);
  faux.setResponses([...responses]);

  for (const extension of extensions) registry.install(extension);

  /** Cut the current instance off. */
  let cut = () => {};

  /** The storage as one instance reaches it, until it is cut off. */
  const connect = (): Storage => {
    let live = true;

    cut = () => {
      live = false;
    };

    // As `refusingStorage` (`./sqlite-testing.ts`) does for a Durable Object's storage: a proxy trap is dynamic by
    // nature, and the storage's members are told apart at run time, with no schema to parse.
    return new Proxy(memory, {
      get: (target, key) => {
        // oxlint-disable-next-line anti-slop/no-reflect-get -- see above
        const value: unknown = Reflect.get(target, key, target);

        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- see above
        if (typeof value !== "function") return value;

        // Refused when called, not when read, so a method the instance captured before the cut refuses too.
        return (...args: ReadonlyArray<unknown>) => {
          if (!live) throw new Error("This instance was cut off from its storage");

          return value.apply(target, args);
        };
      },
    });
  };

  const open = () => Harness.open(connect(), { models, registry, settings }, context);

  let current = await open();

  const root = await current.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });

  await root.submit({ type: "input", content: "go" }, context);

  return {
    harness: () => current,
    /** The newest tool result of the root conversation, as the current instance reads it. */
    lastToolResult: async (): Promise<ToolResultMessage | undefined> => {
      const conversation = await current.conversation(root.id, context);
      const page = await conversation?.entries({}, 50, undefined, context);
      const entry = Arr.findFirst(page?.items ?? [], (item) => ToolResultEntry.is(item));
      const message = Option.getOrUndefined(entry)?.model?.[0];

      return message?.role === "toolResult" ? message : undefined;
    },
    restart: async () => {
      cut();
      current = await open();
      current.resume();
    },
  };
};

/** Wait until `check` holds, or fail saying `failure`. */
export const until = async (check: () => boolean, failure: () => string): Promise<void> => {
  for (let tries = 0; tries < 1000; tries += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(failure());
};

/** The text of a tool result's output. */
export const resultText = (result: ToolResultMessage | undefined): string =>
  Arr.join(
    Arr.map(result?.content ?? [], (block) => (block.type === "text" ? block.text : "")),
    "",
  );
