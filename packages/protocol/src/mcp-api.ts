// The MCP endpoint's `api` contract (`docs/architecture/mcp-endpoint.md` → The `api` target, Tools, Following a Run,
// Transcripts, Access and identity): what the main Worker's `McpApi` target answers `McpServer`, and what the Session
// object answers the main Worker (`status`, `waitForChange`, `transcriptPage`, `submit`, `stop`). Effect Schemas, shared
// with `packages/pi-cloudpid`, so nothing here imports the MCP SDK, pi-durable's runtime or a Worker API.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over short strings and records.
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { WhenBusy } from "./session.ts";

/** The most input text a message may carry over the endpoint, in UTF-8 bytes (`input_too_large`). */
export const MAX_MCP_INPUT_BYTES = 1_900_000;

/** The most `data` one import slice carries, in UTF-8 bytes. */
export const MAX_MCP_SLICE_BYTES = 2 * 1024 * 1024;

/** The most an import brings in total, in bytes. */
export const MAX_MCP_IMPORT_BYTES = 64 * 1024 * 1024;

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

/** How the caller got in: an Access OAuth grant (the owner), or the Local agent's service token. */
export const McpAuth = Schema.Literals(["oauth", "service_token"]);

export type McpAuth = typeof McpAuth.Type;

/** The MCP generation the caller spoke. */
export const McpEra = Schema.Literals(["legacy", "modern"]);

export type McpEra = typeof McpEra.Type;

/** The caller's name (display only, untrusted), and its version when it said. */
export const McpClient = Schema.Struct({
  name: Schema.String,
  version: Schema.optionalKey(Schema.String),
});

export type McpClient = typeof McpClient.Type;

/**
 * Who sent an input over the endpoint (`docs/architecture/mcp-endpoint.md` → Access and identity, Marks): never the
 * owner's email. The `auth` kind and the client's name are the audit mark; `era` is for telemetry.
 */
export const Via = Schema.Struct({
  client: Schema.optionalKey(McpClient),
  auth: McpAuth,
  era: Schema.optionalKey(McpEra),
});

export type Via = typeof Via.Type;

/** The words that say where an input or Session came from: "MCP · pi", or "MCP" when the caller gave no name. */
export const viaLabel = (via: Pick<Via, "client">, kind: "mcp" | "import" = "mcp"): string => {
  const prefix = kind === "mcp" ? "MCP" : "Imported";

  return via.client === undefined ? prefix : `${prefix} · ${via.client.name}`;
};

/** Domain failures (`isError` results); the endpoint's `unsupported` and `unavailable` end the list. */
export const ApiErrorCode = Schema.Literals([
  "not_found",
  "ambiguous_environment",
  "invalid_argument",
  "invalid_cursor",
  "session_busy",
  "session_importing",
  "session_archived",
  "branch_taken",
  "input_too_large",
  "too_many_running",
  "too_many_waits",
  "rate_limited",
  "offset_mismatch",
  "import_too_large",
  "import_expired",
  "checksum_mismatch",
  "unsupported_format",
  "unsupported",
  "unavailable",
]);

export type ApiErrorCode = typeof ApiErrorCode.Type;

const isApiErrorCode = Schema.is(ApiErrorCode);

/**
 * A code as a caller reads it: one this version does not know (a newer deploy's) reads as `unavailable`, the generic
 * failure that may heal, never as a decoding error (`docs/architecture/mcp.md` → Deploys).
 */
export const readApiErrorCode = (code: Schema.Json): ApiErrorCode =>
  isApiErrorCode(code) ? code : "unavailable";

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

/** What `describe()` says the deployed `Server` supports; `McpServer` gates its tools on it. */
export const ApiDescription = Schema.Struct({
  operations: Schema.Array(Schema.String),
  limits: Schema.Struct({
    maxInputBytes: Schema.Finite,
    maxSliceBytes: Schema.Finite,
    maxImportBytes: Schema.Finite,
    maxWaitMs: Schema.Finite,
  }),
});

export type ApiDescription = typeof ApiDescription.Type;

/** The limits `describe()` reports. */
export const MCP_API_LIMITS: ApiDescription["limits"] = {
  maxInputBytes: MAX_MCP_INPUT_BYTES,
  maxSliceBytes: MAX_MCP_SLICE_BYTES,
  maxImportBytes: MAX_MCP_IMPORT_BYTES,
  maxWaitMs: MAX_MCP_WAIT_MS,
};

/** Every operation `McpApi` has had since this contract; the import ones come with `stageImport*`. */
export const MCP_API_OPERATIONS = [
  "environments",
  "sessions",
  "session",
  "start",
  "send",
  "wait",
  "transcript",
  "stop",
] as const;

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
});

