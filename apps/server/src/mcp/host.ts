// What `McpHost`'s methods do (`docs/architecture/mcp-connections.md` → The host object, RPC, Discovery and the MCP
// inventory): take the Environment's MCP server set, pull it from the Registry when a Context Window opens, discover
// its servers and answer the MCP inventory. Over `McpHostStore`, `McpRegistryPort`, `McpEngineClient` and the
// discoveries in flight, kept in one long-lived `ManagedRuntime` per object, so a workerd test drives them over real
// SQLite storage, a scripted Registry and a scripted engine; the Durable Object (`McpHost.ts`) only gives them the
// object's own.
//
// Every edge only gains (`docs/architecture/mcp.md` → Deploys): an operation this build does not know fails as
// `HostUnsupported`, and a failure is a value, never a thrown error.
// @effect-diagnostics missingPipeableSignature:off -- methods of the object, not combinators.
import {
  HostFailed,
  HostUnsupported,
  MCP_HOST_FEATURES,
  MCP_MAX_WAIT_MS,
  McpApplied,
  type McpApply,
  McpApplyDestroy,
  McpApplyReload,
  type McpApplyResult,
  McpApplySet,
  McpApplySignIns,
  McpDestroyed,
  McpNoServer,
  McpReloaded,
  type McpHostRequest,
  type McpHostRequestHooks,
  type McpHostRequestResult,
  type McpRequestStart,
  type McpRequestStartResult,
  McpServerLog,
  type McpServerLogRequest,
  type McpServerLogResult,
  type McpServerInventory,
  type McpServersRequest,
  type McpServersResult,
  McpSignInsTaken,
  McpStale,
  REDISCOVERING_CHANGES,
} from "@cloudpid/mcp/types";
import { normalizeMcpName } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import {
  awaitDiscoveries,
  interrupt,
  restartable,
  McpDiscovery,
  type McpDiscoveryServices,
  refreshVersions,
  reviveStale,
  startDue,
  writeOrHalt,
} from "./discovery.ts";
import { McpEngineClient, type McpEngineClientService } from "./engine.ts";
import { serverHashes } from "./inventory.ts";
import { McpLoadCaps } from "./limits.ts";
import { McpRegistryPort, type McpRegistryPortService } from "./registry-port.ts";
import { request } from "./request.ts";
import { type ServerView, type Trigger, viewServers } from "./server-state.ts";
import { McpProcessEnded, type McpProcessEndedHandler } from "./stdio.ts";
import { McpHostStore, type McpHostStoreService } from "./store.ts";
import { McpTokens } from "./tokens.ts";

export {
  McpRegistryPort,
  type McpRegistryPortService,
  McpRegistryUnavailable,
} from "./registry-port.ts";

/** What the host's methods run over: its storage, the Registry, the engine, its load caps and the discoveries in flight. */
export type McpHostServices = McpDiscoveryServices;

/**
 * The host's services over `store`, `registry` and `engine`, with a fresh set of discoveries; `references` sets the
 * runtime's own `Clock` and `Tracer` (the object's `Telemetry`, a test's clock).
 */
export const mcpHostLayer = (deps: {
  readonly store: McpHostStoreService;
  readonly registry: McpRegistryPortService;
  readonly engine: McpEngineClientService;
  /** What is done when a stdio server's child ended; nothing, until #478. */
  readonly processEnded?: McpProcessEndedHandler;
  readonly references?: Layer.Layer<never>;
}): Layer.Layer<McpHostServices> =>
  Layer.mergeAll(
    Layer.succeed(McpHostStore, deps.store),
    Layer.succeed(McpRegistryPort, deps.registry),
    Layer.succeed(McpEngineClient, deps.engine),
    McpTokens.layer.pipe(Layer.provide(Layer.succeed(McpRegistryPort, deps.registry))),
    McpDiscovery.layer,
    McpLoadCaps.layer,
    deps.processEnded === undefined
      ? McpProcessEnded.none
      : Layer.succeed(McpProcessEnded, deps.processEnded),
    deps.references ?? Layer.empty,
  );

