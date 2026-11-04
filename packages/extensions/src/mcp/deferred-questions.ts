// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
// A server's questions kept for later (`docs/architecture/mcp-server-requests.md` → The waiting-question record,
// Elicitation requests; ADR-0041): the deferred half of the Session's MCP questions (`questions.ts`). A Modern server's
// round, and a Legacy server's `-32042` (its pages, #487), end the call as `input_required` or `pages_required` and are
// stored whole, so they survive the instance: a rerun of the call finds the round and waits again, and the cards show
// from it, so an answer the owner gives while no call waits is still kept. A round of pages is sent again by `resend`
// (`McpRoundState` `Resend`), a Modern round by `Resume`.
//
// - **The storage** (an implementation word): the call's record `mcp-question:d:<callId>` (its server, its questions'
//   ids, and once stored, the round: the server's `conn`, the round's number, the server's name for the tool, what
//   `details.elicitation` holds so far and the call's count toward its cap), listed in `mcp-question:deferred`; one
//   value per question, `mcp-question:q:<id>` (its kind, the request as the owner is shown it, and once given, the
//   answer), so no value grows with the round; and the `ResumeState` in chunks of `RESUME_CHUNK` characters under
//   `mcp-question:d:<callId>:<n>`; and, for a call's pages, `mcp-question:pages:<callId>` (the pages the owner was done
//   at and how many the server asked for again, which outlive a round and go with the call).
// - **Shown only once marked:** `commitRound` stores the round, the call writes `mcp.wait.<r>`, and only then does
//   `showRound` show its cards and tell the owner, so no card shows for a round a rerun would not wait for.
// - **Never a value in the clear:** an accepted form's content is sealed in its question (the `vault`, AES-GCM) until
//   the round's resume is built, and goes with the record: at the call's end, Stop, or, for a call gone with an earlier
//   instance, the Session going idle (`dropAbandoned`).
// - **A kind per question:** `elicitation` (a question stored without one is one), and `sampling`, a Modern server's
//   Sampling request kept beside the forms ([#486](https://github.com/ian-pascoe/cloudpid/issues/486)): its card
//   (`mcp_sampling_requests`) and the request's parameters, redacted and chunked in `mcp-question:p:<id>:<n>`, since the
//   sample is made when the round resumes, not when the owner allows it; it is listed in its call's record under
//   `sampling:<id>`, apart from the forms' ids. One refusal of a Sampling request sinks the round: every other question
//   of it is answered `cancel` (or refused) by cloudpid, "the server's call ended", even a form the owner had answered
//   (`decideSampling`). A round holding a kind this build does not know is not waited for again.
import {
  ElicitationContent,
  type McpElicitationPage,
  type McpElicitationRequest,
  type McpSamplingRequest,
} from "@cloudpid/protocol";
import { ROLE_NAMES, type RoleName } from "@cloudpid/config";
import { isJsonObject, type JsonObject, type McpEra } from "@cloudpid/mcp/types";
import type { SealedValue, SecretVaultError } from "../secrets/vault.ts";
import type { McpElicitationDetail, McpSamplingWhy } from "./details.ts";
import {
  cancelled,
  JsonText,
  MCP_CALL_ENDED_REASON,
  MCP_QUESTION_UNRECORDED_REASON,
  MCP_RUN_STOPPED_REASON,
  type McpQuestionAnswer,
  type McpQuestionAsk,
  type McpQuestionBasics,
  type McpWaitingKind,
  type McpQuestionOutcome,
  McpQuestionsError,
  type McpQuestionStorage,
  eraDefault,
  pageIdentityOf,
  questionId,
} from "./question-records.ts";
import type { McpSamplingDecision } from "./sampling-questions.ts";
import { type McpSamplingGrant, samplingRecords } from "./sampling-records.ts";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";

const DEFERRED_KEY = "mcp-question:deferred";
const deferredKey = (callId: string) => `mcp-question:d:${callId}`;
const chunkKey = (callId: string, n: number) => `${deferredKey(callId)}:${n}`;
const questionKey = (id: string) => `mcp-question:q:${id}`;

/** A Sampling request's id in its call's record, apart from the forms' ids (both are `<callId>:<n>`). */
const samplingSlot = (id: string) => `sampling:${id}`;

/** The chunks of a Sampling request's parameters, as JSON: the sample is made from them when the round resumes. */
const paramsKey = (id: string, n: number) => `mcp-question:p:${id}:${n}`;

/** The most characters of a Sampling request's parameters, as JSON, that are kept for later: 1 MiB. */
export const MCP_SAMPLING_PARAMS_MAX = 1024 * 1024;

/** The most characters of a `ResumeState`'s JSON one storage value holds: 32 Ki, at most 96 KiB as UTF-8. */
const RESUME_CHUNK = 32 * 1024;

/**
 * The `deadline` a deferred question's request carries for a client from before `waits`, which needs one: 30 days, far
 * past any wait. A client that knows `waits` ignores it.
 */
export const MCP_DEFERRED_DEADLINE_MS = 30 * 24 * 60 * 60 * 1000;

/** What a deferred question asks for: an elicitation form, or a Sampling request. */
type DeferredKind = "elicitation" | "sampling";

/**
 * A deferred question's answer as the record keeps it: an accepted form's content sealed, never in the clear; a page's
 * `accept` ("Done, try again") has no content to keep.
 */
type KeptAnswer =
  | {
      readonly action: "accept";
      readonly by: "owner";
      readonly sealed: SealedValue;
      readonly fields: ReadonlyArray<string>;
    }
  | { readonly action: "accept"; readonly by: "owner"; readonly page: true }
  | {
      readonly action: "decline" | "cancel";
      readonly by: "owner" | "cloudpid";
      readonly reason?: string;
    };

