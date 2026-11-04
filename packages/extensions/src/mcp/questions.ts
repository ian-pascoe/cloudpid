// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
// The questions an MCP server asks the owner during a call (`docs/architecture/mcp-server-requests.md` → Questions, The
// waiting-question record, Elicitation requests; ADR-0037, ADR-0041). A Legacy server's elicitation form waits here,
// in memory, for the owner's answer from any client: the first answer wins, a late one is refused. It lives only as
// long as its call waits (ADR-0037), so nothing survives an eviction: a new instance finds the records of the questions
// the old one left waiting and expires them ("the server's call ended"). A Modern server's form is kept for later
// instead (`defer`, in `deferred-questions.ts`), and outlives the instance.
//
// - **Never a value.** The owner's answer goes from `answer` to the waiting call through a `Deferred`, in memory, and
//   nowhere else: the waiting record holds the form the owner saw, and the settled record the names of the fields
//   answered, never what was entered. A value that holds a Secret (as the Session knows them, or a Secret Reference's
//   placeholder) is bounced to the card, nothing kept.
// - **One record per question** in the Session's storage (an implementation word): `mcp-question:waiting` lists the
//   questions waiting (small: who asks, which call, when), and each question that ended leaves a settled record
//   (`question-records.ts`) with the message and form the owner was shown (redacted of held Secrets). The full request
//   is in memory only. `/export`, a Fork or Clone and the question's span read the records (`export-lines.ts`,
//   `copies`; #569).
// - **The notification** is told of the first question a call waits on, and of a later one only after 2 min with none
//   waiting for that call.
import { MCP_ELICITATION_WAIT_MS, type McpEra } from "@cloudpid/mcp/types";
import {
  createDeferredQuestions,
  type McpDeferredAnswer,
  type McpDeferredRound,
  type McpQuestionVault,
} from "./deferred-questions.ts";
import type { JsonObject } from "@cloudpid/mcp/types";
import {
  callKeysOf,
  cancelled,
  modeOf,
  type McpQuestionBasics,
  questionBasics,
  MCP_CALL_ENDED_REASON,
  MCP_ELICITATION_CAP_REASON,
  MCP_QUESTION_UNRECORDED_REASON,
  MCP_RUN_STOPPED_REASON,
  type McpQuestionAnswer,
  type McpQuestionAsk,
  type McpQuestionCopies,
  type McpQuestionOutcome,
  type McpQuestionRecord,
  McpQuestionsError,
  type McpQuestionStorage,
  type McpQuestionUnseen,
  type McpSamplingDecision,
  type McpWaitingKind,
  eraDefault,
  eraOfAsk,
  pageIdentityOf,
  questionId,
  waitsOf,
} from "./question-records.ts";
import type {
  McpElicitationRequest,
  McpElicitationScope,
  McpSamplingRequest,
  McpSamplingSessionGrant,
} from "@cloudpid/protocol";
import {
  createSamplingQuestions,
  type McpSamplingGiven,
  type McpSamplingQuestion,
  type McpSamplingRemember,
  type McpSamplingStanding,
} from "./sampling-questions.ts";
import { samplingRecords } from "./sampling-records.ts";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { Mutable } from "effect/Types";

export {
  MCP_DEFERRED_DEADLINE_MS,
  type McpDeferredAnswer,
  type McpDeferredRound,
  type McpDeferredSample,
  McpRoundState,
  type McpQuestionVault,
} from "./deferred-questions.ts";

export {
  MCP_SAMPLING_ASK_WAIT_MS,
  MCP_SAMPLING_UNANSWERED_REASON,
  type McpSamplingCard,
  type McpSamplingGiven,
  type McpSamplingQuestion,
  type McpSamplingRemember,
  type McpSamplingStanding,
} from "./sampling-questions.ts";

export {
  MCP_CALL_ENDED_REASON,
  MCP_DECLINED_IN_SESSION_REASON,
  MCP_ELICITATION_CAP_REASON,
  type McpSamplingDecision,
  MCP_QUESTION_RECORDS,
  MCP_QUESTION_RENOTIFY_MS,
  MCP_QUESTION_UNRECORDED_REASON,
  MCP_RUN_STOPPED_REASON,
  McpQuestionsError,
  type McpQuestionAnswer,
  type McpPageRef,
  type McpQuestionAsk,
  type McpQuestionCopies,
  type McpQuestionCopy,
  callKeysOf,
  type McpQuestionOutcome,
  type McpQuestionRecord,
  type McpQuestionStorage,
  type McpQuestionUnseen,
  originOf,
} from "./question-records.ts";

const WAITING_KEY = "mcp-question:waiting";

/** The servers the owner chose to decline in this Session (`mcp-question:declined`), which survives a restart. */
const DECLINED_KEY = "mcp-question:declined";

/** How long a page the server says is finished reads "Finished at <host>" before its card goes, in ms. */
export const MCP_PAGE_FINISHED_SHOWN_MS = 4000;

/** What a page the owner opened came to for the server: accepted. */
const ACCEPTED: McpQuestionOutcome = { action: "accept", by: "owner", content: {} };

