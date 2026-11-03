// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off preferSchemaOverJson:off
// The questions an MCP server asks the owner during a call (`docs/architecture/mcp-server-requests.md` → Questions, The
// waiting-question record, Elicitation requests; ADR-0037, ADR-0041): what a Legacy server's elicitation form becomes
// in the Session. A form waits here, in memory, for the owner's answer from any client: the first answer wins, a late
// one is refused. It lives only as long as its call waits (ADR-0037), so nothing survives an eviction: a new instance
// finds the records of the questions the old one left waiting and expires them ("the server's call ended").
//
// - **Never a value.** The owner's answer goes from `answer` to the waiting call through a `Deferred`, in memory, and
//   nowhere else: the waiting record holds the form the owner saw, and the settled record the names of the fields
//   answered, never what was entered. A value that holds a Secret (as the Session knows them, or a Secret Reference's
//   placeholder) is bounced to the card, nothing kept.
// - **One record per question** in the Session's storage (an implementation word): `mcp-question:waiting` lists the
//   questions waiting (small: who asks, which call, when), and each question that ended leaves a settled record
//   `mcp-question:s:<id>`, the newest `MCP_QUESTION_RECORDS` kept, with the message and form the owner was shown
//   (redacted of held Secrets). The full request is in memory only. Nothing reads the records yet: the call card and
//   `/export` lines that will (#569) are their reader.
// - **The notification** is told of the first question a call waits on, and of a later one only after 2 min with none
//   waiting for that call.
//
// A Modern server's form is kept for later instead (`defer`): its call ends its round as `input_required`, and the
// round is stored whole in the call's deferred record `mcp-question:d:<callId>` (the questions as the owner is shown
// them, the server's `conn`, the round's number and the `ResumeState`, in chunks of `RESUME_CHUNK` characters under
// `mcp-question:d:<callId>:<n>`), listed in `mcp-question:deferred`. It survives the instance: a rerun of the call
// finds it (`deferredRound`) and waits again (`awaitRound`), and the cards show from it, so an owner who answers
// while no call waits still has the answer kept. An accepted form's content is sealed in the record (the `vault`,
// AES-GCM) until the round's resume is built; the record goes with the call's end (`settleCall`), Stop, or, for a call
// gone with an earlier instance, the Session going idle (`dropAbandoned`).
// (`docs/architecture/mcp-server-requests.md` → The waiting-question record, Elicitation requests: Values are never
// kept.)
import {
  answeredFields,
  MCP_ELICITATION_WAIT_MS,
  MCP_ELICITATIONS_PER_CALL,
  validateElicitation,
} from "@cloudpid/mcp/types";
import { holdsPlaceholder } from "../secrets/references.ts";
import type { SealedValue, SecretVaultError } from "../secrets/vault.ts";
import type { McpElicitationDetail } from "./details.ts";
import type {
  ElicitationContent,
  ElicitationForm,
  McpElicitationRequest,
  McpElicitationSource,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type { Mutable } from "effect/Types";

/** The Durable Object's synchronous key-value storage, as the questions use it. */
export type McpQuestionStorage = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
};

/** How long a call's later question waits to be told to the owner: after this long with none waiting, in ms. */
export const MCP_QUESTION_RENOTIFY_MS = 2 * 60 * 1000;

/** How many settled records are kept; the oldest go first. */
export const MCP_QUESTION_RECORDS = 100;

/** The most bytes a settled record holds (past it, its form is left out). */
const MAX_RECORD_BYTES = 64 * 1024;

/** Why a request past the call's cap of `MCP_ELICITATIONS_PER_CALL` is cancelled. */
export const MCP_ELICITATION_CAP_REASON = "elicitation limit for this call reached";

const WAITING_KEY = "mcp-question:waiting";
const SETTLED_KEY = "mcp-question:settled";
const settledKey = (id: string) => `mcp-question:s:${id}`;
const DEFERRED_KEY = "mcp-question:deferred";
const deferredKey = (callId: string) => `mcp-question:d:${callId}`;
const chunkKey = (callId: string, n: number) => `${deferredKey(callId)}:${n}`;

/** The most characters of a `ResumeState`'s JSON one storage value holds: 32 Ki, at most 96 KiB as UTF-8. */
const RESUME_CHUNK = 32 * 1024;

