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
//   is in memory only. Nothing reads the records yet: the call card and `/export` lines that will (#569) are their
//   reader.
// - **The notification** is told of the first question a call waits on, and of a later one only after 2 min with none
//   waiting for that call.
import { MCP_ELICITATION_WAIT_MS } from "@cloudpid/mcp/types";
import {
  createDeferredQuestions,
  type McpDeferredAnswer,
  type McpDeferredRound,
  type McpQuestionVault,
} from "./deferred-questions.ts";
import {
  cancelled,
  questionBasics,
  MCP_CALL_ENDED_REASON,
  MCP_ELICITATION_CAP_REASON,
  MCP_QUESTION_UNRECORDED_REASON,
  MCP_RUN_STOPPED_REASON,
  type McpQuestionAnswer,
  type McpQuestionAsk,
  type McpQuestionOutcome,
  type McpQuestionRecord,
  McpQuestionsError,
  type McpQuestionStorage,
  type McpQuestionUnseen,
  questionId,
} from "./question-records.ts";
import type { McpElicitationRequest } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Mutable } from "effect/Types";

export {
  MCP_DEFERRED_DEADLINE_MS,
  type McpDeferredAnswer,
  type McpDeferredRound,
  type McpQuestionVault,
} from "./deferred-questions.ts";

export {
  MCP_CALL_ENDED_REASON,
  MCP_ELICITATION_CAP_REASON,
  MCP_QUESTION_RECORDS,
  MCP_QUESTION_RENOTIFY_MS,
  MCP_QUESTION_UNRECORDED_REASON,
  MCP_RUN_STOPPED_REASON,
  McpQuestionsError,
  type McpQuestionAnswer,
  type McpQuestionAsk,
  type McpQuestionOutcome,
  type McpQuestionRecord,
  type McpQuestionStorage,
  type McpQuestionUnseen,
} from "./question-records.ts";

const WAITING_KEY = "mcp-question:waiting";

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
  /** Server `server` was switched off, hidden or removed: cancel every question it waits on, and withdraw the cards. */
  readonly withdrawServer: (server: string, reason: string) => Effect.Effect<void>;
  /** The call is done, however it ended: withdraw every question it still waits on, and forget its count. */
  readonly settleCall: (callId: string) => Effect.Effect<void>;
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
  readonly notify?: ((who: { readonly server: string }) => Effect.Effect<void>) | undefined;
  /** `value` with every Secret the Session holds replaced by its reference: all the owner is shown, and all a record keeps. */
  readonly redact: <A>(value: A) => Effect.Effect<A>;
  /**
   * Whether a string the owner entered holds a Secret the Session holds or a deploy-time credential, in any encoding
   * redaction knows; a Secret Reference's placeholder is refused here whatever this says.
   */
  readonly holdsSecret: (text: string) => Effect.Effect<boolean>;
  /** How long a question waits, `MCP_ELICITATION_WAIT_MS` unless a test shortens it. */
  readonly waitMs?: number | undefined;
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
};

/** The Session's MCP questions over its storage. Synchronous: the tools that ask are built before the runtime. */
export const createMcpQuestions = (options: McpQuestionsOptions): McpQuestionsService => {
  const { storage, announce } = options;
  const waitMs = options.waitMs ?? MCP_ELICITATION_WAIT_MS;
  const waiting = new Map<string, Waiting>();
  const basics = questionBasics(options);
  const { keep } = basics;

  const tell: Effect.Effect<void> = Effect.suspend(() => pending.pipe(Effect.flatMap(announce)));

  const deferred = createDeferredQuestions({ storage, vault: options.vault, basics, tell });

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
      yield* keep(
        basics.settledOf(
          request,
          {
            action: outcome.action,
            by: outcome.by,
            reason: outcome.action === "accept" ? undefined : outcome.reason,
            // The names of the fields answered: never a value.
            fields:
              outcome.action === "accept"
                ? basics.answeredFields(request.form, outcome.content)
                : [],
          },
          entry.askedAt,
          now,
        ),
      );
      yield* Deferred.succeed(held.outcome, outcome);
      yield* tell;

      return true;
    });

  const ask = (question: McpQuestionAsk): Effect.Effect<McpQuestionOutcome> =>
    Effect.gen(function* () {
      const sequence = yield* basics.count(question);

      if (sequence === undefined) return cancelled(MCP_ELICITATION_CAP_REASON);

      const id = questionId(question.callId, sequence);
      const now = yield* Clock.currentTimeMillis;
      const request = yield* basics.requestOf(question, id, now + waitMs);

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
            { action: "cancel", by: "cloudpid", reason, fields: [] },
            now,
            now,
          ),
        );

        return cancelled(reason);
      }

      const outcome = yield* Deferred.make<McpQuestionOutcome>();

      waiting.set(id, { key: question.key, request, entry, outcome });
      yield* tell;
      yield* basics.startWaiting(question.callId, question.server, 1, now);

      yield* Deferred.await(outcome).pipe(
        Effect.timeoutOption(waitMs),
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

  const answer: McpQuestionsService["answer"] = (id, given) =>
    Effect.gen(function* () {
      const held = waiting.get(id);

      if (held === undefined) {
        if (yield* deferred.answer(id, given)) return;

        return yield* McpQuestionsError.make({ message: "This request ended" });
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

  const settleCall = (callId: string) =>
    Effect.gen(function* () {
      yield* endWhere((held) => held.request.callId === callId, MCP_CALL_ENDED_REASON);
      yield* deferred.settleCall(callId, MCP_CALL_ENDED_REASON);
      basics.calls.delete(callId);
    });

  const unseen: McpQuestionsService["unseen"] = (form) =>
    Effect.gen(function* () {
      const sequence = yield* basics.count(form);

      if (sequence === undefined) return "capped" as const;

      const now = yield* Clock.currentTimeMillis;
      const shown = yield* basics.shownOf(form);

      const record: Mutable<McpQuestionRecord> = {
        id: questionId(form.callId, sequence),
        callId: form.callId,
        conversationId: form.conversationId,
        server: form.server,
        tool: form.tool,
        mode: "form",
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
    withdraw: (callId, key, reason) =>
      endWhere((held) => held.request.callId === callId && held.key === key, reason),
    withdrawServer: (server, reason) =>
      Effect.andThen(
        endWhere((held) => held.request.server === server, reason),
        deferred.withdrawServer(server, reason),
      ),
    settleCall,
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
    records: basics.records,
  } satisfies McpQuestionsService;
};