/** A question waiting, as the storage keeps it: who asks and when, so a new instance can expire it. */
type WaitingEntry = {
  readonly id: string;
  readonly callId: string;
  readonly conversationId: McpElicitationRequest["conversationId"];
  readonly server: string;
  readonly tool: string;
  readonly askedAt: number;
};

export type McpQuestionsService = {
  /**
   * Show the owner `ask` and wait for the answer. It ends with the owner's answer, or with a `cancel` of cloudpid's own:
   * the 10 min bound, the call's cap of `MCP_ELICITATIONS_PER_CALL`, the call's end (`settleCall`), a withdrawal. An
   * interrupted wait (Stop) withdraws the question. Never fails.
   */
  readonly ask: (ask: McpQuestionAsk) => Effect.Effect<McpQuestionOutcome>;
  /** The questions waiting for the owner, oldest first. */
  readonly pending: Effect.Effect<ReadonlyArray<McpElicitationRequest>>;
  /**
   * The owner's answer to question `id`. Fails when no such question waits (answered, or its call ended), and, for an
   * `accept`, when `content` does not fit the form or holds a Secret: the message says which field.
   */
  readonly answer: (
    id: string,
    answer: McpQuestionAnswer,
  ) => Effect.Effect<void, McpQuestionsError>;
  /** The server stopped waiting for question `key` of call `callId`: withdraw its card. */
  readonly withdraw: (callId: string, key: string, reason: string) => Effect.Effect<void>;
  /**
   * The host did not give question `key` of call `callId`'s answer to its server (it changed while the owner answered):
   * the question's record, if the owner had answered it, says cancelled by cloudpid with `reason`. Nothing for a
   * question that did not end in an answer.
   */
  readonly overturn: (callId: string, key: string, reason: string) => Effect.Effect<void>;
  /**
   * The server says the owner finished at the page question `key` of call `callId` asked them to open (its
   * `notifications/elicitation/complete` on the call's own stream). A page the owner opened reads "Finished at <host>"
   * for a moment (`McpQuestionsOptions.finishedShownMs`) and then closes, and the call's clock goes on at once; any other
   * closes.
   */
  readonly complete: (callId: string, key: string) => Effect.Effect<void>;
  /**
   * Waits until page question `key` of call `callId`, which the owner opened, has ended: finished, withdrawn, or its call
   * over; a prompt send's, at most until its question's own wait is up. At once for a question that has.
   */
  readonly whileOpen: (callId: string, key: string) => Effect.Effect<void>;
  /** Whether `host` is one of cloudpid's own (`McpQuestionsOptions.ownHost`). */
  readonly isOwnHost: (host: string) => boolean;
  /** Server `server` was switched off, hidden or removed: cancel every question it waits on, and withdraw the cards. */
  readonly withdrawServer: (server: string, reason: string) => Effect.Effect<void>;
  /**
   * The `codemode` call `scriptCallId` ended because its `timeout_ms` passed: cancel every question the calls it made
   * wait on, `reason` being the one the owner and the agent read, and withdraw the cards.
   */
  readonly withdrawScript: (scriptCallId: string, reason: string) => Effect.Effect<void>;
  /**
   * The call is done, however it ended: withdraw every question it still waits on, and forget its count. `reason` is
   * what they read when it was known why (`MCP_CALL_ENDED_REASON` otherwise).
   */
  readonly settleCall: (callId: string, reason?: string) => Effect.Effect<void>;
  /**
   * Record a form cloudpid declined or cancelled unseen (a credential, a malformed form). It counts toward the call's
   * cap of `MCP_ELICITATIONS_PER_CALL` like any request: `"capped"` says the call was past it, and the record says so.
   */
  readonly unseen: (unseen: McpQuestionUnseen) => Effect.Effect<"recorded" | "capped">;
  /**
   * Expire the questions an earlier instance left waiting: their calls are gone with it. Run once, when the instance
   * starts, before any call can ask.
   */
  readonly expireStale: Effect.Effect<void>;
  /** The settled records, newest last. */
  readonly records: Effect.Effect<ReadonlyArray<McpQuestionRecord>>;
  /**
   * The owner's "Decline all" (`scope: "call"`) or "Decline in this Session" (`scope: "session"`) on question `id`: it is
   * declined, and with `call` the call's other waiting questions too; with `session` only this one, and the server's later
   * requests are declined unseen (`isDeclined`) until `revokeDeclined`, the questions already waiting staying on their
   * cards. A page that is open can only be cancelled, which is what it is answered. Fails when `id` waits no more, or when
   * the Session could not keep the choice (nothing is then declined).
   */
  readonly declineScoped: (
    id: string,
    scope: McpElicitationScope,
  ) => Effect.Effect<void, McpQuestionsError>;
  /** The servers the owner chose to decline in this Session, oldest first. */
  readonly declinedServers: () => ReadonlyArray<string>;
  /** Whether the owner chose to decline `server`'s requests in this Session. */
  readonly isDeclined: (server: string) => boolean;
  /** Take back "Decline in this Session" for `server`: the clients are told. */
  readonly revokeDeclined: (server: string) => Effect.Effect<void>;
  /** What a Fork or Clone carries of the settled records, and keeps of the ones it was sent. */
  readonly copies: McpQuestionCopies;
  /**
   * Show the owner a Sampling request the sampler checked and wait for their decision, from any client (the first answer
   * wins). It ends with the owner's allow or refusal, or a refusal of cloudpid's own: the 10 min bound, the call's end
   * (`settleCall`), a withdrawal. An interrupted wait (Stop) withdraws the card. Never fails.
   */
  readonly askSampling: (question: McpSamplingQuestion) => Effect.Effect<McpSamplingDecision>;
  /** What the owner has already decided for this call and server (a grant), so their request needs no card; undefined: none. */
  readonly samplingStanding: (callId: string, server: string) => McpSamplingStanding | undefined;
  /** The Sampling requests waiting for the owner, oldest first. */
  readonly pendingSampling: Effect.Effect<ReadonlyArray<McpSamplingRequest>>;
  /** The Session's grants: what the owner chose for a server until the Session ends. */
  readonly samplingGrants: Effect.Effect<ReadonlyArray<McpSamplingSessionGrant>>;
  /**
   * The owner's answer to Sampling request `id`. Fails when no such request waits (answered, or its call ended), when the
   * Role is not one the card offers, and when a choice that writes the definition cannot (the request still waits).
   */
  readonly answerSampling: (
    id: string,
    given: McpSamplingGiven,
  ) => Effect.Effect<void, McpQuestionsError>;
  /**
   * The server's definition reads `mode` now, told at every request start: the Sampling requests of it waiting for the
   * owner, live or kept with a Modern call's round, are run as `allow` says, with no card, or refused as `off` says, which
   * sinks their rounds; `ask` decides nothing (`docs/architecture/mcp-server-requests.md` → The server changes while a
   * question waits).
   */
  readonly samplingSwitched: (server: string, mode: "allow" | "ask" | "off") => Effect.Effect<void>;
  /** Take back the Session's grant for `server`. */
  readonly revokeSampling: (server: string) => Effect.Effect<void>;
  /**
   * Keep a Modern server's Sampling request, which the sampler checked, for the call's round: its card is stored beside the
   * forms, shown once the round is (`showRound`), and answered by `answerSampling`; the sample is made when the round
   * resumes, from `params` (redacted). `"unrecorded"`: the storage cannot take it (a replaced Session's) or it is too large,
   * and the request is to be refused.
   */
  readonly deferSampling: (
    question: McpSamplingQuestion & { readonly sequence: number; readonly params: JsonObject },
  ) => Effect.Effect<"deferred" | "unrecorded">;
  /** How many Sampling requests the call has made, kept with its rounds so a rerun after an eviction counts on from them. */
  readonly sampledCount: (callId: string) => number;
  /** The call made Sampling request number `sequence`. */
  readonly noteSampled: (callId: string, sequence: number) => void;
  /** Whether a Modern server's form can be kept for later: the service has a vault for the answers. */
  readonly defers: boolean;
  /**
   * Keep `ask`, a Modern server's form, for the call's round: stored, and shown once the round is (`showRound`). It
   * counts toward the call's cap like any request (`"capped"`); a storage that cannot take it (a replaced Session)
   * leaves nothing kept (`"unrecorded"`), and the server is to be told `cancel`.
   */
  readonly defer: (ask: McpQuestionAsk) => Effect.Effect<"deferred" | "capped" | "unrecorded">;
  /**
   * Store the call's round whole: its `ResumeState` beside the questions `defer` kept, not shown yet. Fails when the
   * storage cannot take it.
   */
  readonly commitRound: (round: McpDeferredRound) => Effect.Effect<void, McpQuestionsError>;
  /**
   * Show the call's stored round, once `mcp.wait.<r>` is written: its cards show, and the owner is told as `ask` tells
   * (a rerun's round, shown before, is not told again). Fails when the storage cannot take it.
   */
  readonly showRound: (callId: string) => Effect.Effect<void, McpQuestionsError>;
  /** The round the call stored, when it did: a rerun of the call waits for it again. */
  readonly deferredRound: (callId: string) => Effect.Effect<McpDeferredRound | undefined>;
  /**
   * Wait until every question of the call's round has its answer, and give them, accepted content opened. An answer the
   * owner gave while no call waited is taken at once. An interrupted wait (Stop) withdraws the questions and drops the
   * round; one whose sealed answer cannot be opened is a `cancel` of cloudpid's own. `undefined`: the call has no round
   * stored (it was settled meanwhile).
   */
  readonly awaitRound: (
    callId: string,
  ) => Effect.Effect<ReadonlyArray<McpDeferredAnswer> | undefined>;
  /**
   * The round's resume is on its way (`mcp.resumed.<r>` is written): its questions are settled, their sealed answers
   * dropped, and the round forgotten.
   */
  readonly endRound: (callId: string) => Effect.Effect<void>;
  /** Withdraw every deferred round no call in this instance waits for: their calls ended with an earlier instance. */
  readonly dropAbandoned: Effect.Effect<void>;
};

