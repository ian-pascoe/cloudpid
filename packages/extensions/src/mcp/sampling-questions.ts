// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- the Session's service, over plain values.
// The Sampling requests an MCP server asks the owner to allow (`docs/architecture/mcp-server-requests.md` → Sampling
// requests, The card, The waiting-question record): a Legacy server's request on an agent's call waits here, in memory, for
// the owner's answer from any client, the first answer winning and a late one refused (ADR-0037). It is the Sampling half of
// `McpQuestions` (`questions.ts`), beside the elicitation forms, and shares their notification: the owner is told of a
// call's first waiting question, of whichever kind.
//
// - **The decision is the owner's, or the definition's.** What waits here is a request already checked (its parameters, its
//   messages, the Spend limit, a model to answer it): the sampler (`sampling.ts`) asks only about a request it could run.
//   What comes back is allow, with the Role to run it on and the grant it was given by, or a refusal. The one other
//   decider is the definition: when its `sampling` is switched while requests wait, `switched` runs them (`allow`) or
//   refuses them (`off`), unless an owner's answer is already in flight, which wins.
// - **Grants.** *Allow for this call* is kept in memory until the call ends (a Legacy call does not outlive its instance).
//   *Allow in this Session* and *Refuse in this Session* are kept in the Session's storage (`mcp-sampling:grants`), the
//   server's, for every conversation of the Session, until the owner takes one back. *Always allow* and *Never* write the
//   server's definition (`remember`). *Never* also refuses the rest of the call, without asking.
// - **The first answer wins.** An answer claims its call before it does anything else (one claim per call, so two answers
//   on different requests of one call cannot both take effect), so a second answer, the owner's, the clock's or a
//   switch's, finds it taken. One rule for a choice that cannot be kept (a write of the definition that fails or takes
//   too long, a grant the storage refuses): the claim is released and the answer fails with why, so the card says it and the
//   owner picks another; nothing is settled.
// - **A Modern server's request** is kept for later instead (`./deferred-questions.ts`, `deferSampling`): the card is stored
//   with the call's round, outlives the instance, and is answered here by the same choices; the sample runs at the round's
//   resume. *Allow for this call* is kept in the storage for such a call (`mcp-sampling:call:<callId>`), so a later round of
//   the call, after an eviction, still finds it. One refusal sinks the round (`decideSampling`).
// - **The record.** The request's card is made of its record (`sampling-records.ts`), which the sampler wrote as `waiting`
//   before it asked. `mcp-sampling:waiting` lists what waits, so a new instance, which finds nothing to answer them, can
//   settle those records as refused.
import { ROLE_NAMES, type RoleName } from "@cloudpid/config";
import type { JsonObject } from "@cloudpid/mcp/types";
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
import {
  decisionOf,
  MCP_CALL_ENDED_REASON,
  MCP_QUESTION_UNRECORDED_REASON,
  MCP_RUN_STOPPED_REASON,
  type McpQuestionBasics,
  McpQuestionsError,
  type McpQuestionStorage,
  type McpSamplingDecision,
  type McpSamplingVerdict,
  refusedBy,
  waitsOf,
} from "./question-records.ts";
import { MCP_DEFERRED_DEADLINE_MS, type McpDeferredQuestions } from "./deferred-questions.ts";
import { samplingRecords } from "./sampling-records.ts";

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
  /** How long a request of a prompt send waits, `MCP_PROMPT_QUESTION_WAIT_MS` unless a test shortens it. */
  readonly promptWaitMs?: number | undefined;
  /** Where *Always allow* and *Never* write; without it the card cannot offer them. */
  readonly remember?: McpSamplingRemember | undefined;
  /** A Modern server's requests, kept for later: their cards show beside the live ones, and the same choices answer them. */
  readonly deferred: Pick<
    McpDeferredQuestions,
    | "shownSampling"
    | "samplingHeld"
    | "decideSampling"
    | "deferSampling"
    | "allowServer"
    | "refuseServer"
  >;
};

const WAITING_KEY = "mcp-sampling:waiting";

const GRANTS_KEY = "mcp-sampling:grants";

