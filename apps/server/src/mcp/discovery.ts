// Discovery and its scheduler (`docs/architecture/mcp-connections.md` → Discovery and the MCP inventory): the
// discoveries in flight, which servers start one, and the discovery itself, from the cached era to the stored inventory
// and its versions. When a server is due, and the state a discovery leaves it in, are `server-state.ts`'s.
//
// Discoveries run as fibers in the host's runtime, kept in its scope (`McpDiscovery`), so they outlive the call that
// started them: single-flight per `conn`, at most 3 at once, each one request in flight on its server and one
// background engine call (`McpLoadCaps`). Nothing arms an alarm: a server is retried only on demand (`requestStart`,
// `servers`, a set change, a reload), once its backoff is over. A stdio server is discovered only on a live caller's
// demand that names the caller's Workspace, in that Workspace's Container, which the discovery may start. A storage operation that fails stops new discoveries
// (a replaced instance, whose writes are refused; `docs/architecture/mcp-connections.md` → Deploys).
//
// A discovery passes the engine no callback (`engine.ts`), so the invocation that started it ending cuts nothing. A
// failure on the host's side (the engine out of reach or silent) is not the server's: it leaves its state as it was,
// held back for 30 s. No discovery holds its slot past `DISCOVERY_DEADLINE_MS`: it is then given up the same way.
// @effect-diagnostics missingPipeableSignature:off -- the scheduler's operations, not combinators.
import { signsInOnItsOwn } from "@cloudpid/config";
import { currentTraceId } from "@cloudpid/telemetry";
import {
  isJsonObject,
  MCP_CLIENT_CREDENTIALS_CAPABILITY,
  MCP_CLIENT_CREDENTIALS_EXTENSION,
  type JsonObject,
  type McpEngineDiscoverResult,
  type McpEngineRequestResult,
  type McpEngineHttpTarget,
  type McpEngineStdioTarget,
  type McpEngineTarget,
  type McpServerState,
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
import * as Semaphore from "effect/Semaphore";
import type * as Types from "effect/Types";
import { authorizedDiscovery, type DiscoveryAccess } from "./discovery-auth.ts";
import { DISCOVER_TIMEOUT_MS, McpEngineClient } from "./engine.ts";
import { inventoryRows } from "./inventory.ts";
import { McpLoadCaps } from "./limits.ts";
import { recordLogs } from "./logs.ts";
import { McpRegistryPort } from "./registry-port.ts";
import {
  currentVersions,
  failedStatus,
  hostFailureStatus,
  isDue,
  RECENT_USE_MS,
  RETRY_FLOOR_MS,
  type ServerView,
  STALE_CONNECTING_MS,
  stateOfError,
  type Trigger,
} from "./server-state.ts";
import { McpHostStore, type StatusRow, type StoredServer } from "./store.ts";
import { type McpProcessEnded, processEnded, rootsOf } from "./stdio.ts";
import { SECOND_MS } from "./time.ts";
import type { McpTokens } from "./tokens.ts";

/** At most 3 discoveries at once per host. */
export const MAX_DISCOVERIES = 3;

/** At most 2 stdio discoveries at once per Workspace: its Container starts and spawns them (D7). */
export const MAX_STDIO_DISCOVERIES_PER_WORKSPACE = 2;

/**
 * The longest a discovery holds its slot, waiting for its turn included: past the engine call's own timeout, so only
 * a discovery stuck elsewhere (a Registry that never answers) reaches it.
 */
export const DISCOVERY_DEADLINE_MS = DISCOVER_TIMEOUT_MS + 60 * SECOND_MS;

export type McpDiscoveryService = {
  /** The discoveries in flight, by `conn`. */
  readonly fibers: FiberMap.FiberMap<string>;
  /** When each discovery in flight started, by `conn`. */
  readonly startedAt: Map<string, number>;
  /** At most `MAX_DISCOVERIES` at once. */
  readonly slots: Semaphore.Semaphore;
  /** The slots of the Workspaces with a stdio discovery in flight or waiting, by `ws:<id>`; one goes once none is. */
  readonly workspaceSlots: Map<string, { readonly slots: Semaphore.Semaphore; users: number }>;
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
        startedAt: new Map<string, number>(),
        slots: yield* Semaphore.make(MAX_DISCOVERIES),
        workspaceSlots: new Map(),
        halted: { value: false },
      };
    }),
  );
}