/** A deferred question's answer as the record keeps it: an accepted form's content sealed, never in the clear. */
type KeptAnswer =
  | {
      readonly action: "accept";
      readonly by: "owner";
      readonly sealed: SealedValue;
      readonly fields: ReadonlyArray<string>;
    }
  | {
      readonly action: "decline" | "cancel";
      readonly by: "owner" | "cloudpid";
      readonly reason?: string;
    };

/** A Modern server's question kept for later: what the owner is shown, and once given, the answer. */
type DeferredQuestion = {
  readonly id: string;
  readonly key: string;
  readonly request: McpElicitationRequest;
  readonly askedAt: number;
  readonly answer?: KeptAnswer;
};

/** A call's deferred record: its questions, and once the round is stored whole, the round. */
type DeferredRecord = {
  readonly callId: string;
  readonly questions: ReadonlyArray<DeferredQuestion>;
  readonly round?: {
    readonly n: number;
    readonly conn: string;
    readonly tool: string;
    /** How many chunks the `ResumeState` is stored in. */
    readonly chunks: number;
    readonly asked: ReadonlyArray<McpElicitationDetail>;
    /** The requests the call had made, toward its cap, so a rerun counts on from them. */
    readonly count: number;
  };
};

/** An answer could not be taken: the question ended, or the answer is not valid for its form. */
export class McpQuestionsError extends Schema.TaggedError<
  McpQuestionsError,
  { readonly brand: unique symbol }
>()("McpQuestionsError", { message: Schema.String }) {}

/** A question as the call that gets it asks it: what the owner is shown, already plain text. */
export type McpQuestionAsk = {
  /** The question's key within its call: the server's request. */
  readonly key: string;
  /** The call that waits for the answer. */
  readonly callId: string;
  readonly conversationId: McpElicitationRequest["conversationId"];
  /** The server's configured name, and where its definition is. */
  readonly server: string;
  readonly source?: McpElicitationSource;
  /** The model-facing name of the tool the call is to. */
  readonly tool: string;
  readonly message: string;
  readonly form: ElicitationForm;
  readonly notes: ReadonlyArray<string>;
};

/** How a question ended. An accepted form's `content` is in memory only: it goes to the server and nowhere else. */
export type McpQuestionOutcome =
  | { readonly action: "accept"; readonly by: "owner"; readonly content: ElicitationContent }
  | {
      readonly action: "decline" | "cancel";
      readonly by: "owner" | "cloudpid";
      readonly reason?: string;
    };

/** A form cloudpid ended before showing it: a credential, or a malformed form. */
export type McpQuestionUnseen = Omit<McpQuestionAsk, "key" | "form" | "notes" | "source"> & {
  readonly form?: ElicitationForm;
  readonly notes?: ReadonlyArray<string>;
  readonly action: "decline" | "cancel";
  readonly reason: string;
};

/** The settled record of a question (`docs/architecture/mcp-server-requests.md` → Elicitation requests, Records). Never a value. */
export type McpQuestionRecord = {
  readonly id: string;
  readonly callId: string;
  readonly conversationId: McpElicitationRequest["conversationId"];
  readonly server: string;
  readonly tool: string;
  readonly mode: "form";
  /** The message as the owner was shown it: redacted of the Secrets the Session held. */
  readonly message: string;
  readonly form?: ElicitationForm;
  readonly notes: ReadonlyArray<string>;
  readonly action: "accept" | "decline" | "cancel";
  readonly by: "owner" | "cloudpid";
  readonly reason?: string;
  /** The names of the fields the owner answered; no value. */
  readonly fields: ReadonlyArray<string>;
  readonly askedAt: number;
  readonly settledAt: number;
};

/** A question waiting, as the storage keeps it: who asks and when, so a new instance can expire it. */
type WaitingEntry = {
  readonly id: string;
  readonly callId: string;
  readonly conversationId: McpElicitationRequest["conversationId"];
  readonly server: string;
  readonly tool: string;
  readonly askedAt: number;
};

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
  /** The `ResumeState`, as the host gave it. */
  readonly resume: Schema.Json;
  /** What became of the call's questions so far, for its `details`: never a value. */
  readonly asked: ReadonlyArray<McpElicitationDetail>;
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
    answer:
      | { readonly action: "accept"; readonly content: ElicitationContent }
      | { readonly action: "decline" | "cancel" },
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
   * Keep `ask`, a Modern server's form, for the call's round: stored, and shown once the round is (`commitRound`). It
   * counts toward the call's cap like any request (`"capped"`); a storage that cannot take it (a replaced Session)
   * leaves nothing kept (`"unrecorded"`), and the server is to be told `cancel`.
   */
  readonly defer: (ask: McpQuestionAsk) => Effect.Effect<"deferred" | "capped" | "unrecorded">;
  /**
   * Store the call's round whole: its `ResumeState` beside the questions `defer` kept, which are shown from now on and
   * told to the owner as `ask` tells. Fails when the storage cannot take it.
   */
  readonly commitRound: (round: McpDeferredRound) => Effect.Effect<void, McpQuestionsError>;
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