export type CursorState = typeof CursorState.Type;

const decodeCursorState = Schema.decodeUnknownOption(Schema.fromJsonString(CursorState));

const encodeBase64Url = (text: string): string =>
  btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const decodeBase64Url = (text: string): string | undefined => {
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
  encodeBase64Url(JSON.stringify({ c: state.c, e: state.e, w: state.w, s: state.s }));

/** The state a cursor holds, or none for one that is not a cursor of this Session's kind (`invalid_cursor`). */
export const decodeCursor = (cursor: string): Option.Option<CursorState> => {
  const json = decodeBase64Url(cursor);

  return json === undefined ? Option.none() : decodeCursorState(json);
};

// ---------------------------------------------------------------------------------------------------------------------
// Following a Run

/** `running`: the root Run is going or input is queued; `background`: the root idles but subagents or tasks work. */
export const McpSessionStatus = Schema.Literals([
  "running",
  "waiting_for_owner",
  "background",
  "idle",
  "importing",
]);

export type McpSessionStatus = typeof McpSessionStatus.Type;

export const WaitingKind = Schema.Literals([
  "approval",
  "secret",
  "sign_in",
  "elicitation",
  "sampling",
  "browser_handoff",
]);

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
  result: Schema.Literals(["answered", "stopped", "failed"]),
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

export const EndedBy = Schema.Literals([
  "run_ended",
  "owner_needed",
  "import_ended",
  "stalled",
  "timeout",
]);

export type EndedBy = typeof EndedBy.Type;

/** Why the text fields were left out: the Secrets to redact them of could not be read. */
export const TextWithheld = Schema.Literal("secrets_unavailable");

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
  role: Schema.Literals(["user", "assistant", "tool", "notice"]),
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
  via: Via,
});

export type SubmitRequest = typeof SubmitRequest.Type;

export const Delivery = Schema.Literals(["started", "queued", "steered"]);

export type Delivery = typeof Delivery.Type;

export const SubmitResult = Schema.Struct({
  delivery: Delivery,
  cursor: Schema.String,
});

export type SubmitResult = typeof SubmitResult.Type;

export const StopRequest = Schema.Struct({
  /** Also stop every subagent (Stop all). */
  subagents: Schema.optionalKey(Schema.Boolean),
  via: Via,
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

/** Where a listed Session came from: a Fork or Clone's source, or the endpoint's marks. */
export const McpSessionOrigin = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["fork", "clone"]), session: Schema.String }),
  Schema.Struct({
    kind: Schema.Literals(["mcp", "import"]),
    client: Schema.optionalKey(McpClient),
    auth: McpAuth,
  }),
]);

export type McpSessionOrigin = typeof McpSessionOrigin.Type;

/** A Session as `sessions_list` lists it; `status` is the Registry's coarse one. */
export const McpSessionSummary = Schema.Struct({
  session_id: Schema.String,
  title: Schema.NullOr(Schema.String),
  environment: Schema.Struct({ id: Schema.String, name: Schema.String }),
  status: Schema.Literals(["running", "idle"]),
  origin: Schema.optionalKey(McpSessionOrigin),
  updated_at: Schema.String,
  archived: Schema.Boolean,
  url: Schema.String,
});

export type McpSessionSummary = typeof McpSessionSummary.Type;

/** `sessions_list`'s arguments, as `McpApi.sessions` takes them (the environment is an id by then). */
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
      status: Schema.Literals(["working", "idle"]),
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

/**
 * What `McpServer` calls: an `RpcTarget` the main Worker builds per request over the Registry and the Sessions
 * (`apps/server/src/mcp/api.ts`). Failures travel as values; nothing streams. The import operations join it with
 * `stageImport*`: an operation not listed by `describe()` answers `unsupported`.
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
  wait(request: {
    readonly session_id: string;
    readonly after?: string;
    readonly timeout_s?: number;
  }): Promise<ApiResult<WaitResult>>;
  transcript(
    request: TranscriptRequest & { readonly session_id: string },
  ): Promise<ApiResult<TranscriptPage & { readonly session_id: string }>>;
  send(
    request: {
      readonly session_id: string;
      readonly text: string;
      readonly when_busy?: McpWhenBusy;
      readonly request_id?: string;
    } & { readonly via: Via },
  ): Promise<ApiResult<SubmitResult>>;
  stop(
    request: { readonly session_id: string; readonly subagents?: boolean } & {
      readonly via: Via;
    },
  ): Promise<ApiResult<StopResult>>;
  /** Present when the caller is over its rate; `McpServer` answers `rate_limited` with it. */
  limited?: { readonly retryAfterS: number };
}
