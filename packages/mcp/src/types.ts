/**
 * `@cloudpid/mcp/types`: Effect Schemas for `McpHost`'s and `McpEngine`'s RPC (`McpEngineMethods` included). It never
 * loads the SDK, so Sessions, the `mcp` extension, `McpHost`, the web app and the bridge can import it; its test
 * (`sdk-isolation.test.ts`) fails if it comes to.
 *
 * `docs/architecture/mcp.md` → Packages and objects (the core's seam), Deploys (`prior` rows carry a format `v`).
 * What is here so far: the core's tagged `McpError`, `McpErrorWire` (with its fallback `OtherMcpError`, and
 * `mayHaveRun`) for the engine edge, the call context, the `prior` rows the host keeps for the engine
 * (`docs/architecture/mcp-connections.md` → Storage), `McpEngine`'s RPC, `McpEngineMethods`
 * (`docs/architecture/mcp-connections.md` → The engine) with the Schemas of its sign-in read (`./public-fetch.ts`), and the
 * host's own RPC (`./host.ts`).
 */
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { McpInputAnswer, McpInputRequest } from "./elicitation.ts";
import { hostAnswerReader, McpHostFailure } from "./host.ts";
import { isJsonObject, JsonObject } from "./json.ts";
import { McpLogEntry } from "./log.ts";
import type { McpPublicFetchRequest, McpPublicFetchResult } from "./public-fetch.ts";
import { McpAuthChallenge } from "./sign-in.ts";

export * from "./deadline.ts";

export * from "./elicitation.ts";

export * from "./host.ts";

export * from "./log.ts";

export { isMissingMethod } from "./missing-method.ts";

export {
  BODYLESS_STATUSES,
  McpPublicFetched,
  McpPublicFetchRequest,
  McpPublicFetchResult,
  McpPublicRefused,
  PUBLIC_FETCH_HEADERS,
  publicFetchHeaders,
} from "./public-fetch.ts";

export { isJsonObject, JsonObject, jsonListOf, present } from "./json.ts";

export { xMcpHeaderProblems } from "./tool-headers.ts";

/** Where a call comes from (The MCP core #394 D7, `McpCallContext`). */
export const McpCallOrigin = Schema.Literals(["agent", "owner", "app", "host"]);

export type McpCallOrigin = typeof McpCallOrigin.Type;

/**
 * What a caller can answer (`docs/architecture/mcp-server-requests.md` → Questions): the kinds of question the call's
 * `onInput` takes (elicitation and, on a Legacy server, Sampling), and how long a Legacy question may wait for the owner (`inputWaitMs`, the largest of the kinds
 * offered). The core declares to the server only what is offered here, and a callback's presence is the other half of
 * the version-skew gate (`docs/architecture/mcp.md` → Deploys: `ctx.answers`).
 */
export const McpAnswers = Schema.Struct({
  elicitation: Schema.optionalKey(Schema.Boolean),
  /**
   * The caller answers a server's Sampling request (`docs/architecture/mcp-server-requests.md` → Sampling requests): a
   * Legacy server's, on the call's stream, and a Modern server's, in a round of questions, which `onInput` runs, or keeps
   * for later when the caller also sets `defer`. A Modern request declares `sampling` only with it.
   */
  sampling: Schema.optionalKey(Schema.Boolean),
  inputWaitMs: Schema.optionalKey(Schema.Finite),
  /**
   * The caller keeps a Modern server's questions for later (`onInput` may answer `defer`), so the request may be
   * answered `input_required` with a `ResumeState`, and `resume` sends it again with the answers. Without it no request
   * is ever answered `input_required`, and a `defer` reads as `cancel` (`docs/architecture/mcp-server-requests.md` →
   * Questions).
   */
  defer: Schema.optionalKey(Schema.Boolean),
  /**
   * The caller keeps a Legacy server's `-32042` (URL elicitation required) for later, as it does a Modern round with
   * `defer` (which it sets too): the request may be answered `pages_required` with a `ResendState`, and `resend` sends
   * it again once the owner has opened the pages. Without it a `-32042` is the server's error, as before. A new success
   * shape, so asked for apart from `defer` (`docs/architecture/mcp.md` → Deploys). With `defer` it is also what makes a
   * Modern request declare the elicitation's `url` mode: the caller keeps a page for later and sends the call again once
   * the owner is done there, as `resume` does for any Modern round (a read, which has no `resume`, declares none).
   */
  pages: Schema.optionalKey(Schema.Boolean),
  /**
   * The caller waits for the owner at a page, live, with no resume (a prompt send's `prompts/get`, which keeps nothing for
   * later): a Modern request declares the elicitation's `url` mode, and its page reaches `onInput` as a `deferrable`
   * question the caller answers once the owner is done there; a Legacy server's `-32042` reaches it the same way, once per
   * resend of the request, at most `MCP_INPUT_ROUNDS` times. Without it a get has neither (`docs/architecture/
   * mcp-server-requests.md` → Questions, Elicitation requests). A new key, so a core from before it ignores it and the
   * request is as it was.
   */
  livePages: Schema.optionalKey(Schema.Boolean),
});

export type McpAnswers = typeof McpAnswers.Type;

/**
 * Who a request is made for: what the client declares on it (`capabilities(ctx)`) and which questions it may ask
 * (`answers`) follow from it.
 */
export const McpCallContext = Schema.Struct({
  origin: McpCallOrigin,
  conversation: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(Schema.String),
  allowTask: Schema.optionalKey(Schema.Boolean),
  answers: Schema.optionalKey(McpAnswers),
});

export type McpCallContext = typeof McpCallContext.Type;

/**
 * The MCP tasks extension's id (`docs/architecture/mcp.md` → Extensions): a Modern server advertises it in its
 * `capabilities.extensions`, and a client declares it in a request's `_meta` client capabilities, only on a
 * `tools/call` it can wait for (`ctx.allowTask`) and on the `tasks/*` requests of a task it started.
 */
export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/** The statuses of an MCP task (`docs/architecture/mcp-server-requests.md` → MCP tasks). */
export const McpTaskStatus = Schema.Literals([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);

export type McpTaskStatus = typeof McpTaskStatus.Type;

/** What every task carries: the server's id for it (never shown to a model), its times and its hints. */
const TaskFields = {
  taskId: Schema.String,
  statusMessage: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  lastUpdatedAt: Schema.String,
  /** How long the server keeps the task after it ends, in milliseconds; `null` for as long as it likes. */
  ttlMs: Schema.NullOr(Schema.Int),
  pollIntervalMs: Schema.optionalKey(Schema.Int),
};

/** A task as a `tools/call` created it: `resultType: "task"` without the `resultType`. */
export const McpTaskCreated = Schema.Struct({ ...TaskFields, status: McpTaskStatus });

export type McpTaskCreated = typeof McpTaskCreated.Type;

/** A JSON-RPC error a failed task ended with. */
export const McpTaskError = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Json),
});

export type McpTaskError = typeof McpTaskError.Type;

/**
 * What a `tasks/get` answers, by status. A `completed` task's result is the `CallToolResult` the call would have
 * returned: the core hands it apart from the snapshot (`McpTaskState`), so the engine can validate it and, when large,
 * stream it as it does any result. `inputRequests` are the server's questions, kept as the server sent them: answering
 * them comes with the Modern questions, not with the task wire.
 */
export const McpTaskSnapshot = Schema.Union([
  Schema.Struct({ ...TaskFields, status: Schema.Literal("working") }),
  Schema.Struct({
    ...TaskFields,
    status: Schema.Literal("input_required"),
    inputRequests: Schema.Record(Schema.String, JsonObject),
  }),
  Schema.Struct({ ...TaskFields, status: Schema.Literal("completed") }),
  Schema.Struct({ ...TaskFields, status: Schema.Literal("failed"), error: McpTaskError }),
  Schema.Struct({ ...TaskFields, status: Schema.Literal("cancelled") }),
]);

export type McpTaskSnapshot = typeof McpTaskSnapshot.Type;

/** The answers to a task's questions, by the key each was asked under: what `tasks/update` carries. */
export const McpTaskInputResponses = Schema.Record(Schema.String, JsonObject);

export type McpTaskInputResponses = typeof McpTaskInputResponses.Type;

/** The most a `ResumeState` may weigh, as JSON (ADR-0037). */
export const MCP_RESUME_STATE_MAX_BYTES = 1024 * 1024;

/** The most rounds of questions one request may take before it fails (ADR-0037). */
export const MCP_INPUT_ROUNDS = 10;

/**
 * What a resume whose `ResumeState` this build cannot read says: a format `v` past its 30 days, or a state that is not
 * one (`docs/architecture/mcp-server-requests.md` → Questions; `docs/architecture/mcp.md` → Deploys).
 */
export const MCP_RESUME_STATE_EXPIRED =
  "The question was asked by an older version of cloudpid and can't be resumed; call the tool again";

/**
 * A `ResumeState`, format 1 (`docs/architecture/mcp-server-requests.md` → Questions; ADR-0037): what the core needs to
 * send a Modern request again once its deferred questions are answered. JSON, at most `MCP_RESUME_STATE_MAX_BYTES`,
 * opaque to everyone but the core: the Session keeps it in the question's record and hands it back to `resume`. A later
 * format is a new `v`, and this one stays readable for 30 days after it (`docs/architecture/mcp.md` → Deploys).
 */
export const ResumeStateV1 = Schema.Struct({
  v: Schema.Literal(1),
  method: Schema.Literal("tools/call"),
  name: Schema.String,
  arguments: JsonObject,
  /** The server's own state, echoed byte for byte. */
  requestState: Schema.optionalKey(Schema.String),
  /** The round's questions answered at once (Roots, or a question the caller answered then), sent with the rest. */
  answered: McpTaskInputResponses,
  /** The keys of the round's questions the caller deferred: a resume answers every one. */
  deferred: Schema.Array(Schema.String),
  /** Which round of questions this is, from 1. */
  round: Schema.Int,
});

