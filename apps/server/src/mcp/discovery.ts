// Discovery and its scheduling (`docs/architecture/mcp-connections.md` → Discovery and the MCP inventory): what each
// server of the set is in (its state), when it is due, and the discovery itself, from the cached era to the stored
// inventory and its versions.
//
// Discoveries run as fibers in the host's runtime, kept in its scope (`McpDiscovery`), so they outlive the call that
// started them: single-flight per `conn`, at most 3 at once. Nothing arms an alarm: a server is retried only on demand
// (`requestStart`, `servers`, a set change, a reload), once its backoff is over. A storage operation that fails stops
// new discoveries (a replaced instance, whose writes are refused; `docs/architecture/mcp-connections.md` → Deploys).
//
// A discovery started in the background passes the engine `untilAborted()` from the invocation that started it, which
// lives only as long as that invocation (#409 answer 2): one that outlives it is cut, read as `unavailable`, and
// retried after its backoff.
// @effect-diagnostics missingPipeableSignature:off -- the scheduler's operations, not combinators.
import type {
  McpEngineDiscoverResult,
  McpEngineTarget,
  McpErrorWire,
  McpServerState,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { McpEngineClient } from "./engine.ts";
import { McpRegistryPort } from "./registry-port.ts";
import { type Inventory, inventoryRows, inventoryVersions, readInventory } from "./inventory.ts";
import { McpHostStore, type StatusRow, type StoredServer } from "./store.ts";

/** At most 3 discoveries at once per host. */
export const MAX_DISCOVERIES = 3;

/** An HTTP server new to the set is discovered at once only if a Session used the host within 24 h. */
export const RECENT_USE_MS = 24 * 60 * 60 * 1000;

/** A `connecting` status older than this at wake belongs to a discovery that died with its instance. */
export const STALE_CONNECTING_MS = 120 * 1000;

/** `unavailable`'s backoff: 30 s, 1, 2, 5, then 10 min. */
export const BACKOFF_MS: ReadonlyArray<number> = [30_000, 60_000, 120_000, 300_000, 600_000];

/** A `failed` server is retried at most once a minute; a `skipped` one is looked at again after a minute. */
export const RETRY_FLOOR_MS = 60 * 1000;

/** A status error is cut at 300 characters. */
export const MAX_ERROR = 300;

export type McpDiscoveryService = {
  /** The discoveries in flight, by `conn`. */
  readonly fibers: FiberMap.FiberMap<string>;
  /** At most `MAX_DISCOVERIES` at once. */
  readonly slots: Semaphore.Semaphore;
  /** Set once a storage operation failed: no discovery starts after it. */
  readonly halted: { value: boolean };
};

/** The host's discoveries in flight, kept in its runtime's scope. Internal to the host. */
export class McpDiscovery extends Context.Service<McpDiscovery, McpDiscoveryService>()(
  "@cloudpid/server/mcp/discovery/McpDiscovery",
) {
  static readonly layer = Layer.effect(
    McpDiscovery,
    Effect.gen(function* () {
      return {
        fibers: yield* FiberMap.make<string>(),
        slots: yield* Semaphore.make(MAX_DISCOVERIES),
        halted: { value: false },
      };
    }),
  );
}

/** What the host needs to discover. */
export type McpDiscoveryServices = McpHostStore | McpEngineClient | McpRegistryPort | McpDiscovery;

/** How a server of the set is reached: over HTTP, through the bridge (not built yet), or not at all (switched off). */
type Reach = "http" | "stdio" | "off";

/** A server of the held set, with what the host knows of it. */
export type ServerView = {
  readonly server: StoredServer;
  readonly reach: Reach;
  readonly status: StatusRow | undefined;
  readonly inventory: Option.Option<Inventory>;
  readonly state: McpServerState;
};

const reachOf = (server: StoredServer): Reach => {
  const { enabled, exposure, type } = server.server;

  if (enabled === false || exposure === "hidden") return "off";

  return type === "stdio" ? "stdio" : "http";
};

/** The state a server is reported in: `disabled` when switched off, `skipped` for stdio, else its status's. */
const stateOf = (reach: Reach, status: StatusRow | undefined): McpServerState =>
  Match.value(reach).pipe(
    Match.when("off", () => "disabled" as const),
    Match.when("stdio", () => "skipped" as const),
    Match.orElse(() => status?.state ?? "not_discovered"),
  );

/** Every server of the held set, in its order, with its status and inventory. */
export const viewServers: Effect.Effect<
  ReadonlyArray<ServerView>,
  never,
  McpHostStore
> = Effect.gen(function* () {
  const store = yield* McpHostStore;
  const set = store.readSet();
  const statuses = store.statuses();
  const inventories = store.inventories();

  return Arr.map(set?.servers ?? [], (server): ServerView => {
    const reach = reachOf(server);
    const status = statuses.get(server.conn);
    const rows = inventories.get(server.conn);

    return {
      server,
      reach,
      status,
      inventory: rows === undefined ? Option.none() : readInventory(rows),
      state: stateOf(reach, status),
    };
  });
});

/** The inventory's versions over `views`, kept in `mcp_meta`. */
export const versionsOf = (views: ReadonlyArray<ServerView>) =>
  inventoryVersions(
    Arr.map(views, (view) => ({
      name: view.server.name,
      entryHash: view.server.entryHash,
      state: view.state,
      inventory: view.inventory,
    })),
  );

/** Recompute the versions and keep them. */
export const refreshVersions = Effect.gen(function* () {
  const store = yield* McpHostStore;
  const versions = versionsOf(yield* viewServers);

  store.setMeta(versions);

  return versions;
});

/** What makes a discovery due: a demand (a Session's request, a status read), a set change, or a reload. */
export type Trigger = "demand" | "set" | "reload";

/** Whether `view` is due a discovery at `now` for `trigger`; `usedRecently` says whether a Session used the host. */
export const isDue = (
  view: ServerView,
  trigger: Trigger,
  now: number,
  usedRecently: boolean,
): boolean => {
  if (view.reach !== "http") return false;

  if (trigger === "reload") return true;

  const { status } = view;

  if (status === undefined) return trigger === "demand" || usedRecently;

  return Match.value(status.state).pipe(
    Match.when("connecting", () => false),
    Match.when("connected", () =>
      Option.match(view.inventory, {
        onNone: () => true,
        onSome: (inventory) => inventory.meta.ttlUntil <= now,
      }),
    ),
    Match.whenOr("not_discovered", "disabled", () => true),
    Match.whenOr("sign_in", "rejected", () => false),
    Match.whenOr(
      "unavailable",
      "skipped",
      () => status.nextRetryAt === undefined || status.nextRetryAt <= now,
    ),
    Match.whenOr(
      "failed",
      "unknown",
      () => trigger === "set" && now - status.since >= RETRY_FLOOR_MS,
    ),
    Match.exhaustive,
  );
};

const cut = (message: string) => message.slice(0, MAX_ERROR);

/** The status a failure leaves the server in, from the one before it. */
const failedStatus = (
  conn: string,
  state: McpServerState,
  message: string,
  previous: StatusRow | undefined,
  now: number,
): StatusRow => {
  const failures = (previous?.failures ?? 0) + 1;

  const nextRetryAt = Match.value(state).pipe(
    Match.when(
      "unavailable",
      () => now + (BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] ?? RETRY_FLOOR_MS),
    ),
    Match.when("skipped", () => now + RETRY_FLOOR_MS),
    Match.orElse(() => undefined),
  );

  return {
    conn,
    state,
    error: cut(message),
    since: now,
    failures,
    nextRetryAt,
    lastOkAt: previous?.lastOkAt,
  };
};

