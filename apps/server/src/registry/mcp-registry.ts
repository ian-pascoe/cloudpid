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
import {
  type McpPending,
  type McpPush,
  type McpServerSetAnswer,
  type McpServerValuesAnswer,
  McpSetRevision,
  McpWipe,
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
import { signInsRevisionOf } from "./mcp-sign-ins.ts";
import { resolveMcpServerValues } from "./mcp-values.ts";
import { type DocumentStore, mcpLayersOf } from "./settings.ts";
import type { RegistryStore } from "./store.ts";

/** The name of the document that keeps what each Environment's host was last handed, and the revision counter. */
export const MCP_HANDED_DOCUMENT = "mcp-handed";

/** The store as the MCP set reads it: the Settings at both Scopes, and the Environments. */
export type McpSetStore = DocumentStore &
  Pick<RegistryStore, "getSettingsOverrides" | "listEnvironments" | "getEnvironmentSettings">;

/** `environment`'s MCP server set, without its revision, or null when it is not registered. */
export const environmentMcpSet = (
  store: McpSetStore,
  environment: string,
): McpSetContent | null => {
  const overrides = store.getSettingsOverrides(environment);

  return overrides === null ? null : mcpServerSetOf(mcpLayersOf(store, overrides));
};

/** The store as one Environment's servers are resolved from it: Global's document and the Environment's Overrides. */
export type ResolvedServersStore = DocumentStore & Pick<RegistryStore, "getSettingsOverrides">;

/** The servers of `environment`'s set as `resolveMcpServerSet` resolves them, or null when it is not registered. */
export const environmentResolvedServers = (
  store: ResolvedServersStore,
  environment: string,
): ReadonlyArray<McpResolvedServer> | null => {
  const overrides = store.getSettingsOverrides(environment);

  return overrides === null ? null : resolvedMcpServers(mcpLayersOf(store, overrides));
};

/** The server `name` of `environment`'s set as it resolves, for its values and its sign-in. */
export const resolvedServer = (
  store: ResolvedServersStore,
  environment: string,
  name: string,
): McpResolvedServer | undefined =>
  Arr.findFirst(
    environmentResolvedServers(store, environment) ?? [],
    (resolved) => resolved.name === name,
  ).pipe(Option.getOrUndefined);

/** What the Registry knows of the hosts' sets: what each was last handed, the revisions given out, the wipes to send. */
const Handed = Schema.Struct({
  /** The last revision given out, to a set or a deletion: the next gets one more. */
  lastRevision: Schema.Int,
  /** The hash and revision each registered Environment's host was last handed. */
  handed: Schema.Record(Schema.String, McpSetRevision),
  /** The deleted Environments whose host the main Worker has not wiped yet. */
  wipes: Schema.Array(McpWipe),
});

type Handed = typeof Handed.Type;

const decodeHanded = Schema.decodeUnknownOption(Schema.fromJsonString(Handed));

const NOTHING_HANDED: Handed = { lastRevision: 0, handed: {}, wipes: [] };

const readHanded = (store: DocumentStore): Handed =>
  Option.getOrElse(
    Option.flatMap(Option.fromNullishOr(store.getDocument(MCP_HANDED_DOCUMENT)), decodeHanded),
    () => NOTHING_HANDED,
  );

/**
 * Whether the document exists but cannot be read, so that its counter starts again from 0: hosts holding later
 * revisions then answer `Stale` to what is pushed until the counter passes them, which nothing else shows.
 */
export const mcpHandedUnreadable = (store: DocumentStore): boolean => {
  const body = store.getDocument(MCP_HANDED_DOCUMENT);

  return body !== null && Option.isNone(decodeHanded(body));
};

const writeHanded = (store: DocumentStore, handed: Handed, now: number): void =>
  store.putDocument(MCP_HANDED_DOCUMENT, JSON.stringify(handed), now);

/** The Environments of `handed` that are in `known`: a deleted one's record goes with the next write. */
const registered = (known: ReadonlySet<string>, handed: Handed["handed"]): Handed["handed"] =>
  Record.filter(handed, (_, id) => known.has(id));

/** The ids of the registered Environments. */
const registeredIds = (store: Pick<RegistryStore, "listEnvironments">): ReadonlySet<string> =>
  new Set(Arr.map(store.listEnvironments(), ({ id }) => id));

/**
 * The answer to the host's `mcpServerSet({ environment, heldHash })`: the current hash with a new revision, and the set
 * unless the host holds it (a host that holds none holds the empty set). The hash and revision are noted as handed to
 * the host, held set or not: a later change is pushed to it even when no push was ever made or answered, and a push
 * handed out before is outranked. An Environment the Registry does not list gets no revision and no set (it has no host
 * to fill: a deleted one's is wiped).
 */
export const mcpServerSetAnswer = (
  store: McpSetStore,
  input: { readonly environment: string; readonly heldHash?: string | undefined },
  now: number,
): McpServerSetAnswer => {
  const known = environmentMcpSet(store, input.environment);

  const signInsRevision = signInsRevisionOf(store);

  if (known === null) return { hash: EMPTY_MCP_SET_HASH, signInsRevision };

  const state = readHanded(store);
  const revision = state.lastRevision + 1;

  writeHanded(
    store,
    {
      ...state,
      lastRevision: revision,
      handed: {
        ...registered(registeredIds(store), state.handed),
        [input.environment]: { hash: known.hash, revision },
      },
    },
    now,
  );

  const answer: McpServerSetAnswer = { hash: known.hash, signInsRevision, revision };

  return known.hash === (input.heldHash ?? EMPTY_MCP_SET_HASH)
    ? answer
    : { ...answer, set: known.entries };
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
 * every deleted Environment's host still to be wiped, whatever Environment the sync is for, so any sync retries a wipe
 * that was lost. A revision is given out here and recorded only when the push is answered (`mcpPushed`).
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
    const handed = Record.get(state.handed, id).pipe(Option.map(({ hash }) => hash));

    return set !== null && shouldPushMcpSet(Option.getOrUndefined(handed), set.hash)
      ? Result.succeed({ environment: id, set })
      : Result.failVoid;
  });

  const pushes = Arr.map(due, ({ environment: id, set }, index): McpPush => ({
    environment: id,
    set: { ...set, revision: state.lastRevision + 1 + index },
  }));

  if (pushes.length > 0) {
    writeHanded(store, { ...state, lastRevision: state.lastRevision + pushes.length }, now);
  }

  return { pushes, wipes: state.wipes };
};

