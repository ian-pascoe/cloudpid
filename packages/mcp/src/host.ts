/**
 * `McpHost`'s RPC types, re-exported by `@cloudpid/mcp/types` (`docs/architecture/mcp-connections.md` → RPC, Storage;
 * `docs/architecture/mcp-configuration.md` → From the Registry to the host). Like everything in `./types`, this never
 * loads the SDK.
 *
 * Every edge only gains (`docs/architecture/mcp.md` → Deploys): a Schema drops the keys it does not know, a union the
 * other end may extend has a fallback member, and an operation this build does not know fails as `HostUnsupported`,
 * never as a decode error. Failures cross the edge as plain data (`_tag` and fields), since a Durable Object's RPC
 * does not carry error classes.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { McpLogEntry } from "./log.ts";

/**
 * Where an entry of the set is defined: Global, the Environment, or a Repo's `.pi/mcp.json`. `kind` this build does not
 * know reads as the last member, which keeps the key only.
 */
export const McpSetSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("global") }),
  Schema.Struct({ kind: Schema.Literal("environment") }),
  Schema.Struct({
    kind: Schema.Literal("repo"),
    /** The Repo's directory name in the Environment (`/workspace/<directory>`). */
    directory: Schema.String,
    /** The Repo's `owner/repo`. */
    slug: Schema.String,
    /** The file's path in the Repo. */
    path: Schema.String,
  }),
  Schema.Struct({ kind: Schema.String }),
]);

export type McpSetSource = typeof McpSetSource.Type;

/**
 * One MCP server of the set as the Registry hands it over: its entry in force with every default applied and `${NAME}`
 * unresolved (so no resolved value is here, in a hash, or in the host's storage), and three hashes of it, which the
 * Registry computes with `@cloudpid/config` so the host never needs to.
 */
export const McpSetEntry = Schema.Struct({
  /** The name as the entry spells it. */
  name: Schema.String,
  source: McpSetSource,
  /** The entry in force (`McpServerEntry`): its type, command or url, env or headers, and the keys that shape tools. */
  server: Schema.Record(Schema.String, Schema.Json),
  /** SHA-256 of the entry: any change to it, `description` and `exposure` included. */
  hash: Schema.String,
  /** The connection key (`mcpConnectionKey`): what keys the connection, the inventory and the era. */
  conn: Schema.String,
  /** `mcpServerIdentity`: tells a server re-pinned to another definition from a new one. */
  identity: Schema.String,
});

export type McpSetEntry = typeof McpSetEntry.Type;

/** A set's hash with the revision it was handed out under: what a host holds, and what the Registry notes as handed. */
export const McpSetRevision = Schema.Struct({
  hash: Schema.String,
  revision: Schema.Int,
});

export type McpSetRevision = typeof McpSetRevision.Type;

/** `apply({ kind: "set" })`: the Environment's whole MCP server set, in the order its entries resolved. */
export const McpApplySet = Schema.Struct({
  kind: Schema.Literal("set"),
  /** SHA-256 over the entries' names and hashes, in order. */
  hash: Schema.String,
  /**
   * The Registry's own order of the sets it hands out, which only rises: the host refuses a set whose revision is below
   * the one it holds, so a push that arrives after a later pull, or two pushes out of order, never bring back an older
   * set.
   */
  revision: Schema.Int,
  entries: Schema.Array(McpSetEntry),
});

export type McpApplySet = typeof McpApplySet.Type;

/**
 * `apply({ kind: "destroy" })`: an Environment was deleted; the host wipes its storage and keeps `revision`, which the
 * Registry gave the deletion, so a set handed out before it (a push or a pull answered late) never fills the host again.
 */
export const McpApplyDestroy = Schema.Struct({
  kind: Schema.Literal("destroy"),
  revision: Schema.Int,
});

export type McpApplyDestroy = typeof McpApplyDestroy.Type;

/**
 * `apply({ kind: "reload" })`: `settings_mcp_reload` or `mcpReconnect`. The host drops the eras and Legacy sessions of
 * `servers` (every server when absent), and rediscovers its HTTP servers at once, a `failed` one included
 * (`docs/architecture/mcp-connections.md` → Discovery and the MCP inventory).
 */
