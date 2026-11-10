// The MCP endpoint's `api` contract (`docs/architecture/mcp-endpoint.md` → The `api` target, Tools, Following a Run,
// Transcripts, Access and identity): what the main Worker's `McpApi` target answers `McpServer`, and what the Session
// object answers the main Worker (`status`, `waitForChange`, `transcriptPage`, `submit`, `stop`). Effect Schemas, shared
// with `packages/pi-cloudpid`, so nothing here imports the MCP SDK, pi-durable's runtime or a Worker API.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over short strings and records.
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ModelId, ThinkingLevel } from "@cloudpid/config";
import { ApprovalStateOutput } from "./harness-tools/approvals.ts";
import { openLiterals } from "./open-literals.ts";
import { WhenBusy } from "./session.ts";

/** The most input text a message may carry over the endpoint, in UTF-8 bytes (`input_too_large`). */
export const MAX_MCP_INPUT_BYTES = 1_900_000;

/** The most `data` one import slice carries, in UTF-8 bytes. */
export const MAX_MCP_SLICE_BYTES = 2 * 1024 * 1024;

/** The most an import brings in total, in bytes. */
export const MAX_MCP_IMPORT_BYTES = 64 * 1024 * 1024;

/**
 * The most Sessions started over the endpoint (or imported) that run at once (`too_many_running`), counted by the
 * Registry (`docs/architecture/mcp-endpoint.md` → Limits and errors).
 */
export const MAX_MCP_RUNNING = 10;

/** How many Session imports one identity may have open (begun and not ended, cancelled or expired) at once. */
export const MAX_MCP_OPEN_IMPORTS = 2;

/** The longest `session_wait` may wait, in milliseconds. */
export const MAX_MCP_WAIT_MS = 300_000;

/** How long `session_wait` waits when it is not told, in milliseconds. */
export const DEFAULT_MCP_WAIT_MS = 45_000;

/** The most waits one Session holds at once (`too_many_waits`): each keeps the Session object resident. */
export const MAX_SESSION_WAITS = 8;

/** The longest a `session_stop` waits for the Session to go idle, in milliseconds, before it says `stopping`. */
export const STOP_WAIT_MS = 30_000;

/** How many characters of the Run's answer a wait result carries (middle-cut). */
export const MAX_WAIT_ANSWER_CHARS = 8_000;

/** How many characters of the last answer `session_get` carries. */
export const MAX_LAST_ANSWER_CHARS = 4_000;

/** How many one-line summaries of the latest activity a wait result carries. */
export const MAX_LATEST_ACTIVITY = 5;

/** The transcript tool's `max_chars`: its bounds and its default. */
export const MIN_TRANSCRIPT_CHARS = 2_000;

export const MAX_TRANSCRIPT_CHARS = 40_000;

export const DEFAULT_TRANSCRIPT_CHARS = 12_000;

/** The most entries one transcript page holds. */
export const MAX_TRANSCRIPT_ENTRIES = 200;

/**
 * The MCP endpoint's path (`docs/architecture/mcp-endpoint.md` → The handler, Self-use): exactly this, every method. The
 * main Worker routes it and the Session's Self-use rule (`isOwnEndpoint`) matches it.
 */
export const MCP_ROUTE = "/mcp";