/** The state a failed discovery leaves a server in (`docs/architecture/mcp-connections.md` → States). */
const stateOfError = (error: McpErrorWire): McpServerState =>
  Match.value(error).pipe(
    Match.tag("SignInRequired", (signIn) => (signIn.rejected ? "rejected" : "sign_in")),
    Match.tag("StepUpRequired", () => "sign_in" as const),
    Match.tag("Unreachable", "Cut", "TimedOut", () => "unavailable" as const),
    Match.tag(
      "TooLarge",
      "ServerError",
      "NotFound",
      "Unsupported",
      "ProtocolViolation",
      "OtherMcpError",
      () => "failed" as const,
    ),
    Match.exhaustive,
  );

/** Why a server was not reached: the state it is left in, and the error to show. */
type NotReached = { readonly state: McpServerState; readonly message: string };

const notReached = (state: McpServerState, message: string) =>
  Result.fail<NotReached>({ state, message });

const isJsonRecord = (
  value: Schema.Json | undefined,
): value is Readonly<Record<string, Schema.Json>> =>
  Predicate.isObject(value) && !Arr.isArray(value);

/** A JSON record's string values. */
const stringValues = (record: Readonly<Record<string, Schema.Json>>) =>
  Record.filterMap(record, (value) =>
    Predicate.isString(value) ? Result.succeed(value) : Result.failVoid,
  );

