// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
// A server's questions kept for later (`docs/architecture/mcp-server-requests.md` → The waiting-question record,
// Elicitation requests; ADR-0041): the deferred half of the Session's MCP questions (`questions.ts`). A Modern server's
// round, and a Legacy server's `-32042` (its pages, #487), end the call as `input_required` or `pages_required` and are
// stored whole, so they survive the instance: a rerun of the call finds the round and waits again, and the cards show
// from it, so an answer the owner gives while no call waits is still kept. A round of pages is sent again by `resend`
// (`McpDeferredRound.resend`), a Modern round by `resume`.
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
// - **A kind per question:** `elicitation`, and `sampling` once Sampling requests are deferred too
//   ([#486](https://github.com/ian-pascoe/cloudpid/issues/486)); a question stored without one is an elicitation. This
//   build shows and answers elicitations only: a round with any other kind is not waited for again.
import {
  ElicitationContent,
  type McpElicitationPage,
  type McpElicitationRequest,
} from "@cloudpid/protocol";
import type { SealedValue, SecretVaultError } from "../secrets/vault.ts";
import type { McpElicitationDetail } from "./details.ts";
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
  questionId,
} from "./question-records.ts";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";

const DEFERRED_KEY = "mcp-question:deferred";
const deferredKey = (callId: string) => `mcp-question:d:${callId}`;
const chunkKey = (callId: string, n: number) => `${deferredKey(callId)}:${n}`;
const questionKey = (id: string) => `mcp-question:q:${id}`;

/** The most characters of a `ResumeState`'s JSON one storage value holds: 32 Ki, at most 96 KiB as UTF-8. */
const RESUME_CHUNK = 32 * 1024;

/**
 * The `deadline` a deferred question's request carries for a client from before `waits`, which needs one: 30 days, far
 * past any wait. A client that knows `waits` ignores it.
 */
export const MCP_DEFERRED_DEADLINE_MS = 30 * 24 * 60 * 60 * 1000;

/** What a deferred question asks for: an elicitation form, or (not deferred yet, #486) a Sampling request. */
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
  readonly kind?: DeferredKind;
  readonly request: McpElicitationRequest;
  readonly askedAt: number;
  readonly answer?: KeptAnswer;
  /** The Protocol era of the server that asked; absent reads as Modern (a Legacy `-32042` round is `legacy`). */
  readonly era?: "legacy";
  /** What it asks: a form, or a page to open; absent reads as a form. */
  readonly mode?: "form" | "url";
};

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
    /** The state is a `ResendState`: a round of pages. */
    readonly resend?: true | undefined;
    readonly asked: ReadonlyArray<McpElicitationDetail>;
    /** The requests the call had made, toward its cap, so a rerun counts on from them. */
    readonly count: number;
    /** Whether its cards show: set once `mcp.wait.<r>` is written. */
    readonly shown?: boolean;
  };
};

const kindOf = (question: DeferredQuestion): DeferredKind => question.kind ?? "elicitation";

/** Seals and opens an accepted Modern form's content while it waits for its resume, bound to the question's id. */
export type McpQuestionVault = {
  readonly seal: (id: string, text: string) => Effect.Effect<SealedValue, SecretVaultError>;
  readonly open: (id: string, sealed: SealedValue) => Effect.Effect<string, SecretVaultError>;
};

/** What became of a deferred question, the accepted content opened: the call's resume sends it, `details` notes it. */
export type McpDeferredAnswer = {
  readonly key: string;
  readonly outcome: McpQuestionOutcome;
  /** The names of the fields the owner answered. */
  readonly fields: ReadonlyArray<string>;
  /** The host of the page, when it was a page question. */
  readonly page?: { readonly host: string };
};

/** A Modern call's round of questions, stored whole: what a resume is sent from. */
export type McpDeferredRound = {
  readonly callId: string;
  /** The round's number, from 1: the `mcp.wait.<r>` and `mcp.resumed.<r>` markers name it. */
  readonly round: number;
  /** The server's connection key when it asked: a resume on another one is refused. */
  readonly conn: string;
  /** The server's own name for the tool. */
  readonly tool: string;
  /** The `ResumeState`, as the host gave it; for a round of pages (`resend`), the `ResendState`. */
  readonly resume: Schema.Json;
  /** The round is a Legacy `-32042`'s pages: the call is sent again with `resend`, not `resume`. */
  readonly resend?: true | undefined;
  /** What became of the call's questions so far, for its `details`: never a value. */
  readonly asked: ReadonlyArray<McpElicitationDetail>;
};