/** The twelve tools, snake_case, no prefix (clients add `mcp__cloudpid__`). */
export const MCP_TOOL_NAMES = [
  "environments_list",
  "sessions_list",
  "session_get",
  "session_wait",
  "session_transcript",
  "session_start",
  "session_send",
  "session_stop",
  "session_import_begin",
  "session_import_append",
  "session_import_finish",
  "session_import_cancel",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** The only import format there is: pi's own session file, one JSON line per entry. */
export const PI_SESSION_FORMAT = "pi-session-jsonl";

/**
 * How the caller got in: an Access OAuth grant (the owner), or `local` (a stage under `alchemy dev`, which has no
 * Access: the loopback rule). `service_token` is the Local agent's old Access service token, which the server no longer
 * produces (#636) but records written before it still hold, so it stays here to decode and display. `trigger` is a
 * Trigger's Fire (`docs/architecture/triggers.md` → Fire records, origin marks and notifications), whose mark names the
 * Trigger. A member this version does not know reads as `unknown`.
 */
export const McpAuth = openLiterals(
  Schema.Literals(["oauth", "service_token", "local", "trigger", "unknown"]),
  "unknown",
);

export type McpAuth = typeof McpAuth.Type;

/** The mark of a Trigger on what it started or sent: its id and name, kept as they were at the Fire. */
export const TriggerMark = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

export type TriggerMark = typeof TriggerMark.Type;

/** The MCP generation the caller spoke. */
export const McpEra = openLiterals(Schema.Literals(["legacy", "modern", "unknown"]), "unknown");

export type McpEra = typeof McpEra.Type;

/** The caller's name (display only, untrusted), and its version when it said. */
export const McpClient = Schema.Struct({
  name: Schema.String,
  version: Schema.optionalKey(Schema.String),
});

export type McpClient = typeof McpClient.Type;

/**
 * What `McpServer` tells `McpApi` of the caller (`docs/architecture/mcp-endpoint.md` → The `api` target): the client's
 * name and the MCP generation it spoke. How the caller got in is never an argument: the main Worker closes it over the
 * `api` target.
 */
export const Via = Schema.Struct({
  client: Schema.optionalKey(McpClient),
  era: McpEra,
});

export type Via = typeof Via.Type;

/**
 * Who sent an input over the endpoint, as the Session object takes it and keeps it (`UserEntryData.via`;
 * `docs/architecture/mcp-endpoint.md` → Access and identity, Marks): never the owner's email. The `auth` kind and the
 * client's name are the audit mark; `era` is for telemetry. The main Worker adds `auth` (and, for the owner, `clientId`)
 * to the `api`'s `Via`, from the verified caller.
 */
export const SessionVia = Schema.Struct({
  client: Schema.optionalKey(McpClient),
  auth: McpAuth,
  era: Schema.optionalKey(McpEra),
  /**
   * The owner's Access OAuth registration (the assertion's `oauth.client_id`, an opaque id Access gave the client when it
   * registered): which of the owner's grants sent the input, so a Session's inputs can be told apart by grant. Absent
   * for the old service token, for local dev, and for a version that predates it. Kept in the input's entry; never displayed.
   */
  clientId: Schema.optionalKey(Schema.String),
  /** The Trigger that sent the input (`auth: "trigger"`): its id and name at the Fire. */
  trigger: Schema.optionalKey(TriggerMark),
});

export type SessionVia = typeof SessionVia.Type;

const VIA_PREFIX = { mcp: "MCP", import: "Imported", trigger: "Trigger", unknown: "Via" } as const;

/**
 * The words that say where a Session came from (its origin chip): "MCP · pi", or "MCP" when the caller gave no name;
 * "Trigger · <name>" for a Trigger's Fire; "Via · pi" for a kind this version does not know. An input's chip is
 * {@link inputViaChipLabel}.
 */
export const sessionOriginLabel = (
  via: Pick<SessionVia, "client" | "trigger">,
  kind: "mcp" | "import" | "trigger" | "unknown" = "mcp",
): string => {
  const prefix = VIA_PREFIX[kind];

  if (kind === "trigger" && via.trigger !== undefined) return `${prefix} · ${via.trigger.name}`;

  return via.client === undefined ? prefix : `${prefix} · ${via.client.name}`;
};

/**
 * The words that mark an input sent over the endpoint (its chip; a Session's is {@link sessionOriginLabel}): "via pi
 * (MCP)", or "via MCP" when the caller gave no name; "via <name> (Trigger)" for a Trigger's Fire.
 */
export const inputViaChipLabel = (via: Pick<SessionVia, "client" | "auth" | "trigger">): string => {
  if (via.auth === "trigger" && via.trigger !== undefined)
    return `via ${via.trigger.name} (Trigger)`;

  return via.client === undefined ? "via MCP" : `via ${via.client.name} (MCP)`;
};

/**
 * Domain failures (`isError` results); the endpoint's `unsupported` and `unavailable` end the list. A code this version
 * does not know (a newer deploy's) reads as `unavailable`, the generic failure that may heal; the error's `retryable`
 * travels with it, so a reader that does not know `stopped` (a message the owner's Stop withdrew) still sees that
 * sending it again will not help.
 */
export const ApiErrorCode = openLiterals(
  Schema.Literals([
    "not_found",
    "ambiguous_environment",
    "invalid_argument",
    "invalid_cursor",
    "session_busy",
    "session_importing",
    "session_archived",
    "branch_taken",
    "stopped",
    "input_too_large",
    "too_many_running",
    "too_many_waits",
    "too_many_approvals",
    "rate_limited",
    "offset_mismatch",
    "import_too_large",
    "import_expired",
    "checksum_mismatch",
    "unsupported_format",
    "unsupported",
    "unavailable",
  ]),
  "unavailable",
);

export type ApiErrorCode = typeof ApiErrorCode.Type;

export const ApiError = Schema.Struct({
  code: ApiErrorCode,
  /** One actionable sentence. */
  message: Schema.String,
  retryable: Schema.Boolean,
  details: Schema.optionalKey(Schema.Json),
});

export type ApiError = typeof ApiError.Type;

/** A failure as a value: it crosses RPC and never throws. */
export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiError };

/** The Schema of `ApiResult<T>`, for a value Schema `value`. */
export const ApiResult = <S extends Schema.Top>(value: S) =>
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value }),
    Schema.Struct({ ok: Schema.Literal(false), error: ApiError }),
  ]);

/** Codes a retry may heal. */
const RETRYABLE: ReadonlySet<ApiErrorCode> = new Set([
  "session_busy",
  "too_many_waits",
  "rate_limited",
  "unavailable",
]);