/** `${NAME}` appears in a value of `headers`: the Registry resolves them. */
const hasNames = (headers: Readonly<Record<string, string>>): boolean =>
  Arr.some(Record.values(headers), (value) => value.includes("${"));

/** An HTTP server's target, its `${NAME}` values resolved by the Registry, or why it cannot be reached. */
const targetOf = (environment: string, server: StoredServer) =>
  Effect.gen(function* () {
    const { url, headers, timeout } = server.server;
    const written = stringValues(isJsonRecord(headers) ? headers : {});

    const target = (resolved: Readonly<Record<string, string>>) =>
      Result.succeed<McpEngineTarget>({
        kind: "http",
        conn: server.conn,
        name: server.name,
        url: Predicate.isString(url) ? url : "",
        headers: resolved,
        timeoutMs: (Predicate.isNumber(timeout) ? timeout : 60) * 1000,
      });

    if (!hasNames(written)) return target(written);

    const registry = yield* McpRegistryPort;

    const answer = yield* registry
      .serverValues({ environment, server: server.name, conn: server.conn })
      .pipe(Effect.option);

    if (Option.isNone(answer)) {
      return notReached("unavailable", "The Registry could not resolve its ${NAME} values");
    }

    const values = answer.value;

    if (values.status !== "values" || !("missing" in values)) {
      return notReached("unavailable", "The Registry holds another definition of this server");
    }

    if (values.missing.length > 0) {
      const names = Arr.join(
        Arr.map(values.missing, (name) => "${" + name + "}"),
        ", ",
      );

      return notReached("skipped", `Needs ${names}, which resolve to nothing`);
    }

    return target(values.headers);
  });

/** Keep what a discovery found: the rows it changed, then the inventory and status, or the status it failed with. */
const keep = (
  conn: string,
  result: McpEngineDiscoverResult,
  previous: StatusRow | undefined,
  now: number,
) =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;

    store.keepState(conn, result.state, now);

    Match.value(result).pipe(
      Match.discriminatorsExhaustive("kind")({
        failed: (failure) =>
          store.putStatus(
            failedStatus(conn, stateOfError(failure.error), failure.error.message, previous, now),
          ),
        discovered: (discovered) => {
          store.putInventory(conn, inventoryRows(discovered, now));
          store.putStatus({ conn, state: "connected", since: now, failures: 0, lastOkAt: now });
        },
      }),
    );
  });

