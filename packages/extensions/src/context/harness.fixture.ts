// A pi-durable Harness over memory storage with the context and subagents extensions, a tool that returns a large
// output, and a scripted model with a small context window, so a few tool rounds cross the compaction threshold.
// pi-durable's Harness and the faux provider are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off newPromise:off globalTimers:off preferEffectArray:off globalRandom:off preferEffectRecord:off
import { Harness, openHarness } from "@cloudpid/effect-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  type ToolCall,
  Type,
} from "@earendil-works/pi-ai";
import {
  type ConversationId,
  defineExtension,
  defineTool,
  type EntryRecord,
  type Extension,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { ContextManagement } from "../context.ts";
import { defaultSubagentSettings, Subagents } from "../subagents.ts";

export const context = BACKGROUND_CONTEXT;

/**
 * The model's context window and the compaction policy, as pi-durable's defaults in miniature: above 5,000 tokens a
 * compaction starts in the background, and above 10,000 the next request waits for one. A request starts at about
 * 2,500 tokens (the tool declarations), so two `big` results cross the background threshold and four the blocking one.
 */
const CONTEXT_WINDOW = 12_000;

const COMPACTION = { reserveTokens: 2_000, keepRecentTokens: 200, backgroundTokens: 5_000 };

/** `big` returns this many characters, about 2,000 tokens. */
const BIG_OUTPUT = 8_000;

/** Stand-in tools: `big` fills the context, `noop` does nothing. */
const Tools = defineExtension({
  name: "stand-in",
  tools: [
    defineTool({
      name: "big",
      description: "Return a large output",
      parameters: Type.Object({}),
      execute: async () => ({ output: [{ type: "text", text: "x".repeat(BIG_OUTPUT) }] }),
    }),
    defineTool({
      name: "noop",
      description: "Do nothing",
      parameters: Type.Object({}),
      execute: async () => ({ output: [{ type: "text", text: "noop ran" }] }),
    }),
  ],
});

/** One model request, as the script sees it. */
export type Request = {
  /** `root`, or the subagent's ID. */
  readonly agent: string;
  /** The text of the last message the agent got. */
  readonly text: string;
  /** The text of every message the request sent, system prompts left out. */
  readonly transcript: ReadonlyArray<string>;
  /** The system prompt sections offered so far, joined. */
  readonly system: string;
  /** The tools offered so far. */
  readonly tools: ReadonlyArray<string>;
};

/** A response that calls tools, in order. */
export const call = (
  ...calls: ReadonlyArray<readonly [string, ToolCall["arguments"]]>
): AssistantMessage =>
  fauxAssistantMessage(
    calls.map(([name, args], index) =>
      fauxToolCall(name, args, { id: `call-${name}-${index}-${Math.random()}` }),
    ),
    { stopReason: "toolUse" },
  );

export const answer = (text: string): AssistantMessage => fauxAssistantMessage(text);

export const contentText = (content: Message["content"]): string =>
  Predicate.isString(content)
    ? content
    : content
        .map((block) =>
          "text" in block ? block.text : block.type === "toolCall" ? block.name : "",
        )
        .join("");

/** Who made a request, from the instructions a subagent gets. */
const agentOf = (messages: readonly Message[]): string => {
  const sections = messages.flatMap((message) =>
    message.role === "system" ? Object.values(message.sections ?? {}) : [],
  );

  for (const section of sections) {
    const found = section === null ? null : /You are subagent `([^`]+)`/.exec(section);

    if (found !== null) return found[1] ?? "root";
  }

  return "root";
};

/** The tools offered so far in a request's transcript. */
const toolsOf = (messages: readonly Message[]): string[] => {
  const tools = new Set<string>();

  for (const message of messages) {
    if (message.role !== "system") continue;

    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);

    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }

  return [...tools];
};

/**
 * Open a Harness whose model answers each request with `script(request)`, with the context and subagents extensions and
 * the stand-in tools installed. A large `contextWindow` keeps the threshold out of reach.
 */
export const openContextHarness = async (
  script: (request: Request) => AssistantMessage | Promise<AssistantMessage>,
  contextWindow = CONTEXT_WINDOW,
  /** More extensions to install, after the others. */
  more: ReadonlyArray<Effect.Effect<Extension, never, Harness>> = [],
) => {
  const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow }] });
  const models = createModels();
  const requests: Request[] = [];

  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 200 }, () => (transcript) => {
      const messages = transcript.messages;
      const sent = messages.filter((message) => message.role !== "system");
      const last = sent.at(-1);

      const request: Request = {
        agent: agentOf(messages),
        text: last === undefined ? "" : contentText(last.content),
        transcript: sent.map((message) => contentText(message.content)),
        system: messages
          .flatMap((message) =>
            message.role === "system" ? Object.values(message.sections ?? {}) : [],
          )
          .join("\n"),
        tools: toolsOf(messages),
      };

      requests.push(request);

      return script(request);
    }),
  );

  const service = await Effect.runPromise(
    openHarness(new MemoryStorage(), { models, settings: { compaction: COMPACTION } }),
  );

  const extensions = await Effect.runPromise(
    Effect.all([ContextManagement, Subagents, ...more]).pipe(
      Effect.provide(Context.make(Harness, service)),
      Effect.provide(defaultSubagentSettings()),
    ),
  );

  for (const extension of [Tools, ...extensions]) {
    await Effect.runPromise(service.install(extension));
  }

  const { harness } = service;

  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });

  /** Submit `content` to the root conversation and wait for its answer. */
  const prompt = async (content: string) =>
    (await root.submit({ type: "input", content }, context)).wait(context);

  /** Wait until `check` holds, for up to five seconds. */
  const until = async (check: () => Promise<boolean>, what = "condition") => {
    for (let tries = 0; tries < 500; tries++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Timed out waiting for ${what}`);
  };

  /** Wait until no task is live, background ones included. */
  const settle = () =>
    until(async () => {
      const inspection = await harness.inspect(context);

      return inspection.tasks.length === 0 && inspection.submissions.length === 0;
    }, "the Session to settle");

  /** Every stored entry of conversation `id`, oldest first, also those before a Handoff. */
  const entries = async (id: ConversationId = ROOT_CONVERSATION_ID): Promise<EntryRecord[]> => {
    const conversation = await harness.conversation(id, context);
    const page = await conversation!.entries({ order: "ascending" }, 500, undefined, context);

    return [...page.items];
  };

  /** The text of every tool result of conversation `id`, oldest first. */
  const results = async (id: ConversationId = ROOT_CONVERSATION_ID) =>
    (await entries(id)).flatMap((entry) =>
      (entry.model ?? []).flatMap((message) =>
        message.role === "toolResult" ? [contentText(message.content)] : [],
      ),
    );

  return { harness, root, requests, prompt, until, settle, entries, results };
};