/** A failed result with `code`; `retryable` follows the code unless given. */
export const apiFailure = (
  code: ApiErrorCode,
  message: string,
  extra: { readonly retryable?: boolean; readonly details?: Schema.Json } = {},
): ApiResult<never> => {
  const error: ApiError = { code, message, retryable: extra.retryable ?? RETRYABLE.has(code) };

  return {
    ok: false,
    error: extra.details === undefined ? error : { ...error, details: extra.details },
  };
};

/** A successful result. */
export const apiOk = <T>(value: T): ApiResult<T> => ({ ok: true, value });

/**
 * A Session's id as the Registry makes it: a lowercase UUID (`sessionSocketPath`'s too). The endpoint takes no other
 * form (an upper-case one would name no object), so `McpServer` and the main Worker agree on what a Session id is.
 */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What `describe()` says the deployed `Server` supports; `McpServer` gates its tools on it. */
export const ApiDescription = Schema.Struct({
  operations: Schema.Array(Schema.String),
  limits: Schema.Struct({
    maxInputBytes: Schema.Finite,
    maxSliceBytes: Schema.Finite,
    maxImportBytes: Schema.Finite,
    maxWaitMs: Schema.Finite,
  }),
  /**
   * `Server`'s deploy id, which `McpServer` serves as `serverInfo.version`; an older `Server` sends none, and `McpServer`
   * uses its own version id then (`docs/architecture/mcp-endpoint.md` → The handler).
   */
  version: Schema.optionalKey(Schema.String),
  /**
   * The management tools `harness` serves (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → The
   * dispatcher and `describe().harness`): `McpServer` offers one only when it knows its declaration and it is listed here.
   * An older `Server` sends none, which reads as serving none ({@link harnessServed}).
   */
  harness: Schema.String.pipe(Schema.Array, Schema.optionalKey),
});

export type ApiDescription = typeof ApiDescription.Type;

/** The management tools `description` says `harness` serves: none from an older `Server`. */
export const harnessServed = (
  description: Pick<ApiDescription, "harness">,
): ReadonlyArray<string> => description.harness ?? [];

/** The limits `describe()` reports. */
export const MCP_API_LIMITS: ApiDescription["limits"] = {
  maxInputBytes: MAX_MCP_INPUT_BYTES,
  maxSliceBytes: MAX_MCP_SLICE_BYTES,
  maxImportBytes: MAX_MCP_IMPORT_BYTES,
  maxWaitMs: MAX_MCP_WAIT_MS,
};

/** Every operation `McpApi` has had since this contract; the import ones came with the Session's `stageImport*`. */
export const MCP_API_OPERATIONS = [
  "environments",
  "sessions",
  "session",
  "start",
  "send",
  "wait",
  "transcript",
  "stop",
  "importBegin",
  "importAppend",
  "importFinish",
  "importCancel",
  "harness",
  "approvalWait",
  "approvalWithdraw",
] as const;

// ---------------------------------------------------------------------------------------------------------------------
// The management tools (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools)

/**
 * `harness`'s argument, as `McpApi.harness` takes it: the tool's name, its input as the caller sent it (the dispatcher
 * decodes it again with the shared schema), and, for a tool that changes something, the caller's `request_id`.
 */
export const HarnessRequest = Schema.Struct({
  tool: Schema.String,
  input: Schema.Json,
  requestId: Schema.optionalKey(Schema.String),
  via: Via,
});

export type HarnessRequest = typeof HarnessRequest.Type;

/**
 * What `harness` answers: the tool's result text and its structured value, which `McpServer` only wraps. The structured
 * value is a flat object (`@cloudpid/protocol/harness-tools`), so both MCP lanes carry the same shape.
 */
export const HarnessAnswer = Schema.Struct({
  text: Schema.String,
  structured: Schema.Json,
});

export type HarnessAnswer = typeof HarnessAnswer.Type;

/**
 * `approvalWait`'s argument (`approval_wait`'s input): the request, and how long to wait for it to change, in seconds (0
 * to 300, 45 when not given; the target clamps it again).
 */
export const ApprovalWaitRequest = Schema.Struct({
  approval_id: Schema.String,
  timeout_s: Schema.optionalKey(Schema.Finite),
});

export type ApprovalWaitRequest = typeof ApprovalWaitRequest.Type;

/** `approvalWithdraw`'s argument (`approval_withdraw`'s input). */
export const ApprovalWithdrawRequest = Schema.Struct({ approval_id: Schema.String });

export type ApprovalWithdrawRequest = typeof ApprovalWithdrawRequest.Type;

/** What `approvalWait` and `approvalWithdraw` answer: `approval_wait`'s output without `next`, which `McpServer` adds. */
export const ApprovalState = ApprovalStateOutput.mapFields(Struct.omit(["next"]));

export type ApprovalState = typeof ApprovalState.Type;

// ---------------------------------------------------------------------------------------------------------------------
// Cursors

/**
 * What a cursor holds: the conversation it follows, the newest entry seen, the waiting requests seen (a mark: the newest
 * `since`), and the newest settled input (a mark), so a Run that ended after the cursor is told from one that ended
 * before it. Opaque to callers: base64url of this JSON, valid for the Session's life.
 */