const KindOnly = Schema.Struct({ kind: Schema.String });

const decodeKind = Schema.decodeUnknownOption(KindOnly);

const decodeSet = Schema.decodeUnknownOption(McpApplySet);

const decodeDestroy = Schema.decodeUnknownOption(McpApplyDestroy);

const decodeReload = Schema.decodeUnknownOption(McpApplyReload);

const decodeSignIns = Schema.decodeUnknownOption(McpApplySignIns);

const applied = (set: McpApplySet, changed: boolean): McpApplied =>
  McpApplied.make({ hash: set.hash, changed });

/**
 * Keep `set` as the Environment's set unless the host holds a later one: a set with a revision below the held one is
 * `Stale`, and the held set stays; so is any set no newer than the revision a wiped host was wiped at, which a push or
 * a pull answered after the wipe cannot fill again (`Stale` with no hash). The same hash under a newer revision only
 * moves the revision up. An empty set is kept like any other, so a host emptied of its servers holds the empty set,
 * not the one before.
 */
const applySet = (set: McpApplySet): Effect.Effect<McpApplied | McpStale, never, McpHostStore> =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const held = store.held();
    const wiped = store.wipedAt();

    if (held !== undefined && set.revision < held.revision) {
      return McpStale.make(held);
    }

    if (held === undefined && wiped !== undefined && set.revision <= wiped) {
      return McpStale.make({ hash: "", revision: wiped });
    }

    if (held?.hash === set.hash) {
      if (set.revision > held.revision) yield* Effect.sync(() => store.setRevision(set.revision));

      return applied(set, false);
    }

    yield* Effect.sync(() => store.replaceSet(set));

    return applied(set, true);
  });

/**
 * What a changed set does to the discoveries (`docs/architecture/mcp-connections.md` → Set changes, per name): a `conn`
 * that left (its server changed or was removed) has its discovery aborted and its era and Legacy session rows dropped,
 * and its inventory kept for a revert; a new `conn` is discovered at once if a Session used the host in the last 24
 * h (else at its first demand), a kept inventory served meanwhile; a `failed` one is retried, at most once a minute.
 * A change outside `conn` only moves the versions. Without an Environment, only the storage is settled.
 */
const settleSet = (environment: string | undefined, before: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const views = yield* viewServers;
    const conns = Arr.map(views, (view) => view.server.conn);
    const now = yield* Clock.currentTimeMillis;

    yield* interrupt(Arr.difference(before, conns));
    store.pruneOutsideSet(conns, now);

    if (environment !== undefined) yield* startDue(environment, views, "set");

    yield* refreshVersions;
  });

/** The `conn`s of the held set. */
const heldConns = Effect.map(viewServers, (views) => Arr.map(views, (view) => view.server.conn));

/** Take `set` (`applySet`), and settle the discoveries when it changed the set. */
const takeSet = (environment: string | undefined, set: McpApplySet) =>
  Effect.gen(function* () {
    const before = yield* heldConns;
    const result = yield* applySet(set);

    if (Predicate.isTagged(result, "Applied") && result.changed) {
      yield* settleSet(environment, before);
    }

    return result;
  });

/**
 * Wipe the storage, keeping the revision of the deletion (or the held set's when it is later) as the floor of what may
 * fill it again, after interrupting every discovery in flight (their answers are dropped unread). The best-effort
 * Legacy `DELETE` and the closing of streams come with `control` and listens, which the engine does not offer yet. A
 * wipe the storage refuses is `HostFailed`: the Registry still has it to send.
 */
