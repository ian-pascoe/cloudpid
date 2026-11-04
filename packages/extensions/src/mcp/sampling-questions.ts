// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- the Session's service, over plain values.
// The Sampling requests an MCP server asks the owner to allow (`docs/architecture/mcp-server-requests.md` → Sampling
// requests, The card, The waiting-question record): a Legacy server's request on an agent's call waits here, in memory, for
// the owner's answer from any client, the first answer winning and a late one refused (ADR-0037). It is the Sampling half of
// `McpQuestions` (`questions.ts`), beside the elicitation forms, and shares their notification: the owner is told of a
// call's first waiting question, of whichever kind.
//
// - **The decision is the owner's, and nothing else.** What waits here is a request already checked (its parameters, its
//   messages, the Spend limit, a model to answer it): the sampler (`sampling.ts`) asks only about a request it could run.
//   What comes back is allow, with the Role to run it on and the grant it was given by, or a refusal.
// - **Grants.** *Allow for this call* is kept in memory until the call ends (a Legacy call does not outlive its instance).
//   *Allow in this Session* and *Refuse in this Session* are kept in the Session's storage (`mcp-sampling:grants`), the
//   server's, for every conversation of the Session, until the owner takes one back. *Always allow* and *Never* write the
//   server's definition (`remember`). *Never* also refuses the rest of the call, without asking.
// - **The first answer wins.** An answer claims its request before it does anything else, so a second answer, the owner's
//   or the clock's, finds it taken. One rule for a choice that cannot be kept (a write of the definition that fails or takes
//   too long, a grant the storage refuses): the claim is released and the answer fails with why, so the card says it and the
//   owner picks another; nothing is settled.
// - **The record.** The request's card is made of its record (`sampling-records.ts`), which the sampler wrote as `waiting`
//   before it asked. `mcp-sampling:waiting` lists what waits, so a new instance, which finds nothing to answer them, can
//   settle those records as refused.
import type { RoleName } from "@cloudpid/config";
import type {
  McpElicitationSource,
  McpSamplingChoice,
  McpSamplingRequest,
  McpSamplingSessionGrant,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Mutable } from "effect/Types";
import type { McpSamplingWhy } from "./details.ts";
import {
  MCP_CALL_ENDED_REASON,
  MCP_QUESTION_UNRECORDED_REASON,
  MCP_RUN_STOPPED_REASON,
  type McpQuestionBasics,
  McpQuestionsError,
  type McpQuestionStorage,
} from "./question-records.ts";
import { type McpSamplingGrant, samplingRecords } from "./sampling-records.ts";

/** How long a Sampling request waits for the owner, as the Legacy question does: 10 minutes. */
export const MCP_SAMPLING_ASK_WAIT_MS = 10 * 60 * 1000;

/** Why a request is refused when the owner did not answer in time. */
export const MCP_SAMPLING_UNANSWERED_REASON = "the owner did not answer in time";

/** What the owner is shown: the request without what the service adds (its id, its deadline, whether it can write). */
export type McpSamplingCard = Omit<
  McpSamplingRequest,
  "id" | "deadline" | "writable" | "role" | "roles"
> & {
  /** The Role it would run on, and the Roles the owner may pick: the Session's own, which a client reads as strings. */
  readonly role: RoleName;
  readonly roles: ReadonlyArray<{ readonly role: RoleName; readonly model: string }>;
};

/** A request that waits for the owner: its card, and what the card's choices change. */
export type McpSamplingQuestion = {
  /** The record's id: `<callId>:<sequence>`, unique within the Session. */
  readonly id: string;
  /** The server's own request id: what the server's `notifications/cancelled` names. */
  readonly key: string;
  readonly card: McpSamplingCard;
};

/** How a waiting request ended, for the sampler that waits on it. */
export type McpSamplingDecision =
  | {
      readonly action: "allow";
      /** The Role the owner picked, or the card's own when they did not. */
      readonly role: RoleName;
      /** What let it run; *Allow for this call* is `call`. */
      readonly grant: McpSamplingGrant;
    }
  | {
      readonly action: "refuse";
      readonly by: "owner" | "cloudpid";
      readonly reason: string;
      readonly why?: McpSamplingWhy;
    };

