// What the client reads of an Environment's MCP servers (`docs/architecture/mcp-connections.md` → Telemetry; #382
// D12.3): each server's state, counts, status and tools with their Exposure, its log ring, and the reconnect. The status
// UI itself is not specified yet; these are the `RegistryRpcs` it will use (`mcpServers`, `mcpServerLog`,
// `mcpReconnect`).
//
// Every answer union only gains (`docs/architecture/mcp.md` → Deploys): a state is a string and a tag this build does
// not know reads as `Unavailable` (`readMcpServerState`, the unions' last member), never as a decode error.
import { MCP_EXPOSURES, type McpExposure } from "@cloudpid/config";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * A server's state: `not_discovered` (never asked), `connecting`, `connected`, `sign_in` (wants an MCP sign-in),
 * `rejected` (refused its token), `unavailable` (unreachable for now), `failed`, `skipped` (cannot be used yet), and
 * `disabled`. `unknown` is any state this build does not know, which reads as a problem like `failed`.
 */
export const MCP_SERVER_STATES = [
  "not_discovered",
  "connecting",
  "connected",
  "sign_in",
  "rejected",
  "unavailable",
  "failed",
  "skipped",
  "disabled",
  "unknown",
] as const;

export type McpServerState = (typeof MCP_SERVER_STATES)[number];

const isServerState = Schema.is(Schema.Literals(MCP_SERVER_STATES));

/** `raw`, a state as it crossed the edge, as one this build knows: `unknown` for any other. */
export const readMcpServerState = (raw: string): McpServerState =>
  isServerState(raw) ? raw : "unknown";

const isExposure = Schema.is(Schema.Literals(MCP_EXPOSURES));

/**
 * `raw`, an Exposure as it crossed the edge (`McpToolView.exposure`, a string so that one a later build adds still
 * decodes), as one this build knows (`MCP_EXPOSURES` of `@cloudpid/config`, which protocol already depends on):
 * `unknown` for any other, never a guess at what it allows.
 */
export const readMcpExposure = (raw: string): McpExposure | "unknown" =>
  isExposure(raw) ? raw : "unknown";

/** Whether `state` is one the owner should look at: a failure, a sign-in, a refusal or a state this build does not know. */
export const mcpStateIsProblem = (state: string): boolean => {
  const known = readMcpServerState(state);

  return (
    known === "sign_in" ||
    known === "rejected" ||
    known === "unavailable" ||
    known === "failed" ||
    known === "unknown"
  );
};

/** Where a server is defined: Global, the Environment, or a Repo's `.pi/mcp.json`; a kind this build does not know keeps its name. */
export const McpServerSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("global") }),
  Schema.Struct({ kind: Schema.Literal("environment") }),
  Schema.Struct({
    kind: Schema.Literal("repo"),
    directory: Schema.String,
    slug: Schema.String,
    path: Schema.String,
  }),
  Schema.Struct({ kind: Schema.String }),
]);

export type McpServerSource = typeof McpServerSource.Type;

/** A tool: its name as its server calls it, a title and description if it has them, and its Exposure. */
export const McpToolView = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  /**
   * `codemode`, `deferred`, `direct` or `hidden` (read it with `readMcpExposure`): from the server's `exposure` and
   * `toolExposure`, and a `tools.offered` entry of the Environment's Settings that lifts it to `direct`. The Settings
   * are the Environment's in force (its Overrides over Global's); Sessions resolve theirs the same way.
   */
  exposure: Schema.String,
});

export type McpToolView = typeof McpToolView.Type;

export const McpPromptView = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
});

export type McpPromptView = typeof McpPromptView.Type;

/** What was found wrong with a tool (`tool`), a prompt (`prompt`) or the server itself (neither) at discovery. */
export const McpProblemView = Schema.Struct({
  tool: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  problem: Schema.String,
});

export type McpProblemView = typeof McpProblemView.Type;

/** Since when a server has its state, the failures in a row, and when it may be tried again. */
export const McpServerStatusView = Schema.Struct({
  since: Schema.Finite,
  failures: Schema.Int,
  nextRetryAt: Schema.optionalKey(Schema.Finite),
  lastOkAt: Schema.optionalKey(Schema.Finite),
  /** What the server has used that the MCP spec deprecated (`sampling`), as the host saw it since it started. */
  deprecated: Schema.Array(Schema.String).pipe(Schema.optionalKey),
});