export type McpDeferredQuestionsOptions = {
  readonly storage: McpQuestionStorage;
  readonly vault: McpQuestionVault | undefined;
  readonly basics: McpQuestionBasics;
  /** Tell the clients which questions wait. */
  readonly tell: Effect.Effect<void>;
};

const unrecorded = () => McpQuestionsError.make({ message: MCP_QUESTION_UNRECORDED_REASON });

const decodeContent = Schema.decodeEffect(Schema.fromJsonString(ElicitationContent));

/** The deferred questions over the Session's storage (see the file's header). */
export const createDeferredQuestions = (options: McpDeferredQuestionsOptions) => {
  const { storage, vault, basics, tell } = options;

  /** Calls of this instance waiting for their round, by call: what wakes the wait when an answer comes. */
  const rounds = new Map<string, Deferred.Deferred<void>>();
  /** Calls of this instance that deferred a question: their records are no earlier instance's. */
  const active = new Set<string>();

  const deferredIds = (): ReadonlyArray<string> => storage.get<string[]>(DEFERRED_KEY) ?? [];

  const readRecord = (callId: string): DeferredRecord | undefined =>
    storage.get<DeferredRecord>(deferredKey(callId));

  const readQuestion = (id: string): DeferredQuestion | undefined =>
    storage.get<DeferredQuestion>(questionKey(id));

  /** The record's questions that are stored. */
  const questionsOf = (record: DeferredRecord): ReadonlyArray<DeferredQuestion> =>
    Arr.filterMap(record.questions, (id) =>
      Result.fromNullishOr(readQuestion(id), () => undefined),
    );

  /**
   * The record's questions, when this build can answer every one: all stored, and all elicitations. A record holding
   * another kind (a Sampling request, from a later build) is neither shown, answered nor waited for again.
   */
  const answerable = (record: DeferredRecord): ReadonlyArray<DeferredQuestion> | undefined => {
    const questions = questionsOf(record);

    return questions.length === record.questions.length &&
      questions.every((question) => kindOf(question) === "elicitation")
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

    for (const id of record.questions) storage.delete(questionKey(id));

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

  /** The questions shown to the owner: the elicitations of a round marked shown, not answered yet. */
  const shown = (): ReadonlyArray<McpElicitationRequest> =>
    Arr.flatMap(deferredIds(), (callId) => {
      const record = readRecord(callId);
      const questions = record?.round?.shown === true ? (answerable(record) ?? []) : ([] as const);

      return Arr.filterMap(questions, (question) =>
        question.answer === undefined ? Result.succeed(question.request) : Result.failVoid,
      );
    });

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
        // A Sampling request's record comes with Sampling (#486).
        if (kindOf(question) !== "elicitation") continue;

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
              era: question.era,
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
        (yield* Effect.try(() => basics.pagesOf(ask.callId).opened.includes(ask.key)).pipe(
          Effect.orElseSucceed(() => false),
        ));

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

      // Stored before the round ends: a storage that cannot take it (a replaced Session) keeps nothing, and the server
      // is told `cancel` in the round's retry, never left with a question nobody can answer.
      const stored = yield* Effect.try(() => {
        const record = readRecord(ask.callId);

        // A round still stored is one whose resume went out: its questions were settled.
        if (record?.round !== undefined) removeRecord(record);

        const earlier = record === undefined || record.round !== undefined ? [] : record.questions;

        const question: DeferredQuestion = {
          id,
          key: ask.key,
          kind: "elicitation",
          request,
          askedAt: now,
        };

        // A page is a Legacy `-32042`'s until Modern asks for one too (#493).
        const keptAs: DeferredQuestion =
          ask.page === undefined ? question : { ...question, mode: "url", era: "legacy" };

        // Listed first: a question whose write fails is dropped with the record, never left behind unlisted.
        writeRecord({ callId: ask.callId, server: ask.server, questions: [...earlier, id] });
        storage.put(questionKey(id), keptAs);
      }).pipe(Effect.option);

      if (Option.isSome(stored)) return "deferred" as const;

      // Unlist it again, if the storage takes that much: the round goes on without it.
      yield* Effect.try(() => {
        const record = readRecord(ask.callId);

        storage.delete(questionKey(id));

        if (record === undefined || !record.questions.includes(id)) return;

        const rest = record.questions.filter((each) => each !== id);

        if (rest.length === 0) removeRecord(record);
        else writeRecord({ ...record, questions: rest });
      }).pipe(Effect.ignore);

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

  /** Store the call's round whole: its `ResumeState` beside the questions `defer` kept. Not shown yet. */
  const commitRound = (round: McpDeferredRound) =>
    Effect.gen(function* () {
      const { callId } = round;
      const record = yield* recordOf(callId);

      if (record === undefined || record.questions.length === 0) return yield* unrecorded();

      const text = yield* Schema.encodeEffect(JsonText)(round.resume).pipe(
        Effect.mapError(unrecorded),
      );

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
            resend: round.resend,
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

      if (round.shown === true) return yield* tell;

      yield* Effect.try(() => writeRecord({ ...record, round: { ...round, shown: true } })).pipe(
        Effect.mapError(unrecorded),
      );

      const now = yield* Clock.currentTimeMillis;

      yield* tell;

      const shownPages = yield* Effect.try(() => questionsOf(record)).pipe(
        Effect.map(
          Arr.filterMap((each) =>
            each.request.page === undefined ? Result.failVoid : Result.succeed(each.request.page),
          ),
        ),
        Effect.orElseSucceed((): ReadonlyArray<McpElicitationPage> => []),
      );

      // A round that is all pages the server asks for again tells the owner nothing: they were told of those already.
      const kind: Mutable<McpWaitingKind> = {};

      if (shownPages.length > 0) kind.page = true;

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
        waiting: round.shown === true ? questions.length : undefined,
      });

      active.add(callId);

      return {
        callId,
        round: round.n,
        conn: round.conn,
        tool: round.tool,
        resume: resume.value,
        asked: round.asked,
        resend: round.resend,
      } satisfies McpDeferredRound;
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
        } satisfies McpDeferredAnswer;
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

        return { key: question.key, outcome, fields: [], ...page } satisfies McpDeferredAnswer;
      }

      // Only a form's answer is sealed: the page's was dealt with above.
      if (!("sealed" in given)) {
        return {
          key: question.key,
          outcome: cancelled("the answer could not be opened"),
          fields: [],
        } satisfies McpDeferredAnswer;
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
        } satisfies McpDeferredAnswer;
      }

      return {
        key: question.key,
        outcome: { action: "accept", by: "owner", content: content.value },
        fields: given.fields,
      } satisfies McpDeferredAnswer;
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
            ? Option.none<ReadonlyArray<DeferredQuestion>>()
            : yield* Effect.try(() => questionsOf(record)).pipe(Effect.option);

        if (Option.isNone(questions)) {
          rounds.delete(callId);

          return undefined;
        }

        if (Arr.every(questions.value, (question) => question.answer !== undefined)) {
          rounds.delete(callId);

          return yield* Effect.forEach(questions.value, opened);
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

  /** The shown, unanswered deferred question `id`. */
  const findShown = (id: string) => {
    const question = readQuestion(id);
    const record = question === undefined ? undefined : readRecord(question.request.callId);

    return question !== undefined &&
      record?.round?.shown === true &&
      record.questions.includes(id) &&
      question.answer === undefined &&
      answerable(record) !== undefined
      ? question
      : undefined;
  };

  /**
   * The owner's answer to a deferred page question (a Legacy `-32042`'s): `opened` records Open's click, which answers
   * nothing; `done` ("Done, try again") answers every page of the round `accept` once each is opened, so the call is sent
   * again; a decline or cancel of one answers the whole round the same, since sending the call again can change nothing.
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
        const round = record === undefined ? undefined : questionsOf(record);
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

        if (given.action === "done") {
          const unopened = open.filter((each) => each.request.page?.opened !== true);

          if (unopened.length > 0) return "unopened" as const;

          basics.openedPages(
            callId,
            Arr.map(open, (each) => each.key),
          );

          for (const each of open) {
            storage.put(questionKey(each.id), {
              ...each,
              answer: { action: "accept", by: "owner", page: true },
            });
          }

          return "answered" as const;
        }

        for (const each of open) {
          storage.put(questionKey(each.id), {
            ...each,
            answer: { action: given.action, by: "owner" },
          });
        }

        return "answered" as const;
      }).pipe(Effect.mapError(unkept));

      if (settled === undefined)
        return yield* McpQuestionsError.make({ message: "This request ended" });

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
    });

  return {
    shown,
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
