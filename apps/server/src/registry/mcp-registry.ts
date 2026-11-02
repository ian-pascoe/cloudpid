// What the Registry does with an Environment's MCP server set (`docs/architecture/mcp-configuration.md` → From the
// Registry to the host): answers the host's pull (`mcpServerSet`) and its `${NAME}` values, and says which Environments
// the main Worker must push to or wipe, remembering what each host was last handed (a set it was pushed, `mcpPushed`,
// or answered to its pull) so a push that failed is made again with the next one. The Registry never calls out: the
// main Worker carries the set to `McpHost.apply`.
//
// Every set handed out has a `revision` from one counter, which only rises; the host refuses a set older than the one
// it holds, and `mcpPushed` ignores a revision older than the one recorded, so a push that arrives late (or twice)
// never brings back an older set.
//
// The set is computed from the layers each time, never stored: the Settings (Global's and the Environment's) are the
// source, and the Repo layers (`.pi/mcp.json`, #468) join them when the Registry keeps them.
// @effect-diagnostics missingPipeableSignature:off -- store operations, not combinators.
import { mcpConnectionKey, type McpResolvedServer } from "@cloudpid/config";
import type {
  McpPending,
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
import {
  EMPTY_MCP_SET_HASH,
  type McpSetContent,
  mcpServerSetOf,
  resolvedMcpServers,
  shouldPushMcpSet,
} from "./mcp-set.ts";
import { resolveMcpServerValues } from "./mcp-values.ts";
import { type DocumentStore, mcpLayersOf } from "./settings.ts";
import type { RegistryStore } from "./store.ts";

/** The name of the document that keeps what each Environment's host was last handed, and the revision counter. */
export const MCP_HANDED_DOCUMENT = "mcp-handed";

/** The store as the MCP set reads it: the Settings at both Scopes, and the Environments. */
export type McpSetStore = DocumentStore &
  Pick<RegistryStore, "getSettingsOverrides" | "listEnvironments" | "getEnvironmentSettings">;

const NO_SERVERS: McpSetContent = { kind: "set", hash: EMPTY_MCP_SET_HASH, entries: [] };

/** `environment`'s MCP server set, without its revision, or null when it is not registered. */
export const environmentMcpSet = (
  store: McpSetStore,
  environment: string,
): McpSetContent | null => {
  const overrides = store.getSettingsOverrides(environment);

  return overrides === null ? null : mcpServerSetOf(mcpLayersOf(store, overrides));
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
    resolvedMcpServers(mcpLayersOf(store, overrides)),
    (resolved) => resolved.name === name,
  ).pipe(Option.getOrUndefined);
};

/** What the Registry knows of a host's set: the hash and revision it was last handed, by Environment. */
const Handed = Schema.Struct({
  /** The last revision given out: the next set gets one more. */
  seq: Schema.Int,
  handed: Schema.Record(
    Schema.String,
    Schema.Struct({ hash: Schema.String, revision: Schema.Int }),
  ),
  /** The Environments deleted whose host the main Worker has not wiped yet. */
  destroy: Schema.Array(Schema.String),
});

type Handed = typeof Handed.Type;

const decodeHanded = Schema.decodeUnknownOption(Schema.fromJsonString(Handed));

const NOTHING_HANDED: Handed = { seq: 0, handed: {}, destroy: [] };

const readHanded = (store: DocumentStore): Handed =>
  Option.getOrElse(
    Option.flatMap(Option.fromNullishOr(store.getDocument(MCP_HANDED_DOCUMENT)), decodeHanded),
    () => NOTHING_HANDED,
  );

const writeHanded = (store: DocumentStore, handed: Handed, now: number): void =>
  store.putDocument(MCP_HANDED_DOCUMENT, JSON.stringify(handed), now);

/** The Environments of `handed` that are still registered: a deleted one's record goes with the next write. */
const registered = (
  store: Pick<RegistryStore, "listEnvironments">,
  handed: Handed["handed"],
): Handed["handed"] => {
  const known = new Set(Arr.map(store.listEnvironments(), ({ id }) => id));

  return Record.filter(handed, (_, id) => known.has(id));
};

/**
 * The answer to the host's `mcpServerSet({ environment, heldHash })`: the current hash, and the set with a new revision
 * unless the host holds it (a host that holds none holds the empty set). An Environment the Registry does not list has
 * no servers. A set handed out is recorded as the host's, so a later change is pushed to it even when no push of the
 * earlier set was ever made or answered.
 */