/** The Session's MCP questions. */
export class McpQuestions extends Context.Service<McpQuestions, McpQuestionsService>()(
  "@cloudpid/extensions/mcp/questions/McpQuestions",
) {}

export type McpQuestionsOptions = {
  readonly storage: McpQuestionStorage;
  /** Tell the clients which questions wait; called whenever that changes. */
  readonly announce: (requests: ReadonlyArray<McpElicitationRequest>) => Effect.Effect<void>;
  /**
   * Tell the owner a call waits for them (a push), in the background; it must not fail. Called for the first question
   * of a call and for a later one after `MCP_QUESTION_RENOTIFY_MS` with none waiting; never with the message.
   */
  readonly notify?:
    | ((who: {
        readonly server: string;
        readonly page?: true;
        readonly sampling?: true;
      }) => Effect.Effect<void>)
    | undefined;
  /**
   * Whether `host` (lowercase, ASCII) is one of cloudpid's own, which a page the server asks the owner to open must not
   * be on (`docs/architecture/mcp-server-requests.md` → URL mode). Without it none is.
   */
  readonly ownHost?: ((host: string) => boolean) | undefined;
  /** Tell the clients which Sampling requests wait and what the Session's grants are; called whenever either changes. */
  readonly announceSampling?:
    | ((message: {
        readonly requests: ReadonlyArray<McpSamplingRequest>;
        readonly grants: ReadonlyArray<McpSamplingSessionGrant>;
      }) => Effect.Effect<void>)
    | undefined;
  /** How long a Sampling request waits, `MCP_SAMPLING_ASK_WAIT_MS` unless a test shortens it. */
  readonly samplingWaitMs?: number | undefined;
  /** Where the card's *Always allow* and *Never* write the server's definition; without it the card does not offer them. */
  readonly remember?: McpSamplingRemember | undefined;
  /** `value` with every Secret the Session holds replaced by its reference: all the owner is shown, and all a record keeps. */
  readonly redact: <A>(value: A) => Effect.Effect<A>;
  /**
   * Whether a string the owner entered holds a Secret the Session holds or a deploy-time credential, in any encoding
   * redaction knows; a Secret Reference's placeholder is refused here whatever this says.
   */
  readonly holdsSecret: (text: string) => Effect.Effect<boolean>;
  /** How long a question waits, `MCP_ELICITATION_WAIT_MS` unless a test shortens it. */
  readonly waitMs?: number | undefined;
  /** How long a question of a prompt send waits, `MCP_PROMPT_QUESTION_WAIT_MS` unless a test shortens it. */
  readonly promptWaitMs?: number | undefined;
  /** How long a page the server says is finished reads "Finished at <host>" before its card goes, `MCP_PAGE_FINISHED_SHOWN_MS` unless a test shortens it. */
  readonly finishedShownMs?: number | undefined;
  /**
   * Where an accepted Modern form's content is sealed until its resume. Without one, nothing is deferred: a Modern
   * server's form is answered live, as a Legacy one.
   */
  readonly vault?: McpQuestionVault | undefined;
};

