// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off
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
import {
  answeredFields,
  MCP_ELICITATION_WAIT_MS,
  MCP_ELICITATIONS_PER_CALL,
  validateElicitation,
} from "@cloudpid/mcp/types";
import { holdsPlaceholder } from "../secrets/references.ts";
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

  const pending = Effect.sync(() => Arr.map([...waiting.values()], (held) => held.request));

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

      const now = yield* Clock.currentTimeMillis;
      const { request, entry } = held;

      waiting.delete(id);

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

  const answer: McpQuestionsService["answer"] = (id, given) =>
    Effect.gen(function* () {
      const held = waiting.get(id);

      if (held === undefined) {
        return yield* McpQuestionsError.make({ message: "This request ended" });
      }

      if (given.action !== "accept") {
        yield* finish(id, { action: given.action, by: "owner" });

        return;
      }

      const checked = validateElicitation(held.request.form, given.content);

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

      // The first answer wins: a question another client answered meanwhile is gone.
      const taken = yield* finish(id, { action: "accept", by: "owner", content: checked.success });

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
      yield* endWhere((held) => held.request.callId === callId, "the server's call ended");
      calls.delete(callId);
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
    withdrawServer: (server, reason) => endWhere((held) => held.request.server === server, reason),
    settleCall,
    unseen,
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
