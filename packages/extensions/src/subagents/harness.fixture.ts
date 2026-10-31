// A pi-durable Harness over memory storage with the subagents extension and stand-in coding tools, whose scripted model
// answers each request by the agent that makes it and the last message it got. pi-durable's Harness and the faux
// provider are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off newPromise:off globalTimers:off preferEffectArray:off preferEffectRecord:off globalRandom:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  type Message,
  type ToolCall,
  Type,
} from "@earendil-works/pi-ai";
import {
  type ConversationId,
  createRegistry,
  defineExtension,
  defineTool,
  type EntryRecord,
  type Extension,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import {
  defaultSubagentSettings,
  Subagents,
  type SubagentOptions,
  SubagentsDoc,
  type SubagentWorkspaceHost,
  SubagentWorkspaces,
} from "../subagents.ts";
import { type AgentWorkspace, EMPTY_STATE } from "./state.ts";
import type { RepoWorkState, SubagentWorkspaceRequest } from "./workspaces.ts";

/**
 * Subagent Workspaces kept in memory: each made on `cloudpid/<id>` (or the branch asked for), with what each has not
 * pushed set by the test (`work`), and those removed. `refuse` makes the next `create` reject with its message, and
 * `failRemoval` every `remove` until it is cleared.
 */
export const fakeSubagentWorkspaces = () => {
  const requests: SubagentWorkspaceRequest[] = [];
  const made = new Map<string, AgentWorkspace>();
  const work = new Map<string, RepoWorkState[]>();
  const removed: string[] = [];
  let refusal: string | undefined;
  let removal: string | undefined;
  let count = 0;
  let warnings: string[] = [];

  const host: SubagentWorkspaceHost = {
    create: async (request) => {
      requests.push(request);

      if (refusal !== undefined) throw new Error(refusal);

      const known = made.get(request.agent);

      if (known !== undefined) return { workspace: known, warnings };

      count += 1;

      const id = `0000000${count}`;

      const workspace: AgentWorkspace = {
        id,
        branch: request.branch ?? `cloudpid/${id}`,
        object: `ws:${id}`,
        directory: "/workspace/app",
      };

      made.set(request.agent, workspace);

      return { workspace, warnings };
    },
    workState: async (workspace) =>
      work.get(workspace.id) ?? [
        {
          repo: "app",
          cloned: true,
          uncommitted: 0,
          unpushed: 0,
          onRemote: true,
          head: workspace.branch,
        },
      ],
    // As the Registry does, a removed Workspace is no longer the one its subagent's ID is answered with.
    remove: async (workspace) => {
      if (removal !== undefined) throw new Error(removal);

      removed.push(workspace.id);

      for (const [agent, each] of made) if (each.id === workspace.id) made.delete(agent);
    },
  };

  return {
    host,
    requests,
    made,
    work,
    removed,
    refuse: (message: string | undefined) => {
      refusal = message;
    },
    failRemoval: (message: string | undefined) => {
      removal = message;
    },
    warn: (next: string[]) => {
      warnings = next;
    },
  };
};

export const context = BACKGROUND_CONTEXT;

/** The stand-in coding tools: each answers with its name. */
const CODING_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;

const Coding = defineExtension({
  name: "coding",
  tools: CODING_TOOLS.map((name) =>
    defineTool({
      name,
      description: `Stand-in ${name}`,
      parameters: Type.Object({}),
      execute: async () => ({ output: [{ type: "text", text: `${name} ran` }] }),
    }),
  ),
});

/** One model request, as the script sees it. */
export type Request = {
  /** `root`, or the subagent's ID. */
  readonly agent: string;
  /** The text of the last message the agent got. */
  readonly text: string;
  /** The tools the request offered. */
  readonly tools: ReadonlyArray<string>;
  readonly model: string;
  /** The system prompt sections offered so far, joined. */
  readonly system: string;
  /** Aborted when the request is. */
  readonly signal: AbortSignal | undefined;
  /** Every message of the request, as the provider gets it. */
  readonly messages: readonly Message[];
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

const contentText = (content: Message["content"]): string =>
  Predicate.isString(content)
    ? content
    : content.map((block) => ("text" in block ? block.text : "")).join("");

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

/** The tools offered in a request: its transcript's system messages replayed, as the transport does. */
const toolsOf = (messages: readonly Message[]): string[] =>
  getCurrentTools(messages).map((tool) => tool.name);

/**
 * Open a Harness whose model answers each request with `script(request)`, with the subagents extension under `options`
 * and the stand-in coding tools installed.
 */
export const openSubagentHarness = async (
  script: (request: Request) => AssistantMessage | Promise<AssistantMessage>,
  options: Partial<SubagentOptions> = {},
  /** Extensions installed beside the subagents and the stand-in coding tools. */
  extensions: readonly Extension[] = [],
  /** The Session's Subagent Workspaces; without them `workspace: "new"` is refused. */
  workspaces?: SubagentWorkspaceHost,
) => {
  const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-small" }] });
  const models = createModels();
  const registry = createRegistry();
  const requests: Request[] = [];

  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 200 }, () => (transcript, options, _state, model) => {
      const messages = transcript.messages;
      const last = messages.findLast((message) => message.role !== "system");

      const request: Request = {
        agent: agentOf(messages),
        text: last === undefined ? "" : contentText(last.content),
        tools: toolsOf(messages),
        model: model.id,
        system: messages
          .flatMap((message) =>
            message.role === "system" ? Object.values(message.sections ?? {}) : [],
          )
          .join("\n"),
        signal: options?.signal,
        messages,
      };

      requests.push(request);

      return script(request);
    }),
  );

  const subagents = await Effect.runPromise(
    Effect.provide(
      workspaces === undefined
        ? Subagents
        : Subagents.pipe(Effect.provideService(SubagentWorkspaces, workspaces)),
      defaultSubagentSettings(options),
    ),
  );

  registry.install(Coding);
  registry.install(subagents);

  for (const extension of extensions) registry.install(extension);

  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry }, context);

  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });

  /** Submit `content` to the root conversation and wait for its answer. */
  const prompt = async (content: string) =>
    (await root.submit({ type: "input", content }, context)).wait(context);

  const state = async () => (await harness.snapshot(SubagentsDoc, context)) ?? EMPTY_STATE;

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

  /** The entries of conversation `id`, oldest first. */
  const entries = async (id: ConversationId = ROOT_CONVERSATION_ID): Promise<EntryRecord[]> => {
    const conversation = await harness.conversation(id, context);
    const page = await conversation!.entries({ order: "ascending" }, 500, undefined, context);

    return [...page.items];
  };

  /** The text of every message of conversation `id` with `role`, oldest first. */
  const texts = async (role: Message["role"], id: ConversationId = ROOT_CONVERSATION_ID) =>
    (await entries(id)).flatMap((entry) =>
      (entry.model ?? []).flatMap((message) =>
        message.role === role ? [contentText(message.content)] : [],
      ),
    );

  return {
    harness,
    root,
    registry,
    storage,
    requests,
    prompt,
    state,
    until,
    settle,
    entries,
    texts,
  };
};

/** A promise and the functions that settle it, for a scripted response that waits on the test. */
export const gate = () => Promise.withResolvers<void>();