/** A Modern server's question kept for later: what the owner is shown, and once given, the answer. */
type DeferredQuestion = {
  readonly id: string;
  readonly key: string;
  /** Absent in a question stored before kinds were: an elicitation. */
  readonly kind?: "elicitation";
  readonly request: McpElicitationRequest;
  readonly askedAt: number;
  readonly answer?: KeptAnswer;
  /**
   * The Protocol era of the server that asked. Absent in a question stored before the field (#487 kept only a Legacy
   * server's pages, and a deferred form is Modern): `eraOf` reads it as `legacy` for a page and `modern` for a form.
   */
  readonly era?: McpEra;
  /** What it asks: a form, or a page to open; absent reads as a form. */
  readonly mode?: "form" | "url";
};

/** A Sampling request's answer as the record keeps it: what the owner decided, or why cloudpid refused it. */
type KeptSampling =
  | {
      readonly action: "allow";
      readonly role: RoleName;
      readonly grant: McpSamplingGrant;
    }
  | {
      readonly action: "refuse";
      readonly by: "owner" | "cloudpid";
      readonly reason: string;
      readonly why?: McpSamplingWhy;
    };

/** A Modern server's Sampling request kept for later: the card the owner is shown, and once given, the answer. */
type DeferredSampling = {
  /** The slot it is listed under in its call's record (`sampling:<request id>`). */
  readonly id: string;
  /** The server's own key for it within its round. */
  readonly key: string;
  readonly kind: "sampling";
  /** The card, as `mcp_sampling_requests` sends it; its `id` is the sampler's record id. */
  readonly request: McpSamplingRequest;
  /** Its number within the call: the sampler's record id's, kept so the resume's sample is the same request. */
  readonly sequence: number;
  readonly askedAt: number;
  /** How many chunks its parameters are stored in. */
  readonly chunks: number;
  readonly answer?: KeptSampling;
};

/** A question of a deferred round, of either kind. */
type StoredQuestion = DeferredQuestion | DeferredSampling;

const isSampling = (question: StoredQuestion): question is DeferredSampling =>
  question.kind === "sampling";

const isElicitation = (question: StoredQuestion): question is DeferredQuestion =>
  question.kind !== "sampling";

/** A call's deferred record: its questions' ids, and once the round is stored whole, the round. */
type DeferredRecord = {
  readonly callId: string;
  readonly server: string;
  readonly questions: ReadonlyArray<string>;
  readonly round?: {
    readonly n: number;
    readonly conn: string;
    readonly tool: string;
    /** How many chunks the `ResumeState` is stored in. */
    readonly chunks: number;
    /** What the state is: absent, a `ResumeState`; a `ResendState` of a call's pages; or nothing, for a read's pages. */
    readonly state?: "resend" | "read" | undefined;
    readonly asked: ReadonlyArray<McpElicitationDetail>;
    /** The requests the call had made, toward its cap, so a rerun counts on from them. */
    readonly count: number;
    /** The Sampling requests the call had made, for the same; absent in a round stored before them. */
    readonly sampled?: number;
    /** Whether its cards show: set once `mcp.wait.<r>` is written. */
    readonly shown?: boolean;
  };
};

/** How a round's state is named in its record: a `ResumeState` is not, as before pages. */
const stateOf = { Resume: undefined, Resend: "resend", Read: "read" } as const;

/** The era an ask names, or the default of one from a core that named none. */
const eraOfAsk = (ask: McpQuestionAsk): McpEra => ask.era ?? eraDefault(ask.page !== undefined);

const kindOf = (question: StoredQuestion): DeferredKind => question.kind ?? "elicitation";

/** The era of the server that asked a question, for a record from before the field too. */
const eraOf = (question: DeferredQuestion): McpEra =>
  question.era ?? eraDefault(question.mode === "url");

/** What names a stored page question across its call's rounds (`pageIdentityOf`). */
const pageOf = (question: DeferredQuestion): string =>
  pageIdentityOf(eraOf(question), question.key, question.request.page?.url);

/** Seals and opens an accepted Modern form's content while it waits for its resume, bound to the question's id. */
export type McpQuestionVault = {
  readonly seal: (id: string, text: string) => Effect.Effect<SealedValue, SecretVaultError>;
  readonly open: (id: string, sealed: SealedValue) => Effect.Effect<string, SecretVaultError>;
};

/** What became of a deferred form or page, the accepted content opened: the call's resume sends it, `details` notes it. */
export type McpDeferredForm = {
  readonly key: string;
  readonly outcome: McpQuestionOutcome;
  /** The names of the fields the owner answered. */
  readonly fields: ReadonlyArray<string>;
  /** The host of the page, when it was a page question. */
  readonly page?: { readonly host: string };
};

/**
 * A deferred Sampling request and what the owner decided: the sample is made when the round resumes, from `params` (the
 * request as it was kept, redacted) as the same request (`id`, `sequence`), or the request is refused.
 */
export type McpDeferredSample = {
  readonly key: string;
  readonly sample: {
    readonly id: string;
    readonly sequence: number;
    readonly params: JsonObject;
    readonly decision: McpSamplingDecision;
  };
};

/** What became of a deferred question of either kind. */
export type McpDeferredAnswer = McpDeferredForm | McpDeferredSample;

/** What a Sampling request is answered with by `decideSampling`: the owner's choice, and what it lets through or sinks. */
export type McpSamplingVerdict =
  | {
      readonly action: "allow";
      readonly role: RoleName;
      readonly grant: McpSamplingGrant;
      /** The owner's choice covers the call's other requests, or the server's across calls. */
      readonly also: "call" | "server";
    }
  | {
      readonly action: "refuse";
      readonly by: "owner";
      readonly reason: string;
      /** A refusal for the Session or for good also refuses the server's requests in other calls. */
      readonly also?: "server";
    };

/** A Modern server's Sampling request, to be kept with its call's round. */
export type McpSamplingDeferral = {
  /** The card; its `id` is the sampler's record id. */
  readonly request: McpSamplingRequest;
  readonly key: string;
  readonly sequence: number;
  /** The request's parameters, redacted: what the sample is made from when the round resumes. */
  readonly params: JsonObject;
};

