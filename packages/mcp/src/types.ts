/**
 * `@cloudpid/mcp/types`: Effect Schemas for `McpHost`'s and `McpEngine`'s RPC (`McpEngineMethods` included). It never
 * loads the SDK, so Sessions, the `mcp` extension, `McpHost`, the web app and the bridge can import it; its test
 * (`sdk-isolation.test.ts`) fails if it comes to.
 *
 * `docs/architecture/mcp.md` → Packages and objects (the core's seam), Deploys (`prior` rows carry a format `v`).
 * What is here so far: the core's tagged `McpError`, `McpErrorWire` (with its fallback `OtherMcpError`, and
 * `mayHaveRun`) for the engine edge, the call context, the `prior` rows the host keeps for the engine
 * (`docs/architecture/mcp-connections.md` → Storage), `McpEngine`'s RPC, `McpEngineMethods`
 * (`docs/architecture/mcp-connections.md` → The engine), and the host's own RPC (`./host.ts`).
 */
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { hostAnswerReader, McpHostFailure } from "./host.ts";
import { JsonObject } from "./json.ts";
import { McpLogEntry } from "./log.ts";
import { McpAuthChallenge } from "./sign-in.ts";

export * from "./host.ts";

export * from "./log.ts";

export { isJsonObject, JsonObject } from "./json.ts";

export { xMcpHeaderProblems } from "./tool-headers.ts";

/** Where a call comes from (The MCP core #394 D7, `McpCallContext`). */
export const McpCallOrigin = Schema.Literals(["agent", "owner", "app", "host"]);

export type McpCallOrigin = typeof McpCallOrigin.Type;

/**
 * Who a request is made for: what the client declares on it (`capabilities(ctx)`) and, in later slices, which
 * questions it may ask, follow from it.
 */
export const McpCallContext = Schema.Struct({
  origin: McpCallOrigin,
  conversation: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(Schema.String),
  allowTask: Schema.optionalKey(Schema.Boolean),
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
 * server's capabilities and instructions from here.
 */
export const SessionRowV1 = Schema.Struct({
  v: Schema.Literal(1),
  sessionId: Schema.String,
  protocolVersion: Schema.String,
  serverInfo: Schema.Record(Schema.String, Schema.Json),
  capabilities: Schema.Record(Schema.String, Schema.Json),
  instructions: Schema.optionalKey(Schema.String),
  initializedAt: Schema.Finite,
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
}) {}

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
]);

export type McpEngineRequestResult = typeof McpEngineRequestResult.Type;

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
 * mcp.md` → RPC edges). Later slices add `onInput`. There is no `onLog`: a server's logs come back in
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

/** What `request` takes. Other `op`s (`prompts/get`, `resources/read`, …) come with their slices. */
export const McpHostRequest = Schema.Union([
  McpHostToolCall,
  McpHostTaskGet,
  McpHostTaskUpdate,
  McpHostTaskCancel,
]);

export type McpHostRequest = typeof McpHostRequest.Type;

/**
 * The callbacks a Session's request carries, passed as RPC stubs that live as long as its invocation, so the Session
 * awaits the request for its whole length (`docs/architecture/mcp-connections.md` → RPC).
 */
export interface McpHostRequestHooks {
  /** Pending until the caller aborts the request (it resolves) or dies (it rejects); either way the host cancels it. */
  readonly untilAborted?: () => Promise<void>;
  /** The request's progress, at most `MCP_PROGRESS_PER_SECOND` a second. */
  readonly onProgress?: (progress: McpProgress) => void | Promise<void>;
}

/** The request completed: the server's result (a `tools/call`'s, `isError` included) and how it fits the output schema. */
export const McpHostCompleted = Schema.TaggedStruct("Completed", {
  result: McpEngineValue,
  structuredOutput: Schema.optionalKey(McpStructuredOutput),
});

export type McpHostCompleted = typeof McpHostCompleted.Type;

/**
 * What a result of a task says of where it was made (`docs/architecture/mcp-sign-in.md` → The sign-in id): `signIn`,
 * the MCP sign-in id of the token the server was called with (absent for a server with no sign-in), so a follower can
 * tell "not reachable under the current sign-in" from "expired"; and `spawn`, the stdio process's id (never present
 * yet: tasks do not run on stdio servers, #494).
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
});

export type McpHostCallFailed = typeof McpHostCallFailed.Type;

/** No server of that name is in the set. */
export const UnknownServer = Schema.TaggedStruct("UnknownServer", { message: Schema.String });

export type UnknownServer = typeof UnknownServer.Type;

/** The server or tool may not be called: switched off, `hidden`, not discovered, or not in its inventory. */
export const NotAllowed = Schema.TaggedStruct("NotAllowed", { message: Schema.String });

export type NotAllowed = typeof NotAllowed.Type;

/** What `request` answers. */
export const McpHostRequestResult = Schema.Union([
  McpHostCompleted,
  McpHostCallFailed,
  UnknownServer,
  NotAllowed,
  McpHostTaskStarted,
  McpHostTaskState,
  McpHostTaskAck,
  ServerChanged,
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