export type ResumeStateV1 = typeof ResumeStateV1.Type;

/**
 * A `ResendState`, format 1 (`docs/architecture/mcp-server-requests.md` → Elicitation requests, URL mode): what the
 * core needs to send a Legacy request again once the owner has opened the pages its `-32042` listed. The call ran
 * nothing, so it goes again as it was, with nothing added. `deferred` are the keys (`elicitationId`s) of the pages, which
 * `resend` takes an `accept` for each of; any other answer fails the call with the server's own error, `message`. JSON,
 * at most `MCP_RESUME_STATE_MAX_BYTES`, opaque to everyone but the core, like a `ResumeState`.
 */
export const ResendStateV1 = Schema.Struct({
  v: Schema.Literal(1),
  method: Schema.Literal("tools/call"),
  name: Schema.String,
  arguments: JsonObject,
  deferred: Schema.Array(Schema.String),
  /** Which `-32042` of the call this is, from 1. */
  round: Schema.Int,
  message: Schema.String,
});

export type ResendStateV1 = typeof ResendStateV1.Type;

/**
 * The era row (`mcp_eras`), format 1: the Protocol era a server was found to speak, its negotiated version and, for a
 * Modern server, its `server/discover` result, so it reconnects with no round trip
 * (`docs/architecture/mcp.md` → Protocol eras).
 */
export const EraRowV1 = Schema.Union([
  Schema.Struct({
    v: Schema.Literal(1),
    era: Schema.Literal("modern"),
    version: Schema.String,
    discover: Schema.Record(Schema.String, Schema.Json),
    probedAt: Schema.Finite,
  }),
  Schema.Struct({
    v: Schema.Literal(1),
    era: Schema.Literal("legacy"),
    version: Schema.String,
    probedAt: Schema.Finite,
  }),
]);

export type EraRow = typeof EraRowV1.Type;

/**
 * The Legacy session row (`mcp_sessions`), format 1: what the core needs to go on with a Legacy server's session
 * without a new `initialize` (The MCP core #394 D5). The resumed SDK client knows none of it, so the core serves the
 * server's capabilities and instructions from here. `declared` only gains: an older row has none.
 */
