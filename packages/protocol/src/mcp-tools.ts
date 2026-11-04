// The MCP endpoint's tools as schemas (`docs/architecture/mcp-endpoint.md` → Tools): each tool's arguments and the result
// `structuredContent` carries, and the `api` operation that serves it. Effect Schemas shared by `McpServer` (which turns
// them into the SDK's tool definitions) and `packages/pi-cloudpid`. The four read tools come first; the rest join as their
// operations do. Nothing here imports the MCP SDK or a Worker API.
import { THINKING_LEVELS } from "@cloudpid/config";
import * as Schema from "effect/Schema";
import {
  DEFAULT_SESSIONS_PAGE,
  DEFAULT_TRANSCRIPT_CHARS,
  DEFAULT_MCP_WAIT_MS,
  EnvironmentsResult,
  ImportAppendResult,
  ImportBeginResult,
  ImportCancelResult,
  ImportFinishResult,
  MAX_MCP_IMPORT_BYTES,
  MAX_MCP_SLICE_BYTES,
  MAX_MCP_WAIT_MS,
  MAX_SESSIONS_PAGE,
  MAX_TRANSCRIPT_CHARS,
  McpSessionSummary,
  type McpToolName,
  McpWhenBusy,
  MIN_TRANSCRIPT_CHARS,
  PI_SESSION_FORMAT,
  SessionDetail,
  StartResult,
  StopResult,
  SubmitResult,
  TranscriptDetail,
  TranscriptPage,
  WaitResult,
} from "./mcp-api.ts";
import { MAX_TITLE_LENGTH } from "./registry.ts";

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

export const SessionWaitInput = Schema.Struct({
  session_id: SessionId,
  after: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "A cursor from session_start, session_send, session_get or the previous session_wait: wait for what happens after it, and pass back the cursor each result gives. Without it the wait returns at once unless a Run is going and nothing waits for the owner.",
    }),
  ),
  timeout_s: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: MAX_MCP_WAIT_MS / 1000 })).annotate(
      {
        description: `The most seconds to wait (0-${MAX_MCP_WAIT_MS / 1000}, default ${DEFAULT_MCP_WAIT_MS / 1000}); the wait returns sooner when the Run ends. When it times out, call it again with the cursor it gave.`,
      },
    ),
  ),
});

export type SessionWaitInput = typeof SessionWaitInput.Type;

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

/** The longest `request_id` (the Session keeps the ones it has seen, and a longer one could not be told apart on a resend). */
export const MAX_REQUEST_ID_CHARS = 256;

const RequestId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_REQUEST_ID_CHARS),
).annotate({
  description:
    "Any id you make up for this call (a UUID is fine). Sending the same request_id again returns the first result instead of doing it twice: use it on a retry after a connection error.",
});

export const SessionStartInput = Schema.Struct({
  environment: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The Environment to work in: its id or its name, from environments_list. Leave it out only for work tied to no Repo (the default Environment has none).",
    }),
  ),
  text: Schema.String.check(Schema.isNonEmpty()).annotate({
    description:
      "The first message: what the Session should do. It starts a Run at once, so say everything it needs.",
  }),
  title: Schema.optionalKey(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_TITLE_LENGTH)).annotate({
      description: "A title for the Session; left out, cloudpid names it after its first answer.",
    }),
  ),
  branch: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The branch the Session's new Workspace works on (default cloudpid/<id>); refused if another Workspace is on it.",
    }),
  ),
  base: Schema.optionalKey(
    Schema.String.annotate({
      description: "The branch a new branch starts from (default: each Repo's default branch).",
    }),
  ),
  model: Schema.optionalKey(
    Schema.String.annotate({
      description: "One of environments_list's models.available; the default model otherwise.",
    }),
  ),
  thinking: Schema.optionalKey(
    Schema.Literals(THINKING_LEVELS).annotate({
      description: "The model's thinking level; the default otherwise.",
    }),
  ),
  request_id: Schema.optionalKey(RequestId),
});

export type SessionStartInput = typeof SessionStartInput.Type;

export const SessionSendInput = Schema.Struct({
  session_id: SessionId,
  text: Schema.String.check(Schema.isNonEmpty()).annotate({
    description: "The message to send the Session, as the owner would type it.",
  }),
  when_busy: Schema.optionalKey(
    McpWhenBusy.annotate({
      description:
        "What to do while a Run is going: queue (the default) waits for the Run to end and then starts another, steer joins the running Run at its next step, reject fails with session_busy. An idle Session starts a Run whichever you pick.",
    }),
  ),
  request_id: Schema.optionalKey(RequestId),
});

export type SessionSendInput = typeof SessionSendInput.Type;

export const SessionStopInput = Schema.Struct({
  session_id: SessionId,
  subagents: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "True also stops every subagent (Stop all); the default (false) stops the Session's own Run and leaves its subagents working.",
    }),
  ),
});