export const McpApplyReload = Schema.Struct({
  kind: Schema.Literal("reload"),
  servers: Schema.String.pipe(Schema.Array, Schema.optionalKey),
});

export type McpApplyReload = typeof McpApplyReload.Type;

/** What `apply` takes. The other kinds (`sign_ins`, `end_watches`) are added by their slices. */
export const McpApply = Schema.Union([McpApplySet, McpApplyDestroy, McpApplyReload]);

export type McpApply = typeof McpApply.Type;

/** The set was taken: its hash, and whether it differs from the one the host held. */
export const McpApplied = Schema.TaggedStruct("Applied", {
  hash: Schema.String,
  changed: Schema.Boolean,
});

export type McpApplied = typeof McpApplied.Type;

/**
 * The set was refused as no newer than what the host holds: `hash` and `revision` are the held set's, which it kept, or
 * (`hash` empty) the revision it was wiped at.
 */
export const McpStale = Schema.TaggedStruct("Stale", McpSetRevision.fields);

export type McpStale = typeof McpStale.Type;

/** The host's storage was wiped (`apply({ kind: "destroy" })`). */
export const McpDestroyed = Schema.TaggedStruct("Destroyed", {});

export type McpDestroyed = typeof McpDestroyed.Type;

/** The servers were reloaded (`apply({ kind: "reload" })`): the names of the set that it reached. */
export const McpReloaded = Schema.TaggedStruct("Reloaded", {
  servers: Schema.Array(Schema.String),
});

export type McpReloaded = typeof McpReloaded.Type;

/** An operation this build of the host does not know (`op`: the `kind` or method asked for). */
export const HostUnsupported = Schema.TaggedStruct("HostUnsupported", {
  message: Schema.String,
  op: Schema.String,
});

export type HostUnsupported = typeof HostUnsupported.Type;

/**
 * The fallback of the host's failures: any tag this build does not know, or a known one whose fields do not fit, reads
 * as this one, keeping the original in `tag`.
 */
export const HostFailed = Schema.TaggedStruct("HostFailed", {
  message: Schema.String,
  tag: Schema.optionalKey(Schema.String),
});

export type HostFailed = typeof HostFailed.Type;

export const McpHostFailure = Schema.Union([HostUnsupported, HostFailed]);

export type McpHostFailure = typeof McpHostFailure.Type;

/** What `apply` answers: the set was taken or refused as stale, the storage wiped, the servers reloaded, or why not. */
export const McpApplyResult = Schema.Union([
  McpApplied,
  McpStale,
  McpDestroyed,
  McpReloaded,
  ...McpHostFailure.members,
]);

export type McpApplyResult = typeof McpApplyResult.Type;