export const SessionRowV1 = Schema.Struct({
  v: Schema.Literal(1),
  sessionId: Schema.String,
  protocolVersion: Schema.String,
  serverInfo: Schema.Record(Schema.String, Schema.Json),
  capabilities: Schema.Record(Schema.String, Schema.Json),
  instructions: Schema.optionalKey(Schema.String),
  initializedAt: Schema.Finite,
  /**
   * What the client declared at `initialize` (`mcp-server-requests.md` → Questions): a session whose declaration is not
   * today's (or has none, as rows from before questions did not) is initialized again at its next use, since a server
   * keeps what it was told for the life of the session.
   */
  declared: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

export type SessionRow = typeof SessionRowV1.Type;

/**
 * The server wants the owner signed in: a 401. `rejected` when it refused a token the core sent, twice. `challenge` is
 * the parameters of the 401's `WWW-Authenticate` header, when it had any (the host reports them to the Registry).
 */
export class SignInRequired extends Schema.TaggedError<
  SignInRequired,
  { readonly brand: unique symbol }
>()("SignInRequired", {
  message: Schema.String,
  rejected: Schema.Boolean,
  challenge: Schema.optionalKey(McpAuthChallenge),
}) {}

/**
 * The server wants a token with more scope: a 403 with `insufficient_scope`; `challenge` is the parameters of its
 * `WWW-Authenticate` header.
 */
export class StepUpRequired extends Schema.TaggedError<
  StepUpRequired,
  { readonly brand: unique symbol }
>()("StepUpRequired", {
  message: Schema.String,
  scope: Schema.optionalKey(Schema.String),
  challenge: Schema.optionalKey(McpAuthChallenge),
}) {}

/**
 * The server could not be reached or is not answering for now: a network error, a 5xx, a 408 or a 429. `stopped` is set
 * for a stdio server whose Workspace's Container is not running (the bridge's `stopped` refusal): nothing was wrong, and
 * the host asks again only where the process runs. Optional, so an edge that does not know it reads the failure as any.
 */
export class Unreachable extends Schema.TaggedError<
  Unreachable,
  { readonly brand: unique symbol }
>()("Unreachable", {
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int),
  stopped: Schema.optionalKey(Schema.Boolean),
  /**
   * Set when the server is unreachable because its sign-in could not be used for now (the Registry could not refresh it or
   * be asked), so a Session says so ("try again shortly") and `details.sign_in` is `unavailable`
   * (`docs/architecture/mcp-sign-in.md` → Sign-in requests). Optional, so an edge that does not know it reads the failure as any.
   */
  signIn: Schema.optionalKey(Schema.Boolean),
}) {}

/** The message of the `Cut` a stdio call gets when its Workspace's Container stopped under it: the Session reads it to say so. */
export const MCP_CONTAINER_STOPPED_CUT = "Container stopped";

/**
 * The request's stream ended before its answer arrived; a `tools/call` may or may not have run. `lost` says where it
 * was lost when that was not the server's stream: `"engine"`, the host's RPC to the engine broke, which a Session shows
 * as `details.cut: "engine_lost"` (`docs/architecture/mcp-in-a-session.md` → Calls and results). Optional and read as
 * any string, so an edge that does not know it, or a value it does not know, still reads the cut.
 */
export class Cut extends Schema.TaggedError<Cut, { readonly brand: unique symbol }>()("Cut", {
  message: Schema.String,
  mayHaveRun: Schema.Boolean,
  lost: Schema.optionalKey(Schema.String),
}) {}

/** The answer was over its byte limit and was dropped, never truncated. */
export class TooLarge extends Schema.TaggedError<TooLarge, { readonly brand: unique symbol }>()(
  "TooLarge",
  {
    message: Schema.String,
    limit: Schema.Int,
  },
) {}

/** No answer within the request's timeout. */
export class TimedOut extends Schema.TaggedError<TimedOut, { readonly brand: unique symbol }>()(
  "TimedOut",
  {
    message: Schema.String,
  },
) {}

/**
 * The server answered with an error: a JSON-RPC error (`code`), or an HTTP status that is not a sign-in, step-up or
 * unavailability (`status`: a 403 without `insufficient_scope`, a redirect to another origin).
 */
export class ServerError extends Schema.TaggedError<
  ServerError,
  { readonly brand: unique symbol }
>()("ServerError", {
  message: Schema.String,
  code: Schema.optionalKey(Schema.Int),
  status: Schema.optionalKey(Schema.Int),
}) {}

/** The tool, prompt or resource asked for does not exist (`-32002`, `-32602`). */
export class NotFound extends Schema.TaggedError<NotFound, { readonly brand: unique symbol }>()(
  "NotFound",
  {
    message: Schema.String,
    code: Schema.Int,
  },
) {}

/** The server and cloudpid share no protocol version, or the server does not offer what was asked. */
export class Unsupported extends Schema.TaggedError<
  Unsupported,
  { readonly brand: unique symbol }
>()("Unsupported", {
  message: Schema.String,
}) {}

/** The JSON-RPC code of a Legacy server's "URL elicitation required" error (the SDK's `ProtocolErrorCode.UrlElicitationRequired`). */
export const MCP_URL_REQUIRED_CODE = -32042;

/** The server answered with something that is not MCP: not JSON-RPC, the wrong content type, a malformed result. */
export class ProtocolViolation extends Schema.TaggedError<
  ProtocolViolation,
  { readonly brand: unique symbol }
>()("ProtocolViolation", {
  message: Schema.String,
}) {}

/** Every way a core request fails (`docs/architecture/mcp.md` → Packages and objects). */
export const McpError = Schema.Union([
  SignInRequired,
  StepUpRequired,
  Unreachable,
  Cut,
  TooLarge,
  TimedOut,
  ServerError,
  NotFound,
  Unsupported,
  ProtocolViolation,
]);

export type McpError = typeof McpError.Type;

/**
 * A failure whose tag this build does not know, or whose fields do not fit its tag: from a newer engine, or a broken
 * one. It has a tag of its own, so nothing reads it as the tag it came with (`tag`), and it may have run unless it
 * says not (`mayHaveRun`).
 */
export class OtherMcpError extends Schema.TaggedError<
  OtherMcpError,
  { readonly brand: unique symbol }
>()("OtherMcpError", {
  message: Schema.String,
  tag: Schema.String,
  mayHaveRun: Schema.optionalKey(Schema.Boolean),
}) {}

/** Any failure as it crosses the edge: its own tag, a message and, maybe, whether it may have run. */
const AnyMcpErrorFields = Schema.Struct({
  _tag: Schema.String,
  message: Schema.String,
  mayHaveRun: Schema.optionalKey(Schema.Boolean),
});

/** `OtherMcpError` on the wire: under the tag it came with, so it goes on as it came. */
const OtherMcpErrorFromWire = AnyMcpErrorFields.pipe(
  Schema.decodeTo(
    Schema.toType(OtherMcpError),
    SchemaTransformation.transform({
      decode: ({ _tag, ...fields }) => OtherMcpError.make({ ...fields, tag: _tag }),
      // An error's `message` is not its own enumerable key, so each field is named.
      encode: (error) =>
        error.mayHaveRun === undefined
          ? { _tag: error.tag, message: error.message }
          : { _tag: error.tag, message: error.message, mayHaveRun: error.mayHaveRun },
    }),
  ),
);

/**
 * The engine edge's failure Schema (`docs/architecture/mcp.md` → Deploys): every known tag reads as its `McpError`,
 * anything else as an `OtherMcpError`, so a newer engine's new tag never fails a decode on an older host.
 */
export const McpErrorWire = Schema.Union([...McpError.members, OtherMcpErrorFromWire]);

export type McpErrorWire = typeof McpErrorWire.Type;

/**
 * Whether a failed request may have run (`docs/architecture/mcp-connections.md` → Failures and cuts), so whether it
 * may be sent again. Only a `tools/call` runs anything; for any other method this is what a `Cut` or an
 * `OtherMcpError` says, else false. For a `tools/call`:
 *
 * - **May have run:** a `Cut` that says so, an `OtherMcpError` unless it says not, and every failure that comes after
 *   the server took the call: `TimedOut` (the timeout starts at the send), `TooLarge` and `ProtocolViolation` (it
 *   answered), and `Unreachable` with a 5xx (it failed while handling the call).
 * - **Did not run:** what the server refused before running it: `Unreachable` with a 408 or 429, or with no status (a
 *   network error once the call is sent is a `Cut`), `SignInRequired`, `StepUpRequired`, `ServerError` (a JSON-RPC
 *   error or an HTTP status; a tool's own failure is a result with `isError`), `NotFound` and `Unsupported`.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain predicate over a value, not a combinator.
export const mayHaveRun = (error: McpErrorWire, method: string): boolean => {
  const call = method === "tools/call";

  return Match.value(error).pipe(
    Match.tag("Cut", (cut) => cut.mayHaveRun),
    Match.tag("OtherMcpError", (other) => other.mayHaveRun ?? call),
    Match.tag("TimedOut", "TooLarge", "ProtocolViolation", () => call),
    Match.tag("Unreachable", ({ status }) => call && status !== undefined && status >= 500),
    Match.tag(
      "SignInRequired",
      "StepUpRequired",
      "ServerError",
      "NotFound",
      "Unsupported",
      () => false,
    ),
    Match.exhaustive,
  );
};

// ---------------------------------------------------------------------------------------------------------------------
// `McpEngine`'s RPC (`McpEngineMethods`): what `McpHost` sends the engine and what comes back
// (`docs/architecture/mcp-connections.md` → The engine; The Environment's MCP host object #382 D1).
//
// The engine is a `WorkerEntrypoint`, so a call's values cross by structured clone: the engine sends each result
// encoded with these Schemas and the host decodes it with them, a failure through `McpErrorWire` (an unknown tag reads
// as `OtherMcpError`). The edge only gains (`docs/architecture/mcp.md` → Deploys): a new operation is a new `op`, which
// an older engine fails as `Unsupported`, and a new success shape is returned only when the request asked for it.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What every target carries: the connection key `conn`, the server's name, the Secret values the host substituted for
 * `${NAME}` (`redact`) and the entry's `timeout`.
 */
const TargetFields = {
  conn: Schema.String,
  name: Schema.String,
  /**
   * The Secret values the host substituted for `${NAME}` into `headers` or `env` (`${…}` is refused in the URL): what
   * the engine scrubs, as far as four characters, from the logs, errors, results and inventory it hands back
   * (`docs/architecture/mcp-connections.md` → Telemetry). Empty for an entry that references no Secret, and absent from
   * a host older than this field.
   */
  redact: Schema.Array(Schema.String).pipe(Schema.optionalKey),
  /** The entry's `timeout` for a `tools/call` (default 60 s). */
  timeoutMs: Schema.optionalKey(Schema.Int),
  /**
   * Whether a Legacy connection to this server declares `sampling` at `initialize` (the definition's `sampling` key lets
   * it: `docs/architecture/mcp-server-requests.md` → Sampling requests). Absent from a host older than this field, and
   * for a server that is declared none: a stdio server's questions are not answered yet, and a Modern connection
   * declares no sampling.
   */
  sampling: Schema.optionalKey(Schema.Boolean),
};

/** A remote server: its URL and headers, `${NAME}` values resolved. */
export const McpEngineHttpTarget = Schema.Struct({
  kind: Schema.Literal("http"),
  ...TargetFields,
  url: Schema.String,
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /**
   * The MCP extensions this connection declares besides MCP Apps, in both eras (`docs/architecture/mcp.md` →
   * Extensions): today only OAuth Client Credentials, and only on a connection that signs in with that grant. The engine
   * declares the ones it knows and no other. Absent from a host older than this field, and from any other connection.
   */
  extensions: Schema.Record(Schema.String, JsonObject).pipe(Schema.optionalKey),
});

export type McpEngineHttpTarget = typeof McpEngineHttpTarget.Type;

export type McpEngineHttpTargetEncoded = typeof McpEngineHttpTarget.Encoded;

/**
 * A Root as a stdio server is offered it (`docs/architecture/mcp-in-a-session.md` → Roots): `file:///workspace/<repo-dir>`,
 * named `owner/name`.
 */
export const McpRoot = Schema.Struct({
  uri: Schema.String,
  name: Schema.optionalKey(Schema.String),
});

export type McpRoot = typeof McpRoot.Type;

/**
 * A stdio server, run by the bridge of the Container of Workspace object `workspace` (`ws:<id>`): what the bridge spawns,
 * with the entry's `env` resolved, and whether the call may start a stopped Container (`start`: a live caller's request
 * only, never background work). `roots` are what the server is offered, the Repos of that Workspace; a target without
 * them declares no `roots` (`docs/architecture/mcp-connections.md` → The stdio bridge).
 */
export const McpEngineStdioTarget = Schema.Struct({
  kind: Schema.Literal("stdio"),
  ...TargetFields,
  workspace: Schema.String,
  start: Schema.Boolean,
  command: Schema.String,
  args: Schema.Array(Schema.String).pipe(Schema.optionalKey),
  env: Schema.Record(Schema.String, Schema.String).pipe(Schema.optionalKey),
  cwd: Schema.optionalKey(Schema.String),
  roots: Schema.Array(McpRoot).pipe(Schema.optionalKey),
});

export type McpEngineStdioTarget = typeof McpEngineStdioTarget.Type;

/**
 * The server a call goes to. A `kind` an engine does not know fails as `Unsupported`, sending nothing, so the edge only
 * gains (`docs/architecture/mcp.md` → Deploys).
 */
export const McpEngineTarget = Schema.Union([McpEngineHttpTarget, McpEngineStdioTarget]);

export type McpEngineTarget = typeof McpEngineTarget.Type;

/**
 * The rows the host keeps for a connection (`mcp_eras`, `mcp_sessions`), as JSON of any format: the engine reads a row
 * it does not know as absent (`docs/architecture/mcp-connections.md` → Storage).
 */
export const McpEnginePrior = Schema.Struct({
  era: Schema.optionalKey(Schema.Json),
  session: Schema.optionalKey(Schema.Json),
});

export type McpEnginePrior = typeof McpEnginePrior.Type;

/** The rows a call changed, for the host to keep: a row to keep, `null` to drop it, absent to leave it as it is. */
export const McpEngineState = Schema.Struct({
  era: Schema.Json.pipe(Schema.NullOr, Schema.optionalKey),
  session: Schema.Json.pipe(Schema.NullOr, Schema.optionalKey),
});

export type McpEngineState = typeof McpEngineState.Type;

/** The logs a call received, oldest first, at most `MCP_LOG_RING`. Gain-only on every result: absent when none came. */
const EngineLogs = { logs: McpLogEntry.pipe(Schema.Array, Schema.optionalKey) };

/**
 * The spawn id of the stdio server's process the call last heard from (the bridge's `x-cloudpid-spawn`): it changes when
 * the process is spawned again, so the host learns of a restart (`docs/architecture/mcp-connections.md` → The stdio
 * bridge). Gain-only: absent for an HTTP server and from an engine that does not know it.
 */
const EngineSpawn = { spawn: Schema.optionalKey(Schema.String) };

/**
 * A tool's definition, as the server listed it and the host keeps it in its catalog: a `tools/call` carries it, since
 * its `inputSchema` gives the `Mcp-Param` headers and its `outputSchema` is what the engine checks `structuredContent`
 * against (The MCP core #394 D14, D17).
 */
export const McpToolDefinition = Schema.StructWithRest(
  Schema.Struct({
    name: Schema.String,
    inputSchema: JsonObject,
    outputSchema: Schema.optionalKey(JsonObject),
  }),
  [JsonObject],
);

export type McpToolDefinition = typeof McpToolDefinition.Type;

/** A tool whose definition the engine could not use, and why: an `outputSchema` TypeBox rejects. */
export const McpToolProblem = Schema.Struct({
  tool: Schema.String,
  problem: Schema.String,
});

export type McpToolProblem = typeof McpToolProblem.Type;

/**
 * The server's tools, listed again by a `request` because the server refused a `tools/call`'s headers (`-32020`; The
 * MCP core #394 D14), with their schema problems compiled as discovery compiles them, for the host to update its
 * catalog. Present on the call's result whether its second send completed or failed.
 */
const RefreshedTools = {
  tools: McpToolDefinition.pipe(Schema.Array, Schema.optionalKey),
  problems: McpToolProblem.pipe(Schema.Array, Schema.optionalKey),
};

/**
 * What was found wrong with a prompt: one left out for a name or a key that holds a value the call keeps secret, said by
 * its place in the list (`prompt #3`) and never the value. A prompt's problems are kept apart from a tool's, so a
 * prompts-only change never changes the tools' version (`docs/architecture/mcp-connections.md` → Versions).
 */
export const McpPromptProblem = Schema.Struct({
  prompt: Schema.String,
  problem: Schema.String,
});

export type McpPromptProblem = typeof McpPromptProblem.Type;

/** The problems of the prompts a call listed. Gain-only: absent when there are none. */
const PromptProblems = { promptProblems: McpPromptProblem.pipe(Schema.Array, Schema.optionalKey) };

/** What a call failed with, and the rows it changed before it did. */
export const McpEngineFailed = Schema.Struct({
  kind: Schema.Literal("failed"),
  error: McpErrorWire,
  ...RefreshedTools,
  ...EngineLogs,
  ...EngineSpawn,
  state: McpEngineState,
});

export type McpEngineFailed = typeof McpEngineFailed.Type;

/** A server's protocol era as the engine reports it (`docs/architecture/mcp.md` → Protocol eras). */
export const MCP_ENGINE_ERAS = ["modern", "legacy"] as const;

export const McpEngineEra = Schema.Literals(MCP_ENGINE_ERAS);

export type McpEngineEra = typeof McpEngineEra.Type;

/** A mebibyte, the unit of the core's byte limits. */
export const MiB = 1024 * 1024;

/** The most a `tools/call` result or a large read may weigh (#394 D16); a larger answer is `TooLarge`. */
export const MCP_LARGE_RESULT_BYTES = 16 * MiB;

/**
 * How long the engine lets a result's stream go unread before it errors the stream and lets its bytes go (each pull
 * renews it): the Session's waits for a stream stay under it (`docs/architecture/mcp-connections.md` → Memory).
 */
export const MCP_STREAM_HOLD_MS = 60_000;

/** The core's bound on a probe or an `initialize` (#394 D15). */
export const MCP_CONNECT_TIMEOUT_MS = 15_000;

/** The core's bound on walking every page of a list (#394 D15). */
export const MCP_LIST_WALK_TIMEOUT_MS = 120_000;

/** What a `tasks/*` request may take, in the core and at the host: 30 s each (`docs/architecture/mcp-connections.md` → Requests and Legacy sessions). */
export const MCP_TASK_TIMEOUT_MS = 30_000;

/** What a `completion/complete` waits at most (or the entry's lower `timeout`): 5 s, as the form shows it ("Suggestions unavailable" after). */
export const MCP_COMPLETION_TIMEOUT_MS = 5_000;

/** What a `prompts/get` waits at most (or the entry's lower `timeout`): `docs/architecture/mcp-connections.md` → Requests and Legacy sessions. */
export const MCP_PROMPT_GET_TIMEOUT_MS = 30_000;

/**
 * A discovery (`docs/architecture/mcp-connections.md` → Discovery and the MCP inventory): what the server is, every
 * page of its tools and prompts, and the tools whose output schema could not be compiled. The inventory's bounds,
 * versions and storage are the host's.
 */
export const McpEngineDiscovered = Schema.Struct({
  kind: Schema.Literal("discovered"),
  era: McpEngineEra,
  protocolVersion: Schema.String,
  serverInfo: Schema.optionalKey(JsonObject),
  capabilities: JsonObject,
  instructions: Schema.optionalKey(Schema.String),
  tools: Schema.Array(McpToolDefinition),
  prompts: Schema.Array(JsonObject),
  problems: Schema.Array(McpToolProblem),
  ...PromptProblems,
  /** The tools list's cache hint (SEP-2549), for the host's TTL. */
  ttlMs: Schema.optionalKey(Schema.Finite),
  fetchedAt: Schema.Finite,
  ...EngineLogs,
  ...EngineSpawn,
  state: McpEngineState,
});

export type McpEngineDiscovered = typeof McpEngineDiscovered.Type;

export const McpEngineDiscoverResult = Schema.Union([McpEngineDiscovered, McpEngineFailed]);

export type McpEngineDiscoverResult = typeof McpEngineDiscoverResult.Type;

/** The lists a `request` can walk, every page. */
export const McpEngineListOp = Schema.Literals([
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
]);

/**
 * What a `completion/complete` completes an argument of: a prompt by `name`, or a resource template by its
 * `uriTemplate` (`docs/architecture/mcp-in-a-session.md` → Arguments and completions).
 */
export const McpCompletionRef = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ref/prompt"), name: Schema.String }),
  Schema.Struct({ type: Schema.Literal("ref/resource"), uri: Schema.String }),
]);