export type McpServerStatusView = typeof McpServerStatusView.Type;

/** One server of an Environment's set. `state` is a string: read it with `readMcpServerState`. */
export const McpServerView = Schema.Struct({
  name: Schema.String,
  source: McpServerSource,
  state: Schema.String,
  /** The last failure's message, at most 300 characters. */
  error: Schema.optionalKey(Schema.String),
  protocolVersion: Schema.optionalKey(Schema.String),
  discoveredAt: Schema.optionalKey(Schema.Finite),
  counts: Schema.Struct({ tools: Schema.Int, prompts: Schema.Int }),
  resources: Schema.Boolean,
  problems: Schema.Array(McpProblemView),
  tools: Schema.Array(McpToolView),
  prompts: Schema.Array(McpPromptView),
  status: Schema.optionalKey(McpServerStatusView),
});

export type McpServerView = typeof McpServerView.Type;

/** The host could not be reached, or did not answer, or answered with something this build does not know. */
export const McpUnavailable = Schema.TaggedStruct("Unavailable", { message: Schema.String });

export type McpUnavailable = typeof McpUnavailable.Type;

/** The Environment is not listed. */
export const McpNoEnvironment = Schema.TaggedStruct("NoEnvironment", {});

export type McpNoEnvironment = typeof McpNoEnvironment.Type;

/** An answer of a tag this build does not know, as it crosses the edge: it reads as `Unavailable`. */
export const OtherAnswerFromWire = Schema.Struct({
  _tag: Schema.String,
  message: Schema.optionalKey(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.toType(McpUnavailable),
    SchemaTransformation.transform({
      decode: ({ _tag, message }) =>
        McpUnavailable.make({
          message:
            message ?? `The server answered with something this build does not know (${_tag})`,
        }),
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- the encoded side is a plain wire object
      encode: ({ message }) => ({ _tag: "Unavailable", message }),
    }),
  ),
);

/** `mcpServers`' answer: the servers in the set's order (none for an Environment with no MCP servers), or why not. */
export const McpServersList = Schema.TaggedStruct("Servers", {
  version: Schema.String,
  servers: Schema.Array(McpServerView),
});

export type McpServersList = typeof McpServersList.Type;

export const McpServersView = Schema.Union([
  McpServersList,
  McpNoEnvironment,
  McpUnavailable,
  OtherAnswerFromWire,
]);

export type McpServersView = typeof McpServersView.Type;

/**
 * One server log entry, oldest first in the ring: `at` is when the engine received it; `data` is JSON text, cut and
 * scrubbed. The twin of `McpLogEntry` in `@cloudpid/mcp`, which protocol does not depend on: change them together.
 */
export const McpLogView = Schema.Struct({
  at: Schema.Finite,
  level: Schema.String,
  logger: Schema.optionalKey(Schema.String),
  data: Schema.String,
});

export type McpLogView = typeof McpLogView.Type;

/**
 * `mcpServerLog`'s answer: the ring of the last 50 entries (and a stdio server's stderr tail when the bridge gives one),
 * read without starting a Container; or that the Environment or the server is not in the set; or why not.
 */
export const McpServerLogEntries = Schema.TaggedStruct("Log", {
  entries: Schema.Array(McpLogView),
  stderr: Schema.optionalKey(Schema.String),
});

export type McpServerLogEntries = typeof McpServerLogEntries.Type;

/** The Environment has no server by that name. */
export const McpServerMissing = Schema.TaggedStruct("NoServer", {});

export type McpServerMissing = typeof McpServerMissing.Type;

export const McpServerLogView = Schema.Union([
  McpServerLogEntries,
  McpServerMissing,
  McpNoEnvironment,
  McpUnavailable,
  OtherAnswerFromWire,
]);

export type McpServerLogView = typeof McpServerLogView.Type;

/** `mcpReconnect`'s answer: the servers it started to discover again (those of the set it names), or why not. */
export const McpReconnecting = Schema.TaggedStruct("Reconnecting", {
  servers: Schema.Array(Schema.String),
});

export type McpReconnecting = typeof McpReconnecting.Type;

export const McpReconnectView = Schema.Union([
  McpReconnecting,
  McpNoEnvironment,
  McpUnavailable,
  OtherAnswerFromWire,
]);

export type McpReconnectView = typeof McpReconnectView.Type;
