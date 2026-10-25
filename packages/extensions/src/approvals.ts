// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off
// Approval (GLOSSARY.md → Approval, `docs/spec.md` → Approval, ADR-0019): an Agent change that waits for the owner's
// yes. A tool that needs one makes a durable request (the change, its target, the values before and after, the agent's
// reason), which the Session sends to every client and the owner answers on a card, Approve or Decline. Modelled on
// `secret_ask`'s requests (`./secrets/store.ts`):
//
// - The request and its answer are kept in the Session DO's storage, so a call an eviction cut off finds the request
//   still waiting when it reruns, or the answer the owner gave meanwhile. The request keeps what the owner saw: a rerun
//   that reads other values waits for the same request, and applies only what was shown (`expected`).
// - The wait has no deadline of its own. Cancelling it (Stop) withdraws the request, and a request whose call is gone
//   is withdrawn once the Session is idle (`dropAbandoned`).
//
// `withApproval` is the way a tool waits: one request per call (its task's id), settled when the call ends however it
// ends. It is shared by the tools that change a Limit or delete, and meant for the Guardian (#38) too.
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/** The Durable Object's synchronous key-value storage, as the requests use it. */
export type ApprovalStorage = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
};

/** A request for the owner's Approval of one change, waiting for an answer from a client. */
export const ApprovalAsk = Schema.Struct({
  /** Unique within the Session: the asking call's task. */
  id: Schema.String,
  /** The conversation whose call asks. */
  conversationId: Schema.Finite,
  /** The tool that makes the change. */
  tool: Schema.String,
  /** What it changes: an Environment, by name, or the Settings. */
  target: Schema.String,
  /** The change, in a few words. */
  change: Schema.String,
  /** The value before as the owner reads it; for a delete, what is deleted. */
  before: Schema.String,
  /** The value after as the owner reads it. */
  after: Schema.String,
  /** Why the agent makes it. */
  reason: Schema.String,
  /**
   * What the target was when the owner was asked, for the call to check once approved: the change is applied only
   * while the target still has it, so the value applied is the one the owner saw. Never sent to a client.
   */
  expected: Schema.NullOr(Schema.Json),
});

export type ApprovalAsk = typeof ApprovalAsk.Type;

/** The owner's answer, with what the target was when the owner was asked. */
export type ApprovalAnswer =
  | { readonly approved: true; readonly expected: Schema.Json | null }
  | {
      readonly approved: false;
      /** The owner's reason, if they gave one. */
      readonly reason?: string | undefined;
      readonly expected: Schema.Json | null;
    };

/** An answer could not be taken, or a request was lost. */
export class ApprovalsError extends Schema.TaggedError<
  ApprovalsError,
  { readonly brand: unique symbol }
>()("ApprovalsError", { message: Schema.String }) {}

export type ApprovalsService = {
  /**
   * Ask the owner to approve `request`, and wait for the answer. Asking again with the same `id` waits for the request
   * already made (the one the owner sees), or returns the answer given while no call waited. Cancelling the wait
   * withdraws the request. The answer is kept until `settle`, so a call cut off after it rerun finds it.
   */
  readonly ask: (request: ApprovalAsk) => Effect.Effect<ApprovalAnswer, ApprovalsError>;
  /** The call that asked `id` is done: withdraw its request if it still waits, and forget its answer. */
  readonly settle: (id: string) => Effect.Effect<void>;
  /** The requests waiting for the owner, oldest first. */
  readonly pending: Effect.Effect<ReadonlyArray<ApprovalAsk>>;
  /**
   * The owner's answer to request `id`. Fails when no such request waits: it was answered, or its call ended.
   */
  readonly answer: (
    id: string,
    answer: { readonly approve: boolean; readonly reason?: string | undefined },
  ) => Effect.Effect<void, ApprovalsError>;
  /**
   * Withdraw every request no call in this instance waits for, and drop the answers no call took. Run only while no
   * work is live: then no call can still come back for them, so they were abandoned.
   */
  readonly dropAbandoned: Effect.Effect<void>;
};

/** The Session's Approval requests (`docs/spec.md` → Approval). */
export class Approvals extends Context.Service<Approvals, ApprovalsService>()(
  "@cloudpid/extensions/approvals",
) {}

const REQUESTS_KEY = "approval-requests";
const ANSWERS_KEY = "approval-answers";

type StoredAnswer = {
  readonly approved: boolean;
  readonly reason?: string;
  readonly expected: Schema.Json | null;
};

type Answers = Readonly<Record<string, StoredAnswer>>;

export type ApprovalsOptions = {
  readonly storage: ApprovalStorage;
  /** Tell the clients which requests wait; called whenever that changes. */
  readonly announce: (requests: ReadonlyArray<ApprovalAsk>) => Effect.Effect<void>;
  /**
   * Called once for each new request, after `announce`: not for one a rerun finds already waiting. It runs in the
   * background, so the request neither waits for it nor is held up by it; it must not fail.
   */
  readonly asked?: ((request: ApprovalAsk) => Effect.Effect<void>) | undefined;
};

