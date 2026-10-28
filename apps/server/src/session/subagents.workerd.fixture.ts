// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off preferEffectArray:off preferEffectRecord:off
// A test Session DO whose Session runs the subagents extension, as the Session DO does, over a scripted model that
// answers by the agent asking. The script's switches live in the object's storage, so an instance started after an
// eviction carries on with them. Its Workspace is a fake one (`fake-workspace.fixture.ts`), absent until a test sets it.
import { DurableObject } from "cloudflare:workers";
import { callDurable, Harness } from "@cloudpid/effect-durable";
import {
  type AgentWorkspace,
  defaultSubagentSettings,
  Subagents,
  SubagentsDoc,
  type SubagentsState,
} from "@cloudpid/extensions/subagents";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import type { ConversationId, UserInput } from "@earendil-works/pi-durable";
import type {
  Catalog,
  CommandOutcome,
  FileMatches,
  SessionAgent,
  TaskGraphSummary,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import {
  askedConversations,
  type FakeWorkspace,
  fakeWorkspaceEnv,
  listedDirectories,
  useFakeWorkspace,
} from "./fake-workspace.fixture.ts";
import {
  type AbortOptions,
  type FileSearch,
  SessionHost,
  sessionHostLayer,
  type SlashCommand,
} from "./host.ts";
import { pricedModels, REQUEST_COST } from "./priced.fixture.ts";
import { sessionSettingsLayer } from "./settings.ts";
import { ReportError, SessionRegistry } from "./status.ts";

/** Set once the child may answer; until then its requests hang until they are interrupted. */
const RELEASED = "released";

/** The subagents the Session reported to the Registry, oldest first, and whether those reports fail. */
const AGENT_REPORTS = "agent-reports";
const AGENT_REPORTS_FAIL = "agent-reports-fail";

/** What `followWorkspaces` saw so far (null: the Session's Workspace), and why its stream ended, if it did. */
type FollowedWorkspaces = { seen: (AgentWorkspace | null)[]; ended?: string };

/** The shortest time between two reports of the subagents, short so a test sees the throttled ones. */
export const AGENTS_REPORT_TEST_MS = 100;

const text = (content: Message["content"]): string =>
  Predicate.isString(content)
    ? content
    : content.map((block) => ("text" in block ? block.text : "")).join("");

/** Who asks: a subagent names itself in its instructions. */
const askedBy = (messages: readonly Message[]): string => {
  for (const message of messages) {
    if (message.role !== "system") continue;

    for (const section of Object.values(message.sections ?? {})) {
      const found = section === null ? null : /You are subagent `([^`]+)`/.exec(section);

      if (found?.[1] !== undefined) return found[1];
    }
  }

  return "root";
};

export class TestSubagentSession extends DurableObject {
  #runtime!: ManagedRuntime.ManagedRuntime<SessionHost | Harness, unknown>;
  /** Resolves when this instance's child request starts and hangs. */
  readonly hanging = Promise.withResolvers<void>();
  /** Resolves when `answerChild` is called: the child's hanging request then answers instead of waiting to be interrupted. */
  readonly #childMayAnswer = Promise.withResolvers<void>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    const faux = fauxProvider({
      provider: "anthropic",
      models: [{ id: "claude-opus-5-5", reasoning: true }],
    });

    faux.setResponses(
      Array.from(
        { length: 20 },
        () => (transcript, options) => this.#respond(transcript.messages, options?.signal),
      ),
    );

    const models = createModels();

    models.setProvider(faux.provider);

    const subagents = Effect.provide(Subagents, defaultSubagentSettings());

    void ctx.blockConcurrencyWhile(async () => {
      this.#runtime = ManagedRuntime.make(
        sessionHostLayer({
          storage: ctx.storage,
          models: pricedModels(models, REQUEST_COST),
          reset: (reason) => ctx.abort(reason),
          extensions: Effect.map(subagents, (extension) => [extension]),
          env: fakeWorkspaceEnv(ctx.storage.kv),
          expandTimeout: "1 second",
          agentsReportMs: AGENTS_REPORT_TEST_MS,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(SessionRegistry, {
                report: () => Effect.void,
                // Recorded in storage, so a test reads them across instances; `failAgentReports` makes them fail.
                reportAgents: (agents) =>
                  ctx.storage.kv.get<boolean>(AGENT_REPORTS_FAIL) === true
                    ? Effect.fail(ReportError.make({ message: "The Registry is down" }))
                    : Effect.sync(() => {
                        ctx.storage.kv.put(AGENT_REPORTS, [
                          ...(ctx.storage.kv.get<SessionAgent[][]>(AGENT_REPORTS) ?? []),
                          agents,
                        ]);
                      }),
                notify: () => Effect.void,
                titleWanted: Effect.succeed(false),
                setTitle: () => Effect.void,
              }),
              sessionSettingsLayer({
                read: Effect.sync(() => ({
                  global: ctx.storage.kv.get<Schema.Json>("overrides") ?? {},
                  overrides: {},
                })),
                kv: ctx.storage.kv,
              }),
            ),
          ),
        ),
      );

      await this.#runtime.context();
    });
  }

  #respond(
    messages: readonly Message[],
    signal: AbortSignal | undefined,
  ): AssistantMessage | Promise<AssistantMessage> {
    const agent = askedBy(messages);
    const last = messages.findLast((message) => message.role !== "system");
    const said = last === undefined ? "" : text(last.content);

    if (agent === "agent-1") {
      if (this.ctx.storage.kv.get<boolean>(RELEASED) === true)
        return fauxAssistantMessage("The answer is 42.");

      // Asked to delegate further, it starts its own subagent first; after that it hangs like the others.
      if (said.includes("Find the deeper answer") && last?.role === "user") {
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { task: "Find it deeper" }, { id: "spawn-deeper" })],
          { stopReason: "toolUse" },
        );
      }

      return this.#hang(signal);
    }

    // Any deeper agent hangs too.
    if (agent !== "root") return this.#hang(signal);

    if (said === "Delegate it") {
      return fauxAssistantMessage(
        [
          fauxToolCall("subagent", { task: "Find the answer" }, { id: "spawn" }),
          fauxToolCall("subagent_wait", { agent_id: "agent-1" }, { id: "wait" }),
        ],
        { stopReason: "toolUse" },
      );
    }

    if (said === "Delegate deep") {
      return fauxAssistantMessage(
        [
          fauxToolCall(
            "subagent",
            { task: "Find the deeper answer", delegation: "fanout" },
            { id: "spawn" },
          ),
        ],
        { stopReason: "toolUse" },
      );
    }

    if (said === "Delegate quietly") {
      return fauxAssistantMessage(
        [fauxToolCall("subagent", { task: "Find the answer" }, { id: "spawn" })],
        {
          stopReason: "toolUse",
        },
      );
    }

    return fauxAssistantMessage(`Root saw: ${said}`);
  }

  /** A request that stays open until it is interrupted, or `answerChild` lets it answer. */
  #hang(signal: AbortSignal | undefined): Promise<AssistantMessage> {
    this.hanging.resolve();

    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("Request interrupted", "AbortError"));

      void this.#childMayAnswer.promise.then(() => {
        resolve(fauxAssistantMessage("The answer is 42."));
      });

      if (signal?.aborted === true) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /** The subagents the Session reported to the Registry, oldest first. */
  agentReports(): ReadonlyArray<ReadonlyArray<SessionAgent>> {
    return this.ctx.storage.kv.get<SessionAgent[][]>(AGENT_REPORTS) ?? [];
  }

  /** Make the reports of the subagents fail, or work again. */
  failAgentReports(failing: boolean): void {
    this.ctx.storage.kv.put(AGENT_REPORTS_FAIL, failing);
  }

  /** Stop everything, as archiving the Session does. */
  stopEverything(): Promise<void> {
    return this.#runtime.runPromise(Effect.flatMap(SessionHost, (host) => host.stopEverything));
  }

  /** The Subagent Workspace of conversation `id`'s Changes (null: the Session's), or why it has none. */
  workspaceOf(
    id: ConversationId,
  ): Promise<{ readonly workspace: AgentWorkspace | null } | { readonly failure: string }> {
    return this.#runtime.runPromise(
      Effect.flatMap(SessionHost, (host) => host.workspaceOf(id)).pipe(
        Effect.map((workspace) => ({ workspace: workspace ?? null })),
        Effect.catch((error) => Effect.succeed({ failure: error.message })),
      ),
    );
  }

  /** Give subagent `agent` a Subagent Workspace in the Subagents document, as a spawn in a new Workspace does. */
  giveWorkspace(agent: string, workspace: AgentWorkspace): Promise<void> {
    return this.#runtime.runPromise(
      Effect.flatMap(Harness, ({ harness }) =>
        callDurable("commit", (context) =>
          harness.commit(async (tx) => {
            const record = (await tx.doc(SubagentsDoc)).agents[agent];

            if (record !== undefined) record.workspace = { ...workspace };
          }, context),
        ),
      ),
    );
  }

  #followed: FollowedWorkspaces = { seen: [] };

  /** Follow conversation `id`'s Workspace (`SessionHost.workspaces`) in the background, in this instance. */
  followWorkspaces(id: ConversationId): void {
    const followed: FollowedWorkspaces = { seen: [] };

    this.#followed = followed;
    void this.#runtime.runPromise(
      Stream.unwrap(Effect.map(SessionHost, (host) => host.workspaces(id))).pipe(
        Stream.runForEach((workspace) => Effect.sync(() => followed.seen.push(workspace ?? null))),
        Effect.catch((error) =>
          Effect.sync(() => {
            followed.ended = error.message;
          }),
        ),
      ),
    );
  }

  followedWorkspaces(): FollowedWorkspaces {
    return { ...this.#followed, seen: [...this.#followed.seen] };
  }

  /** Take subagent `agent` out of the Subagents document, as deleting it does. */
  forgetAgent(agent: string): Promise<void> {
    return this.#runtime.runPromise(
      Effect.flatMap(Harness, ({ harness }) =>
        callDurable("commit", (context) =>
          harness.commit(async (tx) => {
            const state = await tx.doc(SubagentsDoc);
            const conversationId = state.agents[agent]?.conversationId;

            delete state.agents[agent];

            if (conversationId !== undefined) delete state.conversations[String(conversationId)];
          }, context),
        ),
      ),
    );
  }

  /** Let the child's hanging request answer now. */
  answerChild(): void {
    this.#childMayAnswer.resolve();
  }

  /** Hold the Session to a spend limit of `perSession` US dollars, from the next prompt on. */
  limit(perSession: number): void {
    this.ctx.storage.kv.put("overrides", { spendLimit: { perSession } });
  }

  /** The error message of each assistant message of conversation `id` that ended in an error, oldest first. */
  errors(id?: ConversationId): Promise<readonly string[]> {
    return this.#runtime.runPromise(
      Effect.flatMap(Harness, ({ harness }) =>
        callDurable("entries", async (context) => {
          const conversation =
            id === undefined
              ? await harness.root(context)
              : await harness.conversation(id, context);

          const page = await conversation!.entries({ order: "ascending" }, 200, undefined, context);

          return page.items.flatMap((entry) =>
            (entry.model ?? []).flatMap((message) =>
              message.role === "assistant" && message.errorMessage !== undefined
                ? [message.errorMessage]
                : [],
            ),
          );
        }),
      ),
    );
  }

  /** Let the child answer, from its next request on. */
  release(): void {
    this.ctx.storage.kv.put(RELEASED, true);
  }

  submit(text: string): Promise<number> {
    return this.#runtime.runPromise(
      Effect.flatMap(SessionHost, (host) => host.submit({ requestId: text, input: text })),
    );
  }

  /** Submit `input`, text and images, to the root, as the web app sends a message with Attachments. */
  submitInput(input: UserInput, requestId: string): Promise<number> {
    return this.#runtime.runPromise(
      Effect.flatMap(SessionHost, (host) => host.submit({ requestId, input })),
    );
  }

  /** The kind, data and content of each owner message of the root, as stored, oldest first. */
  ownerMessages(): Promise<
    ReadonlyArray<{ readonly kind: string; readonly data: unknown; readonly content: unknown }>
  > {
    return this.#runtime.runPromise(
      Effect.flatMap(Harness, ({ harness }) =>
        callDurable("entries", async (context) => {
          const page = await (
            await harness.root(context)
          ).entries({ order: "ascending" }, 200, undefined, context);

          return page.items.flatMap((entry) =>
            entry.kind === "pi.user" || entry.kind === "cloudpid.user"
              ? [{ kind: entry.kind, data: entry.data, content: entry.model?.[0]?.content }]
              : [],
          );
        }),
      ),
    );
  }

  /** Submit `text` to conversation `conversationId`, as the owner does. */
  submitTo(conversationId: ConversationId, text: string): Promise<number> {
    return this.#runtime.runPromise(
      Effect.flatMap(SessionHost, (host) =>
        host.submit({ requestId: text, input: text, conversationId }),
      ),
    );
  }

  /** Give the Session a fake Workspace that holds and answers what `workspace` says. */
  useWorkspace(workspace: FakeWorkspace): void {
    useFakeWorkspace(this.ctx.storage.kv, workspace);
  }

  /** The conversations whose environment the Session built, in order. */
  workspaceAskedFor(): readonly number[] {
    return askedConversations(this.ctx.storage.kv);
  }

  /** What the composer of the root conversation, or of a subagent's, offers. */
  catalog(conversationId?: ConversationId): Promise<Catalog> {
    return this.#runtime.runPromise(
      Effect.flatMap(SessionHost, (host) => host.catalog(conversationId)),
    );
  }

  /** What the `@` menu of the root conversation, or of a subagent's, offers for `query`; or why it could not. */
  files(
    query: string,
    conversationId?: ConversationId,
  ): Promise<FileMatches | { readonly failure: string }> {
    const search: Types.Mutable<FileSearch> = { query };

    if (conversationId !== undefined) search.conversationId = conversationId;

    return this.#runtime.runPromise(
      Effect.flatMap(SessionHost, (host) => host.files(search)).pipe(
        Effect.catch((error) => Effect.succeed({ failure: error.message })),
      ),
    );
  }

  /** The directories the fake Workspace listed, in order. */
  listedDirectories(): readonly string[] {
    return listedDirectories(this.ctx.storage.kv);
  }

  /** Run the Session's Slash command `name`: what it did, or why it could not. */
  command(
    name: string,
    args: string,
    conversationId?: ConversationId,
  ): Promise<{ readonly outcome: CommandOutcome } | { readonly failure: string }> {
    const command: Types.Mutable<SlashCommand> = { name, args };

    if (conversationId !== undefined) command.conversationId = conversationId;

    return this.#runtime.runPromise(
      Effect.flatMap(SessionHost, (host) => host.command(command)).pipe(
        Effect.map((outcome) => ({ outcome })),
        Effect.catch((error) => Effect.succeed({ failure: error.message })),
      ),
    );
  }

  /** The kind and data of each entry of conversation `id`, oldest first, with the text of its message. */
  entries(
    id?: ConversationId,
  ): Promise<
    ReadonlyArray<{ readonly kind: string; readonly data: unknown; readonly text: string }>
  > {
    return this.#runtime.runPromise(
      Effect.flatMap(Harness, ({ harness }) =>
        callDurable("entries", async (context) => {
          const conversation =
            id === undefined
              ? await harness.root(context)
              : await harness.conversation(id, context);

          const page = await conversation!.entries({ order: "ascending" }, 200, undefined, context);

          return page.items.map((entry) => ({
            kind: entry.kind,
            data: entry.data,
            text: (entry.model ?? [])
              .map((message) => (message.role === "system" ? "" : text(message.content)))
              .join(""),
          }));
        }),
      ),
    );
  }

  /** Abort what `options` names: the root by default. */
  abort(options: AbortOptions = {}): Promise<void> {
    return this.#runtime.runPromise(Effect.flatMap(SessionHost, (host) => host.abort(options)));
  }

  /** The first summary of the task graph that `accept`s, as a client watching it is sent. */
  taskGraph(accept: (summary: TaskGraphSummary) => boolean): Promise<TaskGraphSummary> {
    return this.#runtime.runPromise(
      Effect.flatMap(SessionHost, (host) =>
        host.taskGraph.pipe(
          Stream.filter(accept),
          Stream.runHead,
          Effect.timeout("5 seconds"),
          Effect.map(Option.getOrThrow),
        ),
      ),
    );
  }

  /** Whether no work is live; reads only. */
  idle(): Promise<boolean> {
    return this.#runtime.runPromise(Effect.flatMap(SessionHost, (host) => host.idle));
  }

  subagents(): Promise<SubagentsState | undefined> {
    return this.#runtime.runPromise(
      Effect.flatMap(Harness, ({ harness }) =>
        callDurable("snapshot", (context) => harness.snapshot(SubagentsDoc, context)),
      ),
    );
  }

  /** The text of each message of conversation `id` with `role`, oldest first. */
  texts(role: Message["role"], id?: ConversationId): Promise<readonly string[]> {
    return this.#runtime.runPromise(
      Effect.flatMap(Harness, ({ harness }) =>
        callDurable("entries", async (context) => {
          const conversation =
            id === undefined
              ? await harness.root(context)
              : await harness.conversation(id, context);

          const page = await conversation!.entries({ order: "ascending" }, 200, undefined, context);

          return page.items.flatMap((entry) =>
            (entry.model ?? []).flatMap((message) =>
              message.role === role ? [text(message.content)] : [],
            ),
          );
        }),
      ),
    );
  }

  override async alarm(): Promise<void> {
    await this.#runtime.runPromise(Effect.flatMap(SessionHost, (host) => host.alarm));
  }
}