/** Which grant, if any, lets a server's request through without a card, or refuses it without one. */
export type McpSamplingStanding =
  | { readonly action: "allow"; readonly grant: "call" | "session" }
  | { readonly action: "refuse"; readonly grant: "call" | "session"; readonly reason: string };

/** The owner's answer to a waiting request, as a client gives it. */
export type McpSamplingGiven = {
  readonly choice: McpSamplingChoice;
  readonly role?: RoleName | undefined;
};

/** The write of a definition's `sampling` that *Always allow* and *Never* make. */
export type McpSamplingRemember = {
  /** Whether the write can succeed for a definition at `source` here: the card offers the two only when it can. */
  readonly writable: (source: McpElicitationSource | undefined) => Effect.Effect<boolean>;
  /** Write it; a failure says why, in cloudpid's words. */
  readonly write: (input: {
    readonly server: string;
    readonly source: McpElicitationSource | undefined;
    readonly conversationId: McpSamplingRequest["conversationId"];
    readonly value: "allow" | "off";
  }) => Effect.Effect<void, McpQuestionsError>;
};

export type McpSamplingQuestionsOptions = {
  readonly storage: McpQuestionStorage;
  /** Tell the clients what waits and what the Session's grants are; called whenever either changes. */
  readonly announce: (message: {
    readonly requests: ReadonlyArray<McpSamplingRequest>;
    readonly grants: ReadonlyArray<McpSamplingSessionGrant>;
  }) => Effect.Effect<void>;
  readonly basics: McpQuestionBasics;
  /** How long a request waits, `MCP_SAMPLING_ASK_WAIT_MS` unless a test shortens it. */
  readonly waitMs?: number | undefined;
  /** Where *Always allow* and *Never* write; without it the card cannot offer them. */
  readonly remember?: McpSamplingRemember | undefined;
};

const WAITING_KEY = "mcp-sampling:waiting";

const GRANTS_KEY = "mcp-sampling:grants";

/** A request waiting, as the storage keeps it: who asks and when, so a new instance can settle its record. */
type WaitingEntry = { readonly id: string; readonly callId: string; readonly askedAt: number };

type Waiting = {
  readonly request: McpSamplingRequest;
  /** The Role the card's request runs on unless the owner picks another. */
  readonly role: RoleName;
  /** The Roles the owner may pick. */
  readonly roles: ReadonlyArray<RoleName>;
  readonly key: string;
  readonly askedAt: number;
  readonly outcome: Deferred.Deferred<McpSamplingDecision>;
  /** Set by the answer that takes the request: no other answer, and not the clock, ends it afterwards. */
  claimed: boolean;
};

/** How long a write of the definition may take before the answer fails and the request is released: the Registry's own bound. */
const WRITE_MS = 30_000;

/** The reasons the owner's refusals are given, each written once. */
const REFUSED_BY_OWNER = "refused by the owner";
const REFUSED_FOR_SESSION = "refused by the owner for this Session";
const REFUSED_NEVER = "refused by the owner, who switched the server's sampling off";

const refusedBy = (
  by: "owner" | "cloudpid",
  reason: string,
  why?: McpSamplingWhy,
): McpSamplingDecision =>
  why === undefined ? { action: "refuse", by, reason } : { action: "refuse", by, reason, why };

/** The decision of a call that Stop reached, which an `abort` of `signal` ends a wait with; never when there is none. */
export const stoppedBy = (signal: AbortSignal | undefined): Effect.Effect<McpSamplingDecision> =>
  signal === undefined
    ? Effect.never
    : Effect.callback<McpSamplingDecision>((resume) => {
        const stopped = () => {
          resume(Effect.succeed(refusedBy("cloudpid", MCP_RUN_STOPPED_REASON, "unanswered")));
        };

        if (signal.aborted) {
          stopped();

          return;
        }

        signal.addEventListener("abort", stopped, { once: true });

        return Effect.sync(() => {
          signal.removeEventListener("abort", stopped);
        });
      });