/** The call's own grant, kept for a call that outlives its instance (a Modern server's): `Allow for this call`. */
const callGrantKey = (callId: string) => `mcp-sampling:call:${callId}`;

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
  /** Its wait ran out while an answer was taking its call: ended when that answer lets go without deciding it. */
  overdue: boolean;
};

/** How long a write of the definition may take before the answer fails and the request is released: the Registry's own bound. */
const WRITE_MS = 30_000;

/** The reasons the owner's refusals are given, each written once. */
const REFUSED_BY_OWNER = "refused by the owner";
const REFUSED_FOR_SESSION = "refused by the owner for this Session";
const REFUSED_NEVER = "refused by the owner, who switched the server's sampling off";

/** Why a request is refused when the server's definition says `off`, as it was switched to while the request waited or was kept. */
export const MCP_SAMPLING_OFF_REASON = "the server's definition no longer lets it use a model";

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

/** Whether an answer has taken a call's requests, and how one takes them (it lets go when the answer ends: `claimed`). */
type Claim = {
  readonly taken: () => boolean;
  readonly take: () => void;
};

/** The Sampling half of the Session's MCP questions over its storage. */
export const createSamplingQuestions = (options: McpSamplingQuestionsOptions) => {
  const { storage, basics } = options;
  const waitMs = options.waitMs ?? MCP_SAMPLING_ASK_WAIT_MS;
  const waitFor = waitsOf({ waitMs, promptWaitMs: options.promptWaitMs });
  const waiting = new Map<string, Waiting>();
  const callGrants = new Set<string>();
  const callRefusals = new Set<string>();

  /**
   * The calls an answer is taking, live or kept: the claim is the call's, since the decision covers all its waiting
   * requests, so of two answers on different requests of one call, or an answer and the definition's switch, one takes
   * them and the other yields.
   */
  const claimedCalls = new Set<string>();

  /** Whether an answer is taking `callId`'s requests: what the definition's switch, over the kept ones, yields to. */
  const claiming = (callId: string) => claimedCalls.has(callId);

  /**
   * What the definition reads for each server, as the Session last learned it (`switched`) or the owner wrote it: an
   * answer that was left to finish while the definition went `off` is refused, as the switch would have, not run.
   */
  const modes = new Map<string, "allow" | "ask" | "off">();

  /** `verdict`, unless the definition reads `off` by now: an allow is then a refusal by cloudpid, as the switch would give. */
  const settled = (server: string, verdict: McpSamplingVerdict): McpSamplingVerdict =>
    verdict.action === "allow" && modes.get(server) === "off"
      ? refusedBy("cloudpid", MCP_SAMPLING_OFF_REASON)
      : verdict;

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

  /** The requests waiting for the owner: the live ones, and a Modern server's kept for later. */
  const pending = Effect.sync(() => [
    ...Arr.map([...waiting.values()], (held) => held.request),
    ...options.deferred.shownSampling(),
  ]);

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
   * End request `id` with `decision`: withdrawn from the clients, handed to the sampler that waits. A request of a call an
   * answer has claimed is ended by that answer, or by Stop or the end of its call, and not by the clock (`unlessClaimed`).
   */
  const finish = (id: string, decision: McpSamplingDecision, unlessClaimed = false) =>
    Effect.gen(function* () {
      const held = waiting.get(id);

      if (held === undefined || (unlessClaimed && claimedCalls.has(held.request.callId))) {
        return false;
      }

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

  /**
   * Run `answer` holding the claim on `callId`'s requests, which `choose` takes. However the answer ends (done, failed,
   * interrupted) it lets go of the claim, if it took it; the requests whose wait ran out meanwhile (`overdue`: the clock
   * yields to a claim) are then ended unanswered, so a failed answer does not leave them waiting with no clock.
   */
  const claimed = <A, E>(callId: string, answer: (claim: Claim) => Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      let mine = false;

      const claim: Claim = {
        taken: () => claimedCalls.has(callId),
        take: () => {
          claimedCalls.add(callId);
          mine = true;
        },
      };

      return answer(claim).pipe(
        Effect.onExit(() =>
          Effect.suspend(() => {
            if (!mine) return Effect.void;

            mine = false;
            claimedCalls.delete(callId);

            return Effect.forEach(
              Arr.filter(
                [...waiting.entries()],
                ([, held]) => held.overdue && held.request.callId === callId,
              ),
              ([id]) =>
                finish(id, refusedBy("cloudpid", MCP_SAMPLING_UNANSWERED_REASON, "unanswered")),
              { discard: true },
            );
          }),
        ),
      );
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
      const { waitMs: wait, quiet } = waitFor(card.prompt);

      const request: Mutable<McpSamplingRequest> = {
        ...card,
        id: question.id,
        deadline: now + wait,
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
        overdue: false,
      });
      yield* tell;
      yield* basics.startWaiting(
        card.callId,
        card.server,
        1,
        now,
        quiet ? { sampling: true, quiet: true } : { sampling: true },
      );

      yield* Deferred.await(outcome).pipe(
        Effect.timeoutOption(wait),
        Effect.flatMap(
          Option.match({
            // A call an answer is taking is left to it; if that answer lets go without deciding, `claimed` ends this one.
            onNone: () =>
              finish(
                question.id,
                refusedBy("cloudpid", MCP_SAMPLING_UNANSWERED_REASON, "unanswered"),
                true,
              ).pipe(
                Effect.flatMap((ended) =>
                  Effect.sync(() => {
                    const held = waiting.get(question.id);

                    if (!ended && held !== undefined) held.overdue = true;
                  }),
                ),
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

  /** Whether the call's grant was kept in the storage: a Modern call's, which may outlive its instance. */
  const keptCallGrant = (callId: string): boolean => {
    try {
      return storage.get<true>(callGrantKey(callId)) === true;
    } catch {
      return false;
    }
  };

  /**
   * Keep a Modern server's request for later, with its call's round: its card is stored, shown once the round is, and
   * answered by `answer` like a live one. `params` is the request as the sample will be made from, redacted.
   */
  const defer = (
    question: McpSamplingQuestion & { readonly sequence: number; readonly params: JsonObject },
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      const request: Mutable<McpSamplingRequest> = {
        ...question.card,
        id: question.id,
        // No deadline: the owner is waited for in the call's resume. A client from before `waits` needs one, far off.
        deadline: now + MCP_DEFERRED_DEADLINE_MS,
        waits: "owner",
        writable: yield* canWrite(question.card.source),
      };

      return yield* options.deferred.deferSampling({
        request,
        key: question.key,
        sequence: question.sequence,
        params: question.params,
      });
    });

  /** Whether the owner has already decided for this call or for the Session, so its request needs no card. */
  const standing = (callId: string, server: string): McpSamplingStanding | undefined => {
    const session = sessionGrants().find((grant) => grant.server === server);

    if (session?.action === "refuse")
      return { action: "refuse", grant: "session", reason: REFUSED_FOR_SESSION };

    if (callRefusals.has(callId)) return { action: "refuse", grant: "call", reason: REFUSED_NEVER };

    if (session?.action === "allow") return { action: "allow", grant: "session" };

    return callGrants.has(callId) || keptCallGrant(callId)
      ? { action: "allow", grant: "call" }
      : undefined;
  };

  /**
   * End every waiting request that `matches` with its own `decide`d decision. With `yielding`, a call an answer is taking
   * is left to it (the answer's own call, `yielding.own`, is the answer's to end): an owner's answer in flight wins over
   * the definition's switch and over another call's sweep.
   */
  const endWhere = (
    matches: (held: Waiting) => boolean,
    decide: (held: Waiting) => McpSamplingDecision,
    yielding?: { readonly own?: string },
  ) =>
    Effect.gen(function* () {
      for (const [id, held] of Arr.fromIterable(waiting.entries())) {
        const { callId } = held.request;

        if (yielding !== undefined && callId !== yielding.own && claimedCalls.has(callId)) continue;

        if (matches(held)) yield* finish(id, decide(held));
      }
    });

  /**
   * `keep`, bounded: the write of the definition, or of a grant. One rule for every choice that keeps something (the
   * Session's grants too): a choice that cannot be kept fails the answer with why (it is released by `claimed`, and the
   * request waits as before), so the card says it and the owner picks another. Nothing is settled on a failure.
   */
  const keeping = <E>(keep: Effect.Effect<void, E | McpQuestionsError>) =>
    keep.pipe(
      Effect.timeoutOrElse({
        duration: WRITE_MS,
        orElse: () => McpQuestionsError.make({ message: "The definition was not saved in time" }),
      }),
    );

  /**
   * The write of `request`'s definition that *Always allow* (`allow`) and *Never* (`off`) make, kept as `keeping` does;
   * the definition reads that from then on (`modes`).
   */
  const writtenFor =
    (request: Pick<McpSamplingRequest, "server" | "source" | "conversationId">) =>
    (value: "allow" | "off") =>
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
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            modes.set(request.server, value);
          }),
        ),
      );

  const unavailable = (message: string) => McpQuestionsError.make({ message });

  /**
   * What the owner's choice on `request` decides and keeps, live or kept with its round (one rule for both): the answer's
   * claim, the checks (the Role, a write of the definition), then the choice kept as it asks (the call's grant by
   * `keepCall`, the Session's, the definition's). A choice that cannot be kept fails with why, and the caller (`claimed`)
   * lets go of the claim and settles nothing.
   */
  const choose = (
    request: McpSamplingRequest,
    given: McpSamplingGiven,
    claim: Claim,
    keepCall: Effect.Effect<void, McpQuestionsError>,
  ): Effect.Effect<McpSamplingVerdict, McpQuestionsError> =>
    Effect.gen(function* () {
      const { choice } = given;
      const named = given.role ?? request.role;
      const role = ROLE_NAMES.find((each) => each === named);

      // A request taken is taken, whatever else is wrong with this answer.
      if (claim.taken()) return yield* unavailable("This request is being answered");

      if (role === undefined || !Arr.some(request.roles, (option) => option.role === role)) {
        return yield* unavailable("That Role is not available");
      }

      const writing = choice === "allow_always" || choice === "refuse_never";

      if (writing && !request.writable) {
        return yield* unavailable("This server's definition cannot be changed from here");
      }

      // Taken in one step with the checks above, so of two answers (or an answer and the clock) one takes the request.
      claim.take();

      const written = writtenFor(request);

      /** The verdict, with the Role the owner picked, which the requests it covers run on too. */
      const verdict = (decided: McpSamplingVerdict): McpSamplingVerdict =>
        given.role === undefined ? decided : { ...decided, picked: role };

      switch (choice) {
        case "allow_call": {
          yield* keeping(keepCall);

          return verdict({ action: "allow", role, grant: "call", also: "call" });
        }

        case "allow_session": {
          yield* keeping(setGrant(request.server, "allow"));

          return verdict({ action: "allow", role, grant: "session", also: "server" });
        }

        case "allow_always": {
          yield* written("allow");
          yield* keeping(keepCall);

          return verdict({ action: "allow", role, grant: "always", also: "server" });
        }

        case "refuse":
          return verdict(refusedBy("owner", REFUSED_BY_OWNER));

        case "refuse_session": {
          yield* keeping(setGrant(request.server, "refuse"));

          return verdict({ ...refusedBy("owner", REFUSED_FOR_SESSION), also: "server" });
        }

        case "refuse_never": {
          yield* written("off");

          return verdict({ ...refusedBy("owner", REFUSED_NEVER), also: "server", never: true });
        }
      }
    });

  /**
   * The owner's answer to a Modern server's request, kept with its round: `choose`, then one decision in the storage for
   * every request of the round (`decideSampling`). A refusal sinks the round.
   */
  const answerDeferred = (
    id: string,
    held: { readonly request: McpSamplingRequest },
    given: McpSamplingGiven,
  ): Effect.Effect<void, McpQuestionsError> =>
    claimed(held.request.callId, (claim) =>
      Effect.gen(function* () {
        const { callId } = held.request;

        const verdict = yield* choose(held.request, given, claim, keepCallGrant(callId));

        // The first answer wins: a request another client answered meanwhile (or whose call ended) is gone.
        const taken = yield* options.deferred.decideSampling(id, verdict, claiming);

        if (!taken) return yield* unavailable("This request ended");

        yield* tell;
      }),
    );

  /** Keeps the call's own grant in the storage, which a later round after an eviction still finds. */
  const keepCallGrant = (callId: string) =>
    Effect.try(() => {
      storage.put(callGrantKey(callId), true);
      callGrants.add(callId);
    }).pipe(Effect.catch(() => unavailable("cloudpid could not keep the choice for this call")));

  const answer = (id: string, given: McpSamplingGiven): Effect.Effect<void, McpQuestionsError> =>
    Effect.gen(function* () {
      const held = waiting.get(id);

      // A request of a Modern server's, kept with its round.
      if (held === undefined) {
        const kept = options.deferred.samplingHeld(id);

        if (kept !== undefined) return yield* answerDeferred(id, kept, given);

        return yield* unavailable("This request ended");
      }

      const { request } = held;

      return yield* claimed(request.callId, (claim) =>
        Effect.gen(function* () {
          // A live call's grant is its instance's: it ends with the call, and nothing outlives it.
          const verdict = yield* choose(
            request,
            given,
            claim,
            Effect.sync(() => {
              callGrants.add(request.callId);
            }),
          );

          if (verdict.never === true) callRefusals.add(request.callId);

          /**
           * What the verdict decides for a request it ends, `own` the Role it was shown on: an allow the definition's `off`
           * was waiting out (the switch left the call to this answer) is refused, as the switch would have. Read as each
           * request ends, which the announcing in between may let the switch reach. Only a live request needs it: a kept
           * one is run at its round's resume, after the next request start has refused it.
           */
          const decided = (own: string) => decisionOf(settled(request.server, verdict), own);

          // The request may have ended meanwhile (Stop, the call's end): the owner is told their answer did not take.
          if (!(yield* finish(id, decided(held.role)))) {
            return yield* unavailable("This request ended");
          }

          // One decision for the call's waiting requests, and with a choice for the Session or for good the server's in
          // other calls too (unless an answer is taking those), each on its own Role unless the owner picked one; *Never*
          // refuses the calls' next ones as well.
          yield* endWhere(
            (other) =>
              other.request.id !== id &&
              (other.request.callId === request.callId ||
                (verdict.also === "server" && other.request.server === request.server)),
            (other) => {
              if (verdict.never === true) callRefusals.add(other.request.callId);

              return decided(other.role);
            },
            { own: request.callId },
          );

          if (given.choice === "allow_session" || given.choice === "refuse_session") yield* tell;
        }),
      );
    });

  /** Take back the Session grant of `server`. */
  const revoke = (server: string) =>
    setGrant(server, undefined).pipe(Effect.andThen(tell), Effect.ignore);

  return {
    ask,
    defer,
    tell,
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
    /**
     * The server's definition reads `mode` now, as the Session's latest inventory says (told at every request start, not
     * only when it changed: a switch that yielded to an answer in flight is made again once that answer lets go). `allow`
     * runs what waits for the owner, `off` refuses it, as the definition says, with no card; the kept requests of its
     * rounds are answered too (`allowServer`, `refuseServer`). `ask` decides nothing. Cheap when nothing waits.
     */
    switched: (server: string, mode: "allow" | "ask" | "off") =>
      Effect.gen(function* () {
        modes.set(server, mode);

        if (mode === "allow") {
          yield* endWhere(
            (held) => held.request.server === server,
            (held): McpSamplingDecision => ({ action: "allow", role: held.role }),
            {},
          );
          yield* options.deferred.allowServer(server, claiming);
        } else if (mode === "off") {
          yield* endWhere(
            (held) => held.request.server === server,
            () => refusedBy("cloudpid", MCP_SAMPLING_OFF_REASON),
            {},
          );
          yield* options.deferred.refuseServer(server, MCP_SAMPLING_OFF_REASON, claiming);
        }
      }),
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
        claimedCalls.delete(callId);

        if (keptCallGrant(callId)) {
          yield* Effect.try(() => storage.delete(callGrantKey(callId))).pipe(Effect.ignore);
        }
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
