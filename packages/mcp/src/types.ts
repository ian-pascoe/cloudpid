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
import { JsonObject } from "./json.ts";
import { McpLogEntry } from "./log.ts";

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

/** The server wants the owner signed in: a 401. `rejected` when it refused a token the core sent, twice. */
export class SignInRequired extends Schema.TaggedError<
  SignInRequired,
  { readonly brand: unique symbol }
>()("SignInRequired", {
  message: Schema.String,
  rejected: Schema.Boolean,
}) {}

/** The server wants a token with more scope: a 403 with `insufficient_scope`. */
export class StepUpRequired extends Schema.TaggedError<
  StepUpRequired,
  { readonly brand: unique symbol }
>()("StepUpRequired", {
  message: Schema.String,
  scope: Schema.optionalKey(Schema.String),
}) {}

/** The server could not be reached or is not answering for now: a network error, a 5xx, a 408 or a 429. */
export class Unreachable extends Schema.TaggedError<
  Unreachable,
  { readonly brand: unique symbol }
>()("Unreachable", {
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int),
}) {}

/** The request's stream ended before its answer arrived; a `tools/call` may or may not have run. */
export class Cut extends Schema.TaggedError<Cut, { readonly brand: unique symbol }>()("Cut", {
  message: Schema.String,
  mayHaveRun: Schema.Boolean,
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
 * The server a call goes to: its connection key `conn`, its name and its `timeout`, and for an HTTP server its URL and
 * headers, `${NAME}` values resolved. `kind` keeps room for stdio targets (`workspace`, `start`, `env`), which an
 * engine that does not know them fails as `Unsupported`.
 */
export const McpEngineTarget = Schema.Struct({
  kind: Schema.Literal("http"),
  conn: Schema.String,
  name: Schema.String,
  url: Schema.String,
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** The entry's `timeout` for a `tools/call` (default 60 s). */
  timeoutMs: Schema.optionalKey(Schema.Int),
});

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

/** What a call failed with, and the rows it changed before it did. */
export const McpEngineFailed = Schema.Struct({
  kind: Schema.Literal("failed"),
  error: McpErrorWire,
  ...RefreshedTools,
  ...EngineLogs,
  state: McpEngineState,
});

export type McpEngineFailed = typeof McpEngineFailed.Type;

/** A server's protocol era as the engine reports it (`docs/architecture/mcp.md` → Protocol eras). */
export const MCP_ENGINE_ERAS = ["modern", "legacy"] as const;

export const McpEngineEra = Schema.Literals(MCP_ENGINE_ERAS);

export type McpEngineEra = typeof McpEngineEra.Type;

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
  /** The tools list's cache hint (SEP-2549), for the host's TTL. */
  ttlMs: Schema.optionalKey(Schema.Finite),
  fetchedAt: Schema.Finite,
  ...EngineLogs,
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
  ...EngineLogs,
  state: McpEngineState,
});

export type McpEngineCompleted = typeof McpEngineCompleted.Type;

/**
 * A request's result. Neither result union has a fallback member, by design: a new success shape is returned only
 * when the request asked for it (a request flag such as `ctx.allowTask`), so an older host never receives one it
 * cannot read (`docs/architecture/mcp.md` → Deploys); failures fall back through `McpErrorWire`.
 */
export const McpEngineRequestResult = Schema.Union([McpEngineCompleted, McpEngineFailed]);

export type McpEngineRequestResult = typeof McpEngineRequestResult.Type;

/**
 * The callbacks a call carries, passed as RPC stubs that live as long as the caller's invocation (`docs/architecture/
 * mcp.md` → RPC edges). Later slices add `onInput` and `onProgress`. There is no `onLog`: a server's logs come back in
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

export * from "./sign-in.ts";
