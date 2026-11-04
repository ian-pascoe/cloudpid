// The Resource watches the host holds (`docs/architecture/mcp-in-a-session.md` → Resource watches, ADR-0032;
// `docs/architecture/mcp-connections.md` → Requests and Legacy sessions → Listens): a watch is a row (`watch-store.ts`)
// with the SHA-256 of what the agent last read, and the host keeps ONE listen per server instance (a `conn` and, for a
// stdio server, the Workspace whose process it is), shared by every watch on it.
//
// - **Held while its conversations run:** a listen is open only while a watching conversation has made a request in
//   the last 15 min (a timer closes it, and every entry into the host sweeps for what the timer missed), and swapped
//   for a new one when it is older than 10 min. A Modern swap opens the new listen, waits for its acknowledgement, then
//   closes the old; a Legacy session allows one GET stream, so a Legacy swap closes the old one first.
// - **Gaps are checked by re-reading:** any span without the listen (between Runs, a deploy, an eviction, a new HTTP
//   session) is a gap. When a listen opens with none before it (or a Legacy one replaces another), every active watch
//   of the server is read again, at most 6 at a time, and marked changed when its SHA-256 differs from the baseline; a
//   read that fails (or is over the 16 MiB every read is bound by) marks it unchecked. A watch already marked changed
//   is not read again.
// - **Marks:** an event is a flag plus at most 3 sub-resource URIs, so a duplicate is harmless; the mark waits for the
//   conversation's next `requestStart`, and its own next read of the URI makes the new baseline and clears it. A list
//   change the listen hears expires the server's inventory and drops its cached lists.
// - **Ends** are told at the conversation's next `requestStart` (`mcp_watch_ends`), except a silent one.
// - The host's listens and checks run in its runtime's scope: an instance replaced, or evicted, drops them all, and the
//   next request start of a watching conversation opens them again.
// @effect-diagnostics missingPipeableSignature:off missedPipeableOpportunity:off -- steps of the host's methods, not combinators.
import { signsInOnItsOwn } from "@cloudpid/config";
import {
  EraRowV1,
  type McpCaller,
  type McpEngineState,
  McpListenEvent,
  type McpListenFilter,
  type McpWatchChange,
  type McpWatchEnd,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { hasOwnAuthorization, withBearer } from "./discovery-auth.ts";
import {
  attemptOrHalt,
  halt,
  isHalted,
  type McpDiscovery,
  targetOf,
  type McpDiscoveryServices,
  writeOrHalt,
} from "./discovery.ts";
import { sendToEngine } from "./engine-round.ts";
import { McpEngineClient } from "./engine.ts";
import { McpListCache } from "./list-cache.ts";
import { type ServerView, viewServers } from "./server-state.ts";
import { processEnded } from "./stdio.ts";
import { McpHostStore } from "./store.ts";
import { DAY_MS, MINUTE_MS, SECOND_MS } from "./time.ts";
import { McpTokens } from "./tokens.ts";
import {
  MAX_SUB_URIS,
  MAX_WATCHES_PER_CONVERSATION,
  MAX_WATCHES_PER_ENVIRONMENT,
  WATCH_MARK,
  type WatchKey,
  type WatchRow,
} from "./watch-store.ts";

/** What ending watches needs: the storage, the listens, and the discoveries' halt. */
export type WatchServices = McpHostStore | McpDiscovery | McpListens;

/** A listen is held while a watching conversation has made a request within this long. */
export const WATCH_HOLD_MS = 15 * MINUTE_MS;

/** A listen older than this is swapped for a new one at the next request start of a watching conversation. */
export const LISTEN_SWAP_MS = 10 * MINUTE_MS;

/** A watch whose conversation made no request for this long ends, swept at `requestStart` and `apply`. */
export const WATCH_EXPIRY_MS = 7 * DAY_MS;

/** A server that could not be listened to for this long has its watches ended. */
export const LISTEN_FAILING_MS = 60 * MINUTE_MS;

/** At most this many re-reads of a gap check run at once. */
export const GAP_CHECKS_AT_ONCE = 6;

/** What a re-read of a gap check waits for at most. */
const REREAD_TIMEOUT_MS = 30 * SECOND_MS;

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(McpListenEvent));

const decodeEra = Schema.decodeUnknownOption(EraRowV1);

/** One open listen: what its filter asked, when it opened and how to close it. */
type Handle = {
  readonly id: number;
  readonly site: ListenSite;
  readonly openedAt: number;
  readonly uris: ReadonlyArray<string>;
  readonly era: "modern" | "legacy";
  /** Close the listen at the engine and stop reading it; idempotent, never fails. */
  readonly close: () => Promise<void>;
};

