/**
 * `@cloudpid/mcp/types`: Effect Schemas for `McpHost`'s and `McpEngine`'s RPC (`McpEngineMethods` included). It never
 * loads the SDK, so Sessions, the `mcp` extension, `McpHost`, the web app and the bridge can import it; its test
 * (`sdk-isolation.test.ts`) fails if it comes to.
 *
 * `docs/architecture/mcp.md` → Packages and objects (the core's seam), Deploys (`prior` rows carry a format `v`).
 * What is here so far: the core's tagged `McpError`, `McpErrorWire` (with its fallback `OtherMcpError`, and
 * `mayHaveRun`) for the engine edge, the call context, the `prior` rows the host keeps for the engine
 * (`docs/architecture/mcp-connections.md` → Storage), and the host's own RPC (`./host.ts`).
 */
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export * from "./host.ts";

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
