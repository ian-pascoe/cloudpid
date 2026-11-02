// What the Registry does with an Environment's MCP server set (`docs/architecture/mcp-configuration.md` → From the
// Registry to the host): answers the host's pull (`mcpServerSet`) and its `${NAME}` values, and says which Environments
// the main Worker must push to, remembering what each host was last told (`mcpPushed`) so a push that failed is made
// again with the next one. The Registry never calls out: the main Worker carries the set to `McpHost.apply`.
//
// The set is computed from the layers each time, never stored: the Settings (Global's and the Environment's) are the
// source, and the Repo layers (`.pi/mcp.json`, #468) join them when the Registry keeps them.
// @effect-diagnostics missingPipeableSignature:off -- store operations, not combinators.
import { mcpConnectionKey, type McpResolvedServer, resolveMcpServerSet } from "@cloudpid/config";
import type {
  McpApplySet,
  McpPush,
  McpServerSetAnswer,
  McpServerValuesAnswer,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { environmentSettingsOf } from "./global.ts";
import { EMPTY_MCP_SET_HASH, mcpServerSetOf, shouldPushMcpSet } from "./mcp-set.ts";
import { resolveMcpServerValues } from "./mcp-values.ts";
import { type DocumentStore, savedGlobalSettings } from "./settings.ts";
import type { RegistryStore } from "./store.ts";

/** The name of the document that keeps the hash of the set each Environment's host was last told. */
export const MCP_HANDED_DOCUMENT = "mcp-handed";

/** The store as the MCP set reads it: the Settings at both Scopes, and the Environments. */
export type McpSetStore = DocumentStore &
  Pick<RegistryStore, "getSettingsOverrides" | "listEnvironments" | "getEnvironmentSettings">;

const NO_SERVERS: McpApplySet = { kind: "set", hash: EMPTY_MCP_SET_HASH, entries: [] };

/** `environment`'s MCP server set, or null when it is not registered. */
export const environmentMcpSet = (store: McpSetStore, environment: string): McpApplySet | null => {
  const overrides = store.getSettingsOverrides(environment);

  return overrides === null
    ? null
    : mcpServerSetOf({ global: savedGlobalSettings(store), overrides, repos: [] });
};

/** The servers of `environment`'s set as `resolveMcpServerSet` resolves them, for the values of one. */
const resolvedServer = (
  store: McpSetStore,
  environment: string,
  name: string,
): McpResolvedServer | undefined => {
  const overrides = store.getSettingsOverrides(environment);

  if (overrides === null) return undefined;

  return Arr.findFirst(
    resolveMcpServerSet(savedGlobalSettings(store), overrides, []).servers,
    (resolved) => resolved.name === name,
  ).pipe(Option.getOrUndefined);
};

/**
 * The answer to the host's `mcpServerSet({ environment, heldHash })`: the current hash, and the set unless the host
 * holds it (a host that holds none holds the empty set). An Environment the Registry does not list has no servers.
 */
export const mcpServerSetAnswer = (
  store: McpSetStore,
  input: { readonly environment: string; readonly heldHash?: string | undefined },
): McpServerSetAnswer => {
  const set = environmentMcpSet(store, input.environment) ?? NO_SERVERS;
  const held = input.heldHash ?? EMPTY_MCP_SET_HASH;

  // No MCP sign-ins yet: the revision comes with them.
  const answer: McpServerSetAnswer = { hash: set.hash, signInsRevision: 0 };

  return set.hash === held ? answer : { ...answer, set: set.entries };
};

/** The host's `mcpServerValues` arguments: the server by name, with the `conn` the host holds it under. */
export type McpValuesInput = {
  readonly environment: string;
  readonly server: string;
  readonly conn: string;
};

/**
 * The answer to the host's `mcpServerValues`: the entry's `env` and `headers` resolved against the Environment's
 * Secrets (`secrets`, opened by the caller only for an entry that may read them), then its Variables. A name no longer
 * in the set is `unknown_server`; one whose `conn` is no longer the host's is `server_changed`, with the current one.
 */
export const mcpServerValuesAnswer = (
  store: McpSetStore,
  input: McpValuesInput,
  secrets: Readonly<Record<string, string>>,
): McpServerValuesAnswer => {
  const resolved = resolvedServer(store, input.environment, input.server);

  if (resolved === undefined) return { status: "unknown_server" };

  const conn = mcpConnectionKey(resolved);

  if (conn !== input.conn) return { status: "server_changed", conn };

  const state = environmentSettingsOf(store, input.environment);

  return resolveMcpServerValues(resolved, {
    secrets,
    variables: state === null ? {} : state.settings.variables,
  });
};

/** Whether `server` of `environment` may read Secrets, for the caller to open them only then; false when it is gone. */
export const readsSecrets = (store: McpSetStore, environment: string, server: string): boolean =>
  resolvedServer(store, environment, server)?.resolvesSecrets ?? false;

const decodeHanded = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

/** The hash of the set each Environment's host was last told. */
const handedHashes = (store: DocumentStore): Readonly<Record<string, string>> =>
  Option.getOrElse(
    Option.flatMap(Option.fromNullishOr(store.getDocument(MCP_HANDED_DOCUMENT)), decodeHanded),
    () => ({}),
  );

/**
 * The sets to push, by Environment: those of `environment` (all Environments when undefined) whose hash differs from
 * what its host was last told (`shouldPushMcpSet`).
 */
export const pendingMcpPushes = (
  store: McpSetStore,
  environment: string | undefined,
): ReadonlyArray<McpPush> => {
  const handed = handedHashes(store);

  const environments =
    environment === undefined ? Arr.map(store.listEnvironments(), ({ id }) => id) : [environment];

  return Arr.filterMap(environments, (id) => {
    const set = environmentMcpSet(store, id);

    return set !== null &&
      shouldPushMcpSet(Record.get(handed, id).pipe(Option.getOrUndefined), set.hash)
      ? Result.succeed<McpPush>({ environment: id, set })
      : Result.failVoid;
  });
};

/** Note that the host of `environment` was told the set with `hash`. */
export const recordMcpPushed = (
  store: DocumentStore & Pick<RegistryStore, "listEnvironments">,
  environment: string,
  hash: string,
  now: number,
): void => {
  const known = new Set(Arr.map(store.listEnvironments(), ({ id }) => id));
  const kept = Record.filter(handedHashes(store), (_, id) => known.has(id) && id !== environment);

  store.putDocument(MCP_HANDED_DOCUMENT, JSON.stringify({ ...kept, [environment]: hash }), now);
};