export type McpCompletionRef = typeof McpCompletionRef.Type;

/** The argument being completed and what the owner has typed of it. */
export const McpCompletionArgument = Schema.Struct({ name: Schema.String, value: Schema.String });

export type McpCompletionArgument = typeof McpCompletionArgument.Type;

/** The other arguments' values, for a server whose suggestions depend on them. */
export const McpCompletionContext = Schema.Struct({
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

export type McpCompletionContext = typeof McpCompletionContext.Type;

/** What `request` is asked to do. A new operation is a new `op` (`docs/architecture/mcp.md` → Deploys). */
export const McpEngineRequest = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("tools/call"),
    tool: McpToolDefinition,
    arguments: Schema.optionalKey(JsonObject),
    ctx: McpCallContext,
  }),
  Schema.Struct({
    op: McpEngineListOp,
    ctx: McpCallContext,
  }),
  /**
   * `tasks/get` of the MCP task `taskId` (Modern only). `tool` is the definition of the tool that started it, when the
   * host still lists it: the engine checks a completed result's `structuredContent` against its `outputSchema`.
   */
  Schema.Struct({
    op: Schema.Literal("tasks/get"),
    taskId: Schema.String,
    tool: Schema.optionalKey(McpToolDefinition),
    ctx: McpCallContext,
  }),
  /** `tasks/update`: the answers to the questions an MCP task is waiting on, by key. */
  Schema.Struct({
    op: Schema.Literal("tasks/update"),
    taskId: Schema.String,
    inputResponses: McpTaskInputResponses,
    ctx: McpCallContext,
  }),
  Schema.Struct({
    op: Schema.Literal("tasks/cancel"),
    taskId: Schema.String,
    ctx: McpCallContext,
  }),
  /** One `resources/read`: the server's `ReadResourceResult` is the value, and `sha256` the hash of its contents. */
  Schema.Struct({
    op: Schema.Literal("resources/read"),
    uri: Schema.String,
    /**
     * An App's read of its `ui://` resource, which `MCP_APP_READ_BYTES` bounds; every other read has the 16 MiB every read
     * has, a `ui://` one the agent makes included. An engine from before the key bounds a `ui://` read by its URI.
     */
    app: Schema.optionalKey(Schema.Boolean),
    ctx: McpCallContext,
  }),
  /**
   * One page of `resources/list`, from `cursor` (the first without one): the value is the server's `ListResourcesResult`
   * as it is, `{ resources, nextCursor? }`. The lists above walk every page, for a discovery's; this is for a caller that
   * shows a page and walks on by its cursor.
   */
  Schema.Struct({
    op: Schema.Literal("resources/list_page"),
    cursor: Schema.optionalKey(Schema.String),
    ctx: McpCallContext,
  }),
  /** One page of `resources/templates/list`: `{ resourceTemplates, nextCursor? }`. */
  Schema.Struct({
    op: Schema.Literal("resources/templates/list_page"),
    cursor: Schema.optionalKey(Schema.String),
    ctx: McpCallContext,
  }),
  /** One `prompts/get`: the server's `GetPromptResult` is the value. */
  Schema.Struct({
    op: Schema.Literal("prompts/get"),
    name: Schema.String,
    arguments: Schema.Record(Schema.String, Schema.String),
    ctx: McpCallContext,
  }),
  /**
   * One `completion/complete`: the suggestions for `argument` of the prompt or resource template `ref` names, given the
   * other arguments in `context`. The value is the server's `CompleteResult`. A read: the core never retries it.
   */
  Schema.Struct({
    op: Schema.Literal("completion/complete"),
    ref: McpCompletionRef,
    argument: McpCompletionArgument,
    context: Schema.optionalKey(McpCompletionContext),
    ctx: McpCallContext,
  }),
  /**
   * The `tools/call` that answered `input_required`, sent again from its `ResumeState` (`resume`, opaque here) with the
   * answers to the questions it deferred, by key; `tool` is its definition, as for `tools/call`. Answered as a
   * `tools/call` is: a result, a task, or another round of questions.
   */
  Schema.Struct({
    op: Schema.Literal("resume"),
    tool: McpToolDefinition,
    resume: Schema.Json,
    answers: McpTaskInputResponses,
    ctx: McpCallContext,
  }),
  /**
   * The `tools/call` that answered `pages_required` (a Legacy `-32042`), sent again from its `ResendState` (`resend`,
   * opaque here) with an answer for each page it listed. Answered as a `tools/call` is, `pages_required` again included.
   */
  Schema.Struct({
    op: Schema.Literal("resend"),
    tool: McpToolDefinition,
    resend: Schema.Json,
    answers: McpTaskInputResponses,
    ctx: McpCallContext,
  }),
]);

export type McpEngineRequest = typeof McpEngineRequest.Type;

/** A native byte stream: RPC passes it through without cloning or counting it, and the host returns it unread. */
const ByteStream = Schema.declare(
  (input): input is ReadableStream<Uint8Array> => input instanceof ReadableStream,
);

/**
 * A result's value: inline up to 1 MiB of JSON, else the JSON's bytes as a native `ReadableStream` the engine produces
 * on pull (`docs/architecture/mcp-connections.md` → The engine, large results; #409 answer 3).
 */
export const McpEngineValue = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("inline"), value: Schema.Json }),
  Schema.Struct({ kind: Schema.Literal("stream"), body: ByteStream, bytes: Schema.Int }),
]);

export type McpEngineValue = typeof McpEngineValue.Type;

/**
 * How a `tools/call` result's `structuredContent` fits the tool's `outputSchema`, checked in the engine (The MCP core
 * #394 D17, refined by #382 D9.3): absent when the tool declares none, `valid: false` with the first errors otherwise.
 */
export const McpStructuredOutput = Schema.Union([
  Schema.Struct({ valid: Schema.Literal(true) }),
  Schema.Struct({ valid: Schema.Literal(false), errors: Schema.Array(Schema.String) }),
]);

export type McpStructuredOutput = typeof McpStructuredOutput.Type;