/**
 * What a stored round is sent again from, by the request that asked its questions: a Modern call's (or a Legacy form's)
 * `ResumeState`, a Legacy `tools/call`'s `-32042` as its `ResendState`, or a read's `-32042`, which keeps nothing: the
 * Session sends the read again as it was.
 */
export type McpRoundState = Data.TaggedEnum<{
  Resume: { readonly state: Schema.Json };
  Resend: { readonly state: Schema.Json };
  Read: {};
}>;

export const McpRoundState = Data.taggedEnum<McpRoundState>();

/** A call's round of questions, stored whole: what the request that follows is sent from. */
export type McpDeferredRound = {
  readonly callId: string;
  /** The round's number, from 1: the `mcp.wait.<r>` and `mcp.resumed.<r>` markers name it. */
  readonly round: number;
  /** The server's connection key when it asked: a resume on another one is refused. */
  readonly conn: string;
  /** The server's own name for the tool. */
  readonly tool: string;
  /** The state the host gave, as the request that follows is built from it. */
  readonly state: McpRoundState;
  /** What became of the call's questions so far, for its `details`: never a value. */
  readonly asked: ReadonlyArray<McpElicitationDetail>;
};

export type McpDeferredQuestionsOptions = {
  readonly storage: McpQuestionStorage;
  readonly vault: McpQuestionVault | undefined;
  readonly basics: McpQuestionBasics;
  /** Tell the clients which questions wait. */
  readonly tell: Effect.Effect<void>;
  /** Tell the clients which Sampling requests wait; called when a round's cards for them show, change or go. */
  readonly tellSampling: Effect.Effect<void>;
};

const unrecorded = () => McpQuestionsError.make({ message: MCP_QUESTION_UNRECORDED_REASON });

const decodeContent = Schema.decodeEffect(Schema.fromJsonString(ElicitationContent));

/** What a Sampling request is answered with when its round was sunk by another question's refusal. */
const sunkSampling: KeptSampling = {
  action: "refuse",
  by: "cloudpid",
  reason: MCP_CALL_ENDED_REASON,
  why: "unanswered",
};