/** What the host needs to discover. */
export type McpDiscoveryServices =
  | McpHostStore
  | McpEngineClient
  | McpRegistryPort
  | McpDiscovery
  | McpLoadCaps
  | McpProcessEnded
  | McpTokens;

/** Stop new discoveries: a storage operation failed, so this instance's writes are refused from now on. */
export const halt = Effect.gen(function* () {
  const discovery = yield* McpDiscovery;

  discovery.halted.value = true;
});

/** Run a write that may fail without failing its caller: a failure halts background work instead. */
export const writeOrHalt = (write: () => void) => Effect.asVoid(attemptOrHalt(write));

/** `work`'s value, or undefined when the storage refuses it: a refusal halts background work, and fails no one. */
export const attemptOrHalt = <A>(work: () => A) =>
  Effect.sync(work).pipe(Effect.catchCause(() => Effect.as(halt, undefined)));

/**
 * The servers and the inventory's versions over them, the versions kept for the next reader. A read that fails fails
 * this; a refused write only halts background work.
 */
export const refreshVersions = Effect.gen(function* () {
  const store = yield* McpHostStore;
  const current = yield* currentVersions;

  yield* writeOrHalt(() => store.setMeta(current.versions));

  return current;
});

/** Why a server was not reached: the state it is left in, and the error to show. */
type NotReached = { readonly state: McpServerState; readonly message: string };

const notReached = (state: McpServerState, message: string) =>
  Result.fail<NotReached>({ state, message });

/** A JSON record's string values. */
const stringValues = (record: JsonObject) =>
  Record.filterMap(record, (value) =>
    Predicate.isString(value) ? Result.succeed(value) : Result.failVoid,
  );

/** `${NAME}` appears in a value of `headers`: the Registry resolves them. */
const hasNames = (headers: Readonly<Record<string, string>>): boolean =>
  Arr.some(Record.values(headers), (value) => value.includes("${"));

/**
 * A stdio server's target in `workspace`, its `env` resolved and its Roots from that Workspace's Repos, or why it cannot
 * be reached. `start` says whether the call may start the Workspace's Container: a live caller's demand for a server with
 * no inventory, or a call; never the refresh of an inventory kept (`docs/architecture/mcp-connections.md` → Discovery).
 */
const stdioTargetOf = (
  environment: string,
  server: StoredServer,
  workspace: string | undefined,
  start: boolean,
) =>
  Effect.gen(function* () {
    if (workspace === undefined) {
      return notReached("unavailable", "A stdio server runs in a Workspace, and none was named");
    }

    const { command, args, cwd, timeout } = server.server;
    const registry = yield* McpRegistryPort;

    const answer = yield* registry
      .serverValues({ environment, server: server.name, conn: server.conn, workspace })
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

    const target: Types.Mutable<McpEngineStdioTarget> = {
      kind: "stdio",
      conn: server.conn,
      name: server.name,
      workspace,
      start,
      command: Predicate.isString(command) ? command : "",
      env: values.env,
      roots: rootsOf(values.repos ?? []),
      redact: values.redact ?? [],
      timeoutMs: (Predicate.isNumber(timeout) ? timeout : 60) * 1000,
    };

    if (Arr.isArray(args)) target.args = Arr.filter(args, Predicate.isString);

    if (Predicate.isString(cwd)) target.cwd = cwd;

    return Result.succeed<McpEngineTarget>(target);
  });

/**
 * A server's target, its `${NAME}` values resolved by the Registry, or why it cannot be reached. An HTTP server's is its
 * URL and headers; a stdio server's is what its Workspace's bridge spawns, so it needs the `workspace`, and `start` (a
 * call's, by default) says whether the call may start the Container.
 */