/** What a call has asked, and whether the owner was told. */
type CallState = {
  /** Requests the call made, counted toward its cap: a question, or a form cloudpid ended unseen. */
  asked: number;
  /** Requests turned away at the cap, to give their records an id. */
  capped: number;
  waiting: number;
  notified: boolean;
  idleSince: number;
};

type Waiting = {
  readonly key: string;
  readonly request: McpElicitationRequest;
  readonly entry: WaitingEntry;
  readonly outcome: Deferred.Deferred<McpQuestionOutcome>;
};

/** A question's id: unique within the Session, and within its call whatever the server's own request ids are. */
const questionId = (callId: string, sequence: number | string) => `${callId}:${sequence}`;

/** The strings an accepted form's content holds, to check each against the Session's Secrets. */
const stringsOf = (content: ElicitationContent): ReadonlyArray<readonly [string, string]> => {
  const found: Array<readonly [string, string]> = [];

  for (const [name, value] of Record.toEntries(content)) {
    if (Predicate.isString(value)) found.push([name, value]);
    else if (!Predicate.isNumber(value) && !Predicate.isBoolean(value)) {
      for (const item of value) found.push([name, item]);
    }
  }

  return found;
};

const cancelled = (reason: string): McpQuestionOutcome => ({
  action: "cancel",
  by: "cloudpid",
  reason,
});

