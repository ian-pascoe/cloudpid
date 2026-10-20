// Hosts one pi-durable Harness in a Session Durable Object, the way pi-durable's own `test-workers/worker.ts` does:
// opened over the object's SQLite storage and woken by its alarm (ADR-0002). The Harness stays native Promise code,
// reached through the `Harness` facade and `Effect.tryPromise` (ADR-0003). The object builds both services once, as
// one Layer kept in a `ManagedRuntime`.
import { Harness, type HarnessError, openHarness } from "@cloudpid/effect-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { formatModelId, isModelId } from "@cloudpid/config";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  type Agent,
  type AgentChange,
  type ModelRef,
  type AgentEvent,
  AssistantEntry,
  type ConversationId,
  type Extension,
  type HarnessOptions,
  type InputSubmissionDraft,
  type Submission,
  type UserInput,
  type WatchEnd,
  watchEvents,
} from "@earendil-works/pi-durable";
import {
  type DurableObjectSqliteStorage,
  openDurableObjectSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { harnessSettings, SessionSettings, type SettingsKv } from "./settings.ts";
import { SessionRegistry, type SessionStatus } from "./status.ts";

const context = BACKGROUND_CONTEXT;

/** How often the alarm wakes the object while work is live, so a run an eviction cut off resumes. */
export const HEARTBEAT_MS = 60_000;

/** How long a report to the Registry may take before it counts as failed. */
export const REPORT_TIMEOUT: Duration.Input = "5 seconds";

/**
 * What the alarm is armed for. pi-durable 1.3.0 has no `Harness.wake()`, so the host derives `active` from the live
 * tasks. Once `onWake` ships this becomes pi-durable's `Wake` (`{ active, at? }`): `wake` returns `harness.wake()`,
 * `HarnessOptions.onWake` runs `arm`, and `arm` also arms for the earliest sleep `at`.
 */
type Wake = { readonly active: boolean };

/**
 * The parts of a Durable Object's `ctx.storage` the host uses: its SQLite database, its key-value store and its alarm.
 * Narrow on purpose, so `@cloudflare/workers-types`' module and global declarations of the storage both fit it cheaply.
 */
export type SessionStorage = DurableObjectSqliteStorage & {
  readonly kv: SettingsKv;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

export type SessionHostOptions<R = never> = {
  /** The object's `ctx.storage`. */
  readonly storage: SessionStorage;
  readonly models: Models;
  /**
   * Reset the object (`ctx.abort`). Called when a storage error closes the Harness: the next event starts a new
   * instance, which reopens it.
   */
  readonly reset: (reason: string) => void;
  /** The extensions the Session's conversations run with, installed before any work resumes. */
  readonly extensions: Effect.Effect<readonly Extension[], never, Harness | SessionSettings | R>;
  /**
   * When the object must wake although no work is live, such as when a held Secret expires; the alarm is deleted when
   * this is undefined too.
   */
  readonly wakeAt?: Effect.Effect<number | undefined, never, R>;
  /** Builds a conversation's execution environment for each use (`HarnessOptions.env`): the Session's Workspace. */
  readonly env?: HarnessOptions["env"];
  /** How long a report to the Registry may take before it counts as failed. Defaults to `REPORT_TIMEOUT`. */
  readonly reportTimeout?: Duration.Input;
};

/** User input for the root conversation. */
export type Prompt = {
  /** Submitting the same `requestId` again finds the first submission. */
  readonly requestId?: string;
  readonly input: UserInput;
  /** What the input does while the conversation is busy; pi-durable queues it as a follow-up by default. */
  readonly whenBusy?: NonNullable<InputSubmissionDraft["whenBusy"]>;
};

export type Answer =
  | { readonly status: "answered"; readonly submissionId: number; readonly text: string }
  | { readonly status: "unanswered"; readonly submissionId: number; readonly reason: string };

/** A Harness or Durable Object storage call failed. */
export class SessionError extends Schema.TaggedError<
  SessionError,
  { readonly brand: unique symbol }
>()("SessionError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export type SessionHostService = {
  /** Durably admit `prompt` to the root conversation and return its submission ID. */
  readonly submit: (prompt: Prompt) => Effect.Effect<number, SessionError>;
  /** Submit `prompt` and wait for its answer. */
  readonly prompt: (prompt: Prompt) => Effect.Effect<Answer, SessionError>;
  /** The alarm handler: keep the heartbeat while work is live, and resume it. */
  readonly alarm: Effect.Effect<void, SessionError>;
  /** Whether no task is live and no submission is unsettled. Reads only: it never starts work. */
  readonly idle: Effect.Effect<boolean, SessionError>;
  /** The root conversation's ID; the root is created when absent. */
  readonly root: Effect.Effect<ConversationId, SessionError>;
  /**
   * Pick the root conversation's model and thinking level, from its next request on: a field left out stays as it is,
   * and `null` clears it, so the root follows the default in the settings again. The pick is kept across evictions.
   */
  readonly configure: (change: AgentChange) => Effect.Effect<void, SessionError>;
  /**
   * Read the settings now and bring the root's agent to the default in force, unless the Session picked its own, so
   * what a client is shown is what the next request runs on.
   */
  readonly sync: Effect.Effect<void, SessionError>;
  /** Which of its model and thinking level the Session picked itself; the rest follows the default. */
  readonly picks: Effect.Effect<Picks>;
  /** Abort the root conversation's work and withdraw its queued input, once it is idle. */
  readonly abort: Effect.Effect<void, SessionError>;
  /**
   * Conversation `conversationId`'s agent events, unchanged: a batch holding its `snapshot`, then a batch per commit.
   * Fails when the conversation cannot be watched, and when the Harness ends the watch.
   */
  readonly events: (
    conversationId: ConversationId,
  ) => Stream.Stream<ReadonlyArray<AgentEvent>, SessionError>;
};

/** What the Session DO answers with: its Harness, prompted and woken. */
export class SessionHost extends Context.Service<SessionHost, SessionHostService>()(
  "@cloudpid/server/session/host/SessionHost",
) {}

const attempt = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, SessionError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => SessionError.make({ operation, message: String(cause) }),
  });