/** The deferred questions over the Session's storage (see the file's header). */
export const createDeferredQuestions = (options: McpDeferredQuestionsOptions) => {
  const { storage, vault, basics, tell, tellSampling } = options;
  const samples = samplingRecords(storage);

  /** Calls of this instance waiting for their round, by call: what wakes the wait when an answer comes. */
  const rounds = new Map<string, Deferred.Deferred<void>>();
  /** Calls of this instance that deferred a question: their records are no earlier instance's. */
  const active = new Set<string>();

  const deferredIds = (): ReadonlyArray<string> => storage.get<string[]>(DEFERRED_KEY) ?? [];

  const readRecord = (callId: string): DeferredRecord | undefined =>
    storage.get<DeferredRecord>(deferredKey(callId));

  const readQuestion = (id: string): StoredQuestion | undefined =>
    storage.get<StoredQuestion>(questionKey(id));

  /** The record's questions that are stored. */
  const questionsOf = (record: DeferredRecord): ReadonlyArray<StoredQuestion> =>
    Arr.filterMap(record.questions, (id) =>
      Result.fromNullishOr(readQuestion(id), () => undefined),
    );

  /** The record's forms and pages that are stored: the questions a page's answer is about. */
  const elicitationsOf = (record: DeferredRecord): ReadonlyArray<DeferredQuestion> =>
    Arr.filter(questionsOf(record), isElicitation);

  /**
   * The record's questions, when this build can answer every one: all stored, and all of a kind it knows. A record
   * holding another kind (from a later build) is neither shown, answered nor waited for again.
   */
  const answerable = (record: DeferredRecord): ReadonlyArray<StoredQuestion> | undefined => {
    const questions = questionsOf(record);

    return questions.length === record.questions.length &&
      questions.every((question) => ["elicitation", "sampling"].includes(kindOf(question)))
      ? questions
      : undefined;
  };

  /** Store `record`, listed. Throws when the storage cannot take it. */
  const writeRecord = (record: DeferredRecord) => {
    storage.put(deferredKey(record.callId), record);

    const ids = deferredIds();

    if (!ids.includes(record.callId)) storage.put(DEFERRED_KEY, [...ids, record.callId]);
  };

  /** Forget the call's record, its questions and its `ResumeState`. Throws when the storage cannot take it. */
  const removeRecord = (record: DeferredRecord) => {
    for (let n = 0; n < (record.round?.chunks ?? 0); n += 1) {
      storage.delete(chunkKey(record.callId, n));
    }

    for (const id of record.questions) {
      const question = readQuestion(id);

      if (question !== undefined && isSampling(question)) {
        for (let n = 0; n < question.chunks; n += 1) {
          storage.delete(paramsKey(question.request.id, n));
        }
      }

      storage.delete(questionKey(id));
    }

    storage.delete(deferredKey(record.callId));

    const ids = deferredIds().filter((id) => id !== record.callId);

    if (ids.length === 0) storage.delete(DEFERRED_KEY);
    else storage.put(DEFERRED_KEY, ids);
  };

  /** Read `callId`'s record; a storage that fails reads as none. */
  const recordOf = (callId: string) =>
    Effect.try(() => readRecord(callId)).pipe(Effect.orElseSucceed(() => undefined));

  /** Every listed call; a storage that fails reads as none. */
  const listed = Effect.try(deferredIds).pipe(
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  /** The questions of the rounds marked shown, not answered yet. */
  const shownQuestions = (): ReadonlyArray<StoredQuestion> =>
    Arr.flatMap(deferredIds(), (callId) => {
      const record = readRecord(callId);

      return record?.round?.shown === true ? (answerable(record) ?? []) : [];
    });

  /** The forms and pages shown to the owner: those of a round marked shown, not answered yet. */
  const shown = (): ReadonlyArray<McpElicitationRequest> =>
    Arr.filterMap(shownQuestions(), (question) =>
      isElicitation(question) && question.answer === undefined
        ? Result.succeed(question.request)
        : Result.failVoid,
    );

  /** The Sampling requests shown to the owner, not answered yet: a Modern server's, kept with its round. */
  const shownSampling = (): ReadonlyArray<McpSamplingRequest> =>
    Arr.filterMap(shownQuestions(), (question) =>
      isSampling(question) && question.answer === undefined
        ? Result.succeed(question.request)
        : Result.failVoid,
    );

  /** The call's pages are forgotten: a storage that cannot do it leaves them for the storage's own bound. */
  const forgetPages = (callId: string) =>
    Effect.ignore(Effect.try(() => basics.forgetPages(callId)));

  /** Wake the call that waits for `callId`'s round, if one does in this instance: it reads the record again. */
  const wake = (callId: string) =>
    Effect.suspend(() => {
      const signal = rounds.get(callId);

      return signal === undefined ? Effect.void : Deferred.succeed(signal, undefined);
    });

  /**
   * Settle the call's questions and forget its record: each question's settled record says how it ended, an unanswered
   * one cancelled by cloudpid for `reason`. Sealed answers go with the record.
   */
  const settle = (callId: string, reason: string) =>
    Effect.gen(function* () {
      const record = yield* recordOf(callId);

      if (record === undefined) return;

      const now = yield* Clock.currentTimeMillis;

      const questions = yield* Effect.try(() => questionsOf(record)).pipe(
        Effect.orElseSucceed((): ReadonlyArray<DeferredQuestion> => []),
      );

      for (const question of questions) {
        // A Sampling request the round did not run: its record, written waiting, settles refused.
        if (isSampling(question)) {
          yield* Effect.try(() => {
            const held = samples.get(question.request.id);

            if (held === undefined || (held.status !== "waiting" && held.status !== "running"))
              return;

            const given = question.answer?.action === "refuse" ? question.answer : undefined;
            const { why: _earlier, ...rest } = held;
            const why = given === undefined ? "unanswered" : given.why;

            const refused = {
              ...rest,
              status: "refused" as const,
              by: given?.by ?? "cloudpid",
              reason: given?.reason ?? reason,
              settledAt: now,
            };

            samples.put(why === undefined ? refused : { ...refused, why }, now);
          }).pipe(Effect.ignore);

          continue;
        }

        const given = question.answer;

        yield* basics.keep(
          basics.settledOf(
            question.request,
            {
              action: given?.action ?? "cancel",
              by: given?.by ?? "cloudpid",
              reason:
                given === undefined ? reason : given.action === "accept" ? undefined : given.reason,
              // The names of the fields answered: never a value.
              fields: given?.action === "accept" && "fields" in given ? given.fields : [],
              era: eraOf(question),
            },
            question.askedAt,
            now,
          ),
        );
      }

      if (record.round?.shown === true) basics.stopWaiting(callId, record.questions.length, now);

      yield* Effect.try(() => removeRecord(record)).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not drop an MCP call's deferred questions", cause),
        ),
      );
      yield* tell;

      if (Arr.some(questions, isSampling)) yield* tellSampling;
    });

  /**
   * List question `slot` in its call's record and store it, with the `extra` keys it owns. Stored before the round ends:
   * a storage that cannot take it (a replaced Session) keeps nothing (`false`), and the server is told `cancel` in the
   * round's retry, never left with a question nobody can answer.
   */
  const keepQuestion = (
    callId: string,
    server: string,
    slot: string,
    question: StoredQuestion,
    extra: ReadonlyArray<readonly [string, string]> = [],
  ) =>
    Effect.gen(function* () {
      const stored = yield* Effect.try(() => {
        const record = readRecord(callId);

        // A round still stored is one whose resume went out: its questions were settled.
        if (record?.round !== undefined) removeRecord(record);

        const earlier = record === undefined || record.round !== undefined ? [] : record.questions;

        // Listed first: a question whose write fails is dropped with the record, never left behind unlisted.
        writeRecord({ callId, server, questions: [...earlier, slot] });
        storage.put(questionKey(slot), question);

        for (const [key, value] of extra) storage.put(key, value);
      }).pipe(Effect.option);

      if (Option.isSome(stored)) return true;

      // Unlist it again, if the storage takes that much: the round goes on without it.
      yield* Effect.try(() => {
        const record = readRecord(callId);

        storage.delete(questionKey(slot));

        for (const [key] of extra) storage.delete(key);

        if (record === undefined || !record.questions.includes(slot)) return;

        const rest = record.questions.filter((each) => each !== slot);

        if (rest.length === 0) removeRecord(record);
        else writeRecord({ ...record, questions: rest });
      }).pipe(Effect.ignore);

      return false;
    });

  /**
   * Keep `ask` for the call's round: stored, and shown once the round is. It counts toward the call's cap like any
   * request (`"capped"`); a storage that cannot take it leaves nothing kept (`"unrecorded"`).
   */
  const defer = (ask: McpQuestionAsk) =>
    Effect.gen(function* () {
      // A page the owner was done at and the server asks for again is no new request: it does not count toward the call's
      // cap. The pages the owner was done at are kept, so this holds across a restart.
      const again =
        ask.page !== undefined &&
        (yield* Effect.try(() =>
          basics
            .pagesOf(ask.callId)
            .opened.includes(pageIdentityOf(eraOfAsk(ask), ask.key, ask.page?.url)),
        ).pipe(Effect.orElseSucceed(() => false)));

      let sequence: number | string | undefined;

      if (again) {
        const repeated = yield* Effect.try(() => basics.repeatedPage(ask.callId)).pipe(
          Effect.orElseSucceed(() => undefined),
        );

        sequence = repeated === undefined ? undefined : `again${repeated}`;
      } else sequence = yield* basics.count(ask);

      if (sequence === undefined) return "capped" as const;

      const id = questionId(ask.callId, sequence);
      const now = yield* Clock.currentTimeMillis;
      const request = yield* basics.requestOf(ask, id, now + MCP_DEFERRED_DEADLINE_MS, again);

      request.waits = "owner";
      active.add(ask.callId);

      const keptAs: DeferredQuestion =
        ask.page === undefined
          ? { id, key: ask.key, kind: "elicitation", request, askedAt: now, era: eraOfAsk(ask) }
          : {
              id,
              key: ask.key,
              kind: "elicitation",
              request,
              askedAt: now,
              mode: "url",
              era: eraOfAsk(ask),
            };

      const stored = yield* keepQuestion(ask.callId, ask.server, id, keptAs);

      if (stored) return "deferred" as const;

      yield* basics.keep(
        basics.settledOf(
          request,
          { action: "cancel", by: "cloudpid", reason: MCP_QUESTION_UNRECORDED_REASON, fields: [] },
          now,
          now,
        ),
      );

      return "unrecorded" as const;
    });

  /**
   * Keep a Modern server's Sampling request for the call's round (`deferral.params`, redacted, in chunks beside its
   * card): stored, and shown once the round is. `"unrecorded"`: the storage cannot take it (a replaced Session's), or the
   * request is too large to keep, and the request is to be refused.
   */
  const deferSampling = (deferral: McpSamplingDeferral) =>
    Effect.gen(function* () {
      const { request, key, sequence, params } = deferral;
      const now = yield* Clock.currentTimeMillis;
      const text = yield* Schema.encodeEffect(JsonText)(params).pipe(Effect.option);

      if (Option.isNone(text) || text.value.length > MCP_SAMPLING_PARAMS_MAX) {
        return "unrecorded" as const;
      }

      const chunks = Math.max(1, Math.ceil(text.value.length / RESUME_CHUNK));
      const slot = samplingSlot(request.id);

      const question: DeferredSampling = {
        id: slot,
        key,
        kind: "sampling",
        request,
        sequence,
        askedAt: now,
        chunks,
      };

      active.add(request.callId);

      const stored = yield* keepQuestion(
        request.callId,
        request.server,
        slot,
        question,
        Arr.makeBy(chunks, (n) => [
          paramsKey(request.id, n),
          text.value.slice(n * RESUME_CHUNK, (n + 1) * RESUME_CHUNK),
        ]),
      );

      return stored ? ("deferred" as const) : ("unrecorded" as const);
    });

  /** Store the call's round whole: its `ResumeState` beside the questions `defer` kept. Not shown yet. */
  const commitRound = (round: McpDeferredRound) =>
    Effect.gen(function* () {
      const { callId } = round;
      const record = yield* recordOf(callId);

      if (record === undefined || record.questions.length === 0) return yield* unrecorded();

      const text = yield* Schema.encodeEffect(JsonText)(
        McpRoundState.$match(round.state, {
          Resume: ({ state }) => state,
          Resend: ({ state }) => state,
          Read: () => null,
        }),
      ).pipe(Effect.mapError(unrecorded));

      const chunks = Math.max(1, Math.ceil(text.length / RESUME_CHUNK));
      const { asked } = basics.callOf(callId);

      // The record, with its chunk count, first: a chunk whose write fails is dropped with the record (`removeRecord`).
      yield* Effect.try(() => {
        writeRecord({
          ...record,
          round: {
            n: round.round,
            conn: round.conn,
            tool: round.tool,
            chunks,
            asked: round.asked,
            count: asked,
            sampled: basics.callOf(callId).sampled,
            state: stateOf[round.state._tag],
          },
        });

        for (let n = 0; n < chunks; n += 1) {
          storage.put(chunkKey(callId, n), text.slice(n * RESUME_CHUNK, (n + 1) * RESUME_CHUNK));
        }
      }).pipe(Effect.mapError(unrecorded));
    });

  /**
   * Show the call's stored round, once `mcp.wait.<r>` is written: its cards show, and the owner is told as a live
   * question tells. A round already shown (a rerun's) is told to the clients again, never to the owner.
   */
  const showRound = (callId: string) =>
    Effect.gen(function* () {
      const record = yield* recordOf(callId);
      const round = record?.round;

      if (record === undefined || round === undefined) return yield* unrecorded();

      if (round.shown === true) {
        yield* tell;

        if (Arr.some(questionsOf(record), isSampling)) yield* tellSampling;

        return;
      }

      yield* Effect.try(() => writeRecord({ ...record, round: { ...round, shown: true } })).pipe(
        Effect.mapError(unrecorded),
      );

      const now = yield* Clock.currentTimeMillis;

      yield* tell;

      const stored = yield* Effect.try(() => questionsOf(record)).pipe(
        Effect.orElseSucceed((): ReadonlyArray<StoredQuestion> => []),
      );

      const shownPages = Arr.filterMap(stored, (each) =>
        isElicitation(each) && each.request.page !== undefined
          ? Result.succeed(each.request.page)
          : Result.failVoid,
      ) satisfies ReadonlyArray<McpElicitationPage>;

      const hasSampling = Arr.some(stored, isSampling);

      if (hasSampling) yield* tellSampling;

      // A round that is all pages the server asks for again tells the owner nothing: they were told of those already.
      const kind: Mutable<McpWaitingKind> = {};

      if (shownPages.length > 0) kind.page = true;
      // A round of Sampling requests alone asks to use a model; one with a form beside them asks for input.
      else if (hasSampling && Arr.every(stored, isSampling)) kind.sampling = true;

      if (
        shownPages.length === record.questions.length &&
        shownPages.every((page) => page.again === true)
      ) {
        kind.quiet = true;
      }

      yield* basics.startWaiting(callId, record.server, record.questions.length, now, kind);
    });

  /** The round the call stored, when it did and this build can answer it: a rerun of the call waits for it again. */
  const deferredRound = (callId: string) =>
    Effect.gen(function* () {
      const record = yield* recordOf(callId);
      const round = record?.round;

      if (record === undefined || round === undefined) return undefined;

      const questions = yield* Effect.try(() => answerable(record)).pipe(
        Effect.orElseSucceed(() => undefined),
      );

      if (questions === undefined) return undefined;

      const parts = yield* Effect.try(() =>
        Arr.makeBy(round.chunks, (n) => storage.get<string>(chunkKey(callId, n))),
      ).pipe(Effect.orElseSucceed(() => [undefined]));

      if (parts.some((part) => part === undefined)) return undefined;

      const resume = yield* Schema.decodeEffect(JsonText)(parts.join("")).pipe(Effect.option);

      if (Option.isNone(resume)) return undefined;

      // A rerun's call counts on toward its cap, and the owner, told when the round was shown, is not told again.
      basics.restoreCall(callId, {
        count: round.count,
        sampled: round.sampled,
        waiting: round.shown === true ? questions.length : undefined,
      });

      active.add(callId);

      return {
        callId,
        round: round.n,
        conn: round.conn,
        tool: round.tool,
        state: Match.value(round.state).pipe(
          Match.when("read", () => McpRoundState.Read()),
          Match.when("resend", () => McpRoundState.Resend({ state: resume.value })),
          Match.orElse(() => McpRoundState.Resume({ state: resume.value })),
        ),
        asked: round.asked,
      } satisfies McpDeferredRound;
    });

  /**
   * What a Sampling request's kept answer gives the resume: the request as it was kept, and what was decided. A request
   * whose parameters can no longer be read is refused by cloudpid.
   */
  const openedSample = (question: DeferredSampling) =>
    Effect.gen(function* () {
      const parts = yield* Effect.try(() =>
        Arr.makeBy(question.chunks, (n) => storage.get<string>(paramsKey(question.request.id, n))),
      ).pipe(Effect.orElseSucceed(() => [undefined]));

      const params = parts.some((part) => part === undefined)
        ? Option.none<JsonObject>()
        : yield* Schema.decodeEffect(JsonText)(parts.join("")).pipe(
            Effect.option,
            Effect.map(Option.filter(isJsonObject)),
          );

      const given = question.answer;

      const decision: McpSamplingDecision =
        Option.isNone(params) || given === undefined
          ? {
              action: "refuse",
              by: "cloudpid",
              reason:
                given === undefined ? "the request was withdrawn" : MCP_QUESTION_UNRECORDED_REASON,
              why: "unanswered",
            }
          : given.action === "allow"
            ? { action: "allow", role: given.role, grant: given.grant }
            : given.why === undefined
              ? { action: "refuse", by: given.by, reason: given.reason }
              : { action: "refuse", by: given.by, reason: given.reason, why: given.why };

      return {
        key: question.key,
        sample: {
          id: question.request.id,
          sequence: question.sequence,
          params: Option.getOrElse(params, (): JsonObject => ({})),
          decision,
        },
      } satisfies McpDeferredSample;
    });

  /** What a deferred question's kept answer gives the resume: an accepted form's content opened. */
  const opened = (question: DeferredQuestion) =>
    Effect.gen(function* () {
      const given = question.answer;

      // A page needs nothing opened: Done is its `accept`, with no content.
      if (given?.action === "accept" && "page" in given) {
        return {
          key: question.key,
          outcome: { action: "accept", by: "owner", content: {} },
          fields: [],
          page: { host: question.request.page?.host ?? "" },
        } satisfies McpDeferredForm;
      }

      const page =
        question.request.page === undefined ? {} : { page: { host: question.request.page.host } };

      if (given === undefined || given.action !== "accept") {
        const outcome: McpQuestionOutcome =
          given === undefined
            ? cancelled("the question was withdrawn")
            : given.reason === undefined
              ? { action: given.action, by: given.by }
              : { action: given.action, by: given.by, reason: given.reason };

        return { key: question.key, outcome, fields: [], ...page } satisfies McpDeferredForm;
      }

      // Only a form's answer is sealed: the page's was dealt with above.
      if (!("sealed" in given)) {
        return {
          key: question.key,
          outcome: cancelled("the answer could not be opened"),
          fields: [],
        } satisfies McpDeferredForm;
      }

      const content =
        vault === undefined
          ? Option.none<ElicitationContent>()
          : yield* vault
              .open(question.id, given.sealed)
              .pipe(Effect.flatMap(decodeContent), Effect.option);

      if (Option.isNone(content)) {
        return {
          key: question.key,
          outcome: cancelled("the answer could not be opened"),
          fields: [],
        } satisfies McpDeferredForm;
      }

      return {
        key: question.key,
        outcome: { action: "accept", by: "owner", content: content.value },
        fields: given.fields,
      } satisfies McpDeferredForm;
    });

  /**
   * Wait until every question of the call's round has its answer, and give them, accepted content opened. An answer the
   * owner gave while no call waited is taken at once. An interrupted wait (Stop) withdraws the questions and drops the
   * round; one whose sealed answer cannot be opened is a `cancel` of cloudpid's own. `undefined`: the call has no round
   * stored (it was settled meanwhile).
   */
  const awaitRound = (callId: string) =>
    Effect.gen(function* () {
      active.add(callId);

      while (true) {
        // Made before the record is read: an answer that lands between the read and the wait still wakes it.
        const signal = yield* Deferred.make<void>();

        rounds.set(callId, signal);

        const record = yield* recordOf(callId);

        const questions =
          record === undefined
            ? Option.none<ReadonlyArray<StoredQuestion>>()
            : yield* Effect.try(() => questionsOf(record)).pipe(Effect.option);

        if (Option.isNone(questions)) {
          rounds.delete(callId);

          return undefined;
        }

        if (Arr.every(questions.value, (question) => question.answer !== undefined)) {
          rounds.delete(callId);

          return yield* Effect.forEach(
            questions.value,
            (question): Effect.Effect<McpDeferredAnswer> =>
              isSampling(question) ? openedSample(question) : opened(question),
          );
        }

        yield* Deferred.await(signal).pipe(
          Effect.onInterrupt(() =>
            Effect.andThen(
              Effect.sync(() => rounds.delete(callId)),
              settle(callId, MCP_RUN_STOPPED_REASON),
            ),
          ),
        );
      }
    });

  /** The shown, unanswered deferred question `id`, of the kind `matches`. */
  const findShownBy = <Q extends StoredQuestion>(
    id: string,
    matches: (q: StoredQuestion) => q is Q,
  ) => {
    const question = readQuestion(id);
    const record = question === undefined ? undefined : readRecord(question.request.callId);

    return question !== undefined &&
      matches(question) &&
      record?.round?.shown === true &&
      record.questions.includes(id) &&
      question.answer === undefined &&
      answerable(record) !== undefined
      ? question
      : undefined;
  };

  /** The shown, unanswered deferred form or page `id`. */
  const findShown = (id: string) => findShownBy(id, isElicitation);

  /**
   * The owner's answer to a deferred page question (a Legacy `-32042`'s, or a Modern server's): `opened` records Open's
   * click, which answers nothing; `done` ("Done, try again") answers every page of the round `accept` once each is
   * opened, so the call is sent again; a decline or cancel of one answers the whole round the same for a Legacy `-32042`,
   * since sending the call again can change nothing, and only that page for a Modern server.
   */
  const answerPage = (question: DeferredQuestion, given: McpQuestionAnswer) =>
    Effect.gen(function* () {
      if (given.action === "accept") {
        return yield* McpQuestionsError.make({
          message: "This request is a page to open, not a form",
        });
      }

      const unkept = () =>
        McpQuestionsError.make({ message: "The answer could not be kept; try again" });

      const { callId, page } = question.request;

      if (page === undefined) return yield* unkept();

      const settled = yield* Effect.try(() => {
        const record = readRecord(callId);
        const round = record === undefined ? undefined : elicitationsOf(record);
        const open = round?.filter((each) => each.answer === undefined);

        // The first answer wins: read again, in the step that writes.
        if (open === undefined || !open.some((each) => each.id === question.id)) return undefined;

        if (given.action === "opened") {
          storage.put(questionKey(question.id), {
            ...question,
            request: { ...question.request, page: { ...page, opened: true } },
          });

          return "opened" as const;
        }

        // A Modern page that is open is left by Cancel, not Decline (its Decline is for before it was opened); a Legacy
        // `-32042`'s Decline is offered throughout.
        if (
          given.action === "decline" &&
          eraOf(question) === "modern" &&
          open.some((each) => each.id === question.id && each.request.page?.opened === true)
        ) {
          return "opened_page" as const;
        }

        // A Modern round may hold forms beside its pages: Done is about its pages only.
        const pages = open.filter((each) => each.request.page !== undefined);

        if (given.action === "done") {
          const unopened = pages.filter((each) => each.request.page?.opened !== true);

          if (unopened.length > 0) return "unopened" as const;

          basics.openedPages(callId, Arr.map(pages, pageOf));

          for (const each of pages) {
            storage.put(questionKey(each.id), {
              ...each,
              answer: { action: "accept", by: "owner", page: true },
            });
          }

          return "answered" as const;
        }

        // A Legacy `-32042`'s round answers as one, since sending the call again can change nothing; a Modern server's
        // questions are each its own: a declined page never sinks a form beside it.
        for (const each of eraOf(question) === "modern"
          ? open.filter((other) => other.id === question.id)
          : open) {
          storage.put(questionKey(each.id), {
            ...each,
            answer: { action: given.action, by: "owner" },
          });
        }

        return "answered" as const;
      }).pipe(Effect.mapError(unkept));

      if (settled === undefined)
        return yield* McpQuestionsError.make({ message: "This request ended" });

      if (settled === "opened_page") {
        return yield* McpQuestionsError.make({
          message: "This page is open: cancel it instead",
        });
      }

      if (settled === "unopened") {
        return yield* McpQuestionsError.make({ message: "Open every page first" });
      }

      yield* tell;

      if (settled === "answered") yield* wake(callId);

      return true;
    });

  /**
   * The owner's answer to deferred question `id`: kept in the question (sealed, for an accept) for the call's resume.
   * `false`: no such question is deferred.
   */
  const answer = (id: string, given: McpQuestionAnswer) =>
    Effect.gen(function* () {
      const question = yield* Effect.try(() => findShown(id)).pipe(
        Effect.orElseSucceed(() => undefined),
      );

      if (question === undefined) return false;

      if (question.request.page !== undefined) return yield* answerPage(question, given);

      if (given.action === "opened" || given.action === "done") {
        return yield* McpQuestionsError.make({ message: "This request is a form, not a page" });
      }

      let kept: KeptAnswer = { action: "decline", by: "owner" };

      if (given.action !== "accept") kept = { action: given.action, by: "owner" };
      else {
        const content = yield* basics.checkedContent(question.request.form, given.content);

        if (vault === undefined) {
          return yield* McpQuestionsError.make({ message: "This request ended" });
        }

        const text = yield* Schema.encodeEffect(Schema.fromJsonString(ElicitationContent))(
          content,
        ).pipe(
          Effect.mapError(() =>
            McpQuestionsError.make({ message: "The answer does not fit the form" }),
          ),
        );

        const sealed = yield* vault
          .seal(question.id, text)
          .pipe(
            Effect.mapError(() =>
              McpQuestionsError.make({ message: "The answer could not be kept; try again" }),
            ),
          );

        kept = {
          action: "accept",
          by: "owner",
          sealed,
          fields: basics.answeredFields(question.request.form, content),
        };
      }

      // The first answer wins: read again, since another client may have answered while this one was sealed, and
      // written in the same step, so no settle between the two can see its key deleted and then written again.
      const still = yield* Effect.try(() => {
        const found = findShown(id);

        if (found !== undefined) storage.put(questionKey(id), { ...found, answer: kept });

        return found;
      }).pipe(
        Effect.mapError(() =>
          McpQuestionsError.make({ message: "The answer could not be kept; try again" }),
        ),
      );

      if (still === undefined) {
        return yield* McpQuestionsError.make({ message: "This request ended" });
      }

      yield* tell;
      yield* wake(still.request.callId);

      return true;
    });

  /** Server `server`'s deferred questions, answered `cancel` by cloudpid for `reason`, and their calls woken. */
  const withdrawServer = (server: string, reason: string) =>
    Effect.gen(function* () {
      for (const callId of yield* listed) {
        const record = yield* recordOf(callId);

        if (record?.server !== server) continue;

        yield* Effect.try(() => {
          for (const question of questionsOf(record)) {
            if (question.answer !== undefined) continue;

            // A Sampling request has no `cancel`: refused, which ends the call as it does for any refusal.
            if (isSampling(question)) {
              const answer: KeptSampling = {
                action: "refuse",
                by: "cloudpid",
                reason,
                why: "unanswered",
              };

              storage.put(questionKey(question.id), { ...question, answer });

              continue;
            }

            const answer: KeptAnswer = { action: "cancel", by: "cloudpid", reason };

            storage.put(questionKey(question.id), { ...question, answer });
          }
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not withdraw an MCP server's deferred questions", cause),
          ),
        );
        yield* wake(callId);
      }

      yield* tell;
      yield* tellSampling;
    });

  /** The shown, unanswered Sampling request `id` (its record id), as its card answers it. */
  const samplingHeld = (id: string) => {
    try {
      const question = findShownBy(samplingSlot(id), isSampling);

      return question === undefined ? undefined : { request: question.request };
    } catch {
      return undefined;
    }
  };

  /**
   * The owner's decision on Sampling request `id`, kept in its question (`false`: it is not shown or was answered
   * meanwhile: the first answer wins, read again in the step that writes). An allow lets through the call's other
   * unanswered requests, or the server's across calls, each on its own Role. A refusal sinks the round: every other
   * question of it is answered by cloudpid ("the server's call ended"), even a form the owner had answered, and a refusal
   * for the Session or for good sinks the server's other rounds the same way, refusing their requests of it.
   */
  const decideSampling = (id: string, verdict: McpSamplingVerdict) =>
    Effect.gen(function* () {
      const woken = new Set<string>();

      const decided = yield* Effect.try(() => {
        const slot = samplingSlot(id);
        const question = findShownBy(slot, isSampling);

        if (question === undefined) return false;

        const { callId, server } = question.request;

        if (verdict.action === "allow") {
          const answer: KeptSampling = {
            action: "allow",
            role: verdict.role,
            grant: verdict.grant,
          };

          storage.put(questionKey(slot), { ...question, answer });
          woken.add(callId);

          // What the choice covers: the call's other requests, or the server's across calls, each on its own Role.
          for (const other of deferredIds()) {
            const record = readRecord(other);

            if (record?.round?.shown !== true) continue;

            if (verdict.also === "call" ? other !== callId : record.server !== server) continue;

            for (const each of questionsOf(record)) {
              const role = isSampling(each)
                ? ROLE_NAMES.find((name) => name === each.request.role)
                : undefined;

              if (!isSampling(each) || role === undefined) continue;

              if (each.id === slot || each.answer !== undefined) continue;

              storage.put(questionKey(each.id), {
                ...each,
                answer: { action: "allow", role, grant: verdict.grant },
              });
              woken.add(other);
            }
          }

          return true;
        }

        const refused: KeptSampling = { action: "refuse", by: verdict.by, reason: verdict.reason };

        /** `record`'s round sunk: its Sampling requests answered `sampling`, every other question cancelled by cloudpid. */
        const sink = (
          record: DeferredRecord,
          except: string | undefined,
          sampling: KeptSampling,
        ) => {
          for (const each of questionsOf(record)) {
            if (each.id === except) continue;

            storage.put(
              questionKey(each.id),
              isSampling(each)
                ? { ...each, answer: sampling }
                : {
                    ...each,
                    answer: { action: "cancel", by: "cloudpid", reason: MCP_CALL_ENDED_REASON },
                  },
            );
          }

          woken.add(record.callId);
        };

        const record = readRecord(callId);

        if (record === undefined) return false;

        storage.put(questionKey(slot), { ...question, answer: refused });
        // The other questions of its round are withdrawn, the owner's own answers to them too.
        sink(record, slot, sunkSampling);

        // A refusal for the Session or for good sinks the server's other rounds too, refusing what they ask.
        if (verdict.also === "server") {
          for (const other of deferredIds()) {
            const rest = other === callId ? undefined : readRecord(other);

            if (rest?.server === server && rest.round?.shown === true)
              sink(rest, undefined, refused);
          }
        }

        return true;
      }).pipe(Effect.orElseSucceed(() => false));

      if (!decided) return false;

      yield* tell;
      yield* tellSampling;

      for (const callId of woken) yield* wake(callId);

      return true;
    });

  return {
    shown,
    shownSampling,
    samplingHeld,
    decideSampling,
    deferSampling,
    answer,
    defer,
    commitRound,
    showRound,
    deferredRound,
    awaitRound,
    /** The round's resume is on its way (`mcp.resumed.<r>` is written): its questions are settled, the round forgotten. */
    endRound: (callId: string) => settle(callId, MCP_CALL_ENDED_REASON),
    /** The call is over: its questions are settled for `reason`, and this instance forgets it. */
    settleCall: (callId: string, reason: string) =>
      Effect.andThen(
        settle(callId, reason),
        Effect.andThen(
          Effect.sync(() => {
            active.delete(callId);
            rounds.delete(callId);
          }),
          forgetPages(callId),
        ),
      ),
    withdrawServer,
    /** Withdraw every deferred round no call in this instance waits for: their calls ended with an earlier instance. */
    dropAbandoned: Effect.gen(function* () {
      for (const callId of yield* listed) {
        if (active.has(callId)) continue;

        yield* settle(callId, MCP_CALL_ENDED_REASON);
        yield* forgetPages(callId);
      }
    }),
  };
};

export type McpDeferredQuestions = ReturnType<typeof createDeferredQuestions>;