export type McpListensService = {
  /** The open listens, by `listenKey`. */
  readonly handles: Map<string, Handle>;
  /** The fibers that read listens, time their hold and check gaps, by name. */
  readonly fibers: FiberMap.FiberMap<string>;
  /** One open or swap at a time per server instance. */
  readonly locks: Map<string, Semaphore.Semaphore>;
  /** Since when each server instance's listen has failed to open, for the hour after which its watches end. */
  readonly failingSince: Map<string, number>;
  readonly counter: { next: number };
};

/** The host's listens, kept in its runtime's scope. Internal to the host. */
export class McpListens extends Context.Service<McpListens, McpListensService>()(
  "@cloudpid/server/mcp/watches/McpListens",
) {
  static readonly layer = Layer.effect(
    McpListens,
    Effect.gen(function* () {
      return {
        handles: new Map<string, Handle>(),
        fibers: yield* FiberMap.make<string>(),
        locks: new Map<string, Semaphore.Semaphore>(),
        failingSince: new Map<string, number>(),
        counter: { next: 1 },
      };
    }),
  );
}

/** A server instance a listen is held on: the Environment it is for, its `conn` and, for a stdio server, its Workspace. */
export type ListenSite = {
  readonly environment: string;
  readonly conn: string;
  /** The Workspace of a stdio server's process; undefined for an HTTP server. */
  readonly workspace: string | undefined;
};

type Instance = Pick<ListenSite, "conn" | "workspace">;

/** The server instance a watch row is on: its storage spells no Workspace `""`, which is the one place that is read. */
const instanceOf = (row: Pick<WatchRow, "conn" | "workspace">): Instance => ({
  conn: row.conn,
  workspace: row.workspace === "" ? undefined : row.workspace,
});

const siteOf = (environment: string, row: Pick<WatchRow, "conn" | "workspace">): ListenSite => ({
  environment,
  ...instanceOf(row),
});

/** What a server instance's listen is kept under: the one place the key is made. */
const listenKey = (instance: Instance) => `${instance.conn}\0${instance.workspace ?? ""}`;

const onInstance = (instance: Instance) => (row: Pick<WatchRow, "conn" | "workspace">) =>
  row.conn === instance.conn && row.workspace === (instance.workspace ?? "");

const sameWatch = (a: WatchKey) => (b: WatchKey) =>
  a.session === b.session &&
  a.conversation === b.conversation &&
  a.server === b.server &&
  a.uri === b.uri;

/** The URIs of `rows`, each once, sorted: what a listen's filter asks. */
const urisOf = (rows: ReadonlyArray<WatchRow>) =>
  Arr.sort(Arr.dedupe(Arr.map(rows, (row) => row.uri)), Order.String);

const sameUris = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && Arr.every(a, (uri, index) => uri === b[index]);

/** The watches on `instance`; throws when the storage refuses the read, so only a caller that halts on it uses this. */
const rowsOf = (store: { readonly watches: () => ReadonlyArray<WatchRow> }, instance: Instance) =>
  Arr.filter(store.watches(), onInstance(instance));

/**
 * The watches on `instance`, or undefined when the storage refuses the read: a refusal halts background work, like any
 * failed storage operation (`discovery.ts` → `halt`), and fails no one.
 */
const rowsOrHalt = (
  store: { readonly watches: () => ReadonlyArray<WatchRow> },
  instance: Instance,
) => attemptOrHalt(() => rowsOf(store, instance));

/** Every watch, or undefined when the storage refuses the read (which halts background work). */
const watchesOrHalt = (store: { readonly watches: () => ReadonlyArray<WatchRow> }) =>
  attemptOrHalt(() => store.watches());

/**
 * Run background work (a listen's reader, its hold timer, a gap check): a failure that is not an interruption halts
 * background work, as every failed storage operation does, and ends only this work.
 */
const haltOnFailure = <R>(work: Effect.Effect<void, never, R>) =>
  work.pipe(Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : halt)));

/** When a server instance's listen is no longer held: 15 min after its most recent watching request. */
const holdDeadline = (rows: ReadonlyArray<WatchRow>) =>
  Arr.reduce(rows, 0, (latest, row) => Math.max(latest, row.lastRequestAt)) + WATCH_HOLD_MS;