/** The Sampling half of the Session's MCP questions over its storage. */
export const createSamplingQuestions = (options: McpSamplingQuestionsOptions) => {
  const { storage, basics } = options;
  const waitMs = options.waitMs ?? MCP_SAMPLING_ASK_WAIT_MS;
  const waiting = new Map<string, Waiting>();
  const callGrants = new Set<string>();
  const callRefusals = new Set<string>();
  const records = samplingRecords(storage);

  const entries = (): ReadonlyArray<WaitingEntry> => storage.get<WaitingEntry[]>(WAITING_KEY) ?? [];

  const putEntries = (next: ReadonlyArray<WaitingEntry>) => {
    if (next.length === 0) storage.delete(WAITING_KEY);
    else storage.put(WAITING_KEY, next);
  };

  const sessionGrants = (): ReadonlyArray<McpSamplingSessionGrant> =>
    storage.get<McpSamplingSessionGrant[]>(GRANTS_KEY) ?? [];

  const putGrants = (next: ReadonlyArray<McpSamplingSessionGrant>) => {
    if (next.length === 0) storage.delete(GRANTS_KEY);
    else storage.put(GRANTS_KEY, next);
  };

  const pending = Effect.sync(() => Arr.map([...waiting.values()], (held) => held.request));

  const grants = Effect.sync(sessionGrants);

  /** Tell every client what waits and what is granted. */
  const tell: Effect.Effect<void> = Effect.zipWith(pending, grants, (requests, held) => ({
    requests,
    grants: held,
  })).pipe(Effect.flatMap(options.announce));

  /** Keep `server`'s Session grant (replacing one it had), or take it back with `undefined`. */
  const setGrant = (server: string, action: McpSamplingSessionGrant["action"] | undefined) =>
    Effect.try(() =>
      putGrants([
        ...sessionGrants().filter((grant) => grant.server !== server),
        ...(action === undefined ? [] : [{ server, action }]),
      ]),
    ).pipe(
      Effect.catch(() =>
        McpQuestionsError.make({ message: "cloudpid could not keep the choice for this Session" }),
      ),
    );

  /**
   * End request `id` with `decision`: withdrawn from the clients, handed to the sampler that waits. A request an answer
   * has claimed is ended by that answer, or by Stop or the end of its call, and not by the clock (`unlessClaimed`).
   */
  const finish = (id: string, decision: McpSamplingDecision, unlessClaimed = false) =>
    Effect.gen(function* () {
      const held = waiting.get(id);

      if (held === undefined || (unlessClaimed && held.claimed)) return false;

      // Gone at once: an answer that comes while the clock is read finds nothing to take.
      waiting.delete(id);

      const now = yield* Clock.currentTimeMillis;

      basics.stopWaiting(held.request.callId, 1, now);

      yield* Effect.try(() => putEntries(entries().filter((entry) => entry.id !== id))).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not update the waiting Sampling requests", cause),
        ),
      );
      yield* Deferred.succeed(held.outcome, decision);
      yield* tell;

      return true;
    });

  /** Whether the write of a definition at `source` can succeed here, so the card offers *Always allow* and *Never*. */
  const canWrite = (source: McpElicitationSource | undefined) =>
    source?.kind === "repo" || options.remember === undefined
      ? Effect.succeed(false)
      : options.remember.writable(source).pipe(Effect.orElseSucceed(() => false));

  const ask = (question: McpSamplingQuestion): Effect.Effect<McpSamplingDecision> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const { card } = question;

      const request: Mutable<McpSamplingRequest> = {
        ...card,
        id: question.id,
        deadline: now + waitMs,
        writable: yield* canWrite(card.source),
      };

      // Stored before it is shown: a storage that cannot take it leaves no card for a request nobody can expire.
      const stored = yield* Effect.try(() =>
        putEntries([...entries(), { id: question.id, callId: card.callId, askedAt: now }]),
      ).pipe(Effect.option);

      if (Option.isNone(stored)) {
        return refusedBy("cloudpid", MCP_QUESTION_UNRECORDED_REASON, "internal");
      }

      const outcome = yield* Deferred.make<McpSamplingDecision>();

      waiting.set(question.id, {
        request,
        role: card.role,
        roles: Arr.map(card.roles, (option) => option.role),
        key: question.key,
        askedAt: now,
        outcome,
        claimed: false,
      });
      yield* tell;
      yield* basics.startWaiting(card.callId, card.server, 1, now, { sampling: true });

      yield* Deferred.await(outcome).pipe(
        Effect.timeoutOption(waitMs),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              finish(
                question.id,
                refusedBy("cloudpid", MCP_SAMPLING_UNANSWERED_REASON, "unanswered"),
                true,
              ),
            onSome: () => Effect.void,
          }),
        ),
        Effect.onInterrupt(() =>
          finish(question.id, refusedBy("cloudpid", MCP_RUN_STOPPED_REASON, "unanswered")),
        ),
      );

      return yield* Deferred.await(outcome);
    });

  /** Whether the owner has already decided for this call or for the Session, so its request needs no card. */
  const standing = (callId: string, server: string): McpSamplingStanding | undefined => {
    const session = sessionGrants().find((grant) => grant.server === server);

    if (session?.action === "refuse")
      return { action: "refuse", grant: "session", reason: REFUSED_FOR_SESSION };

    if (callRefusals.has(callId)) return { action: "refuse", grant: "call", reason: REFUSED_NEVER };

    if (session?.action === "allow") return { action: "allow", grant: "session" };

    return callGrants.has(callId) ? { action: "allow", grant: "call" } : undefined;
  };

  /** End every waiting request that `matches` with `decision`, each with its own Role. */
  const endWhere = (
    matches: (held: Waiting) => boolean,
    decide: (held: Waiting) => McpSamplingDecision,
  ) =>
    Effect.gen(function* () {
      for (const [id, held] of Arr.fromIterable(waiting.entries())) {
        if (matches(held)) yield* finish(id, decide(held));
      }
    });

  const answer = (id: string, given: McpSamplingGiven): Effect.Effect<void, McpQuestionsError> =>
    Effect.gen(function* () {
      const held = waiting.get(id);

      if (held === undefined)
        return yield* McpQuestionsError.make({ message: "This request ended" });

      // A request taken is taken, whatever else is wrong with this answer.
      if (held.claimed) {
        return yield* McpQuestionsError.make({ message: "This request is being answered" });
      }

      const { request } = held;
      const { choice } = given;
      const role = given.role ?? held.role;

      if (!Arr.some(held.roles, (option) => option === role)) {
        return yield* McpQuestionsError.make({ message: "That Role is not available" });
      }

      const writing = choice === "allow_always" || choice === "refuse_never";

      if (writing && !request.writable) {
        return yield* McpQuestionsError.make({
          message: "This server's definition cannot be changed from here",
        });
      }

      // The claim is made in one step with the check above, so of two answers (or an answer and the clock) one takes the request.
      held.claimed = true;

      const sameCall = (other: Waiting) => other.request.callId === request.callId;
      const sameServer = (other: Waiting) => other.request.server === request.server;

      /** Every other request of the call or the server waiting is let through as this one is, on its own Role. */
      const allowed = (matches: typeof sameCall, grant: McpSamplingGrant) =>
        endWhere(
          (other) => matches(other) && other.request.id !== id,
          (other): McpSamplingDecision => ({ action: "allow", role: other.role, grant }),
        );

      /** Every other request of the server waiting is refused as this one is, and with `refusing` its call's next ones too. */
      const refusedAlso = (reason: string, refusing = false) =>
        endWhere(
          (other) => sameServer(other) && other.request.id !== id,
          (other) => {
            if (refusing) callRefusals.add(other.request.callId);

            return refusedBy("owner", reason);
          },
        );

      /**
       * The write of the definition, bounded. One rule for every choice that keeps something (the Session's grants too): a
       * choice that cannot be kept (or is interrupted) releases the request, which waits as before, and the answer fails with why, so the card
       * says it and the owner picks another. Nothing is settled on a failure.
       */
      const keeping = <E>(keep: Effect.Effect<void, E | McpQuestionsError>) =>
        keep.pipe(
          Effect.timeoutOrElse({
            duration: WRITE_MS,
            orElse: () =>
              McpQuestionsError.make({ message: "The definition was not saved in time" }),
          }),
          Effect.onError(() =>
            Effect.sync(() => {
              held.claimed = false;
            }),
          ),
        );

      const written = (value: "allow" | "off") =>
        keeping(
          options.remember === undefined
            ? McpQuestionsError.make({
                message: "This server's definition cannot be changed from here",
              })
            : options.remember.write({
                server: request.server,
                source: request.source,
                conversationId: request.conversationId,
                value,
              }),
        );

      switch (choice) {
        case "allow_call": {
          callGrants.add(request.callId);
          yield* finish(id, { action: "allow", role, grant: "call" });
          yield* allowed(sameCall, "call");

          return;
        }

        case "allow_session": {
          yield* keeping(setGrant(request.server, "allow"));
          yield* finish(id, { action: "allow", role, grant: "session" });
          yield* allowed(sameServer, "session");
          yield* tell;

          return;
        }

        case "allow_always": {
          yield* written("allow");
          callGrants.add(request.callId);
          yield* finish(id, { action: "allow", role, grant: "always" });
          yield* allowed(sameServer, "always");

          return;
        }

        case "refuse": {
          yield* finish(id, refusedBy("owner", REFUSED_BY_OWNER));

          return;
        }

        case "refuse_session": {
          yield* keeping(setGrant(request.server, "refuse"));
          yield* finish(id, refusedBy("owner", REFUSED_FOR_SESSION));
          yield* refusedAlso(REFUSED_FOR_SESSION);
          yield* tell;

          return;
        }

        case "refuse_never": {
          yield* written("off");
          callRefusals.add(request.callId);
          yield* finish(id, refusedBy("owner", REFUSED_NEVER));
          yield* refusedAlso(REFUSED_NEVER, true);

          return;
        }
      }
    });

  /** Take back the Session grant of `server`. */
  const revoke = (server: string) =>
    setGrant(server, undefined).pipe(Effect.andThen(tell), Effect.ignore);

  return {
    ask,
    standing,
    pending,
    grants,
    answer,
    revoke,
    /** The server stopped waiting for request `key` of call `callId`: its card is withdrawn. */
    withdraw: (callId: string, key: string, reason: string) =>
      endWhere(
        (held) => held.request.callId === callId && held.key === key,
        () => refusedBy("cloudpid", reason, "unanswered"),
      ),
    /** The server was switched off, hidden or removed. */
    withdrawServer: (server: string, reason: string) =>
      endWhere(
        (held) => held.request.server === server,
        () => refusedBy("cloudpid", reason, "unanswered"),
      ),
    /** The call is over: what it still waits on is withdrawn and its grant forgotten. */
    settleCall: (callId: string) =>
      Effect.gen(function* () {
        yield* endWhere(
          (held) => held.request.callId === callId,
          () => refusedBy("cloudpid", MCP_CALL_ENDED_REASON, "unanswered"),
        );
        callGrants.delete(callId);
        callRefusals.delete(callId);
      }),
    /**
     * Settle the records an earlier instance left waiting: their calls are gone with it. Run once, when the instance starts,
     * before any call can ask.
     */
    expireStale: Effect.gen(function* () {
      const stale = entries().filter((entry) => !waiting.has(entry.id));

      if (stale.length === 0) return;

      const now = yield* Clock.currentTimeMillis;

      for (const entry of stale) {
        const held = records.get(entry.id);

        if (held !== undefined && (held.status === "waiting" || held.status === "running")) {
          records.put(
            {
              ...held,
              status: "refused",
              by: "cloudpid",
              why: "unanswered",
              reason: `expired: ${MCP_CALL_ENDED_REASON}`,
              settledAt: now,
            },
            now,
          );
        }
      }

      yield* Effect.try(() => putEntries(entries().filter((entry) => waiting.has(entry.id)))).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not update the waiting Sampling requests", cause),
        ),
      );
      yield* tell;
    }),
  };
};
