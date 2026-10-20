// Hosts one pi-durable Harness in a Session Durable Object, the way pi-durable's own `test-workers/worker.ts` does:
// opened over the object's SQLite storage and woken by its alarm (ADR-0002). The Harness stays native Promise code,
// reached through `Effect.tryPromise` (ADR-0003).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  AssistantEntry,
  type Conversation,
  createRegistry,
  Harness,
  type Submission,
} from "@earendil-works/pi-durable";
import {
  type DurableObjectSqliteStorage,
  openDurableObjectSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const context = BACKGROUND_CONTEXT;

/** How often the alarm wakes the object while work is live, so a run an eviction cut off resumes. */
export const HEARTBEAT_MS = 60_000;

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
  readonly models: Models;
  /** The root conversation's agent, applied when the root is created. */
  readonly agent: AgentChange;
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

export type SessionHost = {
  /** Durably admit `prompt` to the root conversation and return its submission ID. */
  readonly submit: (prompt: Prompt) => Effect.Effect<number, SessionError>;
  /** Submit `prompt` and wait for its answer. */
  readonly prompt: (prompt: Prompt) => Effect.Effect<Answer, SessionError>;
  /** The alarm handler: keep the heartbeat while work is live, and resume it. */
  readonly alarm: Effect.Effect<void, SessionError>;
};

const attempt = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, SessionError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => SessionError.make({ operation, message: String(cause) }),
  });

/**
 * Open the Harness on the object's `storage`, under the `pi_` prefix, and resume interrupted work. Run it from the
 * object's constructor, inside `blockConcurrencyWhile`.
 */
export const openSessionHost = Effect.fn("openSessionHost")(function* (
  storage: SessionStorage,
  options: SessionHostOptions,
) {
  const heartbeat = Clock.currentTimeMillis.pipe(Effect.map((now) => now + HEARTBEAT_MS));

  // A fallback before anything can fail: an object whose open or recovery fails is started again.
  const fallback = yield* heartbeat;
  const current = yield* attempt("getAlarm", () => storage.getAlarm());

  if (current === null || current > fallback) {
    yield* attempt("setAlarm", () => storage.setAlarm(fallback));
  }

  const piStorage = yield* attempt("openStorage", () =>
    openDurableObjectSqliteStorage(storage, { prefix: "pi_" }),
  );

  const harness = yield* attempt("open", () =>
    Harness.open(
      piStorage,
      { models: options.models, registry: createRegistry(), settings: RETENTION },
      context,
    ),
  );

  // Alarm decisions run one at a time, so an idle check never deletes the heartbeat a concurrent submit just armed.
  const serially = Semaphore.withPermit(yield* Semaphore.make(1));

  const root = attempt("root", (): Promise<Conversation> =>
    harness.root(context, { agent: options.agent }),
  );

  /** Live work keeps the heartbeat; a task no installed definition can run never becomes runnable by waking. */
  const wake: Effect.Effect<Wake, SessionError> = attempt("inspect", () =>
    harness.inspect(context),
  ).pipe(
    Effect.map(({ tasks }) => ({
      active: Arr.some(tasks, (task) => task.state.kind !== "blocked"),
    })),
  );

  const arm = (next: Wake) =>
    next.active
      ? heartbeat.pipe(Effect.flatMap((at) => attempt("setAlarm", () => storage.setAlarm(at))))
      : attempt("deleteAlarm", () => storage.deleteAlarm());

  // Armed before `resume()` runs anything, as for any call that can start work.
  const wakeAndResume = wake.pipe(
    Effect.flatMap(arm),
    Effect.andThen(Effect.sync(() => harness.resume())),
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
    );

  const answer = Effect.fn("SessionHost.prompt")(function* (prompt: Prompt) {
    const submission = yield* admit(prompt);
    const settled = yield* attempt("wait", () => submission.wait(context));

    // The run is over: drop the heartbeat unless other work is live.
    yield* wake.pipe(Effect.flatMap(arm), serially);

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
  } satisfies SessionHost;
});