export const CursorState = Schema.Struct({
  /** The conversation followed. */
  c: Schema.Int,
  /** The newest entry the caller has seen. */
  e: Schema.Int,
  /** The newest waiting request the caller has seen, by its `since`. */
  w: Schema.Finite,
  /** The newest settled input's submission the caller has seen. */
  s: Schema.Int,
  /** Whether the Session was importing when the cursor was made, so a wait tells an import that has ended since. */
  i: Schema.optionalKey(Schema.Boolean),
});

export type CursorState = typeof CursorState.Type;

const decodeCursorState = Schema.decodeUnknownOption(Schema.fromJsonString(CursorState));

/** `text` as base64url, without padding. */
export const encodeBase64Url = (text: string): string =>
  btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** The text a base64url string holds, or none for a string that is not one. */
export const decodeBase64Url = (text: string): string | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;

  try {
    const padded = text.replaceAll("-", "+").replaceAll("_", "/");

    return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return undefined;
  }
};

/** `state` as the opaque cursor a caller passes back. */
export const encodeCursor = (state: CursorState): string =>
  encodeBase64Url(
    JSON.stringify(
      state.i === true
        ? { c: state.c, e: state.e, w: state.w, s: state.s, i: true }
        : { c: state.c, e: state.e, w: state.w, s: state.s },
    ),
  );

/** The state a cursor holds, or none for one that is not a cursor of this Session's kind (`invalid_cursor`). */
export const decodeCursor = (cursor: string): Option.Option<CursorState> => {
  const json = decodeBase64Url(cursor);

  return json === undefined ? Option.none() : decodeCursorState(json);
};

// ---------------------------------------------------------------------------------------------------------------------
// Following a Run

/** `running`: the root Run is going or input is queued; `background`: the root idles but subagents or tasks work. */
export const McpSessionStatus = openLiterals(
  Schema.Literals(["running", "waiting_for_owner", "background", "idle", "importing", "unknown"]),
  "unknown",
);

export type McpSessionStatus = typeof McpSessionStatus.Type;

export const WaitingKind = openLiterals(
  Schema.Literals([
    "approval",
    "secret",
    "sign_in",
    "elicitation",
    "sampling",
    "browser_handoff",
    "unknown",
  ]),
  "unknown",
);

export type WaitingKind = typeof WaitingKind.Type;

/** A request waiting for the owner, as the Local agent sees it: `summary` is cloudpid's own words, redacted. */
export const WaitingRequest = Schema.Struct({
  kind: WaitingKind,
  request_id: Schema.String,
  agent_id: Schema.String,
  summary: Schema.String,
  /** Epoch milliseconds. */
  since: Schema.Finite,
  /** `/sessions/<id>?request=<request_id>`: the Session page scrolls to that card. */
  url: Schema.String,
});

export type WaitingRequest = typeof WaitingRequest.Type;

/** How the root Run ended, from its submission: a failed Run is an outcome, never an error. */
export const RunOutcome = Schema.Struct({
  result: openLiterals(Schema.Literals(["answered", "stopped", "failed", "unknown"]), "unknown"),
  reason: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});

export type RunOutcome = typeof RunOutcome.Type;

/** What a submission that settled without an answer says, as the outcome (`mcp-endpoint.md` → Following a Run). */
export const runOutcome = (
  settled:
    | { readonly status: "done" }
    | { readonly status: "unanswered"; readonly reason: string; readonly detail?: unknown },
): RunOutcome => {
  if (settled.status === "done") return { result: "answered" };

  const { reason } = settled;
  const detail = Predicate.isString(settled.detail) ? settled.detail : undefined;

  if (reason === "aborted" || reason === "withdrawn" || reason === "reset") {
    return { result: "stopped", reason };
  }

  // pi-ai's marker of a limit that retrying will not lift (`spendMessage`).
  const spent = detail?.includes("out of budget") === true;

  const failed: RunOutcome = { result: "failed", reason: spent ? "spend_limit" : reason };

  return detail === undefined ? failed : { ...failed, message: detail };
};

export const Activity = Schema.Struct({
  entries: Schema.Int,
  tool_calls: Schema.Int,
  latest: Schema.Array(Schema.String),
});

export type Activity = typeof Activity.Type;

export const AnswerText = Schema.Struct({ text: Schema.String, truncated: Schema.Boolean });

export type AnswerText = typeof AnswerText.Type;

// A wait ended by a reason this version does not know reads as `timeout`: a deliberately generic reading, "the wait
// ended; look again", not an alias of the real `timeout`.
export const EndedBy = openLiterals(
  Schema.Literals(["run_ended", "owner_needed", "import_ended", "timeout"]),
  "timeout",
);

export type EndedBy = typeof EndedBy.Type;

// The only reason there is, so an unknown one reads as it: "text withheld", the generic reading, not an alias.
/** Why the text fields were left out: the Secrets to redact them of could not be read. */
export const TextWithheld = openLiterals(
  Schema.Literals(["secrets_unavailable"]),
  "secrets_unavailable",
);