/** A failure under a tag this build does not know, as it crosses the edge: its tag, and a message if it has one. */
const OtherHostFailureFromWire = Schema.Struct({
  _tag: Schema.String,
  message: Schema.optionalKey(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.toType(HostFailed),
    SchemaTransformation.transform({
      decode: ({ _tag, message }) =>
        HostFailed.make({
          message:
            message ?? `The MCP host answered with something this build does not know (${_tag})`,
          tag: _tag,
        }),
      // The wire shape: the tag it came with, or `HostFailed` when it had none of its own.
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- the encoded side is a plain wire object
      encode: ({ message, tag }) => ({ _tag: tag ?? "HostFailed", message }),
    }),
  ),
);

/**
 * `McpApplyResult` as it crosses the edge: a tag this build does not know reads as `HostFailed`, never as a decode
 * error (`docs/architecture/mcp.md` → Deploys). A known tag whose fields do not fit reads as `HostFailed` as well.
 */
export const McpApplyResultWire = Schema.Union([
  ...McpApplyResult.members,
  OtherHostFailureFromWire,
]);

export type McpApplyResultWire = typeof McpApplyResultWire.Type;

const decodeApplyResult = Schema.decodeUnknownOption(McpApplyResultWire);

/**
 * `answer`, an `apply` answer as it crossed the edge, as a result this build knows. Anything that is no result at all
 * reads as `HostFailed` too.
 */
export const readMcpApplyResult = (answer: Schema.Json): McpApplyResult =>
  Option.getOrElse(decodeApplyResult(answer), () =>
    HostFailed.make({ message: "The MCP host answered with something that is no result" }),
  );

/**
 * The features the host lists at `requestStart`: a Session uses one only once it is listed (`mcp.md` → Deploys).
 * `inventory`: `requestStart` answers the MCP inventory's versions and servers and takes `known`, `waitFor` and
 * `waitMs`, and the host answers `servers` and `apply({ kind: "reload" })`.
 */
export const MCP_HOST_FEATURES: ReadonlyArray<string> = ["inventory"];

/** The Session that asks, as `requestStart` marks its conversation active. */
export const McpCaller = Schema.Struct({
  session: Schema.String,
  conversation: Schema.String,
  workspace: Schema.String,
});

export type McpCaller = typeof McpCaller.Type;

/** The longest `requestStart` and `servers` wait for a discovery: 10 s (`docs/architecture/mcp-connections.md` → Discovery). */
export const MCP_MAX_WAIT_MS = 10_000;

/** `requestStart`'s arguments (`docs/architecture/mcp-connections.md` → RPC). */
export const McpRequestStart = Schema.Struct({
  caller: McpCaller,
  /** Set on a Context Window's first request: the host asks the Registry for the set, so a lost push heals. */
  windowOpened: Schema.optionalKey(Schema.Boolean),
  /**
   * The inventory's `version` the caller built its tools from; absent before its first build. Only a caller with none
   * waits (`waitFor`): a Session's first request.
   */
  known: Schema.optionalKey(Schema.String),
  /**
   * The servers, by name, worth waiting for: the caller's own pick, those whose Exposure can yield `direct` tools. The
   * host waits only for those with no inventory yet, and stops waiting for one once it settles (any state but
   * `connecting`).
   */
  waitFor: Schema.String.pipe(Schema.Array, Schema.optionalKey),
  /** How long to wait for them, at most `MCP_MAX_WAIT_MS` (10 s, also the default). */
  waitMs: Schema.optionalKey(Schema.Finite),
});

export type McpRequestStart = typeof McpRequestStart.Type;

/**
 * A server's state in the MCP inventory (`docs/architecture/mcp-connections.md` → Discovery and the MCP inventory):
 *
 * - `not_discovered`: in the set, never asked yet (an HTTP server waits for its first demand once the host is idle);
 * - `connecting`: being discovered;
 * - `connected`: discovered; its inventory is current or being refreshed;
 * - `sign_in`: the server wants an MCP sign-in; `rejected`: it refused the token it was given, twice;
 * - `unavailable`: unreachable for now, retried on demand after a backoff;
 * - `failed`: broken until a set change, a reload or a call retries it;
 * - `skipped`: not connected, as its definition cannot be used yet (a `${NAME}` that resolves to nothing, a stdio
 *   server before the bridge);
 * - `disabled`: switched off, or `hidden` by its own `exposure`; its inventory is kept.
 *
 * `unknown` is the fallback: a state a newer build stored or sent reads as it, which reads as `failed`.
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

export const McpServerState = Schema.Literals(MCP_SERVER_STATES);

export type McpServerState = typeof McpServerState.Type;

const isServerState = Schema.is(McpServerState);

/** `raw`, a state as stored or sent, as one this build knows: `unknown` for any other. */
export const readMcpServerState = (raw: string): McpServerState =>
  isServerState(raw) ? raw : "unknown";

/** One server as `requestStart` reports it. `state` reads as `unknown` where this build does not know it. */
export const McpServerReport = Schema.Struct({
  toolsHash: Schema.String,
  promptsHash: Schema.String,
  state: Schema.String,
});

export type McpServerReport = typeof McpServerReport.Type;

/** `requestStart`'s answer (`docs/architecture/mcp-in-a-session.md` → The `mcp` extension). */
export const McpRequestStartAnswer = Schema.Struct({
  version: Schema.String,
  promptsVersion: Schema.String,
  features: Schema.Array(Schema.String),
  servers: Schema.Record(Schema.String, McpServerReport),
  watches: Schema.Struct({
    changed: Schema.Array(Schema.String),
    ended: Schema.Array(Schema.String),
  }),
});

export type McpRequestStartAnswer = typeof McpRequestStartAnswer.Type;

/**
 * What `requestStart` answers: its answer, or `HostFailed` when the host could not read what it holds (a replaced
 * instance whose storage is refused), never an empty inventory that would read as no servers.
 */
export const McpRequestStartResult = Schema.Union([McpRequestStartAnswer, HostFailed]);

export type McpRequestStartResult = typeof McpRequestStartResult.Type;

/**
 * `servers`' arguments (`docs/architecture/mcp-connections.md` → RPC): the servers by name (every one when absent),
 * the parts to add (a part this build does not know is left out), how long to wait for one being discovered, and the
 * caller's Workspace. It never starts a Container.
 */
export const McpServersRequest = Schema.Struct({
  names: Schema.String.pipe(Schema.Array, Schema.optionalKey),
  parts: Schema.Array(Schema.String),
  waitMs: Schema.optionalKey(Schema.Finite),
  workspace: Schema.optionalKey(Schema.String),
});

export type McpServersRequest = typeof McpServersRequest.Type;

/**
 * A problem found at discovery: a tool's (`tool`), a prompt's (`prompt`), or the server's own (neither), such as the
 * tools past its bound.
 */
export const McpInventoryProblem = Schema.Struct({
  tool: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  problem: Schema.String,
});

export type McpInventoryProblem = typeof McpInventoryProblem.Type;

/** A server's status beyond its state: since when, the failures in a row, and when it may be retried. */
export const McpServerStatus = Schema.Struct({
  since: Schema.Finite,
  failures: Schema.Int,
  nextRetryAt: Schema.optionalKey(Schema.Finite),
  lastOkAt: Schema.optionalKey(Schema.Finite),
});

export type McpServerStatus = typeof McpServerStatus.Type;

const JsonRecord = Schema.Record(Schema.String, Schema.Json);

/** One server as `servers` answers it: always its config, state and counts, and the parts asked for. */
export const McpServerInventory = Schema.Struct({
  name: Schema.String,
  source: McpSetSource,
  /** The entry in force, `${NAME}` unresolved. */
  server: JsonRecord,
  conn: Schema.String,
  state: Schema.String,
  error: Schema.optionalKey(Schema.String),
  protocolVersion: Schema.optionalKey(Schema.String),
  discoveredAt: Schema.optionalKey(Schema.Finite),
  /** Where it was discovered: absent for an HTTP server, the Workspace for a stdio one. */
  discoveredIn: Schema.optionalKey(Schema.String),
  toolsHash: Schema.String,
  promptsHash: Schema.String,
  counts: Schema.Struct({ tools: Schema.Int, prompts: Schema.Int }),
  /** Whether the server offers resources. */
  resources: Schema.Boolean,
  problems: Schema.Array(McpInventoryProblem),
  /** The `tools` part: the tools a Session registers, bounds applied. */
  tools: JsonRecord.pipe(Schema.Array, Schema.optionalKey),
  prompts: JsonRecord.pipe(Schema.Array, Schema.optionalKey),
  instructions: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(McpServerStatus),
});

export type McpServerInventory = typeof McpServerInventory.Type;

/** `servers`' answer: the inventory's versions, and the servers asked for, in the set's order. */
export const McpServersAnswer = Schema.Struct({
  version: Schema.String,
  promptsVersion: Schema.String,
  servers: Schema.Array(McpServerInventory),
});

export type McpServersAnswer = typeof McpServersAnswer.Type;

/** What `servers` answers: its answer, or `HostFailed` when the host could not read what it holds. */
export const McpServersResult = Schema.Union([McpServersAnswer, HostFailed]);

export type McpServersResult = typeof McpServersResult.Type;

/**
 * `serverLog`'s arguments (`docs/architecture/mcp-connections.md` → Telemetry): the server by name, and the Workspace
 * whose stdio server's stderr tail is wanted. It reads what the host holds and never starts a Container.
 */
export const McpServerLogRequest = Schema.Struct({
  server: Schema.String,
  workspace: Schema.optionalKey(Schema.String),
});

export type McpServerLogRequest = typeof McpServerLogRequest.Type;

/**
 * A server's log ring: the last `MCP_LOG_RING` entries the host kept, oldest first. `stderr` is a stdio server's
 * stderr tail from the bridge's status (`start: false`), which comes with the bridge's first user; absent until then.
 */
export const McpServerLog = Schema.TaggedStruct("ServerLog", {
  entries: Schema.Array(McpLogEntry),
  stderr: Schema.optionalKey(Schema.String),
});

export type McpServerLog = typeof McpServerLog.Type;

/** The host's set has no server by that name. */
export const McpNoServer = Schema.TaggedStruct("NoServer", {});

export type McpNoServer = typeof McpNoServer.Type;

/** What `serverLog` answers: the ring, that there is no such server, or `HostFailed` when the host could not read it. */
export const McpServerLogResult = Schema.Union([McpServerLog, McpNoServer, HostFailed]);

export type McpServerLogResult = typeof McpServerLogResult.Type;

/**
 * The Registry's answer to the host's `mcpServerSet({ environment, heldHash })` (`docs/architecture/mcp-configuration.md`
 * → From the Registry to the host): the current set's hash, and the set itself unless it is the one held.
 */
export const McpServerSetAnswer = Schema.Struct({
  hash: Schema.String,
  /** Bumped by an MCP sign-in, sign-out or rebind (`docs/architecture/mcp-sign-in.md`); 0 until sign-ins exist. */
  signInsRevision: Schema.Int,
  set: McpSetEntry.pipe(Schema.Array, Schema.optionalKey),
  /**
   * Its place in the Registry's order of the sets it hands out (`McpApplySet.revision`), for the set when it comes and
   * otherwise for the hash the host holds, which the Registry noted as handed under it. Absent for an Environment the
   * Registry does not list.
   */
  revision: Schema.optionalKey(Schema.Int),
});

export type McpServerSetAnswer = typeof McpServerSetAnswer.Type;

/** What the Registry hands the main Worker to push: an Environment's set whose hash the host was last told differently. */
export const McpPush = Schema.Struct({
  environment: Schema.String,
  set: McpApplySet,
});

export type McpPush = typeof McpPush.Type;

/** A deleted Environment whose host is to be wiped, with the revision the deletion was given. */
export const McpWipe = Schema.Struct({
  environment: Schema.String,
  revision: Schema.Int,
});

export type McpWipe = typeof McpWipe.Type;

/**
 * What the Registry hands the main Worker at a sync: the sets to push, and every deleted Environment whose host is yet
 * to be wiped (`apply({ kind: "destroy" })`), whatever Environment the sync was for.
 */
export const McpPending = Schema.Struct({
  pushes: Schema.Array(McpPush),
  wipes: Schema.Array(McpWipe),
});

export type McpPending = typeof McpPending.Type;

/**
 * The Registry's answer to the host's `mcpServerValues({ environment, server, conn })`: the entry's `env` and `headers`
 * with every `${NAME}` resolved (Secrets, then Variables; a Repo's entries read Variables only), and the names that
 * resolved to nothing. The host keeps them in memory only. `status` this build does not know reads as a failure.
 */
export const McpServerValuesAnswer = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("values"),
    env: Schema.Record(Schema.String, Schema.String),
    headers: Schema.Record(Schema.String, Schema.String),
    missing: Schema.Array(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal("unknown_server") }),
  Schema.Struct({ status: Schema.Literal("server_changed"), conn: Schema.String }),
  Schema.Struct({ status: Schema.String }),
]);

export type McpServerValuesAnswer = typeof McpServerValuesAnswer.Type;