/** Close the listen of `key`, if one is open. */
const closeListen = (key: string) =>
  Effect.gen(function* () {
    const listens = yield* McpListens;
    const handle = listens.handles.get(key);

    listens.handles.delete(key);
    yield* FiberMap.remove(listens.fibers, `hold\0${key}`);

    if (handle !== undefined) yield* Effect.promise(handle.close);
  });

/** Close every listen and stop every fiber of them: the host is wiped, or goes. */
export const closeListens = Effect.gen(function* () {
  const listens = yield* McpListens;
  const open = [...listens.handles.values()];

  listens.handles.clear();
  listens.failingSince.clear();
  yield* FiberMap.clear(listens.fibers);
  yield* Effect.forEach(open, (handle) => Effect.promise(handle.close), { discard: true });
});

/** Close the listens of the server instances `keys` that no watch is left on. */
const closeUnwatched = (instances: ReadonlyArray<Instance>) =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const rows = yield* watchesOrHalt(store);

    // Nothing is closed on a read that failed: the listens are closed by their timers and at the next sweep.
    if (rows === undefined) return;

    for (const key of Arr.dedupe(Arr.map(instances, listenKey))) {
      if (!Arr.some(rows, (row) => listenKey(instanceOf(row)) === key)) {
        yield* closeListen(key);
      }
    }
  });

/**
 * End `rows`: noted for their conversations' next `requestStart` as ended with `reason` unless `silent`, then dropped;
 * the listens nothing is watched on any more close. How many ended.
 */
export const endWatches = (
  rows: ReadonlyArray<WatchRow>,
  reason: string,
  silent = false,
): Effect.Effect<number, never, WatchServices> =>
  Effect.gen(function* () {
    if (rows.length === 0) return 0;

    const store = yield* McpHostStore;
    const now = yield* Clock.currentTimeMillis;

    yield* writeOrHalt(() => {
      if (!silent) {
        store.putWatchEnds(
          Arr.map(rows, ({ session, conversation, server, uri }) => ({
            session,
            conversation,
            server,
            uri,
            reason,
            at: now,
          })),
        );
      }

      store.dropWatches(rows);
    });

    yield* closeUnwatched(Arr.map(rows, instanceOf));

    return rows.length;
  });

/**
 * What the listen's event `event` does to the watches on `site`: an update marks the watch of its URI
 * changed, and the watches of the resources under it (a URI that has it as a directory) with the sub-resource URI, at
 * most 3 each; a list change expires the server's inventory, so its next demand lists again, and drops its cached lists.
 */
const heard = (site: ListenSite, event: McpListenEvent) =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const cache = yield* McpListCache;

    if (event.kind === "list_changed") {
      yield* writeOrHalt(() => store.expireInventory([site.conn]));
      cache.dropServer({ conn: site.conn, workspace: site.workspace });

      return;
    }

    if (!Predicate.hasProperty(event, "uri") || !Predicate.isString(event.uri)) return;

    const { uri } = event;

    yield* writeOrHalt(() => {
      for (const row of rowsOf(store, site)) {
        if (row.state !== "active") continue;

        const parent = row.uri.endsWith("/") ? row.uri : `${row.uri}/`;

        if (row.uri === uri) {
          store.putWatch({ ...row, mark: WATCH_MARK.changed });
        } else if (uri.startsWith(parent)) {
          const subUris =
            row.subUris.includes(uri) || row.subUris.length >= MAX_SUB_URIS
              ? row.subUris
              : [...row.subUris, uri];

          store.putWatch({ ...row, mark: WATCH_MARK.changed, subUris });
        }
      }
    });
  });

/** Read `events` (a listen's lines) until it ends, telling `heard` of each; then forget the listen if it is still the open one. */
const readEvents = (
  key: string,
  id: number,
  site: ListenSite,
  events: ReadableStream<Uint8Array>,
) =>
  Effect.gen(function* () {
    const listens = yield* McpListens;
    const reader = events.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const lines = (text: string) => {
      buffer += text;

      const parts = buffer.split("\n");

      buffer = parts.pop() ?? "";

      return Arr.filter(parts, (line) => line.trim() !== "");
    };

    const loop = Effect.gen(function* () {
      while (true) {
        const chunk = yield* Effect.tryPromise(() => reader.read());

        if (chunk.done) return;

        for (const line of lines(decoder.decode(chunk.value, { stream: true }))) {
          const event = decodeEvent(line);

          if (Option.isSome(event)) yield* heard(site, event.value);
        }
      }
    });

    yield* loop.pipe(
      Effect.ignoreCause,
      // The listen ended (the server closed it, or it broke): forget it, and close what is left of it at the engine.
      Effect.ensuring(
        Effect.suspend(() => {
          const handle = listens.handles.get(key);

          if (handle?.id !== id) return Effect.void;

          listens.handles.delete(key);

          return Effect.promise(handle.close);
        }),
      ),
    );
  });