export const targetOf = (
  environment: string,
  server: StoredServer,
  workspace?: string,
  start = true,
) =>
  Effect.gen(function* () {
    if (server.server.type === "stdio") {
      return yield* stdioTargetOf(environment, server, workspace, start);
    }

    const { url, headers, timeout } = server.server;
    const written = stringValues(isJsonObject(headers) ? headers : {});

    const target = (resolved: Readonly<Record<string, string>>, redact: ReadonlyArray<string>) => {
      const reached: Types.Mutable<McpEngineHttpTarget> = {
        kind: "http",
        conn: server.conn,
        name: server.name,
        url: Predicate.isString(url) ? url : "",
        headers: resolved,
        redact,
        timeoutMs: (Predicate.isNumber(timeout) ? timeout : 60) * 1000,
      };

      // A connection that signs in on its own declares the OAuth Client Credentials extension, and no other does.
      if (signsInOnItsOwn(server.server)) {
        reached.extensions = {
          [MCP_CLIENT_CREDENTIALS_EXTENSION]: MCP_CLIENT_CREDENTIALS_CAPABILITY,
        };
      }

      return Result.succeed<McpEngineTarget>(reached);
    };

    if (!hasNames(written)) return target(written, []);

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

    return target(values.headers, values.redact ?? []);
  });

/** Whether `result` of a discovery or a call failed because the bridge's Workspace has no record any more (`Unreachable` with status 404). */
export const isWorkspaceGone = (
  result: McpEngineDiscoverResult | McpEngineRequestResult,
): boolean =>
  result.kind === "failed" &&
  Predicate.isTagged(result.error, "Unreachable") &&
  result.error.status === 404;

/**
 * Whether a discovery that was not to start the Container found it not running (the bridge's `stopped` refusal), or its
 * Workspace gone (the 404 of a Workspace with no record). Any other failure, a bridge that does not answer in a Container
 * that runs included, is a failure of the refresh like any other.
 */
const foundNotRunning = (result: McpEngineDiscoverResult): boolean =>
  result.kind === "failed" &&
  Predicate.isTagged(result.error, "Unreachable") &&
  (result.error.stopped === true || result.error.status === 404);

/** Keep what a discovery found: the rows it changed, then the inventory and status, or the status it failed with. */
const storeDiscoveryResult = (
  conn: string,
  result: McpEngineDiscoverResult,
  previous: StatusRow | undefined,
  now: number,
  workspace?: string,
) =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;

    const ended = store.applyEngineState(
      conn,
      result.state,
      now,
      workspace === undefined ? undefined : { workspace, spawn: result.spawn },
    );

    if (workspace !== undefined && ended !== undefined) yield* processEnded(conn, workspace, ended);

    if (workspace !== undefined && isWorkspaceGone(result)) {
      yield* processEnded(conn, workspace, undefined);
    }

    yield* Effect.annotateCurrentSpan(
      Match.value(result).pipe(
        Match.discriminatorsExhaustive("kind")({
          failed: () => ({ "mcp.outcome": "failed" }),
          discovered: (discovered) => ({
            "mcp.outcome": "discovered",
            "mcp.era": discovered.era,
            "mcp.protocol_version": discovered.protocolVersion,
            "mcp.tools": discovered.tools.length,
            "mcp.prompts": discovered.prompts.length,
            "mcp.problems": discovered.problems.length,
          }),
        }),
      ),
    );

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

    // What the server said during the discovery: kept in its ring, `warning` and above also a span event.
    yield* recordLogs(conn, result.logs);
  });

/** `status` put back from `connecting` to the state before it; any other status as it is. */
const statusBeforeConnecting = (status: StatusRow): StatusRow =>
  status.state === "connecting"
    ? { ...status, state: status.previousState ?? "not_discovered", previousState: undefined }
    : status;

/** The status before a discovery: a `connecting` one left by another discovery reads as the state before it. */
const statusBefore = (status: StatusRow | undefined): StatusRow | undefined =>
  status === undefined ? undefined : statusBeforeConnecting(status);

/** The message a discovery given up past its deadline leaves. */
const PAST_DEADLINE = "The discovery did not end in time";

/**
 * Discover one server, single-flight per `conn`, within the host's slots. `cause` is the ID of the trace of the
 * invocation that started it, recorded on the span: a discovery goes on after that invocation, and a span can be neither
 * re-parented nor linked (`docs/architecture/mcp.md` → Testing and tracing).
 */