const destroy = (input: McpApply): Effect.Effect<McpApplyResult, never, McpHostServices> =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const wanted = decodeDestroy(input);

    if (Option.isNone(wanted)) {
      return HostFailed.make({ message: "The destroy has no revision" });
    }

    const revision = Math.max(
      wanted.value.revision,
      store.held()?.revision ?? 0,
      store.wipedAt() ?? 0,
    );

    yield* interrupt();
    yield* Effect.tryPromise(() => store.destroy(revision));

    return McpDestroyed.make({});
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(HostFailed.make({ message: "The storage was not wiped" })),
    ),
  );

/**
 * `reload` (`settings_mcp_reload`, `mcpReconnect`): drop the eras and Legacy sessions of the named servers (all when
 * none is named), then rediscover the HTTP ones at once, whatever their state. A stdio one that has an inventory keeps
 * it, expired and with its hold cleared, for the next live demand to refresh without starting a Container; one with
 * none goes back to never discovered, for that demand to discover. A name not in the set is left out of the answer.
 */
const reload = (environment: string | undefined, input: McpApply) =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const wanted = decodeReload(input);

    if (Option.isNone(wanted)) {
      return HostFailed.make({ message: "The reload is malformed" });
    }

    const names = wanted.value.servers;

    const views = Arr.filter(
      yield* viewServers,
      (view) => names === undefined || names.includes(view.server.name),
    );

    const conns = Arr.map(views, (view) => view.server.conn);

    // A discovery in flight would write back the rows the reload drops: it goes first.
    yield* interrupt(conns);

    // A stdio server is not asked here: that would start a Container with no one waiting for it. One that has an inventory
    // keeps it, expired and with no hold on it, so the next live demand that names a Workspace refreshes it (`start:
    // false`: a stopped Container leaves the tools it lists served); one with none goes back to never discovered, for
    // that demand to discover, starting the Container if it must. All of it is written in one synchronous step.
    const stdio = Arr.filter(views, (view) => view.reach === "stdio");
    const now = yield* Clock.currentTimeMillis;

    store.dropPrior(conns);
    yield* Effect.sync(() => {
      const kept = Arr.filter(stdio, (view) => Option.isSome(view.inventory));

      store.expireInventory(Arr.map(kept, (view) => view.server.conn));

      for (const view of kept) {
        const { status } = view;

        if (status !== undefined) {
          store.putStatus({
            ...status,
            failures: status.state === "failed" ? 0 : status.failures,
            nextRetryAt: undefined,
          });
        }
      }

      for (const view of Arr.filter(stdio, (each) => Option.isNone(each.inventory))) {
        store.putStatus({
          conn: view.server.conn,
          state: "not_discovered",
          since: now,
          failures: 0,
        });
      }
    });

    if (stdio.length > 0) yield* refreshVersions;

    if (environment !== undefined) yield* startDue(environment, views, "reload");

    return McpReloaded.make({ servers: Arr.map(views, (view) => view.server.name) });
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(HostFailed.make({ message: "The servers were not reloaded" })),
    ),
  );

/**
 * The servers of the held set that use an MCP sign-in change (`servers`, the names it goes by in this Environment's
 * set, as the sign-in key compares them). Every cached token of theirs goes, so the next ask reaches the Registry.
 * After a change in `REDISCOVERING_CHANGES` the HTTP ones among them that are not working (`sign_in`, `rejected`,
 * `unavailable`, and `failed` or `unknown` a minute after their last try: `isDue`'s `sign_in` trigger) are asked at
 * once, never waking a Container; after a `signed_out` their Legacy sessions are dropped and nothing is asked. A server
 * that is not in the set is left out of the answer. The revision is kept only when it follows the held one directly: a
 * gap means a change no push carried, which the next pull heals (`pull`). Who sends which change: `signed_in` (and so
 * `replaced`) by the callback today; `signed_out` by #459 and `rebound` by #469, through the same carry.
 */