/** What the Session answers a wait (`waitForChange`): `WaitResult` without the Session's id and the `next` sentence. */
export const WaitOutcome = Schema.Struct({
  status: McpSessionStatus,
  ended_by: EndedBy,
  interrupted: Schema.optionalKey(Schema.Boolean),
  branch_changed: Schema.optionalKey(Schema.Boolean),
  outcome: Schema.optionalKey(RunOutcome),
  waiting: Schema.Array(WaitingRequest),
  activity: Activity,
  answer: Schema.optionalKey(AnswerText),
  text_withheld: Schema.optionalKey(TextWithheld),
  error: Schema.optionalKey(Schema.String),
  cursor: Schema.String,
});

export type WaitOutcome = typeof WaitOutcome.Type;

/** `session_wait`'s result. */
export const WaitResult = Schema.Struct({
  session_id: Schema.String,
  ...WaitOutcome.fields,
  next: Schema.optionalKey(Schema.String),
});

export type WaitResult = typeof WaitResult.Type;

/** What the Session answers `status()`: the part of `session_get` only the Session knows. */
export const SessionStatusReport = Schema.Struct({
  status: McpSessionStatus,
  outcome: Schema.optionalKey(RunOutcome),
  waiting: Schema.Array(WaitingRequest),
  model: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(Schema.String),
  last_answer: Schema.optionalKey(AnswerText),
  text_withheld: Schema.optionalKey(TextWithheld),
  /** Whether the owner moved the active branch since the cursor passed in. */
  branch_changed: Schema.optionalKey(Schema.Boolean),
  cursor: Schema.String,
});

export type SessionStatusReport = typeof SessionStatusReport.Type;

/** `waitForChange`'s argument: the cursor the caller holds, and when to give up (epoch milliseconds). */
export const WaitRequest = Schema.Struct({
  after: Schema.optionalKey(Schema.String),
  deadline: Schema.Finite,
});

export type WaitRequest = typeof WaitRequest.Type;

// ---------------------------------------------------------------------------------------------------------------------
// Transcripts

export const TranscriptDetail = Schema.Literals(["summary", "full"]);

export type TranscriptDetail = typeof TranscriptDetail.Type;

export const TranscriptEntry = Schema.Struct({
  entry_id: Schema.Int,
  // A role this version does not know reads as `notice`, the generic "an entry that is not a message".
  role: openLiterals(Schema.Literals(["user", "assistant", "tool", "notice"]), "notice"),
  /** ISO 8601; empty for an entry with no time. */
  at: Schema.String,
  /** The rendered block, header first. */
  text: Schema.String,
});

export type TranscriptEntry = typeof TranscriptEntry.Type;

/** `transcriptPage`'s argument. Neither cursor: the latest page; `before`: older entries; `after`: newer. */
export const TranscriptRequest = Schema.Struct({
  agent_id: Schema.optionalKey(Schema.String),
  before: Schema.optionalKey(Schema.String),
  after: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(TranscriptDetail),
  max_chars: Schema.optionalKey(Schema.Int),
});

export type TranscriptRequest = typeof TranscriptRequest.Type;

/** What the Session answers a transcript read; `session_id` and `next` are the caller's to add. */
export const TranscriptPage = Schema.Struct({
  agent_id: Schema.optionalKey(Schema.String),
  entries: Schema.Array(TranscriptEntry),
  /** The `before` cursor for the page of older entries; absent when this page starts at the oldest. */
  older: Schema.optionalKey(Schema.String),
  /** The `after` cursor for the page of newer entries: pass it again to wait for more. */
  newer: Schema.String,
  branch_changed: Schema.optionalKey(Schema.Boolean),
});

export type TranscriptPage = typeof TranscriptPage.Type;

// ---------------------------------------------------------------------------------------------------------------------
// Starting, sending and stopping

/** What `session_send` does while the Run is busy: `queue` is pi-durable's `followUp`. */
export const McpWhenBusy = Schema.Literals(["queue", "steer", "reject"]);

export type McpWhenBusy = typeof McpWhenBusy.Type;

/** `when_busy` as the socket's `whenBusy` says it. */
export const whenBusyOf = (busy: McpWhenBusy): WhenBusy => (busy === "queue" ? "followUp" : busy);

/** The Session's `submit` argument: the socket's admission, so `whenBusy` is the socket's. */
export const SubmitRequest = Schema.Struct({
  input: Schema.String,
  whenBusy: Schema.optionalKey(WhenBusy),
  /** Submitting the same `requestId` again finds the first submission. */
  requestId: Schema.optionalKey(Schema.String),
  via: SessionVia,
});

export type SubmitRequest = typeof SubmitRequest.Type;

export const Delivery = openLiterals(
  Schema.Literals(["started", "queued", "steered", "unknown"]),
  "unknown",
);

export type Delivery = typeof Delivery.Type;

export const SubmitResult = Schema.Struct({
  delivery: Delivery,
  cursor: Schema.String,
});

export type SubmitResult = typeof SubmitResult.Type;

/**
 * The Session's `configure` argument: the model and thinking level the root conversation runs with from its next request
 * on, as the socket's `configure` picks them (a field left out stays as it is).
 */