type Waiting = {
  readonly key: string;
  readonly request: McpElicitationRequest;
  readonly entry: WaitingEntry;
  readonly outcome: Deferred.Deferred<McpQuestionOutcome>;
  /** Succeeds once the question has ended, however: a page the owner opened is waited for until then. */
  readonly closed: Deferred.Deferred<void>;
  /**
   * A live page the owner opened: the server was answered `accept` at that Open, goes on, and the card stays until the
   * page is finished. (Never set on a `retry` page, whose Open answers nothing: see `openClicked`.)
   */
  readonly acceptedAtOpen: boolean;
  /**
   * A page the call waits at to be sent again (`McpQuestionAsk.retry`: a Legacy `-32042`'s, or a Modern server's, in a
   * prompt send's get): Open records the click and answers nothing, "Done, try again" answers `accept`.
   */
  readonly retry?: boolean | undefined;
  /** For a `retry` page: the owner clicked Open, which answered nothing (`request.page.opened` says so to the card). */
  readonly openClicked?: boolean | undefined;
  /** The Protocol era of the server that asked, for its settled record. */
  readonly era?: McpEra | undefined;
};

/** What a Fork or Clone carries of the Session's records of its calls' requests: the questions' and the Sampling requests'. */
const copiesOf = (basics: McpQuestionBasics, storage: McpQuestionStorage): McpQuestionCopies => {
  const sampling = samplingRecords(storage);

  return {
    copiesFor: (callIds) => {
      const wanted = new Set(callIds);

      const samples = Arr.filter(
        sampling.list(),
        (record) =>
          wanted.size > 0 && Arr.some(callKeysOf(record.callId), (key) => wanted.has(key)),
      );

      return [
        ...Arr.map(basics.recordsFor(callIds), (record) => ({ kind: "question", record }) as const),
        ...Arr.map(samples, (record) => ({ kind: "sampling", record }) as const),
      ];
    },
    adopt: (copies, conversationId) => {
      basics.adoptRecords(
        Arr.filterMap(copies, (copy) =>
          copy.kind === "question" ? Result.succeed(copy.record) : Result.failVoid,
        ),
        conversationId,
      );

      for (const copy of copies) {
        // The Session's own bound of Sampling records applies; a storage that cannot take one loses it, never the Fork.
        if (copy.kind === "sampling") {
          sampling.put(
            { ...copy.record, conversationId },
            copy.record.settledAt ?? copy.record.askedAt,
          );
        }
      }
    },
  };
};