const takeSignIns = (
  environment: string | undefined,
  input: McpApply,
): Effect.Effect<McpApplyResult, never, McpHostServices> =>
  Effect.gen(function* () {
    const wanted = decodeSignIns(input);

    if (Option.isNone(wanted))
      return HostFailed.make({ message: "The sign-in change is malformed" });

    const { change, servers: named, revision } = wanted.value;
    const store = yield* McpHostStore;
    const tokens = yield* McpTokens;
    const names = Arr.map(named, normalizeMcpName);

    const namedViews = (all: ReadonlyArray<ServerView>) =>
      Arr.filter(
        all,
        (view) => view.reach === "http" && names.includes(normalizeMcpName(view.server.name)),
      );

    const conns = Arr.map(namedViews(yield* viewServers), (view) => view.server.conn);
    const rediscovering = Arr.some(REDISCOVERING_CHANGES, (known) => known === change);

    // A discovery of these servers that is running was asked for with the token of before, and would settle what the
    // change just changed: it goes first, as at a reload, and the server reads as it did before it started.
    if (change === "signed_out" || rediscovering) yield* restartable(conns);

    const views = namedViews(yield* viewServers);

    yield* tokens.drop(Arr.map(views, (view) => view.server.name));

    // The revision the change raised the sign-ins to, kept only when it is the very next one: the next pull then finds
    // it held and does not act on it twice, and a gap (a change that no push carried) is left for the pull to heal.
    yield* writeOrHalt(() => {
      const held = store.meta().signInsRevision;

      if (held !== undefined && revision === held + 1) store.setMeta({ signInsRevision: revision });
    });

    if (change === "signed_out") {
      yield* writeOrHalt(() => store.dropSessions(conns));
    } else if (environment !== undefined && rediscovering) {
      yield* startDue(environment, views, "sign_in");
    }

    return McpSignInsTaken.make({ servers: Arr.map(views, (view) => view.server.name) });
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(HostFailed.make({ message: "The sign-in change was not taken" })),
    ),
  );

/**
 * `apply`: the pushes and teardown. `set` keeps the Environment's set, `reload` rediscovers its servers, `sign_ins`
 * takes a change of an MCP sign-in and `destroy` wipes the storage; any other `kind` fails as `HostUnsupported`, never
 * as a decode error, so a newer caller's operation is refused loudly, and a `set` that is malformed as `HostFailed`.
 * `environment` names the Registry to ask for `${NAME}` values; without one, nothing is discovered.
 */
export const apply = (
  input: McpApply,
  environment?: string,
): Effect.Effect<McpApplyResult, never, McpHostServices> =>
  Effect.gen(function* () {
    const kind = decodeKind(input);

    if (Option.isNone(kind)) {
      return HostFailed.make({ message: "apply takes an object with a kind" });
    }

    yield* Effect.annotateCurrentSpan({ "mcp.apply_kind": kind.value.kind });

    if (kind.value.kind === "destroy") {
      return yield* destroy(input);
    }

    if (kind.value.kind === "reload") {
      return yield* reload(environment, input);
    }

    if (kind.value.kind === "sign_ins") {
      return yield* takeSignIns(environment, input);
    }

    if (kind.value.kind !== "set") {
      return HostUnsupported.make({
        message: `This host does not know apply ${kind.value.kind}`,
        op: kind.value.kind,
      });
    }

    const set = decodeSet(input);

    if (Option.isNone(set)) {
      return HostFailed.make({ message: "The MCP server set is malformed" });
    }

    return yield* takeSet(environment, set.value).pipe(
      Effect.catchCause(() => Effect.succeed(HostFailed.make({ message: "The set was not kept" }))),
    );
  }).pipe(Effect.withSpan("mcp.apply"));

/**
 * Ask the Registry for the set and keep it when it differs from the one held, so a push that was lost heals. A Registry
 * that cannot answer leaves the held set as it is: the next Context Window asks again. Logs no more than that it failed.
 */