/** The `Unsupported` and other failures of a listen, as the reason a watch is not held. */
type NotListening = { readonly message: string };

/** Whether the server `view` speaks the Legacy era as its era row says: its listen cannot overlap another. */
const isLegacy = (row: Schema.Json | undefined) =>
  Option.exists(decodeEra(row), (era) => era.era === "legacy");

/**
 * The target a listen or a re-read of `view`'s server goes to: its own, a stdio server's without starting its Container,
 * an HTTP server's with its MCP sign-in's token as the `Authorization` header (a background call has no token hook: a
 * function stub does not outlive its invocation, #409). Why not, when there is none to call with.
 */
const listenTarget = (environment: string, view: ServerView, workspace: string | undefined) =>
  Effect.gen(function* () {
    const target = yield* targetOf(environment, view.server, workspace, false);

    if (Result.isFailure(target))
      return Result.fail<NotListening>({ message: target.failure.message });

    const reached = target.success;

    if (reached.kind !== "http" || hasOwnAuthorization(reached)) return Result.succeed(reached);

    const tokens = yield* McpTokens;

    const access = yield* tokens.access({
      environment,
      server: view.server.name,
      url: reached.url,
    });

    if (access.kind === "token")
      return Result.succeed<typeof reached>(withBearer(reached, access.token));

    if (
      signsInOnItsOwn(view.server.server) ||
      view.state === "sign_in" ||
      view.state === "rejected"
    ) {
      return Result.fail<NotListening>({ message: "The server needs you signed in" });
    }

    return Result.succeed(reached);
  });

/**
 * The SHA-256 of what `uri` reads now on the server instance, or why it could not be checked: a re-read made as the host
 * (`origin: "host"`), at background priority, never starting a stdio server's Container.
 */
const reread = Effect.fn("mcp.gap_check.read")(function* (
  environment: string,
  view: ServerView,
  views: ReadonlyArray<ServerView>,
  workspace: string | undefined,
  uri: string,
) {
  const target = yield* listenTarget(environment, view, workspace);

  if (Result.isFailure(target)) return undefined;

  const sent = yield* sendToEngine({
    resolved: { environment, view, views, workspace },
    reached: { target: target.success, access: { kind: "open", answered: () => Effect.void } },
    request: {
      op: "resources/read",
      uri,
      ctx: workspace === undefined ? { origin: "host" } : { origin: "host", workspace },
    },
    hooks: {},
    mayHaveRun: false,
    priority: "background",
    timeoutMs: REREAD_TIMEOUT_MS,
    what: "The re-read",
  });

  if (Result.isFailure(sent)) return undefined;

  const { result } = sent.success;

  if (result.kind !== "complete") return undefined;

  // A read over 1 MiB comes as a stream nobody reads: its hash is all the check needs.
  const value = result.result;

  if (value.kind === "stream")
    yield* Effect.promise(() => value.body.cancel().catch(() => undefined));

  return result.sha256;
});

/**
 * Check the gap of the server instance `site`: read each URI of its active watches again (at most 6 at a time), and mark
 * the watches whose SHA-256 differs from their baseline changed, and those whose read failed unchecked ("could not be
 * checked; may have changed"). A watch already marked changed is not read for: what it says is told already.
 */
const gapCheck = Effect.fn("mcp.gap_check")(function* (site: ListenSite) {
  const store = yield* McpHostStore;
  const rows = yield* rowsOrHalt(store, site);

  const watched = Arr.filter(
    rows ?? [],
    (row) => row.state === "active" && row.mark !== WATCH_MARK.changed,
  );

  if (watched.length === 0) return;

  const views = yield* viewServers;
  const view = Arr.findFirst(views, (each) => each.server.conn === site.conn);

  if (Option.isNone(view)) return;

  const uris = urisOf(watched);

  yield* Effect.annotateCurrentSpan({ "mcp.gap_check.watches": uris.length });

  const hashes = yield* Effect.forEach(
    uris,
    (uri) => reread(site.environment, view.value, views, site.workspace, uri),
    { concurrency: GAP_CHECKS_AT_ONCE },
  );

  yield* writeOrHalt(() => {
    // The rows as they are now: a read of the agent's own may have made a new baseline while the checks ran.
    for (const row of rowsOf(store, site)) {
      const index = uris.indexOf(row.uri);

      if (index < 0 || row.state !== "active" || row.mark === WATCH_MARK.changed) continue;

      const hash = hashes[index];

      if (hash === undefined) {
        if (row.mark === WATCH_MARK.none) store.putWatch({ ...row, mark: WATCH_MARK.unchecked });
      } else if (hash !== row.hash) {
        store.putWatch({ ...row, mark: WATCH_MARK.changed });
      }
    }
  });
});