const fromHarness = Effect.mapError((error: HarnessError) =>
  SessionError.make({ operation: error.operation, message: error.message }),
);

/** Why a watch of agent events ended. */
const watchEnded = (end: WatchEnd): string =>
  "error" in end
    ? `Watch ended (${end.reason}): ${String(end.error)}`
    : `Watch ended (${end.reason})`;

/** Which of the root conversation's model and thinking level the Session picked, rather than follows the default. */
export type Picks = { readonly model: boolean; readonly thinkingLevel: boolean };

/** The model and thinking level a Session picked itself, in its storage. */
type Pick = { readonly model?: ModelRef; readonly thinkingLevel?: ModelThinkingLevel };

const PICK_KEY = "agent-pick";

/** `pick` with `change` applied: a field left out stays, `null` clears it. */
const withChange = (pick: Pick, change: AgentChange): Pick => {
  const next: Types.Mutable<Pick> = {};
  const model = change.model === undefined ? pick.model : (change.model ?? undefined);

  const thinkingLevel =
    change.thinkingLevel === undefined ? pick.thinkingLevel : (change.thinkingLevel ?? undefined);

  if (model !== undefined) next.model = model;

  if (thinkingLevel !== undefined) next.thinkingLevel = thinkingLevel;

  return next;
};

/** Whether a conversation's resolved agent is already the `want`ed one. */
const sameAgent = (have: Agent, want: AgentChange): boolean =>
  have.model?.provider === want.model?.provider &&
  have.model?.modelId === want.model?.modelId &&
  have.thinkingLevel === want.thinkingLevel;

/** The alarm heartbeat's next time. */
const heartbeat = Clock.currentTimeMillis.pipe(Effect.map((now) => now + HEARTBEAT_MS));

/** Open the Harness on the object's `storage`, under the `pi_` prefix, after arming a fallback alarm. */
const openSessionHarness = Effect.fn("openSessionHarness")(function* <R>(
  options: SessionHostOptions<R>,
) {
  const { storage } = options;
  const settings = yield* SessionSettings;

  // A fallback before anything can fail: an object whose open or recovery fails is started again.
  const fallback = yield* heartbeat;
  const current = yield* attempt("getAlarm", () => storage.getAlarm());

  if (current === null || current > fallback) {
    yield* attempt("setAlarm", () => storage.setAlarm(fallback));
  }

  const piStorage = yield* attempt("openStorage", () =>
    openDurableObjectSqliteStorage(storage, { prefix: "pi_" }),
  );

  const harnessOptions = { models: options.models, settings: harnessSettings(settings) };

  const harness = yield* openHarness(
    piStorage,
    options.env === undefined ? harnessOptions : { ...harnessOptions, env: options.env },
  ).pipe(fromHarness);

  // A storage error closes the Harness for good; reset the object so the next event reopens it.
  yield* Effect.sync(
    () =>
      void harness.harness.closed.then((end) => {
        if (end.reason === "failed") options.reset(`Harness failed: ${String(end.error)}`);
      }),
  );

  return harness;
});