const pull = (environment: string): Effect.Effect<void, never, McpHostServices> =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const registry = yield* McpRegistryPort;
    const answer = yield* registry.serverSet({ environment, heldHash: store.held()?.hash });

    const known = store.meta().signInsRevision;
    const { revision } = answer;

    // An answer with no revision (an Environment the Registry does not know) holds no set to keep.
    if (revision !== undefined) {
      const held = store.held();

      if (answer.set !== undefined) {
        yield* takeSet(environment, {
          kind: "set",
          hash: answer.hash,
          revision,
          entries: answer.set,
        });
      } else if (held === undefined) {
        // The Registry noted the empty set as handed under this revision, which a push of an older set must not undo.
        yield* takeSet(environment, { kind: "set", hash: answer.hash, revision, entries: [] });
      } else if (held.hash === answer.hash) {
        // The Registry noted the set the host holds as handed under this revision: so does the host.
        yield* Effect.sync(() => {
          if (revision > held.revision) store.setRevision(revision);
        });
      }
    }

    yield* Effect.sync(() => store.setMeta({ signInsRevision: answer.signInsRevision }));

    // A change of the sign-ins that no push carried (a lost one, or one made while the host was away) is healed here:
    // the cached tokens go, and the servers that wait for a sign-in (`sign_in`, `rejected`) are asked at once. One that
    // is `unavailable` or `failed` is not: the change is not known to concern it, and its own retry comes in its time.
    if (known !== answer.signInsRevision) {
      const tokens = yield* McpTokens;
      const views = yield* viewServers;

      yield* tokens.drop();
      yield* startDue(
        environment,
        Arr.filter(
          views,
          (view) => view.status?.state === "sign_in" || view.status?.state === "rejected",
        ),
        "sign_in",
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Environment ${environment}'s MCP server set was not pulled`, cause),
    ),
    Effect.withSpan("mcp.registry"),
  );

/** The longest wait asked for, at most 10 s. */
const waitOf = (waitMs: number | undefined, fallback: number) =>
  Math.max(0, Math.min(waitMs ?? fallback, MCP_MAX_WAIT_MS));

/**
 * The demand-driven part of a read: `connecting` statuses that died with their instance go back, and the servers due
 * a discovery start it.
 */
const onDemand = (environment: string | undefined, trigger: Trigger, workspace?: string) =>
  Effect.gen(function* () {
    yield* reviveStale;

    if (environment !== undefined) {
      yield* startDue(environment, yield* viewServers, trigger, workspace);
    }
  });

/**
 * `requestStart`: marks the host used and says what the Session needs to build its tools. A Context Window's first
 * request (`windowOpened`) pulls the set first. Servers due a discovery start it (an HTTP server never asked, a TTL
 * passed, a backoff over; a stdio server not yet discovered, or failed a minute ago, in the caller's Workspace); a caller with no `known` version (a Session's first request) waits up to `waitMs` (at most
 * 10 s) for the servers it names in `waitFor` that have no inventory yet, each wait ending once its discovery ends,
 * whatever it ends in. The answer is the inventory's content-hash versions, the features the host lists, and per
 * server its hashes and state. The Registry is asked only here and never at the host's start: a host that no Session
 * wakes holds the set it was last pushed, and `windowOpened` heals what a lost push left.
 */