export const ConfigureRequest = Schema.Struct({
  model: Schema.optionalKey(ModelId),
  thinkingLevel: Schema.optionalKey(ThinkingLevel),
});

export type ConfigureRequest = typeof ConfigureRequest.Type;

export const StopRequest = Schema.Struct({
  /** Also stop every subagent (Stop all). */
  subagents: Schema.optionalKey(Schema.Boolean),
  via: SessionVia,
});

export type StopRequest = typeof StopRequest.Type;

export const StopResult = Schema.Struct({
  status: McpSessionStatus,
  /** True when the Session had not gone idle by the time the call answered. */
  stopping: Schema.optionalKey(Schema.Boolean),
});

export type StopResult = typeof StopResult.Type;

// ---------------------------------------------------------------------------------------------------------------------
// The listings `McpApi` answers from the Registry

export const McpEnvironment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  default: Schema.Boolean,
  repos: Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.String })),
  running_sessions: Schema.Int,
});

export type McpEnvironment = typeof McpEnvironment.Type;

export const EnvironmentsResult = Schema.Struct({
  environments: Schema.Array(McpEnvironment),
  models: Schema.Struct({
    available: Schema.Array(Schema.String),
    default: Schema.optionalKey(Schema.String),
  }),
});

export type EnvironmentsResult = typeof EnvironmentsResult.Type;

/**
 * A Session the endpoint made or imported, or a Trigger's Fire started (`kind` and `auth` `trigger`, with the Trigger's
 * id and name): the audit mark of how its caller got in, never the owner's email.
 */
export const MarkedOrigin = Schema.Struct({
  kind: openLiterals(Schema.Literals(["mcp", "import", "trigger", "unknown"]), "unknown"),
  client: Schema.optionalKey(McpClient),
  auth: McpAuth,
  trigger: Schema.optionalKey(TriggerMark),
});

export type MarkedOrigin = typeof MarkedOrigin.Type;

/** Where a listed Session came from: a Fork or Clone's source, or the endpoint's marks. */
export const McpSessionOrigin = Schema.Union([
  Schema.Struct({
    kind: openLiterals(Schema.Literals(["fork", "clone", "unknown"]), "unknown"),
    session: Schema.String,
  }),
  MarkedOrigin,
]);

export type McpSessionOrigin = typeof McpSessionOrigin.Type;

/** A Session as `sessions_list` lists it; `status` is the Registry's coarse one. */
export const McpSessionSummary = Schema.Struct({
  session_id: Schema.String,
  title: Schema.NullOr(Schema.String),
  environment: Schema.Struct({ id: Schema.String, name: Schema.String }),
  status: openLiterals(Schema.Literals(["running", "idle", "importing", "unknown"]), "unknown"),
  origin: Schema.optionalKey(McpSessionOrigin),
  updated_at: Schema.String,
  archived: Schema.Boolean,
  url: Schema.String,
});

export type McpSessionSummary = typeof McpSessionSummary.Type;

/** `sessions_list`'s arguments, as `McpApi.sessions` takes them (the environment is an id or an exact name; `sessions` resolves it). */
export const SessionsQuery = Schema.Struct({
  environment: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(["running", "idle"])),
  /** Only archived Sessions when true; only the others (the default) when false. */
  archived: Schema.optionalKey(Schema.Boolean),
  /** A substring of the title, case-insensitive. */
  query: Schema.optionalKey(Schema.String),
  cursor: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Int),
});

export type SessionsQuery = typeof SessionsQuery.Type;

/** `sessions_list`'s default and largest page. */
export const DEFAULT_SESSIONS_PAGE = 20;

export const MAX_SESSIONS_PAGE = 50;

/**
 * `session_get`: the listing fields and what the Session reports of itself, whose five-valued `status` replaces the
 * Registry's coarse one.
 */
export const SessionDetail = Schema.Struct({
  ...McpSessionSummary.fields,
  ...SessionStatusReport.fields,
  agents: Schema.Array(
    Schema.Struct({
      agent_id: Schema.String,
      parent: Schema.String,
      role: Schema.NullOr(Schema.String),
      status: openLiterals(Schema.Literals(["working", "idle", "unknown"]), "unknown"),
    }),
  ),
  workspace: Schema.Struct({
    branch: Schema.NullOr(Schema.String),
    base: Schema.NullOr(Schema.String),
    repos: Schema.Array(Schema.String),
  }),
  next: Schema.optionalKey(Schema.String),
});

export type SessionDetail = typeof SessionDetail.Type;

/** `session_send`'s arguments, as `McpApi.send` takes them. */
export const SendRequest = Schema.Struct({
  session_id: Schema.String,
  text: Schema.String,
  when_busy: Schema.optionalKey(McpWhenBusy),
  request_id: Schema.optionalKey(Schema.String),
  via: Via,
});

export type SendRequest = typeof SendRequest.Type;

/** `session_stop`'s arguments, as `McpApi.stop` takes them. */
export const StopSessionRequest = Schema.Struct({
  session_id: Schema.String,
  subagents: Schema.optionalKey(Schema.Boolean),
  via: Via,
});