/** How a listen was opened for a server instance: it holds, or why not, and the URIs its server left out of the acknowledgement. */
export type Ensured = Result.Result<{ readonly refused: ReadonlyArray<string> }, NotListening>;

/** Remove from `rows` the watches the server's acknowledgement left out: pending ones are refused, active ones end. */
const settleHonored = (rows: ReadonlyArray<WatchRow>, honored: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const left = Arr.filter(rows, (row) => !honored.includes(row.uri));
    const active = Arr.filter(left, (row) => row.state === "active");

    yield* endWatches(active, "the server no longer sends updates for it");

    return Arr.map(left, (row) => row.uri);
  });

/**
 * Make the listen of the server instance (`conn`, `workspace`) the one its watches want: none when no conversation
 * watching it has made a request in the last 15 min or none watches it, else one whose filter names the URIs watched on
 * it, opened when there is none, or swapped when it is older than 10 min or the URIs changed. A new listen with none
 * before it, or a Legacy one that replaced another, is followed by a gap check. A listen that cannot be opened is no
 * more than that; after an hour of it the watches end. One open or swap at a time per server instance.
 */
export const ensureListen = (
  site: ListenSite,
): Effect.Effect<Ensured, never, McpDiscoveryServices> =>
  Effect.gen(function* () {
    const listens = yield* McpListens;
    const key = listenKey(site);

    const lock = listens.locks.get(key) ?? Semaphore.makeUnsafe(1);

    listens.locks.set(key, lock);

    return yield* lock.withPermits(1)(openListen(site, key));
  }).pipe(Effect.withSpan("mcp.listen"));