export const mcpServerSetAnswer = (
  store: McpSetStore,
  input: { readonly environment: string; readonly heldHash?: string | undefined },
  now: number,
): McpServerSetAnswer => {
  const known = environmentMcpSet(store, input.environment);
  const set = known ?? NO_SERVERS;
  const held = input.heldHash ?? EMPTY_MCP_SET_HASH;

  // No MCP sign-ins yet: the revision comes with them.
  const answer: McpServerSetAnswer = { hash: set.hash, signInsRevision: 0 };

  if (set.hash === held) return answer;

  const state = readHanded(store);
  const revision = state.seq + 1;

  writeHanded(
    store,
    {
      ...state,
      seq: revision,
      handed:
        known === null
          ? state.handed
          : {
              ...registered(store, state.handed),
              [input.environment]: { hash: set.hash, revision },
            },
    },
    now,
  );

  return { ...answer, set: set.entries, revision };
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

/**
 * What the main Worker is to do at a sync: the sets to push, by Environment (`environment`'s, all Environments' when
 * undefined) whose hash differs from what its host was last handed (`shouldPushMcpSet`), each with a new revision; and
 * the deleted Environments whose host is to be wiped. A revision is given out here and recorded only when the push is
 * answered (`mcpPushed`).
 */
export const pendingMcpPushes = (
  store: McpSetStore,
  environment: string | undefined,
  now: number,
): McpPending => {
  const state = readHanded(store);

  const environments =
    environment === undefined ? Arr.map(store.listEnvironments(), ({ id }) => id) : [environment];

  const due = Arr.filterMap(environments, (id) => {
    const set = environmentMcpSet(store, id);

    return set !== null &&
      shouldPushMcpSet(
        Record.get(state.handed, id).pipe(
          Option.map(({ hash }) => hash),
          Option.getOrUndefined,
        ),
        set.hash,
      )
      ? Result.succeed({ environment: id, set })
      : Result.failVoid;
  });

  const pushes = Arr.map(due, ({ environment: id, set }, index): McpPush => ({
    environment: id,
    set: { ...set, revision: state.seq + 1 + index },
  }));

  const destroys = Arr.filter(
    state.destroy,
    (id) => environment === undefined || id === environment,
  );

  if (pushes.length > 0) writeHanded(store, { ...state, seq: state.seq + pushes.length }, now);

  return { pushes, destroys };
};

/**
 * Note that the host of `environment` took the set with `hash` at `revision`. A revision older than the one noted (a
 * later pull was answered meanwhile) changes nothing, nor does one for an Environment that is gone.
 */
export const recordMcpPushed = (
  store: DocumentStore & Pick<RegistryStore, "listEnvironments">,
  input: { readonly environment: string; readonly hash: string; readonly revision: number },
  now: number,
): void => {
  const state = readHanded(store);
  const known = registered(store, state.handed);
  const recorded = Record.get(known, input.environment);

  if (
    !Arr.some(store.listEnvironments(), ({ id }) => id === input.environment) ||
    (Option.isSome(recorded) && recorded.value.revision > input.revision)
  ) {
    return;
  }

  writeHanded(
    store,
    {
      ...state,
      seq: Math.max(state.seq, input.revision),
      handed: { ...known, [input.environment]: { hash: input.hash, revision: input.revision } },
    },
    now,
  );
};

/**
 * Note that `environment` was deleted, so the next sync wipes its host. A host that was never handed a set is not
 * woken just to be wiped: it holds nothing.
 */
export const recordMcpDeleted = (store: DocumentStore, environment: string, now: number): void => {
  const state = readHanded(store);

  if (Option.isNone(Record.get(state.handed, environment))) return;

  writeHanded(
    store,
    {
      ...state,
      handed: Record.remove(state.handed, environment),
      destroy: Arr.append(
        Arr.filter(state.destroy, (id) => id !== environment),
        environment,
      ),
    },
    now,
  );
};

/** Note that the host of `environment` was wiped. */
export const recordMcpDestroyed = (
  store: DocumentStore,
  environment: string,
  now: number,
): void => {
  const state = readHanded(store);

  if (!Arr.contains(state.destroy, environment)) return;

  writeHanded(
    store,
    { ...state, destroy: Arr.filter(state.destroy, (id) => id !== environment) },
    now,
  );
};
