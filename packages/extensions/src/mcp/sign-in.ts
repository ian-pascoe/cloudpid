// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off
// The Sign-in requests of a Session (`docs/architecture/mcp-sign-in.md` → Sign-in requests; ADR-0034): the agent asks the
// owner to sign in to an MCP server (`mcp_sign_in_ask`), the owner signs in from the card's link or declines, and the
// call that asked goes on with the answer. Modelled on the Approval requests (`../approvals.ts`):
//
// - **Durable.** An open request is in the Session's storage with the calls that wait on it, so an eviction loses nothing:
//   the call that asked reruns (`replay: "safe"`), finds its request again, and asks the Registry once more, which is the
//   re-check on resume ("signed in meanwhile?"). A sign-in completed while the Session was gone is carried to it by the
//   main Worker, which wakes it (`resolve`); the outcome is kept until the calls that waited take it.
// - **No deadline.** Only the owner's answer, a sign-in, the server leaving the set or Stop ends one. Stop interrupts the
//   waiting calls, and a request left with no call is withdrawn (its waiter row in the Registry goes too).
// - **Parallel asks join.** A request is one per (conversation, server): a second call that asks while one is open waits on
//   the same request, and one answer ends them all.
// - **The Registry holds the waiter row** (`mcp_sign_in_waiters`), one per request, and says which request is the first open
//   one of its key: that one sends the owner the one Notification. A decline ends only its own request.
// - **Never a URL, code or token** in a request: the card links to `/oauth/mcp/start`, which the main Worker serves.
import type { McpSignInKnownAskAnswer } from "@cloudpid/mcp/types";
import type { McpSignInRequest } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { Mutable } from "effect/Types";

/** The model-facing name of the tool. */
export const MCP_SIGN_IN_TOOL = "mcp_sign_in_ask";

/** The Durable Object's synchronous key-value storage, as the requests use it. */
export type McpSignInStorage = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
};

const REQUESTS_KEY = "mcp-sign-in:requests";
const SEQUENCE_KEY = "mcp-sign-in:sequence";

/** An answer could not be taken, or the Registry could not be asked. */
export class McpSignInsError extends Schema.TaggedError<
  McpSignInsError,
  { readonly brand: unique symbol }
>()("McpSignInsError", { message: Schema.String }) {}

/** A call's ask: who asks, which server, and why in the agent's words. */
export type McpSignInAsk = {
  /** The asking call: its task, which a rerun after an eviction keeps. */
  readonly callId: string;
  readonly conversationId: McpSignInRequest["conversationId"];
  readonly environment: string;
  /** The server's name as the set spells it. */
  readonly server: string;
  readonly reason: string;
};

