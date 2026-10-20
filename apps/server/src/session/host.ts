// Hosts one pi-durable Harness in a Session Durable Object, the way pi-durable's own `test-workers/worker.ts` does:
// opened over the object's SQLite storage and woken by its alarm (ADR-0002). The Harness stays native Promise code,
// reached through the `Harness` facade and `Effect.tryPromise` (ADR-0003). The object builds both services once, as
// one Layer kept in a `ManagedRuntime`.
import { Harness, type HarnessError, openHarness } from "@cloudpid/effect-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  AssistantEntry,
  type Extension,
  type Submission,
} from "@earendil-works/pi-durable";
import {
  type DurableObjectSqliteStorage,
  openDurableObjectSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { SessionRegistry, type SessionStatus } from "./status.ts";

const context = BACKGROUND_CONTEXT;

/** How often the alarm wakes the object while work is live, so a run an eviction cut off resumes. */
export const HEARTBEAT_MS = 60_000;

/** How long a report to the Registry may take before it counts as failed. */
export const REPORT_TIMEOUT: Duration.Input = "5 seconds";

/**
 * Keep no idle conversation contexts or documents in memory. pi-durable 1.3.0 holds them on `setTimeout` timers,
 * and in Workers a pending timer, even an unreferenced one, keeps the object from being evicted or hibernating. SQLite
 * is local to the object, so reloading them is cheap. pi-durable main declines these timers in Workers itself.
 */
const RETENTION = { contextRetentionMs: 0, documentRetentionMs: 0 } as const;

/**
 * What the alarm is armed for. pi-durable 1.3.0 has no `Harness.wake()`, so the host derives `active` from the live
 * tasks. Once `onWake` ships this becomes pi-durable's `Wake` (`{ active, at? }`): `wake` returns `harness.wake()`,
 * `HarnessOptions.onWake` runs `arm`, and `arm` also arms for the earliest sleep `at`.
 */
type Wake = { readonly active: boolean };

/**
 * The parts of a Durable Object's `ctx.storage` the host uses: its SQLite database and its alarm. Narrow on purpose,
 * so `@cloudflare/workers-types`' module and global declarations of the storage both fit it cheaply.
 */
export type SessionStorage = DurableObjectSqliteStorage & {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

export type SessionHostOptions = {
  /** The object's `ctx.storage`. */
  readonly storage: SessionStorage;
  readonly models: Models;
  /** The root conversation's agent, applied when the root is created. */
  readonly agent: AgentChange;
  /**
   * Reset the object (`ctx.abort`). Called when a storage error closes the Harness: the next event starts a new
   * instance, which reopens it.
   */
  readonly reset: (reason: string) => void;
  /** The extensions the Session's conversations run with, installed before any work resumes. */
  readonly extensions: Effect.Effect<readonly Extension[], never, Harness>;
  /** How long a report to the Registry may take before it counts as failed. Defaults to `REPORT_TIMEOUT`. */
  readonly reportTimeout?: Duration.Input;
};

/** User input for the root conversation. Submitting the same `requestId` again finds the first submission. */
export type Prompt = { readonly requestId: string; readonly text: string };

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

/** The alarm heartbeat's next time. */
const heartbeat = Clock.currentTimeMillis.pipe(Effect.map((now) => now + HEARTBEAT_MS));

/** Open the Harness on the object's `storage`, under the `pi_` prefix, after arming a fallback alarm. */
const openSessionHarness = Effect.fn("openSessionHarness")(function* (options: SessionHostOptions) {
  const { storage } = options;

  // A fallback before anything can fail: an object whose open or recovery fails is started again.
  const fallback = yield* heartbeat;
  const current = yield* attempt("getAlarm", () => storage.getAlarm());

  if (current === null || current > fallback) {
    yield* attempt("setAlarm", () => storage.setAlarm(fallback));
  }

  const piStorage = yield* attempt("openStorage", () =>
    openDurableObjectSqliteStorage(storage, { prefix: "pi_" }),
  );

  const harness = yield* openHarness(piStorage, {
    models: options.models,
    settings: RETENTION,
  }).pipe(fromHarness);

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
const startSessionHost = Effect.fn("startSessionHost")(function* (options: SessionHostOptions) {
  const { storage } = options;
  const harness = yield* Harness;
  const registry = yield* SessionRegistry;
  const scope = yield* Scope.Scope;

  // Before anything resumes, so resumed tool calls find their tools.
  for (const extension of yield* options.extensions) yield* harness.install(extension);

  // Alarm decisions run one at a time, so an idle check never deletes the heartbeat a concurrent submit just armed.
  const serially = Semaphore.withPermit(yield* Semaphore.make(1));

  const root = harness.root(options.agent).pipe(fromHarness);
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

  const arm = (next: Wake) =>
    next.active
      ? // The heartbeat first: a report that cannot be made must not leave live work unwoken.
        armHeartbeat.pipe(Effect.andThen(report("running")), Effect.asVoid)
      : // Report before deleting the heartbeat: an unreported end keeps it, to report again.
        report("idle").pipe(
          Effect.flatMap((told) =>
            told ? attempt("deleteAlarm", () => storage.deleteAlarm()) : armHeartbeat,
          ),
        );

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
    // Arm before admitting work: an object that dies after the commit is still woken.
    arm({ active: true }).pipe(
      Effect.andThen(root),
      Effect.flatMap((conversation) =>
        attempt("submit", () =>
          conversation.submit(
            { type: "input", content: prompt.text, requestId: prompt.requestId },
            context,
          ),
        ),
      ),
      serially,
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

  yield* wakeAndResume;

  return {
    submit: (prompt) => admit(prompt).pipe(Effect.map((submission) => submission.id)),
    prompt: answer,
    alarm: wakeAndResume,
    idle: inspect.pipe(
      Effect.map(({ tasks, submissions }) => tasks.length === 0 && submissions.length === 0),
    ),
  } satisfies SessionHostService;
});

/**
 * The Session's services over the object's storage: its `Harness` and its `SessionHost`. Building it opens the
 * Harness and resumes interrupted work, so build it once, from the object's constructor inside
 * `blockConcurrencyWhile`.
 */
export const sessionHostLayer = (
  options: SessionHostOptions,
): Layer.Layer<SessionHost | Harness, SessionError, SessionRegistry> =>
  Layer.effect(SessionHost, startSessionHost(options)).pipe(
    Layer.provideMerge(Layer.effect(Harness, openSessionHarness(options))),
  );