/** What names a question of a call in `answeredIds`. */
const answeredKey = (callId: string, key: string) => `${callId}\u0000${key}`;

/** The Session's MCP questions over its storage. Synchronous: the tools that ask are built before the runtime. */
export const createMcpQuestions = (options: McpQuestionsOptions): McpQuestionsService => {
  const { storage, announce } = options;
  const waitMs = options.waitMs ?? MCP_ELICITATION_WAIT_MS;
  const waitFor = waitsOf({ waitMs, promptWaitMs: options.promptWaitMs });
  const finishedShownMs = options.finishedShownMs ?? MCP_PAGE_FINISHED_SHOWN_MS;
  const waiting = new Map<string, Waiting>();
  /** The id of each question of a running call that ended in an answer, by call and key: `overturn` finds its record. */
  const answeredIds = new Map<string, string>();
  const basics = questionBasics(options);
  const { keep } = basics;

  const tell: Effect.Effect<void> = Effect.suspend(() => pending.pipe(Effect.flatMap(announce)));

  const deferred = createDeferredQuestions({
    storage,
    vault: options.vault,
    basics,
    tell,
    tellSampling: Effect.suspend(() => sampling.tell),
  });

  const sampling = createSamplingQuestions({
    storage,
    basics,
    announce: options.announceSampling ?? (() => Effect.void),
    waitMs: options.samplingWaitMs,
    promptWaitMs: options.promptWaitMs,
    remember: options.remember,
    deferred,
  });

  const pending = Effect.sync(() => [
    ...Arr.map([...waiting.values()], (held) => held.request),
    ...deferred.shown(),
  ]);

  const entries = (): ReadonlyArray<WaitingEntry> => storage.get<WaitingEntry[]>(WAITING_KEY) ?? [];

  const putEntries = (next: ReadonlyArray<WaitingEntry>) => {
    if (next.length === 0) storage.delete(WAITING_KEY);
    else storage.put(WAITING_KEY, next);
  };

  /** End question `id` with `outcome`: written to its record, withdrawn from the clients, handed to the waiting call. */
  const finish = (id: string, outcome: McpQuestionOutcome) =>
    Effect.gen(function* () {
      const held = waiting.get(id);

      if (held === undefined) return false;

      // Gone at once: an answer that comes while the clock is read finds nothing to take.
      waiting.delete(id);

      const now = yield* Clock.currentTimeMillis;
      const { request, entry } = held;

      basics.stopWaiting(request.callId, 1, now);

      yield* Effect.try(() => putEntries(entries().filter((other) => other.id !== id))).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not update the waiting MCP questions", cause),
        ),
      );

      // A page the owner opened was answered `accept` when it was opened, whatever ended it.
      const ended: McpQuestionOutcome = held.acceptedAtOpen ? ACCEPTED : outcome;

      if (ended.action === "accept") answeredIds.set(answeredKey(request.callId, held.key), id);

      yield* keep(
        basics.settledOf(
          request,
          {
            action: ended.action,
            by: ended.by,
            reason: ended.action === "accept" ? undefined : ended.reason,
            // The names of the fields answered: never a value.
            fields:
              ended.action === "accept" ? basics.answeredFields(request.form, ended.content) : [],
            era: held.era,
          },
          entry.askedAt,
          now,
        ),
      );
      yield* Deferred.succeed(held.outcome, outcome);
      yield* Deferred.succeed(held.closed, undefined);
      yield* tell;

      return true;
    });

  const ask = (question: McpQuestionAsk): Effect.Effect<McpQuestionOutcome> =>
    Effect.gen(function* () {
      const retrying = question.retry === true && question.page !== undefined;

      // A page the owner was done at and the server asks for again is no new request: it does not count toward the call's
      // cap, and its card reads "Not finished at <host> yet".
      const again =
        retrying &&
        (yield* Effect.try(() =>
          basics
            .pagesOf(question.callId)
            .opened.includes(pageIdentityOf(eraOfAsk(question), question.key, question.page?.url)),
        ).pipe(Effect.orElseSucceed(() => false)));

      const sequence = again
        ? yield* Effect.try(() => `again${basics.repeatedPage(question.callId)}`).pipe(
            Effect.orElseSucceed(() => undefined),
          )
        : yield* basics.count(question);

      if (sequence === undefined) return cancelled(MCP_ELICITATION_CAP_REASON);

      const id = questionId(question.callId, sequence);
      const now = yield* Clock.currentTimeMillis;
      const { waitMs: wait, quiet } = waitFor(question.prompt);
      const request = yield* basics.requestOf(question, id, now + wait, again);

      const entry: WaitingEntry = {
        id,
        callId: question.callId,
        conversationId: question.conversationId,
        server: question.server,
        tool: question.tool,
        askedAt: now,
      };

      // Stored before it is shown: a storage that cannot take it leaves no card for a question nobody can expire.
      const stored = yield* Effect.try(() => putEntries([...entries(), entry])).pipe(Effect.option);

      if (Option.isNone(stored)) {
        const reason = MCP_QUESTION_UNRECORDED_REASON;

        yield* keep(
          basics.settledOf(
            request,
            { action: "cancel", by: "cloudpid", reason, fields: [], era: question.era },
            now,
            now,
          ),
        );

        return cancelled(reason);
      }

      const outcome = yield* Deferred.make<McpQuestionOutcome>();
      const closed = yield* Deferred.make<void>();

      waiting.set(id, {
        key: question.key,
        request,
        entry,
        outcome,
        closed,
        acceptedAtOpen: false,
        retry: retrying,
        era: question.era,
      });
      yield* tell;
      const kind: Mutable<McpWaitingKind> = {};

      if (question.page !== undefined) kind.page = true;

      // A page asked for again tells the owner nothing: they were told of it.
      if (quiet || again) kind.quiet = true;

      yield* basics.startWaiting(question.callId, question.server, 1, now, kind);

      yield* Deferred.await(outcome).pipe(
        Effect.timeoutOption(wait),
        Effect.flatMap(
          Option.match({
            onNone: () => finish(id, cancelled("the owner did not answer in time")),
            onSome: () => Effect.void,
          }),
        ),
        Effect.onInterrupt(() => finish(id, cancelled(MCP_RUN_STOPPED_REASON))),
      );

      return yield* Deferred.await(outcome);
    });

  /**
   * The owner's answer to a page the call waits at to be sent again (a prompt send's get: a Legacy `-32042`'s page, or a
   * Modern server's): Open records the click and answers nothing; "Done, try again" answers `accept`, once the page is
   * opened, and the get goes on; Cancel answers `cancel`. A Decline is offered until the page is opened, and for a Legacy
   * `-32042` throughout, since sending the request again can change nothing then.
   */
  const answerRetryPage = (
    id: string,
    held: Waiting,
    page: NonNullable<McpElicitationRequest["page"]>,
    given: Exclude<McpQuestionAnswer, { readonly action: "accept" }>,
  ) =>
    Effect.gen(function* () {
      if (given.action === "opened") {
        if (held.openClicked !== true) {
          waiting.set(id, {
            ...held,
            openClicked: true,
            request: { ...held.request, page: { ...page, opened: true } },
          });
          yield* tell;
        }

        return;
      }

      if (given.action === "done") {
        if (held.openClicked !== true) {
          return yield* McpQuestionsError.make({ message: "Open the page first" });
        }

        yield* Effect.try(() =>
          basics.openedPages(held.request.callId, [
            pageIdentityOf(held.era ?? eraDefault(true), held.key, page.url),
          ]),
        ).pipe(Effect.ignore);

        const taken = yield* finish(id, { action: "accept", by: "owner", content: {} });

        if (!taken) return yield* McpQuestionsError.make({ message: "This request ended" });

        return;
      }

      if (given.action === "decline" && held.openClicked === true && held.era === "modern") {
        return yield* McpQuestionsError.make({ message: "This page is open: cancel it instead" });
      }

      yield* finish(id, { action: given.action, by: "owner" });
    });

  /**
   * The owner's answer to a page question that waits live (a Legacy server's, during its call). Open's click answers the
   * server `accept` at once and the card stays, reading "Opened", until the page is finished (`complete`), the server
   * stops waiting, or the call ends; there is no "Done" to press, since the server goes on by itself.
   */
  const answerPage = (id: string, held: Waiting, given: McpQuestionAnswer) =>
    Effect.gen(function* () {
      const { page } = held.request;

      if (page === undefined || given.action === "accept") {
        return yield* McpQuestionsError.make({
          message: "This request is a page to open, not a form",
        });
      }

      if (held.retry === true) return yield* answerRetryPage(id, held, page, given);

      if (given.action === "done") {
        return yield* McpQuestionsError.make({
          message: `${held.request.server} goes on by itself when you finish at the page`,
        });
      }

      if (given.action !== "opened") {
        // Open answered the server `accept`: a Decline can no longer be told to it.
        if (given.action === "decline" && held.acceptedAtOpen) {
          return yield* McpQuestionsError.make({ message: "This page is open: cancel it instead" });
        }

        yield* finish(id, { action: given.action, by: "owner" });

        return;
      }

      if (!held.acceptedAtOpen) {
        waiting.set(id, {
          ...held,
          acceptedAtOpen: true,
          request: { ...held.request, page: { ...page, opened: true } },
        });
      }

      // The first Open answers the server; another client's, or a second click, only finds the card as it is.
      yield* Deferred.succeed(held.outcome, { action: "accept", by: "owner", content: {} });
      yield* tell;
    });

  const declinedServers = (): ReadonlyArray<string> => {
    try {
      return storage.get<string[]>(DECLINED_KEY) ?? [];
    } catch {
      return [];
    }
  };

  /** `id` answered `decline`, or `cancel` where the question cannot be declined (a page that is open). */
  const declineOrCancel = (id: string) =>
    answer(id, { action: "decline" }).pipe(Effect.catch(() => answer(id, { action: "cancel" })));

  const declineScoped: McpQuestionsService["declineScoped"] = (id, scope) =>
    Effect.gen(function* () {
      const waitingNow = yield* pending;
      const asked = Arr.findFirst(waitingNow, (request) => request.id === id);

      if (Option.isNone(asked))
        return yield* McpQuestionsError.make({ message: "This request ended" });

      const { server, callId } = asked.value;

      // The choice is kept first: a storage that cannot take it declines nothing. `session` declines this question and the
      // server's later ones; the others it already waits on stay on their cards (Decline all is for those).
      const added = scope === "session" && !declinedServers().includes(server);

      if (added) {
        const kept = yield* Effect.try(() =>
          storage.put(DECLINED_KEY, [...declinedServers(), server]),
        ).pipe(Effect.option);

        if (Option.isNone(kept)) {
          return yield* McpQuestionsError.make({
            message: "The choice could not be kept; try again",
          });
        }
      }

      const declined = yield* declineOrCancel(id).pipe(Effect.result);

      // The card that was answered ended before the choice could take it: the choice is undone, as it was never made.
      if (Result.isFailure(declined)) {
        if (added) yield* revokeDeclined(server);

        return yield* declined.failure;
      }

      for (const other of waitingNow) {
        if (other.id === id) continue;

        if (scope === "call" && other.callId === callId) {
          // Already ended or answered meanwhile: nothing to decline.
          yield* declineOrCancel(other.id).pipe(Effect.ignore);
        }
      }

      if (scope === "session") yield* tell;
    });

  const revokeDeclined: McpQuestionsService["revokeDeclined"] = (server) =>
    Effect.suspend(() => {
      const held = declinedServers();

      if (!held.includes(server)) return Effect.void;

      return Effect.try(() => {
        const left = held.filter((each) => each !== server);

        if (left.length === 0) storage.delete(DECLINED_KEY);
        else storage.put(DECLINED_KEY, left);
      }).pipe(Effect.ignore, Effect.andThen(tell));
    });

  const answer: McpQuestionsService["answer"] = (id, given) =>
    Effect.gen(function* () {
      const held = waiting.get(id);

      if (held === undefined) {
        if (yield* deferred.answer(id, given)) return;

        return yield* McpQuestionsError.make({ message: "This request ended" });
      }

      if (held.request.page !== undefined) return yield* answerPage(id, held, given);

      if (given.action === "opened" || given.action === "done") {
        return yield* McpQuestionsError.make({ message: "This request is a form, not a page" });
      }

      if (given.action !== "accept") {
        yield* finish(id, { action: given.action, by: "owner" });

        return;
      }

      const content = yield* basics.checkedContent(held.request.form, given.content);

      // The first answer wins: a question another client answered meanwhile is gone.
      const taken = yield* finish(id, { action: "accept", by: "owner", content });

      if (!taken) return yield* McpQuestionsError.make({ message: "This request ended" });
    });

  const endWhere = (matches: (held: Waiting) => boolean, reason: string) =>
    Effect.gen(function* () {
      for (const [id, held] of Arr.fromIterable(waiting.entries())) {
        if (matches(held)) yield* finish(id, cancelled(reason));
      }
    });

  const settleCall = (callId: string, reason: string = MCP_CALL_ENDED_REASON) =>
    Effect.gen(function* () {
      // A page the server said is finished is left to its own timer, so the card reads "Finished at <host>" after the
      // call that usually ends right behind `complete` (`complete`).
      yield* endWhere(
        (held) => held.request.callId === callId && held.request.page?.finished !== true,
        reason,
      );
      yield* sampling.settleCall(callId, reason);
      yield* deferred.settleCall(callId, reason);

      for (const key of Arr.fromIterable(answeredIds.keys())) {
        if (key.startsWith(`${callId}\u0000`)) answeredIds.delete(key);
      }

      basics.calls.delete(callId);
    });

  /** The page question `key` of call `callId` that waits live, if there is one. */
  const waitingFor = (callId: string, key: string) =>
    Arr.findFirst(
      Arr.fromIterable(waiting.entries()),
      ([, held]) => held.request.callId === callId && held.key === key,
    );

  const complete = (callId: string, key: string) =>
    Option.match(waitingFor(callId, key), {
      onNone: () => Effect.void,
      onSome: ([id, held]) => {
        const { page } = held.request;

        // A page the owner opened is finished: its card says so for a moment, and the call's clock goes on now.
        if (held.acceptedAtOpen && page !== undefined && page.finished !== true) {
          waiting.set(id, {
            ...held,
            request: { ...held.request, page: { ...page, finished: true } },
          });

          return Deferred.succeed(held.closed, undefined).pipe(
            Effect.andThen(tell),
            Effect.andThen(
              Effect.forkDetach(
                Effect.sleep(finishedShownMs).pipe(Effect.andThen(finish(id, ACCEPTED))),
              ),
            ),
            Effect.asVoid,
          );
        }

        return finish(
          id,
          held.acceptedAtOpen
            ? ACCEPTED
            : cancelled(`${held.request.server} says the page is finished`),
        ).pipe(Effect.asVoid);
      },
    });

  const whileOpen = (callId: string, key: string) =>
    Option.match(waitingFor(callId, key), {
      onNone: () => Effect.void,
      onSome: ([, held]) => {
        const open = Deferred.await(held.closed);

        // A page of a prompt send is waited for no longer than its question was: the get's clock is not held for good by a
        // page that is never finished (`deadline` is the ask's 5 min).
        if (held.request.prompt === undefined) return open;

        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Effect.timeoutOption(open, Math.max(0, held.request.deadline - now)),
          ),
          Effect.asVoid,
        );
      },
    });

  // The servers whose unseen declines were logged: once per server for as long as this instance lives.
  const warned = new Set<string>();

  /**
   * A `warning` log, once per server, that cloudpid declined a request of it unseen (a credential asked for, an address
   * refused, the owner's "Decline in this Session"); a `cancel` of a malformed form is only recorded. Names no value.
   */
  const warnOnce = (server: string, action: "decline" | "cancel") =>
    Effect.suspend(() => {
      if (action !== "decline" || warned.has(server)) return Effect.void;

      warned.add(server);

      return Effect.logWarning(
        `cloudpid declined a request for input from MCP server ${server} unseen; later ones are recorded, not logged`,
      );
    });

  const unseen: McpQuestionsService["unseen"] = (form) =>
    Effect.gen(function* () {
      const sequence = yield* basics.count(form);

      yield* warnOnce(form.server, form.action);

      if (sequence === undefined) return "capped" as const;

      const now = yield* Clock.currentTimeMillis;
      const shown = yield* basics.shownOf(form);

      const record: Mutable<McpQuestionRecord> = {
        id: questionId(form.callId, sequence),
        callId: form.callId,
        conversationId: form.conversationId,
        server: form.server,
        tool: form.tool,
        ...modeOf(form),
        message: shown.message,
        notes: shown.notes,
        action: form.action,
        by: "cloudpid",
        reason: shown.reason ?? form.reason,
        fields: [],
        askedAt: now,
        settledAt: now,
      };

      if (shown.form !== undefined) record.form = shown.form;

      yield* keep(record);

      return "recorded" as const;
    });

  return {
    ask,
    pending,
    answer,
    overturn: (callId, key, reason) => {
      const id = answeredIds.get(answeredKey(callId, key));

      return id === undefined ? Effect.void : basics.overturn(id, reason);
    },
    withdraw: (callId, key, reason) =>
      Effect.andThen(
        endWhere((held) => held.request.callId === callId && held.key === key, reason),
        sampling.withdraw(callId, key, reason),
      ),
    withdrawServer: (server, reason) =>
      Effect.andThen(
        Effect.andThen(
          endWhere((held) => held.request.server === server, reason),
          sampling.withdrawServer(server, reason),
        ),
        deferred.withdrawServer(server, reason),
      ),
    withdrawScript: (scriptCallId, reason) =>
      Effect.andThen(
        Effect.andThen(
          endWhere((held) => held.request.callId.startsWith(`${scriptCallId}/`), reason),
          sampling.withdrawScript(scriptCallId, reason),
        ),
        deferred.withdrawScript(scriptCallId, reason),
      ),
    askSampling: sampling.ask,
    samplingStanding: sampling.standing,
    pendingSampling: sampling.pending,
    samplingGrants: sampling.grants,
    answerSampling: sampling.answer,
    revokeSampling: sampling.revoke,
    samplingSwitched: sampling.switched,
    deferSampling: sampling.defer,
    sampledCount: (callId) => basics.callOf(callId).sampled,
    noteSampled: (callId, sequence) => {
      const state = basics.callOf(callId);

      state.sampled = Math.max(state.sampled, sequence);
    },
    settleCall,
    complete,
    whileOpen,
    isOwnHost: (host) => options.ownHost?.(host) ?? false,
    unseen,
    defers: options.vault !== undefined,
    defer: deferred.defer,
    commitRound: deferred.commitRound,
    showRound: deferred.showRound,
    deferredRound: deferred.deferredRound,
    awaitRound: deferred.awaitRound,
    endRound: deferred.endRound,
    dropAbandoned: deferred.dropAbandoned,
    expireStale: Effect.gen(function* () {
      yield* sampling.expireStale;

      const stale = entries().filter((entry) => !waiting.has(entry.id));

      if (stale.length === 0) return;

      const now = yield* Clock.currentTimeMillis;

      for (const entry of stale) {
        yield* keep({
          id: entry.id,
          callId: entry.callId,
          conversationId: entry.conversationId,
          server: entry.server,
          tool: entry.tool,
          mode: "form",
          message: "",
          notes: [],
          action: "cancel",
          by: "cloudpid",
          reason: `expired: ${MCP_CALL_ENDED_REASON}`,
          fields: [],
          askedAt: entry.askedAt,
          settledAt: now,
        });
      }

      yield* Effect.try(() => putEntries(entries().filter((entry) => waiting.has(entry.id)))).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not update the waiting MCP questions", cause),
        ),
      );
      yield* tell;
    }),
    declineScoped,
    declinedServers,
    isDeclined: (server) => declinedServers().includes(server),
    revokeDeclined,
    records: basics.records,
    copies: copiesOf(basics, storage),
  } satisfies McpQuestionsService;
};