/** A request that completed: its value, its cache metadata (The MCP core #394 D13) and the rows it changed. */
export const McpEngineCompleted = Schema.Struct({
  kind: Schema.Literal("complete"),
  result: McpEngineValue,
  /** False when the result came from answered questions, so no cache may keep it. */
  cacheable: Schema.Boolean,
  ttlMs: Schema.optionalKey(Schema.Finite),
  cacheScope: Schema.optionalKey(Schema.Literals(["public", "private"])),
  fetchedAt: Schema.Finite,
  structuredOutput: Schema.optionalKey(McpStructuredOutput),
  /** For a `resources/read`, the SHA-256 (lowercase hex) of its contents (`read-hash.ts`); gain-only. */
  sha256: Schema.optionalKey(Schema.String),
  /**
   * `tools` and `problems` after a `-32020`, sent once more with the fresh definition; for a `tools/list` request,
   * `problems` alone, the listed tools' schema problems.
   */
  ...RefreshedTools,
  /** For a `prompts/list` request, the prompts left out. */
  ...PromptProblems,
  ...EngineLogs,
  ...EngineSpawn,
  state: McpEngineState,
});

export type McpEngineCompleted = typeof McpEngineCompleted.Type;

/**
 * A `tools/call` the server answered with an MCP task (`resultType: "task"`): returned only to a call that asked for
 * one (`ctx.allowTask`), and only when the server is Modern and advertises the tasks extension, so a caller without
 * `allowTask` never gets one (`docs/architecture/mcp-server-requests.md` → MCP tasks). `tools` and `problems` are as
 * `McpEngineCompleted`'s after a `-32020`.
 */
export const McpEngineTaskStarted = Schema.Struct({
  kind: Schema.Literal("task"),
  task: McpTaskCreated,
  ...RefreshedTools,
  ...EngineLogs,
  ...EngineSpawn,
  state: McpEngineState,
});

export type McpEngineTaskStarted = typeof McpEngineTaskStarted.Type;

/**
 * A `tasks/get` answer: the task as the server last reported it and, for a `completed` one, the `CallToolResult` it
 * ended with, as any result's value (inline up to 1 MiB, else a stream) with how it fits the tool's `outputSchema`
 * (absent when the request named no tool, or the tool declares none).
 */
export const McpEngineTaskState = Schema.Struct({
  kind: Schema.Literal("task_state"),
  task: McpTaskSnapshot,
  result: Schema.optionalKey(McpEngineValue),
  structuredOutput: Schema.optionalKey(McpStructuredOutput),
  fetchedAt: Schema.Finite,
  ...EngineLogs,
  ...EngineSpawn,
  state: McpEngineState,
});

export type McpEngineTaskState = typeof McpEngineTaskState.Type;

/**
 * A Modern `tools/call` (or its `resume`) whose server asked questions the caller deferred, returned only to a call
 * whose `ctx.answers.defer` is set: the deferred `requests`, scrubbed of the call's tokens, and the `ResumeState` a
 * `resume` goes on from, as the core made it (`docs/architecture/mcp-server-requests.md` → Questions).
 */
export const McpEngineInputRequired = Schema.Struct({
  kind: Schema.Literal("input_required"),
  requests: Schema.Array(McpInputRequest),
  resume: Schema.Json,
  ...RefreshedTools,
  ...EngineLogs,
  ...EngineSpawn,
  state: McpEngineState,
});

export type McpEngineInputRequired = typeof McpEngineInputRequired.Type;

/**
 * A Legacy `tools/call` (or its `resend`) or `resources/read` whose server answered `-32042`, returned only to a call
 * whose `ctx.answers.pages` is set: the pages as `requests`, scrubbed of the call's tokens, and for a call the
 * `ResendState` a `resend` goes on from, as the core made it.
 */
export const McpEnginePagesRequired = Schema.Struct({
  kind: Schema.Literal("pages_required"),
  requests: Schema.Array(McpInputRequest),
  /** The server's own error, `-32042`'s message. */
  message: Schema.String,
  /** The `ResendState`; absent for a `resources/read`, which the caller sends again as it was. */
  resend: Schema.optionalKey(Schema.Json),
  ...RefreshedTools,
  ...EngineLogs,
  ...EngineSpawn,
  state: McpEngineState,
});

export type McpEnginePagesRequired = typeof McpEnginePagesRequired.Type;

/** A `tasks/update` or `tasks/cancel` the server took. */
export const McpEngineTaskAck = Schema.Struct({
  kind: Schema.Literal("task_ack"),
  ...EngineLogs,
  ...EngineSpawn,
  state: McpEngineState,
});

export type McpEngineTaskAck = typeof McpEngineTaskAck.Type;

/**
 * A request's result. Neither result union has a fallback member, by design: a new success shape is returned only
 * when the request asked for it (a request flag such as `ctx.allowTask`, or an `op` of its own such as `tasks/get`),
 * so an older host never receives one it cannot read (`docs/architecture/mcp.md` → Deploys); failures fall back
 * through `McpErrorWire`.
 */
export const McpEngineRequestResult = Schema.Union([
  McpEngineCompleted,
  McpEngineFailed,
  McpEngineTaskStarted,
  McpEngineTaskState,
  McpEngineTaskAck,
  McpEngineInputRequired,
  McpEnginePagesRequired,
]);

export type McpEngineRequestResult = typeof McpEngineRequestResult.Type;

/** How long a listen waits for the server's acknowledgement (`docs/architecture/mcp-connections.md` → Requests and Legacy sessions). */
export const MCP_LISTEN_ACK_MS = 10_000;

/**
 * What a listen carries (`docs/architecture/mcp-in-a-session.md` → Resource watches; The MCP core #394 D12): the resource
 * URIs to be told of (`resourceSubscriptions`, the wire's own name) and the list changes. A `2026-07-28` server
 * acknowledges the part it honors; a `2025-11-25` server's shim subscribes each URI and reads list changes from its GET
 * stream, so what it honors is the URIs it accepted.
 */
export const McpListenFilter = Schema.Struct({
  resourceSubscriptions: Schema.Array(Schema.String).pipe(Schema.optionalKey),
  toolsListChanged: Schema.optionalKey(Schema.Boolean),
  promptsListChanged: Schema.optionalKey(Schema.Boolean),
  resourcesListChanged: Schema.optionalKey(Schema.Boolean),
});

export type McpListenFilter = typeof McpListenFilter.Type;

/** The lists a listen tells a change of. */
export const MCP_LISTEN_LISTS = ["tools", "prompts", "resources"] as const;

/**
 * One thing a listen heard, one line of the engine's event stream: a resource was updated, a list changed, or (the last
 * line) the stream ended. `closed` says how: `graceful` when the server ended it deliberately, `remote` when it was cut
 * or broke; the end the caller asked for (`local`) is never a line. Any `kind` this build does not know reads as the last
 * member, which is ignored.
 */
export const McpListenEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("resource_updated"), uri: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("list_changed"), list: Schema.Literals(MCP_LISTEN_LISTS) }),
  Schema.Struct({ kind: Schema.Literal("closed"), cause: Schema.Literals(["graceful", "remote"]) }),
  Schema.Struct({ kind: Schema.String }),
]);

export type McpListenEvent = typeof McpListenEvent.Type;

/**
 * `listen`'s answer once the server acknowledged: what it honors, and the events as newline-delimited JSON
 * (`McpListenEvent`), a native `ReadableStream` the host reads. The stream ends with a `closed` line when the server ends
 * it; the host cancelling it closes the listen. The engine holds the connection for as long as the stream lives.
 */
export const McpEngineListening = Schema.Struct({
  kind: Schema.Literal("listening"),
  honored: McpListenFilter,
  events: ByteStream,
  era: McpEngineEra,
  ...EngineSpawn,
  state: McpEngineState,
});

export type McpEngineListening = typeof McpEngineListening.Type;

/** `listen`'s result: listening, or what it failed with (a server that cannot send updates is `Unsupported`). */
export const McpEngineListenResult = Schema.Union([McpEngineListening, McpEngineFailed]);

export type McpEngineListenResult = typeof McpEngineListenResult.Type;

/**
 * A server's `notifications/progress` on a call, as it reaches the caller (`docs/architecture/mcp-in-a-session.md` →
 * Calls and results): how far the call is, of `total` if the server knows it, and a message.
 */
export const McpProgress = Schema.Struct({
  progress: Schema.Finite,
  total: Schema.optionalKey(Schema.Finite),
  message: Schema.optionalKey(Schema.String),
});

export type McpProgress = typeof McpProgress.Type;

/** The most progress notices a call passes on in a second (`docs/architecture/mcp-connections.md` → RPC). */
export const MCP_PROGRESS_PER_SECOND = 10;

/**
 * The callbacks a call carries, passed as RPC stubs that live as long as the caller's invocation (`docs/architecture/
 * mcp.md` → RPC edges). There is no `onLog`: a server's logs come back in
 * the result (`logs`), so a discovery, which passes no hooks, brings them too (`docs/architecture/mcp-connections.md` →
 * Telemetry).
 */