/**
 * Note that the host of `environment` took the set with `hash` at `revision`. A revision older than the one noted (a
 * later pull was answered meanwhile) changes nothing, nor does one for an Environment that is gone.
 */
export const recordMcpPushed = (
  store: DocumentStore & Pick<RegistryStore, "listEnvironments">,
  input: McpSetRevision & { readonly environment: string },
  now: number,
): void => {
  const known = registeredIds(store);

  if (!known.has(input.environment)) return;

  const state = readHanded(store);
  const handed = registered(known, state.handed);
  const recorded = Record.get(handed, input.environment);

  if (Option.isSome(recorded) && recorded.value.revision > input.revision) return;

  writeHanded(
    store,
    {
      ...state,
      lastRevision: Math.max(state.lastRevision, input.revision),
      handed: { ...handed, [input.environment]: { hash: input.hash, revision: input.revision } },
    },
    now,
  );
};

/**
 * Note that `environment` was deleted, so the next sync, whatever it is for, wipes its host, under a revision above
 * every set handed out so far. A host that was never handed a set is not woken just to be wiped: it holds nothing.
 */
export const recordMcpDeleted = (store: DocumentStore, environment: string, now: number): void => {
  const state = readHanded(store);

  if (Option.isNone(Record.get(state.handed, environment))) return;

  const revision = state.lastRevision + 1;

  writeHanded(
    store,
    {
      lastRevision: revision,
      handed: Record.remove(state.handed, environment),
      wipes: Arr.append(
        Arr.filter(state.wipes, (wipe) => wipe.environment !== environment),
        { environment, revision },
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

  if (!Arr.some(state.wipes, (wipe) => wipe.environment === environment)) return;

  writeHanded(
    store,
    { ...state, wipes: Arr.filter(state.wipes, (wipe) => wipe.environment !== environment) },
    now,
  );
};
