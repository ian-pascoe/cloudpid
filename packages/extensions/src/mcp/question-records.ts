// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off
// What the Session's MCP questions share, live (`questions.ts`) and deferred (`deferred-questions.ts`)
// (`docs/architecture/mcp-server-requests.md` → The waiting-question record, Elicitation requests): the words for a
// question and how it ended, the settled records `mcp-question:s:<id>` (the newest `MCP_QUESTION_RECORDS`, never a
// value), each call's count toward its cap and whether the owner was told of it, and the checks an accepted form's
// content passes before it goes anywhere.
import {
  answeredFields,
  MCP_ELICITATIONS_PER_CALL,
  MCP_PROMPT_QUESTION_WAIT_MS,
  validateElicitation,
} from "@cloudpid/mcp/types";
import { ROLE_NAMES, type RoleName, sha256Hex } from "@cloudpid/config";
import type { McpEra } from "@cloudpid/mcp/types";
import { holdsPlaceholder } from "../secrets/references.ts";
import type { McpSamplingWhy } from "./details.ts";
import type { McpSamplingGrant, McpSamplingRecord } from "./sampling-records.ts";
import type {
  ElicitationContent,
  ElicitationForm,
  McpElicitationPage,
  McpElicitationRequest,
  McpElicitationSource,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
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

/** Why a question the Session's storage cannot take (a replaced Session's) is cancelled, never shown. */
export const MCP_QUESTION_UNRECORDED_REASON = "cloudpid could not record the question";

/** Why a page a call cannot wait for is cancelled: a Modern server asked for one the call never declared it could take. */
export const MCP_PAGE_NOT_KEPT_REASON = "the call cannot wait for a page";

/** Why a request is declined unseen once the owner chose "Decline in this Session" for its server. */
export const MCP_DECLINED_IN_SESSION_REASON =
  "the owner chose to decline this server's requests in this Session";

/** What a call that was answered by another process than the one that asked says (a stdio server that restarted while its questions waited). */
export const restartedWhileWaiting = (server: string): string =>
  `${server}'s process restarted while it waited for your answer, so it may have lost track; calling it again starts over`;

/** Why a stdio server's question is withdrawn when its Workspace's Container stopped under the call. */
export const containerStoppedReason = (server: string): string =>
  `${server}'s call ended (Container stopped)`;

/** The note on a question a stdio server asks again from another process than the round's before. */
export const restartedSinceAsked = (server: string): string =>
  `${server} restarted since it last asked`;

/** Why a question is cancelled when its call is over: it ended, or it went with an earlier instance. */
export const MCP_CALL_ENDED_REASON = "the server's call ended";

/** Why a question of a `codemode` script's nested call is withdrawn when the script's `timeout_ms` has passed. */
export const MCP_SCRIPT_TIMED_OUT_REASON = "the script timed out";

/** Why a question is cancelled when the Run is stopped. */
export const MCP_RUN_STOPPED_REASON = "Run stopped";

/**
 * How a Sampling request was decided, for the sampler that waits on it, live or kept with its round: an allow with the Role
 * to run it on, or a refusal.
 */
export type McpSamplingDecision =
  | {
      readonly action: "allow";
      /** The Role the owner picked, or the card's own when they did not. */
      readonly role: RoleName;
      /** What let it run; *Allow for this call* is `call`. Absent: the server's definition, switched to `allow` while it waited. */
      readonly grant?: McpSamplingGrant;
    }
  | {
      readonly action: "refuse";
      readonly by: "owner" | "cloudpid";
      readonly reason: string;
      readonly why?: McpSamplingWhy;
    };

/** A refusal, `why` named only when there is one (`exactOptionalPropertyTypes`). */
export const refusedBy = (
  by: "owner" | "cloudpid",
  reason: string,
  why?: McpSamplingWhy,
): McpSamplingDecision =>
  why === undefined ? { action: "refuse", by, reason } : { action: "refuse", by, reason, why };

/**
 * What the owner's choice decides, and what else it covers: the decision for the request they answered, the others of its
 * round getting the same one (each on its own Role unless `picked`), and `also` the call's later requests, or the
 * server's in every call.
 */
export type McpSamplingVerdict = McpSamplingDecision & {
  readonly also?: "call" | "server";
  /** The Role the owner changed the card's to: the requests the choice covers run on it too. */
  readonly picked?: RoleName;
  /** *Never*: the server's later requests in the calls it covers are refused without asking. */
  readonly never?: true;
};

/**
 * `verdict` as the decision of one request it covers: the Role the owner picked runs it, else the Role it was shown on
 * (`own`, as a client reads it), else the verdict's.
 */
export const decisionOf = (verdict: McpSamplingVerdict, own: string): McpSamplingDecision => {
  if (verdict.action === "refuse") return refusedBy(verdict.by, verdict.reason, verdict.why);

  const role = verdict.picked ?? ROLE_NAMES.find((each) => each === own) ?? verdict.role;

  return verdict.grant === undefined
    ? { action: "allow", role }
    : { action: "allow", role, grant: verdict.grant };
};

/** The span of a question that ended (`docs/architecture/mcp-server-requests.md` → Telemetry and testing). */
export const ELICITATION_SPAN = "mcp.elicitation.request";

/**
 * What the span of a question says of it: the server, the origin (an agent's call, or an MCP task's), the mode, the
 * era, how it ended and who decided, how many fields were answered and how long it waited. Never the message, the form,
 * the address (its origin is in the record, not here) or a value.
 */
export const spanOf = (record: McpQuestionRecord) => ({
  "mcp.server": record.server,
  "mcp.origin": isTaskOwner(record.callId) ? "task" : "agent",
  "mcp.elicitation.mode": record.mode,
  "mcp.elicitation.era": record.era ?? eraDefault(record.mode === "url"),
  "mcp.elicitation.action": record.action,
  "mcp.elicitation.by": record.by,
  "mcp.elicitation.fields": record.fields.length,
  "mcp.elicitation.wait_ms": Math.max(0, record.settledAt - record.askedAt),
});

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

/** The page a URL-mode question asks the owner to open, as the call that asks it knows it: plain text, already checked. */
export type McpQuestionPage = Omit<McpElicitationPage, "opened" | "retry" | "again" | "finished">;

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
  /** The model-facing name of the tool the call is to; for a prompt send, the prompt's command. */
  readonly tool: string;
  /**
   * The title of the MCP prompt whose send asks it, when it is a question of a `prompts/get`: such a question waits live
   * for `MCP_PROMPT_QUESTION_WAIT_MS` and tells the owner nothing (`docs/architecture/mcp-server-requests.md` → Questions).
   */
  readonly prompt?: string;
  /**
   * Whether it is a question of an App View's `tools/call` (`docs/architecture/mcp-apps.md` → Server requests from an App
   * View's calls): it waits live as a prompt send's does (5 minutes, no Notification), and its card names the app.
   */
  readonly app?: true;
  /** The handle of the MCP task that asks it, when it is a question of a task (`callId` is then its owner key, `taskOwner`). */
  readonly task?: string;
  readonly message: string;
  /** A page question has a form with no fields: the card draws its `page`. */
  readonly form: ElicitationForm;
  /** The page to open (URL mode). */
  readonly page?: McpQuestionPage;
  /** The call ends and is sent again once the owner is done at the page (a Legacy `-32042`, a Modern round), rather than going on by itself. */
  readonly retry?: true;
  /** The Protocol era of the server that asked; absent when the core that sent the question did not say. */
  readonly era?: McpEra;
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

/**
 * Which page a note, a record of an unseen request or a `details` line is about: the address's host (ASCII) and its
 * origin, never the rest of it.
 */
export type McpPageRef = { readonly host: string; readonly origin: string };

/** A form or page cloudpid ended before showing it: a credential, an address it declines, or a malformed request. */
export type McpQuestionUnseen = Omit<
  McpQuestionAsk,
  "key" | "form" | "notes" | "source" | "page" | "retry" | "era"
> & {
  readonly form?: ElicitationForm;
  /** The host of the page it was, when it was a page question (URL mode). */
  readonly page?: McpPageRef;
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
  readonly mode: "form" | "url";
  /**
   * The Protocol era of the server that asked: a Legacy server's `-32042` and a Modern server's round are told apart
   * here. A record from before the field has none; a page then was a Legacy `-32042`'s, and a form a Modern server's.
   */
  readonly era?: McpEra;
  /** A page question: the address's origin only, never the rest of it. */
  readonly page?: { readonly origin: string };
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

/**
 * The owner's answer to a question, as a client gives it. `opened` and `done` are a page question's: Open's click, and
 * "Done, try again" once every page of the round is opened.
 */
export type McpQuestionAnswer =
  | { readonly action: "accept"; readonly content: ElicitationContent }
  | { readonly action: "decline" | "cancel" | "opened" | "done" };

/** What a call has asked, and whether the owner was told. */
export type McpCallState = {
  /** Requests the call made, counted toward its cap: a question, or a form cloudpid ended unseen. */
  asked: number;
  /** Requests turned away at the cap, to give their records an id. */
  capped: number;
  /** Sampling requests the call made (the sampler's own cap and ids), kept with a round so a rerun counts on from them. */
  sampled: number;
  waiting: number;
  notified: boolean;
  idleSince: number;
};

/**
 * What a call's pages come to, kept in the Session's storage beside its questions so a restart does not forget them
 * (`mcp-question:pages:<callId>`, gone with the call): the keys of the pages the owner was done at, so a server that asks
 * for one again is told "Not finished", and how many it asked for again, which gives their questions an id.
 */
export type McpCallPages = { readonly opened: ReadonlyArray<string>; readonly repeated: number };

/** The most pages of a call that are kept as opened, and the longest a kept key is: a server's `elicitationId` is its own. */
export const MCP_PAGES_KEPT = 64;
export const MCP_PAGE_KEY_CHARS = 200;

/** A page's key as the call's pages keep it: cut, so a server's long `elicitationId` cannot make the record large. */
export const pageKeyOf = (key: string): string => key.slice(0, MCP_PAGE_KEY_CHARS);

/** The prefix of the key an MCP task's questions are kept under: `mcp_task:<handle>` stands where a call's id does. */
export const MCP_TASK_OWNER_PREFIX = "mcp_task:";

/** The key an MCP task's questions are kept under (`docs/architecture/mcp-server-requests.md` → The waiting-question record). */
export const taskOwner = (handle: string): string => `${MCP_TASK_OWNER_PREFIX}${handle}`;

/** Whether `owner` is an MCP task's key rather than a call's id. */
export const isTaskOwner = (owner: string): boolean => owner.startsWith(MCP_TASK_OWNER_PREFIX);

/**
 * The era of a question whose record or request names none (from before the field): a page was a Legacy `-32042`'s, and
 * a form a Modern server's.
 */
export const eraDefault = (page: boolean): McpEra => (page ? "legacy" : "modern");

/** The era of the server that asked a question, for one whose core did not say. */
export const eraOfAsk = (ask: McpQuestionAsk): McpEra =>
  ask.era ?? eraDefault(ask.page !== undefined);

/**
 * What names a page across a call's rounds, as `opened` keeps it. A Legacy server names its own page (`elicitationId`);
 * a Modern one does not (`2026-07-28` has no `elicitationId`), so the round's key for the question and the page's
 * address together do: the same key and address again is the same page.
 */
export const pageIdentityOf = (
  era: McpEra | undefined,
  key: string,
  url: string | undefined,
): string =>
  era === "modern" && url !== undefined
    ? `${key.slice(0, MCP_PAGE_KEY_CHARS / 2)}#${sha256Hex(url).slice(0, 32)}`
    : pageKeyOf(key);

/** The handle a task's question key names, when it is one's (`taskOwner`). */
export const handleOfOwner = (owner: string): string | undefined =>
  isTaskOwner(owner) ? owner.slice(MCP_TASK_OWNER_PREFIX.length) : undefined;

/**
 * `pageIdentityOf` for the question of `owner`. An MCP task's server asks a page again under a new key (a key it was
 * answered is never asked again), so a task's page is named by its address alone.
 */
export const pageIdentityFor = (
  owner: string,
  era: McpEra | undefined,
  key: string,
  url: string | undefined,
): string => pageIdentityOf(era, isTaskOwner(owner) ? "" : key, url);

const pagesKey = (callId: string) => `mcp-question:pages:${callId}`;

/** What a waiting question tells the owner of: the server, and what it waits on when that is not a form. */
const whoOf = (server: string, kind: McpWaitingKind) => {
  if (kind.page === true) return { server, page: true } as const;

  return kind.sampling === true ? ({ server, sampling: true } as const) : { server };
};

/** How a question that waits tells the owner: the first of a call does, a later one only after a pause. */
export type McpWaitingKind = {
  /** It asks to use a model (a Sampling request), which the Notification says. */
  readonly sampling?: true;
  /** It asks the owner to open a page, which the Notification says. */
  readonly page?: true;
  /** The owner is not told at all: a page the server asks for again, which they were told of already. */
  readonly quiet?: true;
};

/**
 * Whose question it is: an agent's call's, a prompt send's (`prompt` is its title), an App View's call's (`app`) or an MCP
 * task's (`task` is its handle). The one rule for a Sampling record's `origin` and span's `mcp.origin`, and for how long a question waits (an elicitation's
 * record keeps no origin, so its span says `task` or `agent` by its owner, `spanOf`).
 */
export const askOriginOf = (origin: {
  readonly prompt?: string | undefined;
  readonly app?: true | undefined;
  readonly task?: string | undefined;
}): "agent" | "prompt" | "app" | "task" => {
  if (origin.task !== undefined) return "task";

  if (origin.app === true) return "app";

  return origin.prompt === undefined ? "agent" : "prompt";
};

/**
 * How a question waits, by whether it is live: a prompt send's (`prompt` is its title) or an App View's call's (`app`). An
 * agent's call's question waits `waitMs` and tells the owner; a live one waits `promptWaitMs`
 * (`MCP_PROMPT_QUESTION_WAIT_MS` unless a test shortens it) and tells them nothing, as they are at the composer or in the
 * View. One rule for the forms and the Sampling requests alike.
 */
export const waitsOf = (waits: {
  readonly waitMs: number;
  readonly promptWaitMs?: number | undefined;
}) => {
  const promptWaitMs = waits.promptWaitMs ?? MCP_PROMPT_QUESTION_WAIT_MS;

  return (origin: {
    readonly prompt?: string | undefined;
    readonly app?: true | undefined;
    readonly task?: string | undefined;
  }): { readonly waitMs: number; readonly quiet: boolean } =>
    // A task's questions are kept for the owner like an agent's call's, and tell the owner.
    askOriginOf(origin) === "agent" || askOriginOf(origin) === "task"
      ? { waitMs: waits.waitMs, quiet: false }
      : { waitMs: promptWaitMs, quiet: true };
};

/** A question's id: unique within the Session, and within its call whatever the server's own request ids are. */
export const questionId = (callId: string, sequence: number | string) => `${callId}:${sequence}`;

/** What a record keeps of an address: its origin only, never the path or the query. */
export const originOf = (url: string): string =>
  Option.getOrElse(
    Option.map(Option.liftThrowable(() => new URL(url))(), (parsed) => parsed.origin),
    () => "",
  );

/** The `mode` and `page` a record of a request has: a page question keeps its address's origin, no form. */
export const modeOf = (ask: {
  readonly page?: { readonly url: string } | { readonly origin: string } | undefined;
}) =>
  ask.page === undefined
    ? ({ mode: "form" } as const)
    : ({
        mode: "url",
        page: { origin: "url" in ask.page ? originOf(ask.page.url) : ask.page.origin },
      } as const);

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

/**
 * The IDs a call's records are found under: the call's own, and for a `codemode` script's nested call
 * (`<parent call>/<key>`, pi-durable's) every call it is nested in, which is the result an export or a Fork finds it by.
 */
export const callKeysOf = (callId: string): ReadonlyArray<string> => {
  const keys = [callId];

  for (let at = callId.indexOf("/"); at > 0; at = callId.indexOf("/", at + 1)) {
    keys.push(callId.slice(0, at));
  }

  return keys;
};

/**
 * A record of a server's request that a Fork or Clone carries: a question's settled record, or a Sampling request's (kept
 * as it was, a stub if it was one).
 */
export type McpQuestionCopy =
  | { readonly kind: "question"; readonly record: McpQuestionRecord }
  | { readonly kind: "sampling"; readonly record: McpSamplingRecord };

/** The records one entry of a page carries (`McpQuestionCopies.copier`). */
export type McpQuestionCopier = (
  callIds: ReadonlyArray<string>,
  budget: number,
) => ReadonlyArray<McpQuestionCopy>;

/**
 * What a Session does with the records of a Fork or Clone (`ExportPage.questions`): which are its calls', and keeping
 * them.
 */
export type McpQuestionCopies = {
  /**
   * A copier for one page of a Fork or Clone: the settled records, of questions and of Sampling requests, of the calls
   * whose result entry is among `callIds`, and of the calls nested in them, which fit in `budget` characters of JSON (the
   * questions' always do, being bounded at 64 KiB and 100; a Sampling record past it is carried as its stub). The Session's
   * Sampling records are read once, at the first entry that holds a call, and not at all for a page that holds none.
   */
  readonly copier: () => McpQuestionCopier;
  /**
   * Keep the records a Fork or Clone's source sent, as the calls of conversation `conversationId`; the bound of the
   * newest 100 questions applies, and the Session's own bound of Sampling records.
   */
  readonly adopt: (
    copies: ReadonlyArray<McpQuestionCopy>,
    conversationId: McpQuestionRecord["conversationId"],
  ) => void;
};

export type McpQuestionBasicsOptions = {
  readonly storage: McpQuestionStorage;
  /** `value` with every Secret the Session holds replaced by its reference: all the owner is shown, and all a record keeps. */
  readonly redact: <A>(value: A) => Effect.Effect<A>;
  /** Whether a string the owner entered holds a Secret the Session holds or a deploy-time credential. */
  readonly holdsSecret: (text: string) => Effect.Effect<boolean>;
  /**
   * Tell the owner a call waits for them (a push); it must not fail. `page`: it asks them to open a page; `sampling`: it asks
   * to use a model; a form otherwise.
   */
  readonly notify?:
    | ((who: {
        readonly server: string;
        readonly page?: true;
        readonly sampling?: true;
      }) => Effect.Effect<void>)
    | undefined;
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
      // One span per question that ended, whatever the storage did with its record (`docs/architecture/
      // mcp-server-requests.md` → Telemetry and testing): what it asked and how it ended, never its content.
      Effect.andThen(
        Effect.void.pipe(Effect.withSpan(ELICITATION_SPAN, { attributes: spanOf(record) })),
      ),
    );

  /**
   * Settled record `id` says `accept`, but the server was never given the answer (the host replaced it: the server
   * changed while the owner answered): it reads cancelled by cloudpid with `reason`, and no field. The question's span
   * was emitted when it settled, and is not again. A record that does not say `accept` is left as it is.
   */
  const overturn = (id: string, reason: string) =>
    Effect.sync(() => storage.get<McpQuestionRecord>(settledKey(id))).pipe(
      Effect.flatMap((record) => {
        if (record === undefined || record.action !== "accept") return Effect.void;

        const overturned: McpQuestionRecord = {
          ...record,
          action: "cancel",
          by: "cloudpid",
          reason,
          fields: [],
        };

        return Schema.encodeEffect(RecordText)(overturned).pipe(
          Effect.flatMap((text) => Effect.try(() => keepNow(overturned, text))),
        );
      }),
      Effect.catch((cause) => Effect.logWarning("Could not amend an MCP question's record", cause)),
    );

  const settled = (): ReadonlyArray<McpQuestionRecord> =>
    Arr.filterMap(storage.get<string[]>(SETTLED_KEY) ?? [], (id) => {
      const record = storage.get<McpQuestionRecord>(settledKey(id));

      return record === undefined ? Result.failVoid : Result.succeed(record);
    });

  const records = Effect.sync(settled);

  /** The settled question records of the calls whose result entry is among `callIds`, and of the calls nested in them. */
  const recordsFor = (callIds: ReadonlyArray<string>): ReadonlyArray<McpQuestionRecord> => {
    if (callIds.length === 0) return [];

    const wanted = new Set(callIds);

    return Arr.filter(settled(), (record) =>
      Arr.some(callKeysOf(record.callId), (key) => wanted.has(key)),
    );
  };

  /** Keep `copied` as question records of conversation `conversationId`. */
  const adoptRecords = (
    copied: ReadonlyArray<McpQuestionRecord>,
    conversationId: McpQuestionRecord["conversationId"],
  ) => {
    for (const each of copied) {
      const record: McpQuestionRecord = { ...each, conversationId };

      try {
        keepNow(record, JSON.stringify(record));
      } catch {
        // A storage that cannot take a record loses that record, never the Fork.
      }
    }
  };

  const callOf = (callId: string): McpCallState => {
    const held = calls.get(callId) ?? {
      asked: 0,
      capped: 0,
      sampled: 0,
      waiting: 0,
      notified: false,
      idleSince: 0,
    };

    calls.set(callId, held);

    return held;
  };

  /**
   * A rerun's call, as an earlier instance left it: `count` requests made toward its cap, and, for a round already
   * shown, `waiting` questions the owner was told of, so they are not told again.
   */
  const restoreCall = (
    callId: string,
    restored: {
      readonly count: number;
      readonly waiting: number | undefined;
      readonly sampled?: number | undefined;
    },
  ) => {
    const state = callOf(callId);

    state.asked = Math.max(state.asked, restored.count);
    state.sampled = Math.max(state.sampled, restored.sampled ?? 0);

    if (restored.waiting !== undefined) {
      state.notified = true;
      state.waiting = restored.waiting;
    }
  };

  /** What the call's pages come to, as the storage keeps it (throws as the storage does). */
  const pagesOf = (callId: string): McpCallPages =>
    storage.get<McpCallPages>(pagesKey(callId)) ?? { opened: [], repeated: 0 };

  /** The owner was done at pages `keys` of the call. */
  const openedPages = (callId: string, keys: ReadonlyArray<string>) => {
    const held = pagesOf(callId);

    storage.put(pagesKey(callId), {
      ...held,
      // The newest are kept: a call that outruns the bound forgets its oldest page, which then reads as new.
      opened: Arr.takeRight(
        Arr.dedupe([...held.opened, ...Arr.map(keys, pageKeyOf)]),
        MCP_PAGES_KEPT,
      ),
    } satisfies McpCallPages);
  };

  /** The server asked for a page of the call again: how many times so far, this one counted. */
  const repeatedPage = (callId: string): number => {
    const held = pagesOf(callId);

    storage.put(pagesKey(callId), { ...held, repeated: held.repeated + 1 } satisfies McpCallPages);

    return held.repeated + 1;
  };

  /** The call is over: what it came to goes. */
  const forgetPages = (callId: string) => {
    storage.delete(pagesKey(callId));
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
  const startWaiting = (
    callId: string,
    server: string,
    count: number,
    now: number,
    kind: McpWaitingKind = {},
  ) =>
    Effect.suspend(() => {
      const state = callOf(callId);

      const notifies =
        kind.quiet !== true &&
        (!state.notified ||
          (state.waiting === 0 && now - state.idleSince >= MCP_QUESTION_RENOTIFY_MS));

      state.waiting += count;
      state.notified = true;

      // Started at once, before anything that follows the question (`secrets/store.ts` says why).
      return notifies && options.notify !== undefined
        ? Effect.forkDetach(options.notify(whoOf(server, kind)), { startImmediately: true }).pipe(
            Effect.asVoid,
          )
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
    ask: Omit<
      McpQuestionAsk,
      "key" | "form" | "notes" | "source" | "page" | "retry" | "era" | "prompt" | "app"
    > & {
      readonly form?: ElicitationForm;
      readonly notes?: ReadonlyArray<string>;
      readonly page?: { readonly url: string } | { readonly origin: string };
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
        ...modeOf(ask),
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

  /**
   * The request the card shows for `ask`, as question `id`: redacted of the Secrets the Session holds. `again` says the
   * page was opened before and the server asks for it once more.
   */
  const requestOf = (ask: McpQuestionAsk, id: string, deadline: number, again = false) =>
    Effect.gen(function* () {
      const shown = yield* options.redact({
        message: ask.message,
        form: ask.form,
        notes: ask.notes,
        page: ask.page,
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

      if (ask.prompt !== undefined) request.prompt = ask.prompt;

      if (ask.app === true) request.app = true;

      if (ask.task !== undefined) request.task = ask.task;

      if (shown.page !== undefined) {
        const page: Mutable<McpElicitationPage> = { ...shown.page, opened: false };

        if (ask.retry === true) page.retry = true;

        if (ask.retry === true && ask.era !== undefined) page.era = ask.era;

        if (again) page.again = true;

        request.page = page;
      }

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
      /** The Protocol era of the server that asked. */
      readonly era?: McpEra | undefined;
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
      ...modeOf(request),
      message: request.message,
      notes: request.notes,
      action: ended.action,
      by: ended.by,
      fields: ended.fields,
      askedAt,
      settledAt: now,
    };

    // A page question has no form to keep: its record names the page's origin.
    if (request.page === undefined) record.form = request.form;

    if (ended.era !== undefined) record.era = ended.era;

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
    overturn,
    records,
    recordsFor,
    adoptRecords,
    callOf,
    pagesOf,
    openedPages,
    repeatedPage,
    forgetPages,
    restoreCall,
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