export interface McpEngineHooks {
  /**
   * Pending until the caller aborts the call (it resolves) or dies (it rejects); either way the engine aborts the server
   * request, since RPC carries no `AbortSignal`. Absent for a call that no caller's invocation holds (the host's
   * background discovery, which a function stub would not outlive, #409 answer 2): the engine then runs it to its own
   * bounds.
   */
  readonly untilAborted?: () => Promise<void>;
  /** An access token for the server, asked again with `stale` after the server refused one; none without OAuth. */
  readonly auth?: (stale: boolean) => Promise<string | undefined>;
  /** Called when a request's response headers arrive, so the host can keep its outbound queue across engine calls. */
  readonly opened?: () => void | Promise<void>;
  /**
   * A `tools/call`'s progress, at most `MCP_PROGRESS_PER_SECOND` a second; each one also resets the call's timeout. A
   * hook that fails or is slow fails nothing: the notice is dropped.
   */
  readonly onProgress?: (progress: McpProgress) => void | Promise<void>;
  /**
   * A question a Legacy server asks while a `tools/call` with `ctx.answers` waits: resolves with the answer the server
   * gets, or rejects when the caller cannot answer (which reads as a `cancel`). The timeout of the call is paused while
   * it is pending. Absent for a call whose caller answers nothing: every question is then cancelled.
   */
  readonly onInput?: (
    request: typeof McpInputRequest.Encoded,
  ) => Promise<typeof McpInputAnswer.Encoded>;
  /** The server stopped waiting for question `key` (its own cancellation): the caller withdraws its card. */
  readonly onInputEnded?: (key: string) => void | Promise<void>;
  /**
   * The server used a feature the MCP spec deprecated (`"sampling"`: it sent a Sampling request), however the request
   * ended: tied to a call or not, answered or refused (`docs/architecture/mcp-server-requests.md` → Sampling requests,
   * Deprecation). A hook that fails or is slow fails nothing. An engine from before never calls it.
   */
  readonly onDeprecated?: (feature: string) => void | Promise<void>;
  /**
   * The owner finished at the page URL question `key` asked them to open: the server said so on the call's own stream
   * (`notifications/elicitation/complete`), and the caller closes its card. The host keeps no `elicitationId`.
   */
  readonly onInputComplete?: (key: string) => void | Promise<void>;
}

/** `McpEngine`'s arguments as they cross RPC, encoded; the engine decodes each. */
export type McpEngineTargetEncoded = typeof McpEngineTarget.Encoded;

export type McpEnginePriorEncoded = typeof McpEnginePrior.Encoded;

export type McpEngineRequestEncoded = typeof McpEngineRequest.Encoded;

/** `McpEngine`'s methods as the host calls them, over the `MCP_ENGINE` binding; each resolves to an encoded result. */
export interface McpEngineMethods {
  readonly discover: (
    target: McpEngineTargetEncoded,
    prior: McpEnginePriorEncoded,
    hooks: McpEngineHooks,
  ) => Promise<typeof McpEngineDiscoverResult.Encoded>;
  readonly request: (
    target: McpEngineTargetEncoded,
    prior: McpEnginePriorEncoded,
    request: McpEngineRequestEncoded,
    hooks: McpEngineHooks,
  ) => Promise<typeof McpEngineRequestResult.Encoded>;
  /**
   * Opens a listen on the server (`docs/architecture/mcp-connections.md` → Requests and Legacy sessions → Listens): a
   * `subscriptions/listen` on a Modern server, `resources/subscribe` for each URI and the GET stream on a Legacy one. It
   * answers once the server acknowledged, or fails in 10 s. The connection lives as long as the event stream does, and
   * ends when `stop`, a stream the caller keeps, ends or breaks: closing it is how the caller ends the listen at once
   * (cancelling the events is seen by the engine only at its next write, so a `ping` line comes every 30 s). An engine from
   * before `stop` ignores it, and ends the listen at that next write.
   */
  readonly listen: (
    target: McpEngineTargetEncoded,
    prior: McpEnginePriorEncoded,
    filter: typeof McpListenFilter.Encoded,
    hooks: McpEngineHooks,
    stop?: ReadableStream<Uint8Array>,
  ) => Promise<typeof McpEngineListenResult.Encoded>;
  /**
   * A public read for the Registry's MCP sign-in on one of cloudpid's own hosts, from this Worker, which has
   * `global_fetch_strictly_public` (`./public-fetch.ts`; `docs/architecture/mcp-sign-in.md` → Code). Not part of a
   * connection. Optional: an engine from before it has no such method, and its stub's call fails as one it does not
   * implement, which the caller reads as "read it yourself".
   */
  readonly fetchPublic?: (
    request: typeof McpPublicFetchRequest.Encoded,
  ) => Promise<typeof McpPublicFetchResult.Encoded>;
}

// ---------------------------------------------------------------------------------------------------------------------
// `McpHost.request`: a Session's call through the host (`docs/architecture/mcp-connections.md` → RPC). Here because it
// carries the engine's values and failures; the rest of the host's RPC is in `./host.ts`. The edge only gains: an `op`
// this host does not know is `HostUnsupported`, and a failure under a tag the caller does not know reads as
// `HostFailed` (`readMcpHostRequestResult`).
// ---------------------------------------------------------------------------------------------------------------------

/** Who a request is for: the call's id, its origin, the Session and conversation it comes from, and its Workspace. */
export const McpHostRequestContext = Schema.Struct({
  callId: Schema.optionalKey(Schema.String),
  origin: McpCallOrigin,
  session: Schema.optionalKey(Schema.String),
  conversation: Schema.optionalKey(Schema.String),
  /** The calling Workspace (`ws:<id>`), where a stdio server runs. */
  workspace: Schema.optionalKey(Schema.String),
  /**
   * The caller can wait for an MCP task: a `tools/call` made with it may be answered with `Task`, and one made without
   * it never is. The host passes it on only for an agent's or an App View's call to an HTTP server
   * (`docs/architecture/mcp-server-requests.md` → MCP tasks, Declaration).
   */
  allowTask: Schema.optionalKey(Schema.Boolean),
  /**
   * For a `tasks/get`: the status the caller last saw. The host spans the request only when the answer is another status
   * or an error, and counts the rest (`docs/architecture/mcp-connections.md` → Observability); without it every one is
   * spanned. Additive and optional: an older host ignores it.
   */
  lastStatus: Schema.optionalKey(Schema.String),
  /** What the caller can answer; with the request's `onInput` hook, it says the call may be asked questions. */
  answers: Schema.optionalKey(McpAnswers),
  /**
   * For an `app` request: the `viewHash` its App record pinned, the origin hash of the server whose View makes it. A
   * server of that name whose own is another (shadowed since) is `ServerChanged`, nothing sent
   * (`docs/architecture/mcp-apps.md` → An App View's calls). Optional, so a host that does not know it checks nothing more.
   */
  viewHash: Schema.optionalKey(Schema.String),
  /**
   * `false`: the request never starts a Container. A stdio server whose Workspace's Container is not running is refused as
   * `Unreachable` with `stopped`, and a running one is read as usual. Set by the owner's own requests that must not wake
   * one: the pages of the `@` menu's list (`docs/architecture/mcp-in-a-session.md` → Attached resources) and a preview of a
   * resource link (→ Resource links and embedded resources). The read of an Attached resource at send leaves it out: the
   * owner sending a message may start the Container. A host that lacks the `no_start` feature drops the key and would
   * start the Container, so a Session sends it only to one that lists it.
   */
  start: Schema.optionalKey(Schema.Boolean),
});

export type McpHostRequestContext = typeof McpHostRequestContext.Type;

/** `request({ op: "tools/call" })`: call tool `params.name` (the server's own name for it) of server `server`. */
export const McpHostToolCall = Schema.Struct({
  op: Schema.Literal("tools/call"),
  server: Schema.String,
  params: Schema.Struct({
    name: Schema.String,
    arguments: Schema.optionalKey(JsonObject),
  }),
  ctx: McpHostRequestContext,
});

export type McpHostToolCall = typeof McpHostToolCall.Type;

/**
 * The MCP task a `tasks/*` request is for: the server's `taskId`, the tool that started it (its definition checks a
 * completed result) and the connection key `conn` the task was started on, which the host compares with the server's
 * current one (`ServerChanged`).
 */
const McpHostTaskParams = {
  taskId: Schema.String,
  tool: Schema.String,
  conn: Schema.String,
};

/** `request({ op: "tasks/get" })`: where the task stands, and its result once it has completed. */
export const McpHostTaskGet = Schema.Struct({
  op: Schema.Literal("tasks/get"),
  server: Schema.String,
  params: Schema.Struct(McpHostTaskParams),
  ctx: McpHostRequestContext,
});

export type McpHostTaskGet = typeof McpHostTaskGet.Type;

/** `request({ op: "tasks/update" })`: the answers to the questions the task is waiting on, by key. */
export const McpHostTaskUpdate = Schema.Struct({
  op: Schema.Literal("tasks/update"),
  server: Schema.String,
  params: Schema.Struct({ ...McpHostTaskParams, inputResponses: McpTaskInputResponses }),
  ctx: McpHostRequestContext,
});

export type McpHostTaskUpdate = typeof McpHostTaskUpdate.Type;

/** `request({ op: "tasks/cancel" })`: allowed for a server that has been switched off since. */
export const McpHostTaskCancel = Schema.Struct({
  op: Schema.Literal("tasks/cancel"),
  server: Schema.String,
  params: Schema.Struct(McpHostTaskParams),
  ctx: McpHostRequestContext,
});

export type McpHostTaskCancel = typeof McpHostTaskCancel.Type;

/**
 * `request({ op: "resume" })`: a `tools/call` answered `InputRequired`, sent again with the answers to the questions it
 * deferred, by key (`docs/architecture/mcp-server-requests.md` → Questions). `tool` is the server's own name for the
 * tool, `conn` the server's connection key when it asked (another one now is `ServerChanged`, nothing sent), and
 * `resume` the `ResumeState` the `InputRequired` carried, as it came. Answered as a `tools/call` is, with the same
 * `ctx`.
 */
export const McpHostResume = Schema.Struct({
  op: Schema.Literal("resume"),
  server: Schema.String,
  params: Schema.Struct({
    tool: Schema.String,
    conn: Schema.String,
    resume: Schema.Json,
    answers: McpTaskInputResponses,
  }),
  ctx: McpHostRequestContext,
});

export type McpHostResume = typeof McpHostResume.Type;

/**
 * `request({ op: "resend" })`: a `tools/call` answered `PagesRequired`, sent again with an answer for each page it
 * listed (`docs/architecture/mcp-server-requests.md` → Elicitation requests, URL mode). Like `McpHostResume`, with the
 * `ResendState` the `PagesRequired` carried as `resend`.
 */