export const requestStart = (
  environment: string | undefined,
  request: McpRequestStart,
): Effect.Effect<McpRequestStartResult, never, McpHostServices> =>
  Effect.gen(function* () {
    // A host that no Environment names has none to ask the Registry about.
    if (request.windowOpened === true && environment !== undefined) yield* pull(environment);

    const store = yield* McpHostStore;

    const now = yield* Clock.currentTimeMillis;

    yield* writeOrHalt(() => store.setMeta({ lastUsedAt: now }));

    // A stdio server is discovered here, in the caller's Workspace, and only here (it may start the Container).
    // (A Session with no Workspace says so with an empty one.)
    yield* onDemand(
      environment,
      "demand",
      request.caller.workspace === "" ? undefined : request.caller.workspace,
    );

    const waitFor = request.waitFor ?? [];

    if (request.known === undefined && waitFor.length > 0) {
      const waited = Arr.filter(
        yield* viewServers,
        (view) => waitFor.includes(view.server.name) && Option.isNone(view.inventory),
      );

      yield* awaitDiscoveries(
        Arr.map(waited, (view) => view.server.conn),
        waitOf(request.waitMs, MCP_MAX_WAIT_MS),
      );
    }

    const { views, versions } = yield* refreshVersions;

    yield* Effect.annotateCurrentSpan({
      "mcp.servers": views.length,
      "mcp.window_opened": request.windowOpened === true,
      "mcp.known": request.known !== undefined,
    });

    return {
      ...versions,
      features: MCP_HOST_FEATURES,
      servers: Record.fromEntries(
        Arr.map(views, (view) => [
          view.server.name,
          { ...toServerHashes(view), state: view.state },
        ]),
      ),
      watches: { changed: [], ended: [] },
    };
  }).pipe(
    Effect.catchCause(() => Effect.succeed(unreadable)),
    Effect.withSpan("mcp.request_start"),
  );

/** A failure to read what the host holds: loud, never an empty inventory that reads as no servers. */
const unreadable = HostFailed.make({ message: "The MCP host could not read its storage" });

/** `view`'s `toolsHash` and `promptsHash`. */
const toServerHashes = (view: ServerView) =>
  serverHashes({
    name: view.server.name,
    entryHash: view.server.entryHash,
    state: view.state,
    inventory: view.inventory,
  });

/** One server as `servers` answers it, with the `parts` asked for. */
const toServerInventory = (view: ServerView, parts: ReadonlyArray<string>): McpServerInventory => {
  const inventory = Option.getOrUndefined(view.inventory);
  const meta = inventory?.meta;

  const answer: Mutable<McpServerInventory> = {
    name: view.server.name,
    source: view.server.source,
    server: view.server.server,
    conn: view.server.conn,
    state: view.state,
    ...toServerHashes(view),
    counts: { tools: inventory?.tools.length ?? 0, prompts: inventory?.prompts.length ?? 0 },
    resources: meta !== undefined && "resources" in meta.capabilities,
    problems: meta?.problems ?? [],
  };

  if (view.status?.error !== undefined) answer.error = view.status.error;

  if (meta !== undefined) {
    answer.protocolVersion = meta.protocolVersion;
    answer.discoveredAt = meta.discoveredAt;

    if (meta.discoveredIn !== undefined) answer.discoveredIn = meta.discoveredIn;
  }

  if (inventory !== undefined && parts.includes("tools")) answer.tools = inventory.tools;

  if (inventory !== undefined && parts.includes("prompts")) answer.prompts = inventory.prompts;

  if (meta?.instructions !== undefined && parts.includes("instructions")) {
    answer.instructions = meta.instructions;
  }

  if (view.status !== undefined && parts.includes("status")) {
    const { since, failures, nextRetryAt, lastOkAt } = view.status;
    const status: Mutable<NonNullable<McpServerInventory["status"]>> = { since, failures };

    if (nextRetryAt !== undefined) status.nextRetryAt = nextRetryAt;

    if (lastOkAt !== undefined) status.lastOkAt = lastOkAt;

    answer.status = status;
  }

  return answer;
};

/**
 * `servers`: the inventory per server, with the parts asked for. HTTP servers due a discovery start it, and it waits up
 * to `waitMs` (at most 10 s, none by default) for those being discovered. It never starts a Container: only a live
 * caller's `requestStart` and `request` do.
 */
export const servers = (
  environment: string | undefined,
  request: McpServersRequest,
): Effect.Effect<McpServersResult, never, McpHostServices> =>
  Effect.gen(function* () {
    yield* onDemand(environment, "demand");

    const named = (view: ServerView) =>
      request.names === undefined || request.names.includes(view.server.name);

    yield* awaitDiscoveries(
      Arr.map(Arr.filter(yield* viewServers, named), (view) => view.server.conn),
      waitOf(request.waitMs, 0),
    );

    const { views, versions } = yield* refreshVersions;

    yield* Effect.annotateCurrentSpan({ "mcp.servers": views.length });

    return {
      ...versions,
      servers: Arr.map(Arr.filter(views, named), (view) => toServerInventory(view, request.parts)),
    };
  }).pipe(
    Effect.catchCause(() => Effect.succeed(unreadable)),
    Effect.withSpan("mcp.servers"),
  );

