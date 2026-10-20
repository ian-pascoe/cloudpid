// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off preferEffectArray:off preferEffectRecord:off
// A test Session DO whose Session runs the subagents extension, as the Session DO does, over a scripted model that
// answers by the agent asking. The script's switches live in the object's storage, so an instance started after an
// eviction carries on with them.
import { DurableObject } from "cloudflare:workers";
import { callDurable, Harness } from "@cloudpid/effect-durable";
import {
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
import type { ConversationId } from "@earendil-works/pi-durable";
import type { TaskGraphSummary } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import { type AbortOptions, SessionHost, sessionHostLayer } from "./host.ts";
import { sessionSettingsLayer } from "./settings.ts";
import { SessionRegistry } from "./status.ts";

/** Set once the child may answer; until then its requests hang until they are interrupted. */
const RELEASED = "released";

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
          models,
          reset: (reason) => ctx.abort(reason),
          extensions: Effect.map(subagents, (extension) => [extension]),
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(SessionRegistry, { report: () => Effect.void }),
              sessionSettingsLayer({ read: Effect.succeed({}), kv: ctx.storage.kv }),
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

  /** Let the child's hanging request answer now. */
  answerChild(): void {
    this.#childMayAnswer.resolve();
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

  /** Submit `text` to conversation `conversationId`, as the owner does. */
  submitTo(conversationId: ConversationId, text: string): Promise<number> {
    return this.#runtime.runPromise(
      Effect.flatMap(SessionHost, (host) =>
        host.submit({ requestId: text, input: text, conversationId }),
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