const openListen = (
  site: ListenSite,
  key: string,
): Effect.Effect<Ensured, never, McpDiscoveryServices> =>
  Effect.gen(function* () {
    const listens = yield* McpListens;
    const store = yield* McpHostStore;
    const engine = yield* McpEngineClient;
    const now = yield* Clock.currentTimeMillis;
    const { environment, conn, workspace } = site;
    const found = yield* rowsOrHalt(store, site);

    // Watches that cannot be read are not listened for: the read halted background work.
    if (found === undefined) {
      return Result.fail<NotListening>({ message: "The host cannot read its watches now" });
    }

    const rows = found;
    const held = listens.handles.get(key);

    if (rows.length === 0 || holdDeadline(rows) <= now) {
      yield* closeListen(key);

      return Result.succeed({ refused: [] });
    }

    // A host whose storage failed starts nothing in the background.
    if (yield* isHalted) {
      return Result.fail<NotListening>({ message: "The host cannot open a listen now" });
    }

    const uris = urisOf(rows);

    if (held !== undefined && sameUris(held.uris, uris) && now - held.openedAt < LISTEN_SWAP_MS) {
      return Result.succeed({ refused: [] });
    }

    const views = yield* viewServers;
    const view = Arr.findFirst(views, (each) => each.server.conn === conn);

    if (Option.isNone(view))
      return Result.fail<NotListening>({ message: "The server is no longer in the set" });

    const target = yield* listenTarget(environment, view.value, workspace);

    if (Result.isFailure(target)) return Result.fail(target.failure);

    // A Legacy session allows one GET stream: the old listen ends before the new one opens, and the gap is checked.
    const legacy =
      held?.era === "legacy" || (held === undefined && isLegacy(store.prior(conn, workspace).era));

    if (held !== undefined && legacy) yield* closeListen(key);

    const stop = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stop.writable.getWriter();

    const filter: McpListenFilter = {
      resourceSubscriptions: uris,
      toolsListChanged: true,
      promptsListChanged: true,
      resourcesListChanged: true,
    };

    const answer = yield* engine
      .listen(target.success, store.prior(conn, workspace), filter, stop.readable)
      .pipe(Effect.result);

    const keepState = (state: McpEngineState, spawn: string | undefined) =>
      Effect.gen(function* () {
        const ended = yield* attemptOrHalt(() =>
          store.applyEngineState(
            conn,
            state,
            now,
            workspace === undefined ? undefined : { workspace, spawn },
          ),
        );

        // The stdio process the watches were on is gone: they end, and are never resumed on its successor.
        if (workspace !== undefined && ended !== undefined) {
          yield* processEnded(conn, workspace, ended);
        }
      });

    const failed = (message: string) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writer.close().catch(() => undefined));

        const since = listens.failingSince.get(key) ?? now;

        listens.failingSince.set(key, since);

        if (now - since >= LISTEN_FAILING_MS) {
          listens.failingSince.delete(key);
          yield* endWatches(rowsOf(store, site), `the server could not be listened to: ${message}`);
        }

        return Result.fail<NotListening>({ message });
      });

    if (Result.isFailure(answer)) return yield* failed(answer.failure.message);

    const listened = answer.success;

    if (listened.kind === "failed") {
      yield* keepState(listened.state, listened.spawn);

      return yield* failed(listened.error.message);
    }

    yield* keepState(listened.state, listened.spawn);
    listens.failingSince.delete(key);

    const id = listens.counter.next++;
    const reader = listened.events;

    const handle: Handle = {
      id,
      site,
      openedAt: now,
      uris,
      era: listened.era,
      close: () =>
        Promise.all([writer.close(), reader.cancel()]).then(
          () => undefined,
          () => undefined,
        ),
    };

    // The old Modern listen closes once the new one has acknowledged, so there is no span without one.
    listens.handles.set(key, handle);
    yield* FiberMap.run(listens.fibers, `read\0${key}\0${id}`, readEvents(key, id, site, reader));
    yield* FiberMap.run(listens.fibers, `hold\0${key}`, haltOnFailure(holdTimer(site)));

    if (held !== undefined && !legacy) yield* Effect.promise(held.close);

    const left = rowsOf(store, site);
    const honoredUris = listened.honored.resourceSubscriptions ?? [];
    const refused = yield* settleHonored(left, honoredUris);

    if (held === undefined || legacy) {
      yield* FiberMap.run(listens.fibers, `gap\0${key}`, haltOnFailure(gapCheck(site)));
    }

    return Result.succeed({ refused });
  }).pipe(
    Effect.catchCause((cause) =>
      // A failure that is no interruption may be the storage's: it halts background work like any failed operation.
      Effect.logWarning("A listen could not be opened", cause).pipe(
        Effect.andThen(Cause.hasInterruptsOnly(cause) ? Effect.void : halt),
        Effect.as(Result.fail<NotListening>({ message: "The listen could not be opened" })),
      ),
    ),
  );

/** Close the listen of `site` once nothing watching it has made a request for 15 min; the time it stays open is the one the rows say. */
const holdTimer = (site: ListenSite): Effect.Effect<void, never, WatchServices> =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const key = listenKey(site);

    while (true) {
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* rowsOrHalt(store, site);

      // A read the storage refused leaves the listen to the next sweep.
      if (rows === undefined) return;

      const deadline = holdDeadline(rows);

      if (deadline <= now) {
        const listens = yield* McpListens;
        const handle = listens.handles.get(key);

        // Not `closeListen`: it removes this timer's own fiber, which would end it before the stream is closed.
        listens.handles.delete(key);

        if (handle !== undefined) yield* Effect.promise(handle.close);

        return;
      }

      yield* Effect.sleep(deadline - now);
    }
  });

/** Close the listens nothing has held for 15 min: the sweep of every entry into the host, for what its timers have not reached. */
export const sweepListens = Effect.gen(function* () {
  const listens = yield* McpListens;
  const store = yield* McpHostStore;
  const now = yield* Clock.currentTimeMillis;

  for (const [key, { site }] of listens.handles) {
    if (holdDeadline(rowsOf(store, site)) <= now) yield* closeListen(key);
  }
});

/**
 * The watches whose server left the set or was switched off or `hidden` or changed end ("server changed"); those whose
 * server wants a sign-in end ("signed out"). Run at every request start and after a set change or a sign-in change.
 */
export const reconcileWatches = (
  views: ReadonlyArray<ServerView>,
): Effect.Effect<void, never, WatchServices> =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const rows = store.watches();

    const byConn = (row: WatchRow) => Arr.findFirst(views, (view) => view.server.conn === row.conn);

    yield* endWatches(
      Arr.filter(rows, (row) =>
        Option.match(byConn(row), { onNone: () => true, onSome: (view) => view.reach === "off" }),
      ),
      "server changed",
    );

    yield* endWatches(
      Arr.filter(store.watches(), (row) =>
        Option.exists(byConn(row), (view) => view.state === "sign_in"),
      ),
      "signed out",
    );
  });