export type SessionStopInput = typeof SessionStopInput.Type;

// Session import: the tools a program drives (`/cloudpid`), never a model.

const ImportId = Schema.String.annotate({
  description: "The import_id session_import_begin returned.",
});

export const SessionImportBeginInput = Schema.Struct({
  environment: Schema.String.annotate({
    description:
      "The Environment to import into: its id or its name, from environments_list. Its Repo for the local cwd must be one of its Repos.",
  }),
  format: Schema.String.annotate({
    description: `The file's format: only ${PI_SESSION_FORMAT} (pi's own session file: its header line and the active branch's entry lines, as pi wrote them).`,
  }),
  size_bytes: Schema.Int.annotate({
    description: `The file's size in UTF-8 bytes (at most ${String(MAX_MCP_IMPORT_BYTES)}).`,
  }),
  title: Schema.optionalKey(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_TITLE_LENGTH)).annotate({
      description:
        "The Session's title (pi's session name); left out, cloudpid names it when the import ends.",
    }),
  ),
  branch: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The branch the Session's new Workspace works on (the local branch, pushed first); refused as branch_taken if another Workspace is on it.",
    }),
  ),
  base: Schema.optionalKey(
    Schema.String.annotate({ description: "The branch a new branch starts from." }),
  ),
  model: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The local model as provider/id. Used if the owner has it, else the Environment's default, with a warning when the import finishes.",
    }),
  ),
  thinking: Schema.optionalKey(
    Schema.Literals(THINKING_LEVELS).annotate({
      description: "The local thinking level, clamped to what the model supports.",
    }),
  ),
  text: Schema.optionalKey(
    Schema.String.check(Schema.isNonEmpty()).annotate({
      description:
        "The instruction: sent to the Session after the import notice once the import ends, as from the Local agent. Left out, the Session waits for the owner.",
    }),
  ),
  request_id: Schema.optionalKey(RequestId),
});

export type SessionImportBeginInput = typeof SessionImportBeginInput.Type;

export const SessionImportAppendInput = Schema.Struct({
  import_id: ImportId,
  offset: Schema.Int.annotate({
    description:
      "The UTF-8 byte offset of data in the file. It must equal the received count the last call gave; otherwise the answer is offset_mismatch with received, and the next slice starts there.",
  }),
  data: Schema.String.annotate({
    description: `The next slice of the file, cut at any character boundary, at most ${String(MAX_MCP_SLICE_BYTES)} UTF-8 bytes. Sending a slice again is harmless.`,
  }),
});

export type SessionImportAppendInput = typeof SessionImportAppendInput.Type;

export const SessionImportFinishInput = Schema.Struct({
  import_id: ImportId,
  sha256: Schema.String.annotate({
    description: "The lowercase hex SHA-256 of the whole file, as the slices put it together.",
  }),
  changes_carried: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Whether uncommitted Changes were pushed to carry_ref (true) or there were none to carry (false). The import notice tells the Session's agent so. Leave it out when unknown.",
    }),
  ),
});

export type SessionImportFinishInput = typeof SessionImportFinishInput.Type;

export const SessionImportCancelInput = Schema.Struct({ import_id: ImportId });

export type SessionImportCancelInput = typeof SessionImportCancelInput.Type;

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

export const SessionWaitResult = WaitResult;

export type SessionWaitResult = typeof SessionWaitResult.Type;

export const SessionTranscriptResult = Schema.Struct({
  session_id: Schema.String,
  ...TranscriptPage.fields,
  next,
});

export type SessionTranscriptResult = typeof SessionTranscriptResult.Type;

export const SessionStartResult = StartResult;

export type SessionStartResult = typeof SessionStartResult.Type;

export const SessionSendResult = Schema.Struct({ ...SubmitResult.fields, next });

export type SessionSendResult = typeof SessionSendResult.Type;

export const SessionStopResult = Schema.Struct({ ...StopResult.fields, next });

export type SessionStopResult = typeof SessionStopResult.Type;

export const SessionImportBeginResult = Schema.Struct({ ...ImportBeginResult.fields, next });

export type SessionImportBeginResult = typeof SessionImportBeginResult.Type;

export const SessionImportAppendResult = Schema.Struct({ ...ImportAppendResult.fields, next });

export type SessionImportAppendResult = typeof SessionImportAppendResult.Type;

export const SessionImportFinishResult = Schema.Struct({ ...ImportFinishResult.fields, next });

export type SessionImportFinishResult = typeof SessionImportFinishResult.Type;

export const SessionImportCancelResult = Schema.Struct({ ...ImportCancelResult.fields, next });

export type SessionImportCancelResult = typeof SessionImportCancelResult.Type;
