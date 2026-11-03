// The state of each server of the set (`docs/architecture/mcp-connections.md` → Discovery and the MCP inventory →
// States): how it is reached, the state it is reported in, when it is due a discovery, the status a failure leaves it
// in, and the inventory's versions over the set. Pure but for reading the store; the scheduler that acts on it is
// `discovery.ts`.
// @effect-diagnostics missingPipeableSignature:off -- the state's operations, not combinators.
import type { McpErrorWire, McpServerState } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { type Inventory, inventoryVersions, readInventory } from "./inventory.ts";
import { McpHostStore, type StatusRow, type StoredServer } from "./store.ts";
import { DAY_MS, MINUTE_MS, SECOND_MS } from "./time.ts";

/** An HTTP server new to the set is discovered at once only if a Session used the host within 24 h. */
export const RECENT_USE_MS = DAY_MS;

/** A `connecting` status older than this at wake belongs to a discovery that died with its instance. */
export const STALE_CONNECTING_MS = 120 * SECOND_MS;

/** `unavailable`'s backoff: 30 s, 1, 2, 5, then 10 min. */
export const BACKOFF_MS: ReadonlyArray<number> = [
  30 * SECOND_MS,
  MINUTE_MS,
  2 * MINUTE_MS,
  5 * MINUTE_MS,
  10 * MINUTE_MS,
];

/** How long a failure on the host's side holds a server back from another try on demand, every time: 30 s. */
export const HOST_FAILURE_HOLD_MS = 30 * SECOND_MS;

/** A `failed` server is retried at most once a minute; a `skipped` one is looked at again after a minute. */
export const RETRY_FLOOR_MS = MINUTE_MS;

/** A status error is cut at 300 characters. */
export const MAX_ERROR = 300;

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

/** The servers of the set and the inventory's versions over them, as stored now. */
export const currentVersions = Effect.gen(function* () {
  const views = yield* viewServers;

  return { views, versions: versionsOf(views) };
});

/**
 * What makes a discovery due: a demand (a Session's request, a status read), a set change, a reload, or a change of an MCP
 * sign-in (`signed_in`, `replaced`, `rebound`, or a pull that finds the sign-ins revision moved).
 */
export type Trigger = "demand" | "set" | "reload" | "sign_in";

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

  // A sign-in changed: what waited for one, or could not refresh, is asked at once (`failed` at most once a minute).
  if (trigger === "sign_in") {
    return (
      status !== undefined &&
      Match.value(status.state).pipe(
        Match.whenOr("sign_in", "rejected", "unavailable", () => true),
        Match.whenOr("failed", "unknown", () => now - status.since >= RETRY_FLOOR_MS),
        Match.orElse(() => false),
      )
    );
  }

  if (status === undefined) return trigger === "demand" || usedRecently;

  // A backoff, or a failure on the host's side (the engine out of reach), holds any state back until it is over.
  if (status.nextRetryAt !== undefined && now < status.nextRetryAt) return false;

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
    Match.whenOr("unavailable", "skipped", () => true),
    Match.whenOr(
      "failed",
      "unknown",
      () => trigger === "set" && now - status.since >= RETRY_FLOOR_MS,
    ),
    Match.exhaustive,
  );
};

/** `message` cut to fit a status's error. */
export const truncateError = (message: string) => message.slice(0, MAX_ERROR);

/**
 * The status a failure on the host's side leaves the server in (the engine out of reach or silent, the host's own
 * invocation ended): not the server's failure, so its state and failures stay as they were, and it is held back from
 * another try on demand for `HOST_FAILURE_HOLD_MS`, with no growth.
 */
export const hostFailureStatus = (
  conn: string,
  message: string,
  previous: StatusRow | undefined,
  now: number,
): StatusRow => ({
  conn,
  state: previous?.state ?? "not_discovered",
  error: truncateError(message),
  since: previous?.since ?? now,
  failures: previous?.failures ?? 0,
  nextRetryAt: now + HOST_FAILURE_HOLD_MS,
  lastOkAt: previous?.lastOkAt,
});

/** The status a failure leaves the server in, from the one before it. */
export const failedStatus = (
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
    error: truncateError(message),
    since: now,
    failures,
    nextRetryAt,
    lastOkAt: previous?.lastOkAt,
  };
};

/** The state a failed discovery leaves a server in (`docs/architecture/mcp-connections.md` → States). */
export const stateOfError = (error: McpErrorWire): McpServerState =>
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