export type StopSessionRequest = typeof StopSessionRequest.Type;

/** `session_wait`'s arguments, as `McpApi.wait` takes them: the cursor held, and how long to wait, in seconds. */
export const WaitSessionRequest = Schema.Struct({
  session_id: Schema.String,
  after: Schema.optionalKey(Schema.String),
  timeout_s: Schema.optionalKey(Schema.Finite),
});

export type WaitSessionRequest = typeof WaitSessionRequest.Type;

/** `session_start`'s arguments, as `McpApi.start` takes them (the environment is an id or an exact name). */
export const StartRequest = Schema.Struct({
  environment: Schema.optionalKey(Schema.String),
  text: Schema.String,
  title: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  base: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(Schema.String),
  request_id: Schema.optionalKey(Schema.String),
  via: Via,
});

export type StartRequest = typeof StartRequest.Type;

export const StartResult = Schema.Struct({
  session_id: Schema.String,
  title: Schema.NullOr(Schema.String),
  url: Schema.String,
  status: McpSessionStatus,
  cursor: Schema.String,
  environment: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    repos: Schema.Array(Schema.String),
  }),
  next: Schema.optionalKey(Schema.String),
});

export type StartResult = typeof StartResult.Type;

// ---------------------------------------------------------------------------------------------------------------------
// Session import (`docs/architecture/mcp-endpoint.md` → Session import)

/** How long an import with no append lives, in milliseconds (`import_expired`): an hour. */
export const IMPORT_EXPIRY_MS = 60 * 60 * 1000;

/** How long `session_import_finish` waits for the translation inline, in milliseconds, before it answers `importing`. */
export const IMPORT_FINISH_WAIT_MS = 30_000;

/** `session_import_begin`'s arguments, as `McpApi.importBegin` takes them (the environment is an id or an exact name). */
export const ImportBeginRequest = Schema.Struct({
  environment: Schema.String,
  /** Anything but {@link PI_SESSION_FORMAT} is `unsupported_format`: a string here, so the refusal is ours and not the SDK's. */
  format: Schema.String,
  size_bytes: Schema.Int,
  title: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  base: Schema.optionalKey(Schema.String),
  /** pi's `provider/id`; a model the owner has not is replaced at finish, with a warning. */
  model: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(Schema.String),
  /** The instruction: submitted after the import notice once the import ends. */
  text: Schema.optionalKey(Schema.String),
  request_id: Schema.optionalKey(Schema.String),
  via: Via,
});

export type ImportBeginRequest = typeof ImportBeginRequest.Type;

export const ImportBeginResult = Schema.Struct({
  /** The id every other import tool takes: the Session's own. */
  import_id: Schema.String,
  session_id: Schema.String,
  url: Schema.String,
  /** The bytes the import holds already: 0 for a new one, more for a `request_id` that found its import. */
  received: Schema.Int,
  max_slice_bytes: Schema.Int,
  /** ISO 8601: when the import expires if nothing is appended. */
  expires_at: Schema.String,
  /** Where the Local agent pushes the cwd's Repo's uncommitted Changes: the server's to name, so its scheme can change. */
  carry_ref: Schema.String,
});

export type ImportBeginResult = typeof ImportBeginResult.Type;

export const ImportAppendRequest = Schema.Struct({
  import_id: Schema.String,
  /** The UTF-8 byte offset of `data` in the file: it must equal `received`. */
  offset: Schema.Int,
  data: Schema.String,
});

export type ImportAppendRequest = typeof ImportAppendRequest.Type;

export const ImportAppendResult = Schema.Struct({ received: Schema.Int });

export type ImportAppendResult = typeof ImportAppendResult.Type;

export const ImportFinishRequest = Schema.Struct({
  import_id: Schema.String,
  /** The lowercase hex SHA-256 of the whole file. */
  sha256: Schema.String,
  /**
   * Whether the Local agent carried its uncommitted Changes (pushed them as one commit to `carry_ref`). Sent with finish,
   * not begin, since the carry push comes after begin; absent from a client that does not say, and then the import notice
   * does not say either.
   */
  changes_carried: Schema.optionalKey(Schema.Boolean),
});

export type ImportFinishRequest = typeof ImportFinishRequest.Type;

/** What the translation cut, dropped (by kind: `custom:<type>` for extension state) and closed. */
export const ImportSummary = Schema.Struct({
  cut: Schema.Int,
  dropped: Schema.Record(Schema.String, Schema.Int),
  closed: Schema.Int,
});

export type ImportSummary = typeof ImportSummary.Type;

export const ImportFinishResult = Schema.Struct({
  session_id: Schema.String,
  /** `importing` while the translation still runs: `session_wait` from the cursor reports `import_ended`. */
  status: McpSessionStatus,
  url: Schema.String,
  cursor: Schema.String,
  summary: Schema.optionalKey(ImportSummary),
  /** Redacted: the model fallback, `context_over_window`. */
  warnings: Schema.Array(Schema.String),
});