const discoverOne = (
  environment: string,
  view: ServerView,
  cause: string | undefined,
  caller?: string,
) =>
  Effect.gen(function* () {
    // Only a stdio server is discovered in a Workspace.
    const workspace = view.reach === "stdio" ? caller : undefined;

    const store = yield* McpHostStore;
    const engine = yield* McpEngineClient;
    const caps = yield* McpLoadCaps;
    const { conn } = view.server;
    const previous = statusBefore(view.status);
    const started = yield* Clock.currentTimeMillis;

    // Past its deadline: given up on the host's side, so the server's state goes back as it was, held back a while.
    const giveUp = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* writeOrHalt(() =>
        store.putStatus(hostFailureStatus(conn, PAST_DEADLINE, previous, now)),
      );
    });

    // Interrupted by the host itself (a set change, a reload, a destroy): the status goes back as it was before.
    const restore = writeOrHalt(() =>
      store.putStatus(previous ?? { conn, state: "not_discovered", since: started, failures: 0 }),
    );

    const discovery = Effect.gen(function* () {
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

      // A server with an inventory is refreshed only in a Container that runs: only one with none may start it.
      const mayStart = Option.isNone(view.inventory);
      const reached = yield* targetOf(environment, view.server, workspace, mayStart);

      if (Result.isFailure(reached)) {
        const { state, message } = reached.failure;

        store.putStatus(
          failedStatus(conn, state, message, previous, yield* Clock.currentTimeMillis),
        );

        return;
      }

      // Each engine call takes its place in the caps; the token is asked for, and a refused one asked for again, in
      // between.
      const call = (target: McpEngineTarget) =>
        caps.inFlight(
          conn,
          caps.engineCall("background", engine.discover(target, store.prior(conn, workspace))),
          workspace,
        );

      const { success: target } = reached;

      // A stdio server has no sign-in: its call is made as it is.
      const result = yield* (
        target.kind === "stdio"
          ? Effect.map(call(target), (answered): DiscoveryAccess => ({
              kind: "answered",
              result: answered,
            }))
          : authorizedDiscovery(environment, view, previous?.state, target, call)
      ).pipe(Effect.result);

      const now = yield* Clock.currentTimeMillis;

      if (Result.isFailure(result)) {
        store.putStatus(hostFailureStatus(conn, result.failure.message, previous, now));

        return;
      }

      // No token to connect with: no call was made, and the server is left in the state the sign-in's answer says.
      if (result.success.kind === "blocked") {
        const { state, message } = result.success;

        store.putStatus(failedStatus(conn, state, message, previous, now));

        return;
      }

      const answered = result.success.result;

      // A refresh that found no running process (a stopped Container, a Workspace gone) leaves the server as it was: its
      // state and inventory stand, nothing counts as a failure, and it is asked again a minute on.
      if (!mayStart && workspace !== undefined && foundNotRunning(answered)) {
        store.putStatus({
          ...(previous ?? { conn, state: "not_discovered", since: started, failures: 0 }),
          nextRetryAt: now + RETRY_FLOOR_MS,
        });

        if (isWorkspaceGone(answered)) yield* processEnded(conn, workspace, undefined);

        return;
      }

      yield* storeDiscoveryResult(conn, answered, previous, now, workspace);
    });

    yield* discovery.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(DISCOVERY_DEADLINE_MS),
        orElse: () => giveUp,
      }),
      Effect.onInterrupt(() => restore),
    );
  }).pipe(
    Effect.andThen(refreshVersions),
    Effect.tap(() => annotateEnd(view.server.conn)),
    Effect.withSpan("mcp.discover", { attributes: discoverAttributes(view, cause) }),
  );

type DiscoverAttributes = { server: string; "mcp.cause_trace_id"?: string };

/** What a discovery's span starts with: the server's name, and the trace that caused it, when known. */
const discoverAttributes = (view: ServerView, cause: string | undefined) => {
  const attributes: DiscoverAttributes = { server: view.server.name };

  if (cause !== undefined) attributes["mcp.cause_trace_id"] = cause;

  return attributes;
};

/** The state a discovery left its server in, and its failures in a row: counts and names, never the error's text. */
const annotateEnd = (conn: string) =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const status = store.statuses().get(conn);

    if (status === undefined) return;

    yield* Effect.annotateCurrentSpan({
      "mcp.state": status.state,
      "mcp.failures": status.failures,
    });
  });

/**
 * Give up each discovery of this instance that held its slot past its deadline (its server held back 30 s, as for any
 * failure on the host's side), and return each `connecting` status older than
 * 120 s that no discovery of this instance holds to the state before it, with no backoff: the discovery died with the
 * instance that ran it. Reads fail their caller; a refused write halts background work.
 */
