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

/** `apply({ kind: "destroy" })`: an Environment was deleted; the host wipes its storage. */
export const McpApplyDestroy = Schema.Struct({ kind: Schema.Literal("destroy") });

export type McpApplyDestroy = typeof McpApplyDestroy.Type;

/** What `apply` takes. The other kinds (`sign_ins`, `reload`, `end_watches`) are added by their slices. */
export const McpApply = Schema.Union([McpApplySet, McpApplyDestroy]);

export type McpApply = typeof McpApply.Type;

/** The set was taken: its hash, and whether it differs from the one the host held. */
export const McpApplied = Schema.TaggedStruct("Applied", {
  hash: Schema.String,
  changed: Schema.Boolean,
});

export type McpApplied = typeof McpApplied.Type;

/** The set was refused as older than the one the host holds (`revision`), which it kept. */
export const McpStale = Schema.TaggedStruct("Stale", {
  hash: Schema.String,
  revision: Schema.Int,
});

export type McpStale = typeof McpStale.Type;

/** The host's storage was wiped (`apply({ kind: "destroy" })`). */
export const McpDestroyed = Schema.TaggedStruct("Destroyed", {});

export type McpDestroyed = typeof McpDestroyed.Type;

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

/** What `apply` answers: the set was taken or refused as stale, the storage wiped, or why not. */
export const McpApplyResult = Schema.Union([
  McpApplied,
  McpStale,
  McpDestroyed,
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

/** The features the host lists at `requestStart`: a Session uses one only once it is listed (`mcp.md` → Deploys). */
export const MCP_HOST_FEATURES: ReadonlyArray<string> = [];

/** The Session that asks, as `requestStart` marks its conversation active. */
export const McpCaller = Schema.Struct({
  session: Schema.String,
  conversation: Schema.String,
  workspace: Schema.String,
});

export type McpCaller = typeof McpCaller.Type;

/**
 * `requestStart`'s arguments (`docs/architecture/mcp-connections.md` → RPC). `known`, `waitFor` and `waitMs` come with
 * the inventory (#449).
 */
export const McpRequestStart = Schema.Struct({
  caller: McpCaller,
  /** Set on a Context Window's first request: the host asks the Registry for the set, so a lost push heals. */
  windowOpened: Schema.optionalKey(Schema.Boolean),
});

export type McpRequestStart = typeof McpRequestStart.Type;

/** One server as `requestStart` reports it. `state` reads as a failure where this build does not know it. */
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
 * The Registry's answer to the host's `mcpServerSet({ environment, heldHash })` (`docs/architecture/mcp-configuration.md`
 * → From the Registry to the host): the current set's hash, and the set itself unless it is the one held.
 */
export const McpServerSetAnswer = Schema.Struct({
  hash: Schema.String,
  /** Bumped by an MCP sign-in, sign-out or rebind (`docs/architecture/mcp-sign-in.md`); 0 until sign-ins exist. */
  signInsRevision: Schema.Int,
  set: McpSetEntry.pipe(Schema.Array, Schema.optionalKey),
  /** With `set`: its place in the Registry's order of the sets it hands out (`McpApplySet.revision`). */
  revision: Schema.optionalKey(Schema.Int),
});

export type McpServerSetAnswer = typeof McpServerSetAnswer.Type;

/** What the Registry hands the main Worker to push: an Environment's set whose hash the host was last told differently. */
export const McpPush = Schema.Struct({
  environment: Schema.String,
  set: McpApplySet,
});

export type McpPush = typeof McpPush.Type;

/**
 * What the Registry hands the main Worker at a sync: the sets to push, and the Environments deleted since whose host
 * must be wiped (`apply({ kind: "destroy" })`).
 */
export const McpPending = Schema.Struct({
  pushes: Schema.Array(McpPush),
  destroys: Schema.Array(Schema.String),
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
