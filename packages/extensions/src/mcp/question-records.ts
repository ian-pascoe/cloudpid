// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off
// What the Session's MCP questions share, live (`questions.ts`) and deferred (`deferred-questions.ts`)
// (`docs/architecture/mcp-server-requests.md` → The waiting-question record, Elicitation requests): the words for a
// question and how it ended, the settled records `mcp-question:s:<id>` (the newest `MCP_QUESTION_RECORDS`, never a
// value), each call's count toward its cap and whether the owner was told of it, and the checks an accepted form's
// content passes before it goes anywhere.
import {
  answeredFields,
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
import * as Effect from "effect/Effect";
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

/** Why a question the Session's storage cannot take (a replaced Session's) is cancelled, never shown. */
export const MCP_QUESTION_UNRECORDED_REASON = "cloudpid could not record the question";

/** Why a question is cancelled when its call is over: it ended, or it went with an earlier instance. */
export const MCP_CALL_ENDED_REASON = "the server's call ended";

/** Why a question is cancelled when the Run is stopped. */
export const MCP_RUN_STOPPED_REASON = "Run stopped";

const SETTLED_KEY = "mcp-question:settled";
const settledKey = (id: string) => `mcp-question:s:${id}`;

/** A value as JSON text, and JSON text read back. */
export const JsonText = Schema.fromJsonString(Schema.Json);

/** Any value as JSON text: a record, to know its size. */
const RecordText = Schema.fromJsonString(Schema.Unknown);

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

/** The owner's answer to a question, as a client gives it. */
export type McpQuestionAnswer =
  | { readonly action: "accept"; readonly content: ElicitationContent }
  | { readonly action: "decline" | "cancel" };

/** What a call has asked, and whether the owner was told. */
export type McpCallState = {
  /** Requests the call made, counted toward its cap: a question, or a form cloudpid ended unseen. */
  asked: number;
  /** Requests turned away at the cap, to give their records an id. */
  capped: number;
  waiting: number;
  notified: boolean;
  idleSince: number;
};

/** A question's id: unique within the Session, and within its call whatever the server's own request ids are. */
export const questionId = (callId: string, sequence: number | string) => `${callId}:${sequence}`;

export const cancelled = (reason: string): McpQuestionOutcome => ({
  action: "cancel",
  by: "cloudpid",
  reason,
});

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

export type McpQuestionBasicsOptions = {
  readonly storage: McpQuestionStorage;
  /** `value` with every Secret the Session holds replaced by its reference: all the owner is shown, and all a record keeps. */
  readonly redact: <A>(value: A) => Effect.Effect<A>;
  /** Whether a string the owner entered holds a Secret the Session holds or a deploy-time credential. */
  readonly holdsSecret: (text: string) => Effect.Effect<boolean>;
  /** Tell the owner a call waits for them (a push); it must not fail. */
  readonly notify?: ((who: { readonly server: string }) => Effect.Effect<void>) | undefined;
};

/** What both kinds of question are built on: the records, the calls' counts, and the checks of an answer. */
export type McpQuestionBasics = ReturnType<typeof questionBasics>;

export const questionBasics = (options: McpQuestionBasicsOptions) => {
  const { storage } = options;
  const calls = new Map<string, McpCallState>();

  /** Keep `record`, `text` long as JSON, and drop the oldest past the bound. */
  const keepNow = (record: McpQuestionRecord, text: string) => {
    const stored: McpQuestionRecord =
      text.length <= MAX_RECORD_BYTES || record.form === undefined
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
    Schema.encodeEffect(RecordText)(record).pipe(
      Effect.flatMap((text) => Effect.try(() => keepNow(record, text))),
      Effect.catch((cause) => Effect.logWarning("Could not keep an MCP question's record", cause)),
    );

  const records = Effect.sync(() =>
    Arr.filterMap(storage.get<string[]>(SETTLED_KEY) ?? [], (id) => {
      const record = storage.get<McpQuestionRecord>(settledKey(id));

      return record === undefined ? Result.failVoid : Result.succeed(record);
    }),
  );

  const callOf = (callId: string): McpCallState => {
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

  /** `count` of the call's questions stopped waiting at `now`. */
  const stopWaiting = (callId: string, count: number, now: number) => {
    const state = calls.get(callId);

    if (state === undefined) return;

    state.waiting = Math.max(0, state.waiting - count);

    if (state.waiting === 0) state.idleSince = now;
  };

  /**
   * `count` of the call's questions start waiting at `now`: the owner is told of the call's first, and of a later one
   * only after `MCP_QUESTION_RENOTIFY_MS` with none waiting. In the background: the push may take seconds, and the
   * question must not wait on it.
   */
  const startWaiting = (callId: string, server: string, count: number, now: number) =>
    Effect.suspend(() => {
      const state = callOf(callId);

      const notifies =
        !state.notified ||
        (state.waiting === 0 && now - state.idleSince >= MCP_QUESTION_RENOTIFY_MS);

      state.waiting += count;
      state.notified = true;

      return notifies && options.notify !== undefined
        ? Effect.forkDetach(options.notify({ server })).pipe(Effect.asVoid)
        : Effect.void;
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

      return cancelled(reason);
    });

  /**
   * Count a request toward the call's cap of `MCP_ELICITATIONS_PER_CALL`: its sequence within the call, or `undefined`
   * when the call was past it (the request is then recorded as turned away).
   */
  const count = (ask: Parameters<typeof turnedAway>[0]) =>
    Effect.gen(function* () {
      const state = callOf(ask.callId);

      if (state.asked >= MCP_ELICITATIONS_PER_CALL) {
        yield* turnedAway(ask);

        return undefined;
      }

      state.asked += 1;

      return state.asked;
    });

  /** The request the card shows for `ask`, as question `id`: redacted of the Secrets the Session holds. */
  const requestOf = (ask: McpQuestionAsk, id: string, deadline: number) =>
    Effect.gen(function* () {
      const shown = yield* options.redact({
        message: ask.message,
        form: ask.form,
        notes: ask.notes,
      });

      const request: Mutable<McpElicitationRequest> = {
        id,
        callId: ask.callId,
        conversationId: ask.conversationId,
        server: ask.server,
        tool: ask.tool,
        message: shown.message,
        form: shown.form,
        notes: shown.notes,
        deadline,
      };

      if (ask.source !== undefined) request.source = ask.source;

      return request;
    });

  /**
   * The settled record of `request`, asked at `askedAt`, ended by `outcome` at `now`: the names of the fields answered,
   * never a value.
   */
  const settledOf = (
    request: McpElicitationRequest,
    ended: {
      readonly action: McpQuestionRecord["action"];
      readonly by: McpQuestionRecord["by"];
      readonly reason?: string | undefined;
      readonly fields: ReadonlyArray<string>;
    },
    askedAt: number,
    now: number,
  ): McpQuestionRecord => {
    const record: Mutable<McpQuestionRecord> = {
      id: request.id,
      callId: request.callId,
      conversationId: request.conversationId,
      server: request.server,
      tool: request.tool,
      mode: "form",
      message: request.message,
      form: request.form,
      notes: request.notes,
      action: ended.action,
      by: ended.by,
      fields: ended.fields,
      askedAt,
      settledAt: now,
    };

    if (ended.reason !== undefined) record.reason = ended.reason;

    return record;
  };

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

  return {
    calls,
    keep,
    records,
    callOf,
    count,
    startWaiting,
    stopWaiting,
    shownOf,
    turnedAway,
    requestOf,
    settledOf,
    checkedContent,
    answeredFields,
  };
};