/**
 * `serverLog`: the log ring of the server `request.server` of the held set (`docs/architecture/mcp-connections.md` →
 * Telemetry). It reads the host's own storage and nothing else: no discovery starts, the engine and the Registry are not
 * asked, and no Workspace or Container is touched, whatever `workspace` the caller names (a stdio server's stderr tail,
 * which comes with the bridge, will be read from `bridge_status` with `start: false`). A server not in the set is
 * `NoServer`; a read the storage refuses is `HostFailed`.
 */
export const serverLog = (
  request: McpServerLogRequest,
): Effect.Effect<McpServerLogResult, never, McpHostServices> =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const views = yield* viewServers;
    const found = Arr.findFirst(views, (view) => view.server.name === request.server);

    if (Option.isNone(found)) return McpNoServer.make({});

    return McpServerLog.make({ entries: store.logs(found.value.server.conn) });
  }).pipe(
    Effect.catchCause(() => Effect.succeed(unreadable)),
    Effect.withSpan("mcp.server_log"),
  );

/** What the host object answers over RPC. */
export type McpHostMethods = {
  /**
   * A Session's request starts (`docs/architecture/mcp-connections.md` → RPC). `windowOpened` makes the host ask the
   * Registry for the MCP server set.
   */
  readonly requestStart: (request: McpRequestStart) => Effect.Effect<McpRequestStartResult>;
  /** The MCP inventory per server, for the `mcp` extension's reads, `settings_mcp_*`, the composer and Settings. */
  readonly servers: (request: McpServersRequest) => Effect.Effect<McpServersResult>;
  /**
   * A server's log ring, read from storage only: it starts no discovery and no Container (`serverLog`). For the main
   * Worker's `mcpServerLog`.
   */
  readonly serverLog: (request: McpServerLogRequest) => Effect.Effect<McpServerLogResult>;
  /** The pushes: the Environment's MCP server set. An operation this host does not know is `HostUnsupported`. */
  readonly apply: (input: McpApply) => Effect.Effect<McpApplyResult>;
  /**
   * A Session's call to one server (`./request.ts`), with its hooks, which live as long as the caller's invocation. An
   * `op` this host does not know is `HostUnsupported`.
   */
  readonly request: (
    input: typeof McpHostRequest.Encoded,
    hooks: McpHostRequestHooks,
  ) => Effect.Effect<McpHostRequestResult>;
};

/**
 * The methods of the host of `environment` over `runtime`, the object's one long-lived runtime: each runs with its
 * services, and the discoveries it starts stay in its scope after the call returns. A host whose name is no
 * `mcp:<environment>` has no Environment, and refuses with a failure.
 */
export const mcpHostMethods = (
  environment: string | undefined,
  runtime: ManagedRuntime.ManagedRuntime<McpHostServices, never>,
): McpHostMethods => {
  const provided = <A>(effect: Effect.Effect<A, never, McpHostServices>): Effect.Effect<A> =>
    Effect.flatMap(runtime.contextEffect, (context) => Effect.provideContext(effect, context));

  return {
    requestStart: (input) => provided(requestStart(environment, input)),
    servers: (input) => provided(servers(environment, input)),
    serverLog: (input) => provided(serverLog(input)),
    request: (input, hooks) => provided(request(environment, input, hooks ?? {})),
    apply: (input) =>
      environment === undefined
        ? Effect.succeed(HostFailed.make({ message: "The MCP host's name is unknown" }))
        : provided(apply(input, environment)),
  };
};