/** Every watch of `servers` (names, or all when none) ends: their sign-in was signed out of. */
export const endSignedOut = (conns: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;

    yield* endWatches(
      Arr.filter(store.watches(), (row) => conns.includes(row.conn)),
      "signed out",
    );
  });

/** A stdio server's child ended (`McpProcessEnded`): the watches on its spawn id, or all in its Workspace when it is gone, end. */
export const endProcessWatches = (conn: string, workspace: string, spawn: string | undefined) =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const rows = yield* rowsOrHalt(store, { conn, workspace });

    yield* endWatches(
      Arr.filter(rows ?? [], (row) => spawn === undefined || row.spawn === spawn),
      "server process ended",
    );
  });

/**
 * `apply({ kind: "end_watches" })`: end the watches of `session` (narrowed by conversation, server and URI as given).
 * Unless silent they are noted as ended with `reason`.
 */
export const endSessionWatches = (
  filter: {
    readonly session: string;
    readonly conversation?: string | undefined;
    readonly server?: string | undefined;
    readonly uri?: string | undefined;
  },
  reason: string,
  silent: boolean,
) =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;

    return yield* endWatches(
      Arr.filter(
        store.watches(),
        (row) =>
          row.session === filter.session &&
          (filter.conversation === undefined || row.conversation === filter.conversation) &&
          (filter.server === undefined || row.server === filter.server) &&
          (filter.uri === undefined || row.uri === filter.uri),
      ),
      reason,
      silent,
    );
  });

/** Sweep the watches no request has touched for 7 days, noted as ended for their conversations. */
export const sweepExpired = Effect.gen(function* () {
  const store = yield* McpHostStore;
  const now = yield* Clock.currentTimeMillis;

  yield* endWatches(
    Arr.filter(store.watches(), (row) => row.lastRequestAt < now - WATCH_EXPIRY_MS),
    "not used for 7 days",
  );
});

/**
 * What `requestStart` tells the conversation `caller` of its watches: the ones marked since its last request start, and
 * the ends noted for it, both told once. Its watches are touched (they are held for 15 min more) and their listens
 * opened or swapped in the background, so the start never waits for a connect or a gap check; what the checks find is
 * told at the next request start.
 */
export const takeWatches = (
  environment: string | undefined,
  caller: McpCaller,
  views: ReadonlyArray<ServerView>,
): Effect.Effect<
  {
    readonly changed: ReadonlyArray<string>;
    readonly ended: ReadonlyArray<string>;
    readonly changes: ReadonlyArray<McpWatchChange>;
    readonly ends: ReadonlyArray<McpWatchEnd>;
  },
  never,
  McpDiscoveryServices
> =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const listens = yield* McpListens;
    const now = yield* Clock.currentTimeMillis;

    yield* sweepExpired;
    yield* reconcileWatches(views);
    yield* sweepListens;

    const mine = Arr.filter(
      store.watches(),
      (row) => row.session === caller.session && row.conversation === caller.conversation,
    );

    const changes = Arr.filterMap(mine, (row) =>
      row.mark === WATCH_MARK.none
        ? Result.failVoid
        : Result.succeed<McpWatchChange>({
            server: row.server,
            uri: row.uri,
            subUris: row.subUris,
            unchecked: row.mark === WATCH_MARK.unchecked,
          }),
    );

    const ends = yield* attemptOrHalt(() =>
      Arr.map(store.takeWatchEnds(caller.session, caller.conversation), (end): McpWatchEnd => ({
        server: end.server,
        uri: end.uri,
        reason: end.reason,
      })),
    );

    yield* writeOrHalt(() => {
      for (const row of mine) {
        store.putWatch({ ...row, mark: WATCH_MARK.none, subUris: [], lastRequestAt: now });
      }
    });

    if (environment !== undefined) {
      const all: ReadonlyArray<ListenSite> = Arr.map(mine, (row) => siteOf(environment, row));
      const sites = Arr.dedupeWith(all, (a, b) => listenKey(a) === listenKey(b));

      for (const site of sites) {
        yield* FiberMap.run(
          listens.fibers,
          `ensure\0${listenKey(site)}`,
          ensureListen(site).pipe(Effect.asVoid),
          { onlyIfMissing: true },
        );
      }
    }

    return {
      changed: Arr.map(changes, (change) => change.uri),
      ended: Arr.map(ends ?? [], (end) => end.uri),
      changes,
      ends: ends ?? [],
    };
  });