/** The Session's MCP questions over its storage. Synchronous: the tools that ask are built before the runtime. */
export const createMcpQuestions = (options: McpQuestionsOptions): McpQuestionsService => {
  const { storage, announce } = options;
  const waitMs = options.waitMs ?? MCP_ELICITATION_WAIT_MS;
  const waiting = new Map<string, Waiting>();
  const calls = new Map<string, CallState>();

  const { vault } = options;

  /** Calls of this instance with deferred questions, by call: what wakes the call's wait for its round. */
  const rounds = new Map<string, Deferred.Deferred<void>>();
  /** Calls of this instance that deferred a question: their records are no earlier instance's. */
  const active = new Set<string>();

  const deferredIds = (): ReadonlyArray<string> => storage.get<string[]>(DEFERRED_KEY) ?? [];

  const readDeferred = (callId: string): DeferredRecord | undefined =>
    storage.get<DeferredRecord>(deferredKey(callId));

  /** Store `record`, listed. Throws when the storage cannot take it. */
  const writeDeferred = (record: DeferredRecord) => {
    storage.put(deferredKey(record.callId), record);

    const ids = deferredIds();

    if (!ids.includes(record.callId)) storage.put(DEFERRED_KEY, [...ids, record.callId]);
  };

  /** Forget the call's record and its `ResumeState`. Throws when the storage cannot take it. */
  const removeDeferred = (callId: string, record: DeferredRecord | undefined) => {
    for (let n = 0; n < (record?.round?.chunks ?? 0); n += 1) storage.delete(chunkKey(callId, n));

    storage.delete(deferredKey(callId));

    const ids = deferredIds().filter((id) => id !== callId);

    if (ids.length === 0) storage.delete(DEFERRED_KEY);
    else storage.put(DEFERRED_KEY, ids);
  };

  /** The deferred questions shown to the owner: those of a stored round, not answered yet. */
  const shownDeferred = (): ReadonlyArray<McpElicitationRequest> =>
    Arr.flatMap(deferredIds(), (callId) => {
      const record = readDeferred(callId);

      return record?.round === undefined
        ? []
        : Arr.filterMap(record.questions, (question) =>
            question.answer === undefined ? Result.succeed(question.request) : Result.failVoid,
          );
    });

  const pending = Effect.sync(() => [
    ...Arr.map([...waiting.values()], (held) => held.request),
    ...shownDeferred(),
  ]);

  const tell = Effect.suspend(() => pending.pipe(Effect.flatMap(announce)));

  const entries = (): ReadonlyArray<WaitingEntry> => storage.get<WaitingEntry[]>(WAITING_KEY) ?? [];

  const putEntries = (next: ReadonlyArray<WaitingEntry>) => {
    if (next.length === 0) storage.delete(WAITING_KEY);
    else storage.put(WAITING_KEY, next);
  };

  /** Keep `record`, and drop the oldest past the bound. */
  const keepNow = (record: McpQuestionRecord) => {
    const bytes = JSON.stringify(record).length;

    const stored: McpQuestionRecord =
      bytes <= MAX_RECORD_BYTES || record.form === undefined
        ? record
        : {
            ...Struct.omit(record, ["form"]),
            notes: [...record.notes, "the form was left out: over 64 KiB"],
          };

    const ids = [
      ...(storage.get<string[]>(SETTLED_KEY) ?? []).filter((id) => id !== record.id),
      record.id,
    ];

    const dropped = ids.slice(0, Math.max(0, ids.length - MCP_QUESTION_RECORDS));

    storage.put(settledKey(record.id), stored);

    for (const id of dropped) storage.delete(settledKey(id));

    storage.put(SETTLED_KEY, ids.slice(dropped.length));
  };

  /**
   * Keep `record`. A storage that fails loses the record, never the answer, and leaves no card behind: it is logged
   * (the cause holds no value, only storage's own error).
   */
  const keep = (record: McpQuestionRecord) =>
    Effect.try(() => keepNow(record)).pipe(
      Effect.catch((cause) => Effect.logWarning("Could not keep an MCP question's record", cause)),
    );

  const callOf = (callId: string): CallState => {
    const held = calls.get(callId) ?? {
      asked: 0,
      capped: 0,
      waiting: 0,
      notified: false,
      idleSince: 0,
    };

    calls.set(callId, held);

    return held;
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

      const state = callOf(request.callId);

      state.waiting = Math.max(0, state.waiting - 1);

      if (state.waiting === 0) state.idleSince = now;

      const record: Mutable<McpQuestionRecord> = {
        id,
        callId: request.callId,
        conversationId: request.conversationId,
        server: request.server,
        tool: request.tool,
        mode: "form",
        message: request.message,
        form: request.form,
        notes: request.notes,
        action: outcome.action,
        by: outcome.by,
        // The names of the fields answered: never a value.
        fields: outcome.action === "accept" ? answeredFields(request.form, outcome.content) : [],
        askedAt: entry.askedAt,
        settledAt: now,
      };

      if (outcome.action !== "accept" && outcome.reason !== undefined) {
        record.reason = outcome.reason;
      }

      yield* Effect.try(() => putEntries(entries().filter((other) => other.id !== id))).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not update the waiting MCP questions", cause),
        ),
      );
      yield* keep(record);
      yield* Deferred.succeed(held.outcome, outcome);
      yield* tell;

      return true;
    });

  /** What a record keeps of text the owner was shown or would have been: redacted of the Secrets the Session holds. */
  const shownOf = (ask: {
    readonly message: string;
    readonly form?: ElicitationForm | undefined;
    readonly notes?: ReadonlyArray<string> | undefined;
    readonly reason?: string;
  }) =>
    options.redact({
      message: ask.message,
      form: ask.form,
      notes: ask.notes ?? [],
      reason: ask.reason,
    });

  /** A request turned away at the call's cap, recorded. */
  const turnedAway = (
    ask: Omit<McpQuestionAsk, "key" | "form" | "notes" | "source"> & {
      readonly form?: ElicitationForm;
      readonly notes?: ReadonlyArray<string>;
    },
  ) =>
    Effect.gen(function* () {
      const state = callOf(ask.callId);
      const now = yield* Clock.currentTimeMillis;
      const reason = MCP_ELICITATION_CAP_REASON;
      const shown = yield* shownOf({ ...ask, reason });

      state.capped += 1;

      const record: Mutable<McpQuestionRecord> = {
        id: questionId(ask.callId, `cap${state.capped}`),
        callId: ask.callId,
        conversationId: ask.conversationId,
        server: ask.server,
        tool: ask.tool,
        mode: "form",
        message: shown.message,
        notes: shown.notes,
        action: "cancel",
        by: "cloudpid",
        reason,
        fields: [],
        askedAt: now,
        settledAt: now,
      };

      if (shown.form !== undefined) record.form = shown.form;

      yield* keep(record);

      return { action: "cancel", by: "cloudpid", reason } satisfies McpQuestionOutcome;
    });

  const ask = (question: McpQuestionAsk): Effect.Effect<McpQuestionOutcome> =>
    Effect.gen(function* () {
      const state = callOf(question.callId);

      if (state.asked >= MCP_ELICITATIONS_PER_CALL) return yield* turnedAway(question);

      state.asked += 1;

      const id = questionId(question.callId, state.asked);
      const now = yield* Clock.currentTimeMillis;

      const shown = yield* options.redact({
        message: question.message,
        form: question.form,
        notes: question.notes,
      });

      const request: Mutable<McpElicitationRequest> = {
        id,
        callId: question.callId,
        conversationId: question.conversationId,
        server: question.server,
        tool: question.tool,
        message: shown.message,
        form: shown.form,
        notes: shown.notes,
        deadline: now + waitMs,
      };

      if (question.source !== undefined) request.source = question.source;

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
        const reason = "cloudpid could not record the question";

        yield* keep({
          id,
          callId: question.callId,
          conversationId: question.conversationId,
          server: question.server,
          tool: question.tool,
          mode: "form",
          message: shown.message,
          form: shown.form,
          notes: shown.notes,
          action: "cancel",
          by: "cloudpid",
          reason,
          fields: [],
          askedAt: now,
          settledAt: now,
        });

        return cancelled(reason);
      }

      const outcome = yield* Deferred.make<McpQuestionOutcome>();

      const notifies =
        options.notify !== undefined &&
        (!state.notified ||
          (state.waiting === 0 && now - state.idleSince >= MCP_QUESTION_RENOTIFY_MS));

      state.waiting += 1;
      state.notified = true;
      waiting.set(id, { key: question.key, request, entry, outcome });
      yield* tell;

      // In the background: the push may take seconds, and the question must not wait on it.
      if (notifies && options.notify !== undefined) {
        yield* Effect.forkDetach(options.notify({ server: question.server }));
      }

      yield* Deferred.await(outcome).pipe(
        Effect.timeoutOption(waitMs),
        Effect.flatMap(
          Option.match({
            onNone: () => finish(id, cancelled("the owner did not answer in time")),
            onSome: () => Effect.void,
          }),
        ),
        Effect.onInterrupt(() => finish(id, cancelled("Run stopped"))),
      );

      return yield* Deferred.await(outcome);
    });

  /** `content` checked against `form` and the Session's Secrets: the content to send, or what the card is told. */
  const checkedContent = (form: ElicitationForm, content: ElicitationContent) =>
    Effect.gen(function* () {
      const checked = validateElicitation(form, content);

      if (Result.isFailure(checked)) {
        const [first] = Record.toEntries(checked.failure);

        return yield* McpQuestionsError.make({
          message:
            first === undefined
              ? "The answer does not fit the form"
              : first[0] === ""
                ? first[1]
                : `${first[0]}: ${first[1]}`,
        });
      }

      for (const [name, text] of stringsOf(checked.success)) {
        if (holdsPlaceholder(text) || (yield* options.holdsSecret(text))) {
          return yield* McpQuestionsError.make({ message: `${name}: matches one of your Secrets` });
        }
      }

      return checked.success;
    });

  /** The shown, unanswered deferred question `id`, and its call's record. */
  const findDeferred = (id: string) => {
    for (const callId of deferredIds()) {
      const record = readDeferred(callId);
      const question = record?.questions.find((each) => each.id === id);

      if (record?.round !== undefined && question !== undefined && question.answer === undefined) {
        return { record, question };
      }
    }

    return undefined;
  };

  /** Wake the call that waits for `callId`'s round, if one does in this instance: it reads the record again. */
  const wake = (callId: string) =>
    Effect.suspend(() => {
      const signal = rounds.get(callId);

      return signal === undefined ? Effect.void : Deferred.succeed(signal, undefined);
    });

  /** Give deferred questions answers: those `answerOf` answers, while still unanswered. Throws when storage does. */
  const answerDeferred = (
    record: DeferredRecord,
    answerOf: (question: DeferredQuestion) => KeptAnswer | undefined,
  ) => {
    const questions = Arr.map(record.questions, (question) => {
      const given = question.answer === undefined ? answerOf(question) : undefined;

      return given === undefined ? question : { ...question, answer: given };
    });

    writeDeferred({ ...record, questions });
  };

  /** The owner's answer to deferred question `id`: kept in its record (sealed, for an accept) for the call's resume. */
  const answerKept = (
    found: { readonly record: DeferredRecord; readonly question: DeferredQuestion },
    given: Parameters<McpQuestionsService["answer"]>[1],
  ) =>
    Effect.gen(function* () {
      const { question } = found;
      let kept: KeptAnswer = { action: "decline", by: "owner" };

      if (given.action !== "accept") kept = { action: given.action, by: "owner" };
      else {
        const content = yield* checkedContent(question.request.form, given.content);

        if (vault === undefined) {
          return yield* McpQuestionsError.make({ message: "This request ended" });
        }

        const sealed = yield* vault
          .seal(question.id, JSON.stringify(content))
          .pipe(
            Effect.mapError(() =>
              McpQuestionsError.make({ message: "The answer could not be kept; try again" }),
            ),
          );

        kept = {
          action: "accept",
          by: "owner",
          sealed,
          fields: answeredFields(question.request.form, content),
        };
      }

      // The first answer wins: read again, since another client may have answered while this one was sealed.
      const record = readDeferred(found.record.callId);
      const still = record?.questions.find((each) => each.id === question.id);

      if (record === undefined || still === undefined || still.answer !== undefined) {
        return yield* McpQuestionsError.make({ message: "This request ended" });
      }

      yield* Effect.try(() =>
        answerDeferred(record, (each) => (each.id === question.id ? kept : undefined)),
      ).pipe(
        Effect.mapError(() =>
          McpQuestionsError.make({ message: "The answer could not be kept; try again" }),
        ),
      );
      yield* tell;
      yield* wake(record.callId);
    });

  const answer: McpQuestionsService["answer"] = (id, given) =>
    Effect.gen(function* () {
      const held = waiting.get(id);

      if (held === undefined) {
        const found = findDeferred(id);

        if (found !== undefined) return yield* answerKept(found, given);

        return yield* McpQuestionsError.make({ message: "This request ended" });
      }

      if (given.action !== "accept") {
        yield* finish(id, { action: given.action, by: "owner" });

        return;
      }

      const content = yield* checkedContent(held.request.form, given.content);

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

  /** Read `callId`'s deferred record; a storage that fails reads as none. */
  const deferredOf = (callId: string) =>
    Effect.try(() => readDeferred(callId)).pipe(Effect.orElseSucceed(() => undefined));

  /**
   * Settle the call's deferred questions and forget its record: each question's settled record says how it ended, an
   * unanswered one cancelled by cloudpid for `reason`. Sealed answers go with the record.
   */
  const settleDeferred = (callId: string, reason: string) =>
    Effect.gen(function* () {
      const record = yield* deferredOf(callId);

      if (record === undefined) return;

      const now = yield* Clock.currentTimeMillis;

      for (const question of record.questions) {
        const given = question.answer;
        const { request } = question;

        const settled: Mutable<McpQuestionRecord> = {
          id: question.id,
          callId,
          conversationId: request.conversationId,
          server: request.server,
          tool: request.tool,
          mode: "form",
          message: request.message,
          form: request.form,
          notes: request.notes,
          action: given?.action ?? "cancel",
          by: given?.by ?? "cloudpid",
          // The names of the fields answered: never a value.
          fields: given?.action === "accept" ? given.fields : [],
          askedAt: question.askedAt,
          settledAt: now,
        };

        const why =
          given === undefined ? reason : given.action === "accept" ? undefined : given.reason;

        if (why !== undefined) settled.reason = why;

        yield* keep(settled);
      }

      const state = calls.get(callId);

      if (record.round !== undefined && state !== undefined) {
        state.waiting = Math.max(0, state.waiting - record.questions.length);

        if (state.waiting === 0) state.idleSince = now;
      }

      yield* Effect.try(() => removeDeferred(callId, record)).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not drop an MCP call's deferred questions", cause),
        ),
      );
      yield* tell;
    });

  const settleCall = (callId: string) =>
    Effect.gen(function* () {
      yield* endWhere((held) => held.request.callId === callId, "the server's call ended");
      yield* settleDeferred(callId, "the server's call ended");
      calls.delete(callId);
      active.delete(callId);
      rounds.delete(callId);
    });

  const defer: McpQuestionsService["defer"] = (question) =>
    Effect.gen(function* () {
      const state = callOf(question.callId);

      if (state.asked >= MCP_ELICITATIONS_PER_CALL) {
        yield* turnedAway(question);

        return "capped" as const;
      }

      state.asked += 1;

      const id = questionId(question.callId, state.asked);
      const now = yield* Clock.currentTimeMillis;

      const shown = yield* options.redact({
        message: question.message,
        form: question.form,
        notes: question.notes,
      });

      const request: Mutable<McpElicitationRequest> = {
        id,
        callId: question.callId,
        conversationId: question.conversationId,
        server: question.server,
        tool: question.tool,
        message: shown.message,
        form: shown.form,
        notes: shown.notes,
      };

      if (question.source !== undefined) request.source = question.source;

      active.add(question.callId);

      // Stored before the round ends: a storage that cannot take it (a replaced Session) keeps nothing, and the server
      // is told `cancel` in the round's retry, never left with a question nobody can answer.
      const stored = yield* Effect.try(() => {
        const record = readDeferred(question.callId);

        // A round already stored is one whose resume went out: its questions were settled.
        if (record?.round !== undefined) removeDeferred(question.callId, record);

        const questions =
          record === undefined || record.round !== undefined ? [] : record.questions;

        writeDeferred({
          callId: question.callId,
          questions: [...questions, { id, key: question.key, request, askedAt: now }],
        });
      }).pipe(Effect.option);

      if (Option.isSome(stored)) return "deferred" as const;

      yield* keep({
        id,
        callId: question.callId,
        conversationId: question.conversationId,
        server: question.server,
        tool: question.tool,
        mode: "form",
        message: shown.message,
        form: shown.form,
        notes: shown.notes,
        action: "cancel",
        by: "cloudpid",
        reason: "cloudpid could not record the question",
        fields: [],
        askedAt: now,
        settledAt: now,
      });

      return "unrecorded" as const;
    });

  const commitRound: McpQuestionsService["commitRound"] = (round) =>
    Effect.gen(function* () {
      const { callId } = round;
      const record = yield* deferredOf(callId);

      const unrecorded = McpQuestionsError.make({
        message: "cloudpid could not record the question",
      });

      if (record === undefined || record.questions.length === 0) return yield* unrecorded;

      const text = JSON.stringify(round.resume);
      const chunks = Math.max(1, Math.ceil(text.length / RESUME_CHUNK));
      const state = callOf(callId);

      yield* Effect.try(() => {
        for (let n = 0; n < chunks; n += 1) {
          storage.put(chunkKey(callId, n), text.slice(n * RESUME_CHUNK, (n + 1) * RESUME_CHUNK));
        }

        writeDeferred({
          ...record,
          round: {
            n: round.round,
            conn: round.conn,
            tool: round.tool,
            chunks,
            asked: round.asked,
            count: state.asked,
          },
        });
      }).pipe(Effect.mapError(() => unrecorded));

      const now = yield* Clock.currentTimeMillis;

      const notifies =
        options.notify !== undefined &&
        (!state.notified ||
          (state.waiting === 0 && now - state.idleSince >= MCP_QUESTION_RENOTIFY_MS));

      state.waiting += record.questions.length;
      state.notified = true;
      yield* tell;

      const [first] = record.questions;

      // In the background: the push may take seconds, and the round must not wait on it.
      if (notifies && options.notify !== undefined && first !== undefined) {
        yield* Effect.forkDetach(options.notify({ server: first.request.server }));
      }
    });

  const deferredRound: McpQuestionsService["deferredRound"] = (callId) =>
    Effect.gen(function* () {
      const record = yield* deferredOf(callId);
      const round = record?.round;

      if (record === undefined || round === undefined) return undefined;

      const parts = yield* Effect.try(() =>
        Arr.makeBy(round.chunks, (n) => storage.get<string>(chunkKey(callId, n))),
      ).pipe(Effect.orElseSucceed(() => [undefined]));

      if (parts.some((part) => part === undefined)) return undefined;

      const resume = yield* Effect.try((): Schema.Json => JSON.parse(parts.join(""))).pipe(
        Effect.option,
      );

      if (Option.isNone(resume)) return undefined;

      // A rerun's call: it counts on toward its cap, and the owner, told when the round began, is not told again.
      const state = callOf(callId);

      state.asked = Math.max(state.asked, round.count);
      state.notified = true;
      state.waiting = record.questions.length;
      active.add(callId);

      return {
        callId,
        round: round.n,
        conn: round.conn,
        tool: round.tool,
        resume: resume.value,
        asked: round.asked,
      };
    });

  /** What a deferred question's kept answer gives the resume: an accepted form's content opened. */
  const opened = (question: DeferredQuestion) =>
    Effect.gen(function* () {
      const given = question.answer;

      if (given === undefined || given.action !== "accept") {
        const outcome: McpQuestionOutcome =
          given === undefined
            ? cancelled("the question was withdrawn")
            : given.reason === undefined
              ? { action: given.action, by: given.by }
              : { action: given.action, by: given.by, reason: given.reason };

        return { key: question.key, outcome, fields: [] } satisfies McpDeferredAnswer;
      }

      const text =
        vault === undefined
          ? Option.none<string>()
          : yield* vault.open(question.id, given.sealed).pipe(Effect.option);

      const content = Option.isNone(text)
        ? Option.none<ElicitationContent>()
        : yield* Effect.try((): ElicitationContent => JSON.parse(text.value)).pipe(Effect.option);

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

  const awaitRound: McpQuestionsService["awaitRound"] = (callId) =>
    Effect.gen(function* () {
      active.add(callId);

      while (true) {
        // Made before the record is read: an answer that lands between the read and the wait still wakes it.
        const signal = yield* Deferred.make<void>();

        rounds.set(callId, signal);

        const record = yield* deferredOf(callId);

        if (record === undefined) {
          rounds.delete(callId);

          return undefined;
        }

        if (Arr.every(record.questions, (question) => question.answer !== undefined)) {
          rounds.delete(callId);

          return yield* Effect.forEach(record.questions, opened);
        }

        yield* Deferred.await(signal).pipe(
          Effect.onInterrupt(() =>
            Effect.andThen(
              Effect.sync(() => rounds.delete(callId)),
              settleDeferred(callId, "Run stopped"),
            ),
          ),
        );
      }
    });

  /** Server `server`'s deferred questions, answered `cancel` by cloudpid for `reason`, and their calls woken. */
  const withdrawDeferred = (server: string, reason: string) =>
    Effect.gen(function* () {
      for (const callId of yield* Effect.try(deferredIds).pipe(Effect.orElseSucceed(() => []))) {
        const record = yield* deferredOf(callId);

        if (record === undefined || record.questions[0]?.request.server !== server) continue;

        yield* Effect.try(() =>
          answerDeferred(record, () => ({ action: "cancel", by: "cloudpid", reason })),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not withdraw an MCP server's deferred questions", cause),
          ),
        );
        yield* wake(callId);
      }

      yield* tell;
    });

  const unseen: McpQuestionsService["unseen"] = (form) =>
    Effect.gen(function* () {
      const state = callOf(form.callId);

      if (state.asked >= MCP_ELICITATIONS_PER_CALL) {
        yield* turnedAway(form);

        return "capped" as const;
      }

      state.asked += 1;

      const now = yield* Clock.currentTimeMillis;
      const shown = yield* shownOf(form);

      const record: Mutable<McpQuestionRecord> = {
        id: questionId(form.callId, state.asked),
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
        withdrawDeferred(server, reason),
      ),
    settleCall,
    unseen,
    defers: vault !== undefined,
    defer,
    commitRound,
    deferredRound,
    awaitRound,
    endRound: (callId) => settleDeferred(callId, "the server's call ended"),
    dropAbandoned: Effect.gen(function* () {
      for (const callId of yield* Effect.try(deferredIds).pipe(Effect.orElseSucceed(() => []))) {
        if (!active.has(callId)) yield* settleDeferred(callId, "the server's call ended");
      }
    }),
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
          reason: "expired: the server's call ended",
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
    records: Effect.sync(() =>
      Arr.filterMap(storage.get<string[]>(SETTLED_KEY) ?? [], (id) => {
        const record = storage.get<McpQuestionRecord>(settledKey(id));

        return record === undefined ? Result.failVoid : Result.succeed(record);
      }),
    ),
  } satisfies McpQuestionsService;
};