export const McpHostResend = Schema.Struct({
  op: Schema.Literal("resend"),
  server: Schema.String,
  params: Schema.Struct({
    tool: Schema.String,
    conn: Schema.String,
    resend: Schema.Json,
    answers: McpTaskInputResponses,
  }),
  ctx: McpHostRequestContext,
});

export type McpHostResend = typeof McpHostResend.Type;

/** The MIME type of an MCP App's HTML, which a `ui://` resource's one content item must have exactly. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** What marks a resource's MIME type as an MCP App's: the lists leave such a resource out. */
export const MCP_APP_PROFILE = "profile=mcp-app";

/** A `ui://` URI is at most this long; longer is a server's mistake, not a page. */
const MCP_APP_URI_MAX_LENGTH = 2048;

/**
 * The `ui://` resource a tool declares as its App in its `_meta.ui.resourceUri` (`docs/architecture/mcp-apps.md` →
 * Declaring and reading Apps); undefined for any other tool, or a URI over 2048 characters. `meta` is the tool's whole
 * `_meta`, as the inventory keeps it.
 */
export const appUriOfMeta = (meta: Schema.Json | undefined): string | undefined => {
  const ui = isJsonObject(meta) ? meta["ui"] : undefined;
  const uri = isJsonObject(ui) ? ui["resourceUri"] : undefined;

  return Predicate.isString(uri) && uri.startsWith("ui://") && uri.length <= MCP_APP_URI_MAX_LENGTH
    ? uri
    : undefined;
};

/**
 * Who a tool is for (`_meta.ui.visibility`, MCP Apps): `model`, `app`, or both, the default when `meta` has none or it
 * cannot be read (`docs/architecture/mcp-apps.md` → Declaring and reading Apps). `meta` is the tool's whole `_meta`.
 */
export const visibilityOfMeta = (meta: Schema.Json | undefined): ReadonlyArray<string> => {
  const ui = isJsonObject(meta) ? meta["ui"] : undefined;
  const visibility = isJsonObject(ui) ? ui["visibility"] : undefined;

  return Arr.isArray(visibility) && Arr.every(visibility, Predicate.isString)
    ? visibility
    : ["model", "app"];
};

/** The most an App's HTML may weigh, as text. */
export const MCP_APP_HTML_MAX_BYTES = 4 * MiB;

/**
 * The most a `resources/read` of a `ui://` resource may answer, JSON as sent (the core's read limit for `ui://`, in
 * `tap.ts`): 4 MiB of HTML as base64, or escaped, with room.
 */
export const MCP_APP_READ_BYTES = 12 * MiB;

/**
 * What the View is mounted with besides its HTML: the `_meta.ui` of the content item, or of the resource's listing
 * entry, of which only these keys are kept (`docs/architecture/mcp-apps.md` → Declaring and reading Apps).
 */
export const McpAppUiMeta = Schema.Struct({
  csp: Schema.optionalKey(JsonObject),
  permissions: Schema.optionalKey(JsonObject),
  domain: Schema.optionalKey(Schema.String),
  prefersBorder: Schema.optionalKey(Schema.Boolean),
});

export type McpAppUiMeta = typeof McpAppUiMeta.Type;

/**
 * `request({ op: "ui/html" })`: App HTML of server `server`. With `params.hash`, the HTML the host kept under that hash
 * (what an App record pins); with `params.uri`, the host reads the `ui://` resource now, keeps it and answers it, for a
 * mount whose read with the call failed.
 */
export const McpHostAppHtmlRequest = Schema.Struct({
  op: Schema.Literal("ui/html"),
  server: Schema.String,
  params: Schema.Union([
    Schema.Struct({ hash: Schema.String }),
    Schema.Struct({ uri: Schema.String }),
  ]),
  ctx: McpHostRequestContext,
});

export type McpHostAppHtmlRequest = typeof McpHostAppHtmlRequest.Type;

/**
 * `request({ op: "prompts/get" })`: get prompt `params.name` of server `server` with `params.arguments`, the owner's
 * pick at send (`docs/architecture/mcp-in-a-session.md` → Getting a prompt at send). The prompt must be in the server's
 * inventory. Answered `Completed` with the server's `GetPromptResult` as its result.
 */