/** Keep `row`: whether the storage kept it. A refusal halts background work, like any failed storage operation. */
const putWatchOrHalt = (store: { readonly putWatch: (row: WatchRow) => void }, row: WatchRow) =>
  Effect.map(
    attemptOrHalt(() => {
      store.putWatch(row);

      return true;
    }),
    (kept) => kept === true,
  );

/** What a watch that is asked for in a read comes to before the read: held on the row, or why it is not. */
export type WatchBegun =
  | { readonly kind: "held"; readonly key: WatchKey; readonly isNew: boolean }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Begin the watch `key` for a read with `watch: true` on the server instance (`conn`, `workspace`): over a cap it is
 * refused, else its row is stored pending, and the server's listen is opened or swapped to name its URI, which a server
 * that cannot send updates, or leaves the URI out of its acknowledgement, refuses (the pending row goes).
 */
export const beginWatch = (
  environment: string,
  key: WatchKey,
  where: Instance,
): Effect.Effect<WatchBegun, never, McpDiscoveryServices> =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* watchesOrHalt(store);

    // The read still answers; its watch is not started, and the host halts.
    if (rows === undefined) {
      return { kind: "refused", reason: "not watched: the host could not read its watches" };
    }

    const existing = Arr.findFirst(rows, sameWatch(key));

    if (Option.isNone(existing)) {
      if (
        Arr.length(
          Arr.filter(
            rows,
            (row) => row.session === key.session && row.conversation === key.conversation,
          ),
        ) >= MAX_WATCHES_PER_CONVERSATION
      ) {
        return {
          kind: "refused",
          reason: `not watched: this conversation already has ${MAX_WATCHES_PER_CONVERSATION} Resource watches`,
        } satisfies WatchBegun;
      }

      if (rows.length >= MAX_WATCHES_PER_ENVIRONMENT) {
        return {
          kind: "refused",
          reason: `not watched: this Environment already has ${MAX_WATCHES_PER_ENVIRONMENT} Resource watches`,
        } satisfies WatchBegun;
      }

      const stored = yield* putWatchOrHalt(store, {
        ...key,
        conn: where.conn,
        workspace: where.workspace ?? "",
        spawn: undefined,
        state: "pending",
        hash: undefined,
        mark: WATCH_MARK.none,
        subUris: [],
        startedAt: now,
        lastRequestAt: now,
      });

      if (!stored)
        return { kind: "refused", reason: "not watched: the host could not store the watch" };
    }

    const ensured = yield* ensureListen({ environment, ...where });

    const refusal = Result.isFailure(ensured)
      ? `not watched: ${ensured.failure.message}`
      : ensured.success.refused.includes(key.uri)
        ? "not watched: the server does not send updates for this resource"
        : undefined;

    if (refusal !== undefined) {
      // An active watch of the same key that the listen's trouble left is still the agent's: only a pending one goes.
      if (Option.isNone(existing)) {
        yield* writeOrHalt(() => store.dropWatches([key]));
        yield* closeUnwatched([where]);
      }

      return { kind: "refused", reason: refusal } satisfies WatchBegun;
    }

    return { kind: "held", key, isNew: Option.isNone(existing) } satisfies WatchBegun;
  });

/**
 * The read of a watched `key` ended. With contents (`sha256`), the watch is active with them as its baseline (a pending
 * watch becomes active; an active one's mark clears, since the agent has read what changed); without, a pending one is
 * dropped, "not watched: the read did not complete". Whether the watch is held now.
 */
export const settleRead = (
  key: WatchKey,
  read: { readonly sha256: string | undefined; readonly spawn: string | undefined },
): Effect.Effect<boolean, never, WatchServices> =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* watchesOrHalt(store);
    const row = Arr.findFirst(rows ?? [], sameWatch(key));

    // A watch that cannot be read is not held: the read answers, and the host halted.
    if (Option.isNone(row)) return false;

    if (read.sha256 === undefined) {
      if (row.value.state === "pending") {
        yield* writeOrHalt(() => store.dropWatches([key]));
        yield* closeUnwatched([instanceOf(row.value)]);

        return false;
      }

      return true;
    }

    return yield* putWatchOrHalt(store, {
      ...row.value,
      state: "active",
      hash: read.sha256,
      spawn: read.spawn ?? row.value.spawn,
      mark: WATCH_MARK.none,
      subUris: [],
      lastRequestAt: now,
    });
  });