/** The Session's Approval requests over its storage. */
export const makeApprovals = ({
  storage,
  announce,
  asked,
}: ApprovalsOptions): Effect.Effect<ApprovalsService> =>
  Effect.sync(() => {
    /** Calls waiting for an answer, by request. */
    const waiters = new Map<string, Deferred.Deferred<void>>();

    const requests = (): ReadonlyArray<ApprovalAsk> =>
      storage.get<ApprovalAsk[]>(REQUESTS_KEY) ?? [];

    const answers = (): Answers => storage.get<Answers>(ANSWERS_KEY) ?? {};

    const putRequests = (next: ReadonlyArray<ApprovalAsk>) =>
      Effect.suspend(() => {
        storage.put(REQUESTS_KEY, next);

        return announce(next);
      });

    const withdraw = (id: string) =>
      Effect.suspend(() => {
        const remaining = requests().filter((request) => request.id !== id);

        return remaining.length === requests().length ? Effect.void : putRequests(remaining);
      });

    const answerOf = (id: string): ApprovalAnswer | undefined => {
      const stored = answers()[id];

      if (stored === undefined) return undefined;

      return stored.approved
        ? { approved: true, expected: stored.expected }
        : { approved: false, reason: stored.reason, expected: stored.expected };
    };

    const ask = (request: ApprovalAsk) =>
      Effect.gen(function* () {
        const ready = answerOf(request.id);

        if (ready !== undefined) return ready;

        const waiter = waiters.get(request.id) ?? (yield* Deferred.make<void>());

        waiters.set(request.id, waiter);

        // A rerun waits for the request the owner sees, not one made of what it read again.
        if (!requests().some((pending) => pending.id === request.id)) {
          yield* putRequests([...requests(), request]);

          // In the background: the owner's notification may take seconds, and the request must not wait on it.
          if (asked !== undefined) yield* Effect.forkDetach(asked(request));
        }

        yield* Deferred.await(waiter).pipe(
          Effect.onInterrupt(() =>
            Effect.suspend(() => {
              waiters.delete(request.id);

              return withdraw(request.id);
            }),
          ),
        );
        waiters.delete(request.id);

        const answered = answerOf(request.id);

        if (answered === undefined) {
          return yield* ApprovalsError.make({
            message: `Approval request ${request.id} was lost`,
          });
        }

        return answered;
      });

    const settle = (id: string) =>
      Effect.suspend(() => {
        waiters.delete(id);

        const all = answers();

        if (all[id] !== undefined) {
          storage.put(
            ANSWERS_KEY,
            Object.fromEntries(Object.entries(all).filter(([key]) => key !== id)),
          );
        }

        return withdraw(id);
      });

    const answer = (
      id: string,
      given: { readonly approve: boolean; readonly reason?: string | undefined },
    ) =>
      Effect.gen(function* () {
        const request = requests().find((pending) => pending.id === id);

        if (request === undefined) {
          return yield* ApprovalsError.make({
            message: `No Approval request ${id} is waiting: it was answered, or its call ended`,
          });
        }

        const reason = given.reason?.trim();

        const stored: StoredAnswer =
          given.approve || reason === undefined || reason === ""
            ? { approved: given.approve, expected: request.expected }
            : { approved: false, reason, expected: request.expected };

        storage.put(ANSWERS_KEY, { ...answers(), [id]: stored });
        yield* putRequests(requests().filter((pending) => pending.id !== id));

        const waiter = waiters.get(id);

        if (waiter !== undefined) yield* Deferred.succeed(waiter, undefined);
      });

    return {
      ask,
      settle,
      pending: Effect.sync(requests),
      answer,
      dropAbandoned: Effect.suspend(() => {
        if (Object.keys(answers()).length > 0) storage.put(ANSWERS_KEY, {});

        const waited = requests().filter((pending) => waiters.has(pending.id));

        return waited.length === requests().length ? Effect.void : putRequests(waited);
      }),
    } satisfies ApprovalsService;
  });

/** The Session's `Approvals` over its storage. */
export const approvalsLayer = (options: ApprovalsOptions): Layer.Layer<Approvals> =>
  Layer.effect(Approvals, makeApprovals(options));

/** The call that asks, as its tool's `ToolExecutionApi` gives it: its task and its conversation. */
export type ApprovalCall = { readonly taskId: number; readonly conversationId: number };

/** What a change shown on an Approval card is: everything but who asks, which the call says. */
export type ApprovalChange = Omit<ApprovalAsk, "id" | "conversationId">;

/**
 * Ask the owner to approve `change` for the call `api` runs, wait for the answer, and hand it to `then`; the request is
 * settled (withdrawn if it still waits, its answer forgotten) when the call ends, however it ends. The request is the
 * call's task's own, so a rerun after an eviction waits for the same one, or takes the answer given meanwhile: give the
 * tool `replay: "safe"`. `then` gets what the target was when the owner was asked, which the change must still find.
 */
export const withApproval = <A, E, R>(
  approvals: ApprovalsService,
  api: ApprovalCall,
  change: ApprovalChange,
  then: (answer: ApprovalAnswer) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ApprovalsError, R> => {
  const id = String(api.taskId);

  return approvals
    .ask({ ...change, id, conversationId: api.conversationId })
    .pipe(Effect.flatMap(then), Effect.ensuring(approvals.settle(id)));
};