/** Install the Session's extensions in the open Harness and resume interrupted work. */
const startSessionHost = Effect.fn("startSessionHost")(function* <R>(
  options: SessionHostOptions<R>,
) {
  const { storage } = options;
  const harness = yield* Harness;
  const registry = yield* SessionRegistry;
  const settings = yield* SessionSettings;
  const scope = yield* Scope.Scope;
  const services = yield* Effect.context<R>();

  /** When the object must wake although no work is live. */
  const wakeAt =
    options.wakeAt === undefined
      ? Effect.undefined
      : Effect.provideContext(options.wakeAt, services);

  // Before anything resumes, so resumed tool calls find their tools.
  for (const extension of yield* options.extensions) yield* harness.install(extension);

  // Alarm decisions run one at a time, so an idle check never deletes the heartbeat a concurrent submit just armed.
  const serially = Semaphore.withPermit(yield* Semaphore.make(1));

  const { kv } = storage;

  /** What this Session picked: a field is absent while the Session follows the default. */
  const picked = (): Pick => {
    const kept = kv.get<Pick>(PICK_KEY) ?? {};

    // A model the settings no longer accept is ignored: the Session follows the default rather than fail every request.
    return kept.model === undefined || isModelId(formatModelId(kept.model))
      ? kept
      : withChange(kept, { model: null });
  };

  /** The agent the root conversation runs with: what the Session picked, then the default in the settings. */
  const wanted = (): AgentChange => {
    const { agent } = settings.current();
    const pick = picked();

    return {
      model: pick.model ?? agent.model,
      thinkingLevel: pick.thinkingLevel ?? agent.thinkingLevel,
    };
  };

  // The agent applies when the root is created: a new Session starts on the default in force.
  const root = Effect.suspend(() => harness.root(wanted())).pipe(fromHarness);

  /** Bring the root's agent to the one it wants, so its next request runs on it; nothing is written when it does. */
  const applyAgent = Effect.gen(function* () {
    const conversation = yield* root;
    const want = wanted();
    const have = yield* attempt("agent", () => conversation.agent(context));

    if (sameAgent(have, want)) return;

    yield* attempt("configure", () => conversation.configure(want, context));
  });

  const inspect = harness.inspect.pipe(fromHarness);

  /**
   * Live work keeps the heartbeat, as pi-durable main's `wake()` counts it: a task no installed definition can run
   * never becomes runnable by waking, and a waiting task counts through the live tasks it waits on.
   */
  const wake: Effect.Effect<Wake, SessionError> = inspect.pipe(
    Effect.map(({ tasks }) => ({
      active: Arr.some(
        tasks,
        (task) => task.state.kind !== "blocked" && task.state.kind !== "waiting",
      ),
    })),
  );

  const armHeartbeat = heartbeat.pipe(
    Effect.flatMap((at) => attempt("setAlarm", () => storage.setAlarm(at))),
  );

  /** What the Registry was last told, by this instance. Unknown at first, so a new instance tells it. */
  let reported: SessionStatus | undefined;

  /**
   * Tell the Registry `status` unless it was just told, and say whether it now has it. A report that fails or takes
   * too long counts as failed, so a slow Registry cannot stall prompts or the constructor.
   */
  const report = (status: SessionStatus): Effect.Effect<boolean> =>
    reported === status
      ? Effect.succeed(true)
      : registry.report(status).pipe(
          Effect.timeout(options.reportTimeout ?? REPORT_TIMEOUT),
          Effect.andThen(
            Effect.sync(() => {
              reported = status;

              return true;
            }),
          ),
          Effect.catchCause((cause) =>
            // The Registry may have applied it before failing, so what it holds is unknown again.
            Effect.logWarning("Registry status report failed", cause).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  reported = undefined;

                  return false;
                }),
              ),
            ),
          ),
        );

  /** The alarm once no work is live: deleted, unless the object must wake later anyway. */
  const rest = wakeAt.pipe(
    Effect.flatMap((at) =>
      at === undefined
        ? attempt("deleteAlarm", () => storage.deleteAlarm())
        : attempt("setAlarm", () => storage.setAlarm(at)),
    ),
  );

  const arm = (next: Wake) =>
    next.active
      ? // The heartbeat first: a report that cannot be made must not leave live work unwoken.
        armHeartbeat.pipe(Effect.andThen(report("running")), Effect.asVoid)
      : // Report before deleting the heartbeat: an unreported end keeps it, to report again.
        report("idle").pipe(Effect.flatMap((told) => (told ? rest : armHeartbeat)));

  /** Reconcile the alarm and the Registry with what is live now. */
  const settle = wake.pipe(Effect.flatMap(arm), serially);

  /** Whether a fiber is waiting for the Session to go idle. */
  let waiting = false;

  /**
   * Once the work now live is done, settle: nobody need be waiting on it for the Registry to hear it ended. One waiter
   * covers every submission, since it ends when the whole Session is idle; it belongs to the layer's scope.
   */
  const settleWhenIdle = Effect.suspend(() => {
    if (waiting) return Effect.void;

    waiting = true;

    return harness.waitForIdle.pipe(
      // Cleared before settling, so a submit that lands meanwhile starts the next waiter.
      Effect.ensuring(
        Effect.sync(() => {
          waiting = false;
        }),
      ),
      Effect.andThen(settle),
      Effect.ignore,
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  });

  // Armed before `resume()` runs anything, as for any call that can start work.
  const wakeAndResume = wake.pipe(
    Effect.flatMap(arm),
    Effect.andThen(harness.resume),
    Effect.andThen(settleWhenIdle),
    serially,
  );

  const admit = (prompt: Prompt): Effect.Effect<Submission, SessionError> =>
    // The next request runs on the settings in force now. The read stays out of the lock, so a slow Registry never holds
    // up the alarm or a status report.
    settings.refresh.pipe(
      Effect.andThen(
        // Arm before admitting work: an object that dies after the commit is still woken.
        arm({ active: true }).pipe(
          Effect.andThen(applyAgent),
          Effect.andThen(root),
          Effect.flatMap((conversation) =>
            attempt("submit", () => {
              const { input, ...options } = prompt;

              return conversation.submit({ type: "input", content: input, ...options }, context);
            }),
          ),
          serially,
        ),
      ),
      Effect.tap(settleWhenIdle),
    );

  const answer = Effect.fn("SessionHost.prompt")(function* (prompt: Prompt) {
    const submission = yield* admit(prompt);
    const settled = yield* attempt("wait", () => submission.wait(context));

    // The run is over: drop the heartbeat unless other work is live.
    yield* settle;

    if (settled.status !== "done" || settled.type !== "input") {
      return {
        status: "unanswered",
        submissionId: submission.id,
        reason: settled.reason ?? settled.status,
      } satisfies Answer;
    }

    const conversation = yield* root;

    const entry = yield* attempt("answer", () =>
      conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context),
    );

    const message = entry?.model?.[0];

    const text =
      message?.role === "assistant"
        ? Arr.join(
            Arr.flatMap(message.content, (block) => (block.type === "text" ? [block.text] : [])),
            "",
          )
        : "";

    return { status: "answered", submissionId: submission.id, text } satisfies Answer;
  });

  const events = (conversationId: ConversationId) =>
    Stream.callback<ReadonlyArray<AgentEvent>, SessionError>((queue) =>
      Effect.acquireRelease(
        attempt("watch", () =>
          // pi-durable fails the watch of a conversation it does not have.
          watchEvents(harness.harness, conversationId, context),
        ),
        (watch) => Effect.promise(() => watch.stop()),
      ).pipe(
        Effect.andThen((watch) =>
          Effect.sync(() => {
            Queue.offerUnsafe(queue, [watch.snapshot]);
            watch.start((batch) => {
              Queue.offerUnsafe(queue, batch);

              return Promise.resolve();
            });
            void watch.closed.then((end) =>
              Queue.failCauseUnsafe(
                queue,
                Cause.fail(SessionError.make({ operation: "watch", message: watchEnded(end) })),
              ),
            );
          }),
        ),
      ),
    );

  yield* wakeAndResume;

  return {
    submit: (prompt) => admit(prompt).pipe(Effect.map((submission) => submission.id)),
    prompt: answer,
    alarm: wakeAndResume,
    idle: inspect.pipe(
      Effect.map(({ tasks, submissions }) => tasks.length === 0 && submissions.length === 0),
    ),
    root: Effect.map(root, (conversation) => conversation.id),
    configure: (change) =>
      settings.refresh.pipe(
        Effect.andThen(
          Effect.sync(() => kv.put(PICK_KEY, withChange(picked(), change))).pipe(
            Effect.andThen(applyAgent),
            serially,
          ),
        ),
      ),
    sync: settings.refresh.pipe(Effect.andThen(applyAgent.pipe(serially))),
    picks: Effect.sync(() => {
      const pick = picked();

      return { model: pick.model !== undefined, thinkingLevel: pick.thinkingLevel !== undefined };
    }),
    abort: root.pipe(
      Effect.flatMap((conversation) => attempt("abort", () => conversation.abort(context))),
    ),
    events,
  } satisfies SessionHostService;
});

/**
 * The Session's services over the object's storage: its `Harness` and its `SessionHost`. Building it opens the
 * Harness and resumes interrupted work, so build it once, from the object's constructor inside
 * `blockConcurrencyWhile`.
 */
export const sessionHostLayer = <R = never>(
  options: SessionHostOptions<R>,
): Layer.Layer<SessionHost | Harness, SessionError, SessionRegistry | SessionSettings | R> =>
  Layer.effect(SessionHost, startSessionHost(options)).pipe(
    Layer.provideMerge(Layer.effect(Harness, openSessionHarness(options))),
  );