/** How a request ended. `signed_in` is a sign-in that completed; the rest end with nothing signed in. */
export type McpSignInOutcome =
  | { readonly kind: "signed_in" }
  | { readonly kind: "declined"; readonly reason?: string }
  | { readonly kind: "withdrawn"; readonly reason: string }
  | { readonly kind: "not_applicable"; readonly reason: string }
  | { readonly kind: "step_up_failed"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/** The Registry as the requests use it: the Session's end of `mcpSignInAsk` and `mcpSignInWithdraw`. */
export type McpSignInsRegistry = {
  readonly ask: (input: {
    readonly environment: string;
    readonly server: string;
    readonly request: string;
  }) => Effect.Effect<McpSignInKnownAskAnswer, McpSignInsError>;
  readonly withdraw: (request: string) => Effect.Effect<void, McpSignInsError>;
};

export type McpSignInsOptions = {
  readonly storage: McpSignInStorage;
  readonly registry: McpSignInsRegistry;
  /** Tell the clients which requests wait; called whenever that changes. */
  readonly announce: (requests: ReadonlyArray<McpSignInRequest>) => Effect.Effect<void>;
  /**
   * Tell the owner (a push), in the background, for the first open request of a sign-in's key: "Sign-in needed: <server> —
   * <reason>", tagged by the key. It must not fail.
   */
  readonly notify?:
    | ((who: {
        readonly server: string;
        readonly reason: string;
        readonly key: string;
      }) => Effect.Effect<void>)
    | undefined;
  /** `value` with every Secret the Session holds replaced by its reference: all the owner is shown. */
  readonly redact: <A>(value: A) => Effect.Effect<A>;
};

export type McpSignInsService = {
  /**
   * Ask the owner to sign in to `ask.server` and wait for how it ends. Immediate when the sign-in stands already or does
   * not apply. Asking again with a call the request already holds (a rerun) rejoins it and asks the Registry once more.
   * Interrupting the wait (Stop) leaves the request, and withdraws it when no call is left on it. Never fails.
   */
  readonly ask: (ask: McpSignInAsk) => Effect.Effect<McpSignInOutcome>;
  /** The requests waiting for the owner, oldest first. */
  readonly pending: Effect.Effect<ReadonlyArray<McpSignInRequest>>;
  /** The owner's decline of request `id`. Fails when no such request waits. */
  readonly decline: (
    id: string,
    reason: string | undefined,
  ) => Effect.Effect<void, McpSignInsError>;
  /** A sign-in was completed (the main Worker carries it here): end each of these requests that is open as `signed_in`. */
  readonly resolve: (requests: ReadonlyArray<string>) => Effect.Effect<number>;
  /**
   * A completed sign-in attempt failed (the main Worker carries it here): show `problem`, the Registry's own words for what
   * went wrong, on each of these requests that is open, which stay open. Returns how many it changed.
   */
  readonly failed: (requests: ReadonlyArray<string>, problem: string) => Effect.Effect<number>;
  /** Server `server` was removed, switched off or hidden: end every request for it as `withdrawn`. */
  readonly withdrawServer: (server: string, reason: string) => Effect.Effect<void>;
  /**
   * Ask the Registry again about every open request, ending those whose sign-in stands now: the catch-up for a completion
   * that was not carried (an older deploy, a host's `working` report). A Registry that cannot be reached leaves them open.
   */
  readonly recheck: Effect.Effect<void>;
  /** Withdraw every request no call in this instance waits for. Run only while no work is live. */
  readonly dropAbandoned: Effect.Effect<void>;
};

/** The Session's Sign-in requests. */
export class McpSignIns extends Context.Service<McpSignIns, McpSignInsService>()(
  "@cloudpid/extensions/mcp/sign-in/McpSignIns",
) {}

/** A request as storage keeps it: the card, the calls that wait on it, and how it ended once it has. */
type Held = {
  readonly request: McpSignInRequest;
  readonly calls: ReadonlyArray<string>;
  readonly outcome?: McpSignInOutcome;
};

/** What an answer from the Registry that keeps no waiter ends a request as. */
const immediate = (answer: McpSignInKnownAskAnswer): McpSignInOutcome | undefined => {
  switch (answer.status) {
    case "signed_in":
      return { kind: "signed_in" };
    case "not_applicable":
      return { kind: "not_applicable", reason: answer.reason };
    case "step_up_failed":
      return { kind: "step_up_failed", reason: answer.reason };
    case "unavailable":
      return { kind: "unavailable", reason: answer.reason };
    case "full":
      return { kind: "unavailable", reason: answer.message };
    case "open":
      return undefined;
  }
};

/** The Session's Sign-in requests over its storage. Synchronous: the tool that asks is built before the runtime. */
export const createMcpSignIns = (options: McpSignInsOptions): McpSignInsService => {
  const { storage, registry, announce } = options;
  /** The calls waiting in this instance, by request. */
  const waiters = new Map<string, Deferred.Deferred<McpSignInOutcome>>();
  const lock = Semaphore.makeUnsafe(1);

  const held = (): ReadonlyArray<Held> => storage.get<Held[]>(REQUESTS_KEY) ?? [];

  const keep = (next: ReadonlyArray<Held>) => {
    if (next.length === 0) storage.delete(REQUESTS_KEY);
    else storage.put(REQUESTS_KEY, next);
  };

  const open = (): ReadonlyArray<Held> => Arr.filter(held(), (each) => each.outcome === undefined);

  const tell = Effect.suspend(() => announce(Arr.map(open(), (each) => each.request)));

  const find = (id: string) =>
    Option.getOrUndefined(Arr.findFirst(held(), (each) => each.request.id === id));

  /** End the open request `id` as `outcome`; false when it is not open. */
  const finish = (id: string, ended: McpSignInOutcome) =>
    Effect.gen(function* () {
      const target = Option.getOrUndefined(Arr.findFirst(open(), (each) => each.request.id === id));

      if (target === undefined) return false;

      const outcome = ended;

      // A request with no call left has nobody to tell: it ends here.
      keep(
        target.calls.length === 0
          ? Arr.filter(held(), (each) => each !== target && each.request.id !== id)
          : Arr.map(held(), (each) => (each.request.id === id ? { ...each, outcome } : each)),
      );

      yield* tell;

      const waiter = waiters.get(id);

      if (waiter !== undefined) yield* Deferred.succeed(waiter, outcome);

      return true;
    });

  /**
   * Show `problem` (none clears it) on each of the open requests `ids`, telling the clients when one changed. With
   * `only: "unshown"`, a request that shows a problem already keeps it: the Registry's `lastError` carries no time, so it is not
   * known to be newer than what a failed attempt carried here.
   */
  const showProblem = (
    ids: ReadonlyArray<string>,
    problem: string | undefined,
    only: "all" | "unshown" = "all",
  ) =>
    Effect.gen(function* () {
      const shown =
        problem === undefined ? undefined : (yield* options.redact({ problem })).problem;

      let changed = 0;

      keep(
        Arr.map(held(), (each) => {
          if (!Arr.contains(ids, each.request.id) || each.outcome !== undefined) return each;

          if (each.request.problem === shown) return each;

          if (only === "unshown" && each.request.problem !== undefined) return each;

          changed += 1;

          const { problem: _before, ...rest } = each.request;

          return { ...each, request: shown === undefined ? rest : { ...rest, problem: shown } };
        }),
      );

      if (changed > 0) yield* tell;

      return changed;
    });

  /** Ask the Registry about request `id` again, ending it when the sign-in stands or does not apply now. */
  const recheckOne = (each: Held) =>
    registry
      .ask({
        environment: each.request.environment,
        server: each.request.server,
        request: each.request.id,
      })
      .pipe(
        Effect.flatMap((answer) => {
          const ended = immediate(answer);

          if (ended !== undefined) return Effect.asVoid(finish(each.request.id, ended));

          // Still open: the Registry's word on the sign-in (its last failure, when it has one) fills a card that shows none.
          return answer.status === "open" && answer.problem !== undefined
            ? Effect.asVoid(showProblem([each.request.id], answer.problem, "unshown"))
            : Effect.void;
        }),
        Effect.catch((error) =>
          Effect.logWarning(`A Sign-in request could not be checked again: ${error.message}`),
        ),
      );

  /** Drop request `id`'s waiter at the Registry, logging a failure: the request is over either way. */
  const dropWaiter = (id: string) =>
    registry
      .withdraw(id)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(`A Sign-in request's waiter could not be dropped: ${error.message}`),
        ),
      );

  /** The call `callId` is done with request `id`: take it off, and withdraw the request if it was left with no call. */
  const leave = (callId: string, id: string) =>
    Effect.gen(function* () {
      const found = find(id);

      if (found === undefined) return;

      const calls = Arr.filter(found.calls, (call) => call !== callId);
      const ended = found.outcome !== undefined;

      if (calls.length > 0) {
        keep(Arr.map(held(), (each) => (each.request.id === id ? { ...each, calls } : each)));

        return;
      }

      waiters.delete(id);
      keep(Arr.filter(held(), (each) => each.request.id !== id));

      if (ended) return;

      // Stop, or an abandoned call: the request goes, and the Registry's waiter with it.
      yield* tell;
      yield* dropWaiter(id);
    });

  const nextId = () => {
    const next = (storage.get<number>(SEQUENCE_KEY) ?? 0) + 1;

    storage.put(SEQUENCE_KEY, next);

    return `signin-${String(next)}`;
  };

  /** The request `ask` waits on: found, joined or made; or how the ask ended with none. */
  const prepare = (ask: McpSignInAsk) =>
    lock.withPermit(
      Effect.gen(function* () {
        const target =
          Option.getOrUndefined(
            Arr.findFirst(held(), (each) => Arr.contains(each.calls, ask.callId)),
          ) ??
          Option.getOrUndefined(
            Arr.findFirst(
              open(),
              (each) =>
                each.request.conversationId === ask.conversationId &&
                each.request.server === ask.server,
            ),
          );

        if (target !== undefined) {
          if (!Arr.contains(target.calls, ask.callId)) {
            keep(
              Arr.map(held(), (each) =>
                each === target ? { ...each, calls: [...each.calls, ask.callId] } : each,
              ),
            );
          }

          // A rerun, or a call joining one: the sign-in may stand by now.
          if (target.outcome === undefined) yield* recheckOne(target);

          return { id: target.request.id } as const;
        }

        const id = nextId();

        const asked = yield* registry
          .ask({ environment: ask.environment, server: ask.server, request: id })
          .pipe(Effect.exit);

        if (Exit.isFailure(asked)) {
          return {
            ended: {
              kind: "unavailable",
              reason: "cloudpid could not reach its store to ask for the sign-in",
            },
          } as const;
        }

        const answer = asked.value;
        const ended = immediate(answer);

        if (ended !== undefined || answer.status !== "open") {
          return {
            ended: ended ?? { kind: "unavailable", reason: "The sign-in could not be asked for" },
          } as const;
        }

        const now = yield* Clock.currentTimeMillis;
        const shown = yield* options.redact({ reason: ask.reason, problem: answer.problem });

        const request: Mutable<McpSignInRequest> = {
          id,
          conversationId: ask.conversationId,
          server: ask.server,
          environment: ask.environment,
          source: answer.source,
          urlHost: answer.urlHost,
          reason: shown.reason,
          why: answer.why,
          scopes: answer.scopes,
          askedAt: now,
        };

        if (answer.issuerHost !== undefined) request.issuerHost = answer.issuerHost;

        if (shown.problem !== undefined) request.problem = shown.problem;

        keep([...held(), { request, calls: [ask.callId] }]);
        yield* tell;

        // In the background: the push may take seconds, and the request must not wait on it.
        if (answer.first && options.notify !== undefined) {
          yield* Effect.forkDetach(
            options.notify({ server: ask.server, reason: shown.reason, key: answer.key }),
          );
        }

        return { id } as const;
      }),
    );

  const wait = (callId: string, id: string) =>
    Effect.gen(function* () {
      const current = find(id);

      if (current === undefined) {
        return { kind: "withdrawn", reason: "the request ended" } satisfies McpSignInOutcome;
      }

      if (current.outcome !== undefined) return current.outcome;

      const waiter = waiters.get(id) ?? (yield* Deferred.make<McpSignInOutcome>());

      waiters.set(id, waiter);

      return yield* Deferred.await(waiter);
    }).pipe(Effect.ensuring(leave(callId, id)));

  const ask: McpSignInsService["ask"] = (call) =>
    prepare(call).pipe(
      Effect.flatMap((prepared) =>
        "ended" in prepared ? Effect.succeed(prepared.ended) : wait(call.callId, prepared.id),
      ),
    );

  return {
    ask,
    pending: Effect.sync(() => Arr.map(open(), (each) => each.request)),
    decline: (id, reason) =>
      Effect.gen(function* () {
        const trimmed = reason?.trim();

        const outcome: Mutable<Extract<McpSignInOutcome, { kind: "declined" }>> = {
          kind: "declined",
        };

        if (trimmed !== undefined && trimmed !== "") outcome.reason = trimmed;

        const taken = yield* finish(id, outcome);

        if (!taken) return yield* McpSignInsError.make({ message: "This request ended" });

        yield* dropWaiter(id);
      }),
    resolve: (requests) =>
      Effect.gen(function* () {
        let ended = 0;

        for (const id of requests) {
          if (yield* finish(id, { kind: "signed_in" })) ended += 1;
        }

        return ended;
      }),
    failed: (requests, problem) => showProblem(requests, problem),
    withdrawServer: (server, reason) =>
      Effect.gen(function* () {
        for (const each of open()) {
          if (each.request.server !== server) continue;

          if (yield* finish(each.request.id, { kind: "withdrawn", reason })) {
            yield* dropWaiter(each.request.id);
          }
        }
      }),
    recheck: Effect.suspend(() => Effect.forEach(open(), recheckOne, { discard: true })),
    dropAbandoned: Effect.gen(function* () {
      for (const each of held()) {
        if (waiters.has(each.request.id)) continue;

        keep(Arr.filter(held(), (other) => other.request.id !== each.request.id));

        if (each.outcome === undefined) {
          yield* dropWaiter(each.request.id);
        }
      }

      yield* tell;
    }),
  } satisfies McpSignInsService;
};