export const reviveStale = Effect.gen(function* () {
  const store = yield* McpHostStore;
  const discovery = yield* McpDiscovery;
  const now = yield* Clock.currentTimeMillis;

  const overdue = Arr.filter(
    [...discovery.startedAt],
    ([, startedAt]) => now - startedAt > DISCOVERY_DEADLINE_MS,
  );

  // Given up on the host's side like one that times out itself: put back, then held back a while.
  for (const [conn] of overdue) {
    yield* FiberMap.remove(discovery.fibers, conn);

    const current = store.statuses().get(conn);

    yield* writeOrHalt(() =>
      store.putStatus(hostFailureStatus(conn, PAST_DEADLINE, statusBefore(current), now)),
    );
  }

  for (const status of store.statuses().values()) {
    if (
      status.state === "connecting" &&
      now - status.since > STALE_CONNECTING_MS &&
      !FiberMap.hasUnsafe(discovery.fibers, status.conn)
    ) {
      yield* writeOrHalt(() => store.putStatus(statusBeforeConnecting(status)));
    }
  }
});

/** `effect` within `workspace`'s slots (at most 2 stdio discoveries at once), when it is for one. */
const inWorkspaceSlot = <A, E, R>(
  discovery: McpDiscoveryService,
  workspace: string | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  if (workspace === undefined) return effect;

  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const held = discovery.workspaceSlots.get(workspace) ?? {
        slots: Semaphore.makeUnsafe(MAX_STDIO_DISCOVERIES_PER_WORKSPACE),
        users: 0,
      };

      discovery.workspaceSlots.set(workspace, held);
      held.users += 1;

      return held;
    }),
    (held) => held.slots.withPermits(1)(effect),
    (held) =>
      Effect.sync(() => {
        held.users -= 1;

        if (held.users === 0) discovery.workspaceSlots.delete(workspace);
      }),
  );
};

/**
 * Start the discoveries of `views` that are due for `trigger`, unless storage failed before. One already in flight is
 * left to run. A storage failure in a discovery stops new ones.
 */
export const startDue = (
  environment: string,
  views: ReadonlyArray<ServerView>,
  trigger: Trigger,
  workspace?: string,
) =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const discovery = yield* McpDiscovery;
    const now = yield* Clock.currentTimeMillis;

    if (discovery.halted.value) return;

    // Each discovery goes on after this call, so it records the trace that caused it.
    const cause = yield* currentTraceId;
    const { lastUsedAt } = store.meta();
    const usedRecently = lastUsedAt !== undefined && now - lastUsedAt < RECENT_USE_MS;

    for (const view of views) {
      const { conn } = view.server;

      if (
        !FiberMap.hasUnsafe(discovery.fibers, conn) &&
        isDue(view, trigger, now, usedRecently, workspace)
      ) {
        // Its deadline counts from when it holds one of the 3 slots, not while it waits for one.
        const started = Effect.flatMap(Clock.currentTimeMillis, (at) =>
          Effect.sync(() => {
            discovery.startedAt.set(conn, at);
          }),
        );

        // A stdio discovery takes its Workspace's slot first, so one waiting for it holds none of the host's 3.
        yield* FiberMap.run(
          discovery.fibers,
          conn,
          inWorkspaceSlot(
            discovery,
            view.reach === "stdio" ? workspace : undefined,
            discovery.slots.withPermits(1)(
              Effect.andThen(started, discoverOne(environment, view, cause, workspace)),
            ),
          ).pipe(
            Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : halt)),
            Effect.ensuring(Effect.sync(() => discovery.startedAt.delete(conn))),
          ),
        );
      }
    }
  });

/**
 * Interrupt the discoveries in flight of `conns` and put the `connecting` status each left back to the state before it, so
 * the server reads as it did and may be started again at once (`startDue`, which leaves a running one alone). For a change
 * the running discovery did not know of (an MCP sign-in): what it would find was asked for with the token of before.
 */
export const restartable = (conns: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;

    yield* interrupt(conns);

    for (const conn of conns) {
      const status = store.statuses().get(conn);

      if (status?.state === "connecting") {
        yield* writeOrHalt(() => store.putStatus(statusBeforeConnecting(status)));
      }
    }
  });

/** Interrupt the discoveries of `conns` (their server changed or left, or a reload), or of every `conn`. */
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