/** Discover one server, single-flight per `conn`, within the host's slots. */
const discoverOne = (environment: string, view: ServerView) =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const engine = yield* McpEngineClient;
    const { conn } = view.server;
    const previous = view.status;
    const started = yield* Clock.currentTimeMillis;

    // A connected server refreshes in place, its inventory served meanwhile.
    if (previous?.state !== "connected") {
      store.putStatus({
        conn,
        state: "connecting",
        since: started,
        failures: previous?.failures ?? 0,
        nextRetryAt: previous?.nextRetryAt,
        lastOkAt: previous?.lastOkAt,
        previousState: previous?.state ?? "not_discovered",
        error: previous?.error,
      });
    }

    const reached = yield* targetOf(environment, view.server);

    if (Result.isFailure(reached)) {
      const { state, message } = reached.failure;

      store.putStatus(failedStatus(conn, state, message, previous, yield* Clock.currentTimeMillis));

      return;
    }

    const result = yield* engine.discover(reached.success, store.prior(conn)).pipe(Effect.result);
    const now = yield* Clock.currentTimeMillis;

    if (Result.isFailure(result)) {
      store.putStatus(failedStatus(conn, "unavailable", result.failure.message, previous, now));

      return;
    }

    yield* keep(conn, result.success, previous, now);
  }).pipe(
    Effect.andThen(refreshVersions),
    Effect.withSpan("mcp.discover", { attributes: { server: view.server.name } }),
  );

/**
 * Return each `connecting` status older than 120 s that no discovery of this instance holds to the state before it,
 * with no backoff: the discovery died with the instance that ran it.
 */
export const reviveStale = Effect.gen(function* () {
  const store = yield* McpHostStore;
  const { fibers } = yield* McpDiscovery;
  const now = yield* Clock.currentTimeMillis;

  for (const status of store.statuses().values()) {
    if (
      status.state === "connecting" &&
      now - status.since > STALE_CONNECTING_MS &&
      !FiberMap.hasUnsafe(fibers, status.conn)
    ) {
      store.putStatus({ ...status, state: status.previousState ?? "not_discovered" });
    }
  }
});

/**
 * Start the discoveries of `views` that are due for `trigger`, unless storage failed before. One already in flight is
 * left to run. A storage failure in a discovery stops new ones.
 */
export const startDue = (environment: string, views: ReadonlyArray<ServerView>, trigger: Trigger) =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const discovery = yield* McpDiscovery;
    const now = yield* Clock.currentTimeMillis;
    const { lastUsedAt } = store.meta();
    const usedRecently = lastUsedAt !== undefined && now - lastUsedAt < RECENT_USE_MS;

    if (discovery.halted.value) return;

    const halt = Effect.sync(() => {
      discovery.halted.value = true;
    });

    for (const view of views) {
      if (
        !FiberMap.hasUnsafe(discovery.fibers, view.server.conn) &&
        isDue(view, trigger, now, usedRecently)
      ) {
        yield* FiberMap.run(
          discovery.fibers,
          view.server.conn,
          discovery.slots
            .withPermits(1)(discoverOne(environment, view))
            .pipe(
              Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : halt)),
            ),
        );
      }
    }
  });

/** Interrupt the discoveries of `conns` (their server changed or left), or of every `conn`. */
export const interrupt = (conns?: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { fibers } = yield* McpDiscovery;

    if (conns === undefined) {
      yield* FiberMap.clear(fibers);

      return;
    }

    yield* Effect.forEach(conns, (conn) => FiberMap.remove(fibers, conn), { discard: true });
  });

/** Wait at most `ms` for the discoveries in flight of `conns` to end. */
export const awaitDiscoveries = (conns: ReadonlyArray<string>, ms: number) =>
  Effect.gen(function* () {
    const { fibers } = yield* McpDiscovery;

    const running = Arr.filterMap(conns, (conn) =>
      Option.match(FiberMap.getUnsafe(fibers, conn), {
        onNone: () => Result.failVoid,
        onSome: (fiber) => Result.succeed(fiber),
      }),
    );

    if (running.length === 0 || ms <= 0) return;

    yield* Effect.forEach(running, (fiber) => Fiber.await(fiber), {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.timeoutOption(Duration.millis(ms)));
  });
