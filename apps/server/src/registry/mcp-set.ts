// The MCP server set the Registry hands an Environment's `McpHost` (`docs/architecture/mcp-configuration.md` → From the
// Registry to the host), and the decision to push it, both pure so they are tested without a Durable Object.
//
// The set is `resolveMcpServerSet`'s servers (Global's, the Environment's, each Repo's), each with its entry in force,
// `${NAME}` unresolved, and three hashes: the entry's, the connection key `conn` and `mcpServerIdentity`. The whole set
// has a hash over its entries' names and hashes in order. No hash covers a resolved value: nothing here reads a Secret
// or a Variable (`./mcp-values.ts` resolves them, at use, and nothing keeps the result).
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
import {
  mcpConnectionKey,
  type McpRepoLayer,
  type McpResolvedServer,
  type McpSource,
  mcpServerIdentity,
  resolveMcpServerSet,
  sha256Hex,
  sortedJson,
} from "@cloudpid/config";
import type { McpApplySet, McpSetEntry, McpSetSource } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";

/** The layers an Environment's set is resolved from: the Global document and the Environment's Overrides, as saved. */
export type McpSetLayers = {
  readonly global: Schema.Json;
  readonly overrides: Schema.Json;
  /** Each Repo's `.pi/mcp.json` as the Registry last read it, in the Environment's Repo order (none until #468). */
  readonly repos: ReadonlyArray<McpRepoLayer>;
};

const hashEntries = (entries: ReadonlyArray<Pick<McpSetEntry, "name" | "hash">>): string =>
  sha256Hex(JSON.stringify(Arr.map(entries, ({ name, hash }) => [name, hash])));

/** The hash of the set with no servers. */
export const EMPTY_MCP_SET_HASH: string = hashEntries([]);

// @effect-diagnostics-next-line schemaSync:off -- pure and synchronous, as the Registry hashes inside a transaction; it reads what it just wrote.
const decodeEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

const setSource = (source: McpSource): McpSetSource => source;

/** `server` as plain JSON: the keys an entry in force leaves undefined are not there. */
const entryJson = (server: McpResolvedServer["server"]): Readonly<Record<string, Schema.Json>> =>
  decodeEntry(JSON.stringify(server));

const setEntry = (resolved: McpResolvedServer): McpSetEntry => {
  const source = setSource(resolved.source);
  const server = entryJson(resolved.server);

  return {
    name: resolved.name,
    source,
    server,
    hash: sha256Hex(JSON.stringify(sortedJson({ name: resolved.name, source, server }))),
    conn: mcpConnectionKey(resolved),
    identity: mcpServerIdentity(resolved),
  };
};

/**
 * The MCP server set of an Environment from its layers, as `apply({ kind: "set" })` takes it: every server of
 * `resolveMcpServerSet`, switched off ones included (the host keeps their inventory), with the hash of the whole.
 */
export const mcpServerSetOf = (layers: McpSetLayers): McpApplySet => {
  const entries = Arr.map(
    resolveMcpServerSet(layers.global, layers.overrides, layers.repos).servers,
    setEntry,
  );

  return { kind: "set", hash: hashEntries(entries), entries };
};

/**
 * Whether the host must be told the set `current`, when it was last told `handed` (undefined: never). It is told when
 * the hash changed, and an empty set only after a non-empty one: an Environment that never had a server is never
 * pushed to, so its host is never woken (`docs/architecture/mcp-connections.md` → The host object).
 */
export const shouldPushMcpSet = (handed: string | undefined, current: string): boolean =>
  current !== (handed ?? EMPTY_MCP_SET_HASH);

/** How many MCP servers the set of `layers` has, for `sessionSettings`: a Session with none never wakes its host. */
export const mcpServerCountOf = (layers: McpSetLayers): number =>
  resolveMcpServerSet(layers.global, layers.overrides, layers.repos).servers.length;
