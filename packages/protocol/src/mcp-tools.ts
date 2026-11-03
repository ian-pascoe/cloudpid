// The MCP endpoint's tools as schemas (`docs/architecture/mcp-endpoint.md` → Tools): each tool's arguments and the result
// `structuredContent` carries, and the `api` operation that serves it. Effect Schemas shared by `McpServer` (which turns
// them into the SDK's tool definitions) and `packages/pi-cloudpid`. The four read tools come first; the rest join as their
// operations do. Nothing here imports the MCP SDK or a Worker API.
import * as Schema from "effect/Schema";
import {
  DEFAULT_SESSIONS_PAGE,
  DEFAULT_TRANSCRIPT_CHARS,
  EnvironmentsResult,
  MAX_SESSIONS_PAGE,
  MAX_TRANSCRIPT_CHARS,
  McpSessionSummary,
  type McpToolName,
  MIN_TRANSCRIPT_CHARS,
  SessionDetail,
  TranscriptDetail,
  TranscriptPage,
} from "./mcp-api.ts";

/**
 * The `McpApi` operation each tool is served by: `McpServer` registers a tool only when the deployed `Server`'s
 * `describe()` lists its operation (`docs/architecture/mcp-endpoint.md` → The `api` target, Version skew).
 */
export const MCP_TOOL_OPERATIONS: Readonly<Record<McpToolName, string>> = {
  environments_list: "environments",
  sessions_list: "sessions",
  session_get: "session",
  session_wait: "wait",
  session_transcript: "transcript",
  session_start: "start",
  session_send: "send",
  session_stop: "stop",
  session_import_begin: "importBegin",
  session_import_append: "importAppend",
  session_import_finish: "importFinish",
  session_import_cancel: "importCancel",
};

// ---------------------------------------------------------------------------------------------------------------------
// Arguments

const SessionId = Schema.String.annotate({
  description: "The Session's full id (a UUID), as sessions_list gives it.",
});

export const EnvironmentsListInput = Schema.Struct({});

export type EnvironmentsListInput = typeof EnvironmentsListInput.Type;

export const SessionsListInput = Schema.Struct({
  environment: Schema.optionalKey(
    Schema.String.annotate({
      description: "Only this Environment's Sessions: its id or its name.",
    }),
  ),
  status: Schema.optionalKey(
    Schema.Literals(["running", "idle"]).annotate({ description: "Only Sessions in this state." }),
  ),
  archived: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "True lists only archived Sessions; the default (false) lists only the others.",
    }),
  ),
  query: Schema.optionalKey(
    Schema.String.annotate({ description: "Only Sessions whose title has this text (any case)." }),
  ),
  cursor: Schema.optionalKey(
    Schema.String.annotate({
      description: "The next_cursor of the previous page, for the next one.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SESSIONS_PAGE })).annotate({
      description: `How many Sessions to list (1-${MAX_SESSIONS_PAGE}, default ${DEFAULT_SESSIONS_PAGE}).`,
    }),
  ),
});

export type SessionsListInput = typeof SessionsListInput.Type;

export const SessionGetInput = Schema.Struct({ session_id: SessionId });

export type SessionGetInput = typeof SessionGetInput.Type;

export const SessionTranscriptInput = Schema.Struct({
  session_id: SessionId,
  agent_id: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "A subagent's id from session_get's agents; the Session's own conversation by default.",
    }),
  ),
  before: Schema.optionalKey(
    Schema.String.annotate({ description: "A page's `older` cursor: read the entries before it." }),
  ),
  after: Schema.optionalKey(
    Schema.String.annotate({ description: "A page's `newer` cursor: read the entries after it." }),
  ),
  detail: Schema.optionalKey(
    TranscriptDetail.annotate({
      description:
        "summary (the default) keeps long text short and shows tool results as one line; full keeps more of it.",
    }),
  ),
  max_chars: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: MIN_TRANSCRIPT_CHARS, maximum: MAX_TRANSCRIPT_CHARS }),
    ).annotate({
      description: `The most characters of transcript in the page (${MIN_TRANSCRIPT_CHARS}-${MAX_TRANSCRIPT_CHARS}, default ${DEFAULT_TRANSCRIPT_CHARS}).`,
    }),
  ),
});

export type SessionTranscriptInput = typeof SessionTranscriptInput.Type;

// ---------------------------------------------------------------------------------------------------------------------
// Results: what `structuredContent` carries, each with `next`, one sentence naming the next tool and cursor.

const next = Schema.optionalKey(Schema.String);

export const EnvironmentsListResult = Schema.Struct({ ...EnvironmentsResult.fields, next });

export type EnvironmentsListResult = typeof EnvironmentsListResult.Type;

export const SessionsListResult = Schema.Struct({
  sessions: Schema.Array(McpSessionSummary),
  next_cursor: Schema.optionalKey(Schema.String),
  next,
});

export type SessionsListResult = typeof SessionsListResult.Type;

export const SessionGetResult = SessionDetail;

export type SessionGetResult = typeof SessionGetResult.Type;

export const SessionTranscriptResult = Schema.Struct({
  session_id: Schema.String,
  ...TranscriptPage.fields,
  next,
});

export type SessionTranscriptResult = typeof SessionTranscriptResult.Type;