export type ImportFinishResult = typeof ImportFinishResult.Type;

export const ImportCancelRequest = Schema.Struct({ import_id: Schema.String });

export type ImportCancelRequest = typeof ImportCancelRequest.Type;

export const ImportCancelResult = Schema.Struct({ cancelled: Schema.Literal(true) });

export type ImportCancelResult = typeof ImportCancelResult.Type;

/** The Repos of a new import's Workspace as its import notice names them: the name, and where it is cloned. */
export const ImportRepo = Schema.Struct({ name: Schema.String, directory: Schema.String });

export type ImportRepo = typeof ImportRepo.Type;

/** `stageImportBegin`'s argument: what the Session keeps with the import until it ends. */
export const StageImportBegin = Schema.Struct({
  size_bytes: Schema.Int,
  model: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  /** Who is importing, as the instruction's input is marked. */
  via: SessionVia,
  /** What the import notice says of the Workspace. */
  workspace: Schema.Struct({ branch: Schema.String, repos: Schema.Array(ImportRepo) }),
});

export type StageImportBegin = typeof StageImportBegin.Type;

/** What `stageImportBegin` and `stageImportAppend` answer: how much the Session holds, and when the import expires (epoch ms). */
export const StagedImport = Schema.Struct({ received: Schema.Int, expires_at: Schema.Finite });

export type StagedImport = typeof StagedImport.Type;

export const StageImportAppend = Schema.Struct({ offset: Schema.Int, data: Schema.String });

export type StageImportAppend = typeof StageImportAppend.Type;

export const StageImportFinish = Schema.Struct({
  sha256: Schema.String,
  /** As `ImportFinishRequest.changes_carried`: kept with the import for its notice, from the finish that is accepted. */
  changes_carried: Schema.optionalKey(Schema.Boolean),
});

export type StageImportFinish = typeof StageImportFinish.Type;

/** What `stageImportFinish` answers: `ImportFinishResult` without the Session's id and URL, which are the caller's. */
export const StagedFinish = Schema.Struct({
  status: McpSessionStatus,
  cursor: Schema.String,
  summary: Schema.optionalKey(ImportSummary),
  warnings: Schema.Array(Schema.String),
});

export type StagedFinish = typeof StagedFinish.Type;

/** What `stageImportCancel` answers: the import is discarded, and the caller deletes the Session. */
export const StagedCancel = Schema.Struct({ cancelled: Schema.Literal(true) });

export type StagedCancel = typeof StagedCancel.Type;

/**
 * What `McpServer` calls: an `RpcTarget` the main Worker builds per request over the Registry and the Sessions
 * (`apps/server/src/mcp/api.ts`). Failures travel as values; nothing streams. An operation `describe()` does not list
 * (an older `Server`'s import ones) answers `unsupported`.
 */
export interface McpApi {
  describe(): ApiDescription;
  environments(): Promise<ApiResult<EnvironmentsResult>>;
  sessions(query: SessionsQuery): Promise<
    ApiResult<{
      readonly sessions: ReadonlyArray<McpSessionSummary>;
      readonly next_cursor?: string;
    }>
  >;
  session(id: string): Promise<ApiResult<SessionDetail>>;
  start(request: StartRequest): Promise<ApiResult<StartResult>>;
  wait(request: WaitSessionRequest): Promise<ApiResult<WaitResult>>;
  transcript(
    request: TranscriptRequest & { readonly session_id: string },
  ): Promise<ApiResult<TranscriptPage & { readonly session_id: string }>>;
  send(request: SendRequest): Promise<ApiResult<SubmitResult>>;
  stop(request: StopSessionRequest): Promise<ApiResult<StopResult>>;
  importBegin(request: ImportBeginRequest): Promise<ApiResult<ImportBeginResult>>;
  importAppend(request: ImportAppendRequest): Promise<ApiResult<ImportAppendResult>>;
  importFinish(request: ImportFinishRequest): Promise<ApiResult<ImportFinishResult>>;
  importCancel(request: ImportCancelRequest): Promise<ApiResult<ImportCancelResult>>;
  /** The management tools `describe().harness` lists. */
  harness(request: HarnessRequest): Promise<ApiResult<HarnessAnswer>>;
  /** `approval_wait`: a request asked over the endpoint, read once or waited for (`docs/architecture/mcp-endpoint.md` → Approvals with no Session). */
  approvalWait(request: ApprovalWaitRequest): Promise<ApiResult<ApprovalState>>;
  /** `approval_withdraw`: a waiting request taken back. */
  approvalWithdraw(request: ApprovalWithdrawRequest): Promise<ApiResult<ApprovalState>>;
  /**
   * Present when the caller is over its rate; `McpServer` answers `rate_limited` with it. A getter of the `RpcTarget`,
   * read once per `tools/call` (and counted then): over RPC it is awaited, so an older `Server` that has none reads as
   * not limited.
   */
  limited?: { readonly retryAfterS: number };
  /** How the caller got in, for the call's span; read over RPC like `limited`, and `unknown` when absent. */
  auth?: McpAuth;
}