export const McpHostPromptGet = Schema.Struct({
  op: Schema.Literal("prompts/get"),
  server: Schema.String,
  params: Schema.Struct({
    name: Schema.String,
    arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
  ctx: McpHostRequestContext,
});

export type McpHostPromptGet = typeof McpHostPromptGet.Type;

/**
 * `request({ op: "completion/complete" })`: suggestions for `params.argument` of the prompt or resource template
 * `params.ref` of server `server`, the owner's (`docs/architecture/mcp-in-a-session.md` → Arguments and completions).
 * Answered `Completed` with the server's `CompleteResult` as its result. It never starts a Container, whatever `ctx.start`
 * says, and is bounded at `MCP_COMPLETION_TIMEOUT_MS`; a server that does not declare `completions` is not asked
 * (`CallFailed` with `Unsupported`).
 */
export const McpHostCompletion = Schema.Struct({
  op: Schema.Literal("completion/complete"),
  server: Schema.String,
  params: Schema.Struct({
    ref: McpCompletionRef,
    argument: McpCompletionArgument,
    context: Schema.optionalKey(McpCompletionContext),
  }),
  ctx: McpHostRequestContext,
});

export type McpHostCompletion = typeof McpHostCompletion.Type;

/**
 * `request({ op: "resources/read" })`: read the resource `params.uri` of server `server`, whether or not any list names it.
 * With `params.watch: true` the host starts a Resource watch on it (subscribing first, then reading) and answers
 * `Completed.watch` with whether it started; with `false` it ends the conversation's watch and still reads
 * (`docs/architecture/mcp-in-a-session.md` → Resource watches).
 */
export const McpHostResourceRead = Schema.Struct({
  op: Schema.Literal("resources/read"),
  server: Schema.String,
  params: Schema.Struct({ uri: Schema.String, watch: Schema.optionalKey(Schema.Boolean) }),
  ctx: McpHostRequestContext,
});

export type McpHostResourceRead = typeof McpHostResourceRead.Type;

const ResourceListFields = {
  server: Schema.String,
  params: Schema.Struct({ cursor: Schema.optionalKey(Schema.String) }),
  ctx: McpHostRequestContext,
};

/**
 * `request({ op: "resources/list" })`: one page of the server's resources, from `params.cursor`. The answer is
 * `Completed` whose value is `{ resources, nextCursor? }`; a Modern server's page is kept by the host for its `ttlMs`
 * (`docs/architecture/mcp-in-a-session.md` → Resource tools).
 */
export const McpHostResourcesList = Schema.Struct({
  op: Schema.Literal("resources/list"),
  ...ResourceListFields,
});

export type McpHostResourcesList = typeof McpHostResourcesList.Type;

/** `request({ op: "resources/templates/list" })`: one page of the server's resource templates, `{ resourceTemplates, nextCursor? }`. */
export const McpHostTemplatesList = Schema.Struct({
  op: Schema.Literal("resources/templates/list"),
  ...ResourceListFields,
});

export type McpHostTemplatesList = typeof McpHostTemplatesList.Type;

/** The resource requests a Session makes, beside the `McpHostRequest`s of its tool calls and tasks (`resources` feature). */
export const McpHostResourceRequest = Schema.Union([
  McpHostResourcesList,
  McpHostTemplatesList,
  McpHostResourceRead,
]);

export type McpHostResourceRequest = typeof McpHostResourceRequest.Type;

/** What `request` takes for a tool call or a task. */
export const McpHostRequest = Schema.Union([
  McpHostToolCall,
  McpHostTaskGet,
  McpHostTaskUpdate,
  McpHostTaskCancel,
  McpHostResume,
  McpHostResend,
]);

export type McpHostRequest = typeof McpHostRequest.Type;

/**
 * Every request the host's `request` answers: what a Session's tool calls and tasks send, App HTML for a View that
 * mounts, the resource requests, or the owner's prompt get.
 */
export const McpHostRequestInput = Schema.Union([
  ...McpHostRequest.members,
  McpHostAppHtmlRequest,
  ...McpHostResourceRequest.members,
  McpHostPromptGet,
  McpHostCompletion,
]);

export type McpHostRequestInput = typeof McpHostRequestInput.Type;

/** The `op`s `request` takes, read from its union: the one list the host's allowlist and its routing come from. */
const MCP_HOST_REQUEST_OPS: ReadonlyArray<string> = Arr.map(
  McpHostRequestInput.members,
  (member) => member.fields.op.literal,
);

/** Whether `op` is one `request` takes; any other is `HostUnsupported`, an `op` a later build sends. */
export const isMcpHostRequestOp = (op: string) => MCP_HOST_REQUEST_OPS.includes(op);

/** A `tasks/*` request: one that follows an MCP task. */
export const isMcpHostTaskRequest = (
  call: McpHostRequest,
): call is McpHostTaskGet | McpHostTaskUpdate | McpHostTaskCancel =>
  call.op === "tasks/get" || call.op === "tasks/update" || call.op === "tasks/cancel";

/** What a failure for an MCP task the request did not ask for says, in the core and at the host. */
export const MCP_UNASKED_TASK_MESSAGE = "The server started an MCP task that was not asked for";

/**
 * The callbacks a Session's request carries, passed as RPC stubs that live as long as its invocation, so the Session
 * awaits the request for its whole length (`docs/architecture/mcp-connections.md` → RPC).
 */
export interface McpHostRequestHooks {
  /** Pending until the caller aborts the request (it resolves) or dies (it rejects); either way the host cancels it. */
  readonly untilAborted?: () => Promise<void>;
  /** The request's progress, at most `MCP_PROGRESS_PER_SECOND` a second. */
  readonly onProgress?: (progress: McpProgress) => void | Promise<void>;
  /**
   * A question the server asks while the request waits (`ctx.answers` says which kinds): resolves with the answer the
   * server gets, or rejects when the caller cannot answer. The host passes it on to the engine, never keeping a
   * question or an answer (`docs/architecture/mcp-server-requests.md` → Questions).
   */
  readonly onInput?: (
    request: typeof McpInputRequest.Encoded,
  ) => Promise<typeof McpInputAnswer.Encoded>;
  /**
   * The server stopped waiting for question `key` (its own cancellation): the caller withdraws its card. The host also
   * calls it, with `reason`, for a question whose server a set change left changed, switched off or removed while the
   * call waited (`docs/architecture/mcp-server-requests.md` → The waiting-question record, #569): a caller from before
   * `reason` ignores it and says its own.
   */
  readonly onInputEnded?: (key: string, reason?: string) => void | Promise<void>;
  /**
   * The owner finished at the page URL question `key` asked them to open: the server said so on the call's own stream
   * (`notifications/elicitation/complete`), and the caller closes its card. The host keeps no `elicitationId`.
   */
  readonly onInputComplete?: (key: string) => void | Promise<void>;
}

/** The request completed: the server's result (a `tools/call`'s, `isError` included) and how it fits the output schema. */
export const McpHostCompleted = Schema.TaggedStruct("Completed", {
  result: McpEngineValue,
  structuredOutput: Schema.optionalKey(McpStructuredOutput),
  /**
   * An App tool's call: the hash its App's HTML is kept under (`ui/html`), once the host has it (`app_html`), and the
   * `viewHash` of the origin the server's Views are served on, when the host knows the Environment and source; the
   * call's record pins it, so a record of a server that has since been shadowed is not mounted at its successor's origin.
   */
  app: Schema.optionalKey(
    Schema.Struct({ htmlHash: Schema.String, viewHash: Schema.optionalKey(Schema.String) }),
  ),
  /** A `resources/read`: the SHA-256 (lowercase hex) of its contents, the baseline of a Resource watch (`resources`). */
  sha256: Schema.optionalKey(Schema.String),
  /**
   * A `resources/read` with `watch: true`: whether the Resource watch started, and why not when it did not (over a cap,
   * a server that cannot send updates, a read that did not complete, a watch the host could not store). The read's
   * contents are given either way. Gain-only: absent for a read that did not ask to watch.
   */
  watch: Schema.optionalKey(
    Schema.Struct({ started: Schema.Boolean, reason: Schema.optionalKey(Schema.String) }),
  ),
  /**
   * A stdio server's process that answered a `resume` or `resend` (its spawn id, as a task's): another one than the
   * `InputRequired` carried is a process that restarted while the questions waited. Gain-only; absent for an HTTP server
   * and from a host from before it.
   */
  spawn: Schema.optionalKey(Schema.String),
});

export type McpHostCompleted = typeof McpHostCompleted.Type;

/**
 * What a result of a task says of where it was made (`docs/architecture/mcp-sign-in.md` → The sign-in id): `signIn`,
 * the MCP sign-in id of the token the server was called with (absent for a server with no sign-in), so a follower can
 * tell "not reachable under the current sign-in" from "expired"; and `spawn`, the stdio process's id (present for a stdio
 * server's task, #494: another one is a process that ended, which the Session reads as the task `unknown`).
 */
const McpHostTaskOrigin = {
  signIn: Schema.optionalKey(Schema.String),
  spawn: Schema.optionalKey(Schema.String),
};

/**
 * A `tools/call` the server answered with an MCP task, returned only to a call with `ctx.allowTask`. `conn` and
 * `identity` (`mcpServerIdentity`) are the server's as the call was made, for the caller to pin the task to.
 */
export const McpHostTaskStarted = Schema.TaggedStruct("Task", {
  task: McpTaskCreated,
  conn: Schema.String,
  identity: Schema.optionalKey(Schema.String),
  /**
   * An App tool's call: the `viewHash` of the origin the server's Views are served on, as `Completed.app.viewHash`, so the
   * App record the task makes when it completes pins it (`docs/architecture/mcp-apps.md` → Results). Absent when the host
   * does not know the Environment and source, or from a host from before it.
   */
  viewHash: Schema.optionalKey(Schema.String),
  ...McpHostTaskOrigin,
});

export type McpHostTaskStarted = typeof McpHostTaskStarted.Type;

/** A `tasks/get` answer: the snapshot and, for a `completed` task, its result, as `Completed`'s. */
export const McpHostTaskState = Schema.TaggedStruct("TaskState", {
  task: McpTaskSnapshot,
  result: Schema.optionalKey(McpEngineValue),
  structuredOutput: Schema.optionalKey(McpStructuredOutput),
  ...McpHostTaskOrigin,
});

export type McpHostTaskState = typeof McpHostTaskState.Type;

/**
 * A `tools/call` (or its `resume`) whose server asked questions the caller deferred, returned only to a call whose
 * `ctx.answers.defer` is set: the questions, and the `ResumeState` a `resume` sends with their answers, opaque to the
 * caller, who keeps it. `conn` and `identity` are the server's as it asked, for the caller's record; `signIn` and
 * `spawn` as a task's (`docs/architecture/mcp-server-requests.md` → The waiting-question record).
 */
export const McpHostInputRequired = Schema.TaggedStruct("InputRequired", {
  requests: Schema.Array(McpInputRequest),
  resume: Schema.Json,
  conn: Schema.String,
  identity: Schema.optionalKey(Schema.String),
  ...McpHostTaskOrigin,
});

export type McpHostInputRequired = typeof McpHostInputRequired.Type;

/**
 * A `tools/call` (or its `resend`) or `resources/read` whose Legacy server answered `-32042`, returned only to a call
 * whose `ctx.answers.pages` is set: the pages as questions, and for a call the `ResendState` a `resend` sends with
 * their answers, opaque to the caller, who keeps it; a read is sent again by the caller as it was. The rest is as
 * `InputRequired`'s.
 */
export const McpHostPagesRequired = Schema.TaggedStruct("PagesRequired", {
  requests: Schema.Array(McpInputRequest),
  /** The server's own error, `-32042`'s message. */
  message: Schema.String,
  /** The `ResendState`; absent for a `resources/read`, which the caller sends again as it was. */
  resend: Schema.optionalKey(Schema.Json),
  conn: Schema.String,
  identity: Schema.optionalKey(Schema.String),
  ...McpHostTaskOrigin,
});

export type McpHostPagesRequired = typeof McpHostPagesRequired.Type;

/** The server took a `tasks/update` or a `tasks/cancel`. */
export const McpHostTaskAck = Schema.TaggedStruct("TaskAck", McpHostTaskOrigin);

export type McpHostTaskAck = typeof McpHostTaskAck.Type;

/**
 * The name's server is not the one the task was started on: its `conn` changed. It carries the current `conn` and
 * `mcpServerIdentity`, so the caller can tell a re-pin (the same identity) from a new server (`docs/architecture/
 * mcp-server-requests.md` → MCP tasks, Failures). Nothing was sent.
 */
export const ServerChanged = Schema.TaggedStruct("ServerChanged", {
  message: Schema.String,
  conn: Schema.String,
  identity: Schema.optionalKey(Schema.String),
});

export type ServerChanged = typeof ServerChanged.Type;

/** The request failed on the way to the server, or the server failed it: the core's failure. */
export const McpHostCallFailed = Schema.TaggedStruct("CallFailed", {
  error: McpErrorWire,
  /** As `McpHostCompleted.spawn`: the stdio process the failed `resume` or `resend` reached. Gain-only. */
  spawn: Schema.optionalKey(Schema.String),
});

export type McpHostCallFailed = typeof McpHostCallFailed.Type;

/**
 * `request({ op: "ui/html" })` completed: the HTML under `hash` and what its View is mounted with. `viewHash` names the
 * server's App sandbox origin (`docs/architecture/mcp-apps.md` → The App sandbox, Origins): set by a host that knows its
 * Environment and the server's source, left out by an older one and for a source it does not know.
 */
export const McpHostAppHtml = Schema.TaggedStruct("AppHtml", {
  hash: Schema.String,
  html: Schema.String,
  meta: McpAppUiMeta,
  viewHash: Schema.optionalKey(Schema.String),
});

export type McpHostAppHtml = typeof McpHostAppHtml.Type;

/** The host holds no HTML under that hash: evicted, or never kept. */
export const NoAppHtml = Schema.TaggedStruct("NoAppHtml", { message: Schema.String });

export type NoAppHtml = typeof NoAppHtml.Type;

/** No server of that name is in the set. */
export const UnknownServer = Schema.TaggedStruct("UnknownServer", { message: Schema.String });

export type UnknownServer = typeof UnknownServer.Type;

/** The server or tool may not be called: switched off, `hidden`, not discovered, or not in its inventory. */
export const NotAllowed = Schema.TaggedStruct("NotAllowed", { message: Schema.String });

export type NotAllowed = typeof NotAllowed.Type;

/** What `request` answers. */
export const McpHostRequestResult = Schema.Union([
  McpHostCompleted,
  McpHostAppHtml,
  NoAppHtml,
  McpHostCallFailed,
  UnknownServer,
  NotAllowed,
  McpHostTaskStarted,
  McpHostTaskState,
  McpHostTaskAck,
  ServerChanged,
  McpHostInputRequired,
  McpHostPagesRequired,
  ...McpHostFailure.members,
]);

export type McpHostRequestResult = typeof McpHostRequestResult.Type;

/**
 * `answer`, a `request` answer as it crossed the edge, as a result this build knows: a failure under a tag it does not
 * know, or anything that is no result, is `HostFailed`.
 */
export const readMcpHostRequestResult: (
  answer: typeof McpHostRequestResult.Encoded,
) => McpHostRequestResult = hostAnswerReader(McpHostRequestResult, "the request");

export * from "./sign-in.ts";
