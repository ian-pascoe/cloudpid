// The host's list cache (`docs/architecture/mcp-in-a-session.md` → Resource tools, Listing is live;
// `docs/architecture/mcp-connections.md` → The list cache): the pages of `resources/list` and
// `resources/templates/list` a Modern server said may be kept, in the host object's memory.
//
// - **Bounds:** at most 4 MiB an entry, 4 MiB in one host object's cache, and 8 MiB in the isolate, the least recently
//   used dropped first. Every host object of an isolate (each `McpHost` Durable Object instance builds its own cache)
//   charges the one isolate budget, and when the isolate is over it the least recently used entry of all the caches
//   goes, whichever cache holds it. A value is measured by its JSON as UTF-8, which is what it weighs on the wire and
//   in storage; one that is over 4 MiB is not kept. A cache is in the budget while it holds an entry, so one whose host
//   object is gone (nothing tells the cache) is drained by the others' puts and then forgotten.
// - **Key:** (server instance, auth context, method, cursor). The server instance is the `conn` and, for a stdio server,
//   the Workspace whose process it is; the auth context is a SHA-256 over the URL, the access token and the headers
//   (`./resources.ts`), so one principal's page is never another's.
// - **Lifetime:** an entry lives for the server's `ttlMs`, capped at 24 h. It is dropped with its server: when the
//   definition changes (another `conn`), the server initializes again or speaks another protocol version (the `epoch` it
//   was read under is not the server's now), or its stdio process ends.
// - **Memory only:** the cache is the object's isolate, never its SQLite, so an eviction or a deploy empties it, and a
//   Legacy server's pages are never put in it (`./resources.ts` decides).
// @effect-diagnostics missingPipeableSignature:off -- the cache's operations, not combinators.
import type * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DAY_MS } from "./time.ts";

/** The most one cached page may weigh. */
export const LIST_CACHE_ENTRY_BYTES = 4 * 1024 * 1024;

/** The most one host object's cache holds. */
export const LIST_CACHE_HOST_BYTES = 4 * 1024 * 1024;

/** The most every host object's cache in one isolate holds together. */
export const LIST_CACHE_ISOLATE_BYTES = 8 * 1024 * 1024;

/** The longest a page is kept, whatever its server said. */
export const LIST_CACHE_MAX_TTL_MS = DAY_MS;

/** Where a cached page came from, which says when it no longer holds. */
export type ListCacheServer = {
  readonly conn: string;
  /** The Workspace whose process serves a stdio server; absent for an HTTP server. */
  readonly workspace?: string | undefined;
};

type Entry = {
  readonly server: ListCacheServer;
  /** The server's era row as it was read under: its protocol version and when it was probed. */
  readonly epoch: string;
  readonly value: Schema.Json;
  readonly bytes: number;
  readonly expiresAt: number;
  /** When it was last used, on the isolate's one clock, so the oldest of all the caches' entries is known. */
  readonly tick: number;
};

/** What the isolate's budget asks of a cache that holds some of it. */
type Holder = {
  /** The tick of its least recently used entry; none when it holds nothing. */
  readonly oldest: () => number | undefined;
  /** Drops its least recently used entry. */
  readonly evictOldest: () => void;
};

/** The bytes every cache of an isolate holds together, and what drops entries when they pass the bound. */
export type IsolateBudget = {
  readonly bytes: () => number;
  readonly charge: (bytes: number) => void;
  readonly release: (bytes: number) => void;
  /** A cache joins when it first holds an entry, so the budget never looks through one that holds none. */
  readonly join: (holder: Holder) => void;
  /** A cache leaves when its last entry goes. */
  readonly leave: (holder: Holder) => void;
  /** How many caches hold something of the budget. */
  readonly holders: () => number;
  /** Drops the least recently used entries, of whichever cache, until the isolate is within its bound. */
  readonly enforce: () => void;
  /** The next tick of the clock that orders every cache's uses. */
  readonly tick: () => number;
};

/** A budget of `limit` bytes: the host's is one for the isolate (`isolateBudget`), a test's its own. */
export const makeIsolateBudget = (limit: number = LIST_CACHE_ISOLATE_BYTES): IsolateBudget => {
  const holders = new Set<Holder>();
  let held = 0;
  let clock = 0;

  return {
    bytes: () => held,
    charge: (bytes) => {
      held += bytes;
    },
    release: (bytes) => {
      held -= bytes;
    },
    join: (holder) => {
      holders.add(holder);
    },
    leave: (holder) => {
      holders.delete(holder);
    },
    holders: () => holders.size,
    tick: () => ++clock,
    enforce: () => {
      while (held > limit) {
        let oldest: { readonly holder: Holder; readonly tick: number } | undefined;

        for (const holder of holders) {
          const tick = holder.oldest();

          if (tick !== undefined && (oldest === undefined || tick < oldest.tick)) {
            oldest = { holder, tick };
          }
        }

        // Nothing left to drop: what is held is not any cache's.
        if (oldest === undefined) return;

        oldest.holder.evictOldest();
      }
    },
  };
};

/** The isolate's one budget, which every host object's cache charges. */
export const isolateBudget: IsolateBudget = makeIsolateBudget();

export type ListCacheService = {
  /** The page kept under `key` for a server that is still in `epoch`, if it has not expired; marks it used. */
  readonly get: (key: string, epoch: string, now: number) => Schema.Json | undefined;
  /**
   * Keeps `value` under `key` for `ttlMs` (capped at 24 h), unless it is over the entry bound or `ttlMs` is not above 0;
   * whether it was kept. Drops the least recently used entries until the cache is within its total.
   */
  readonly put: (
    key: string,
    server: ListCacheServer,
    epoch: string,
    value: Schema.Json,
    ttlMs: number,
    now: number,
  ) => boolean;
  /** Drops every page of the server instance: its stdio process ended. */
  readonly dropServer: (server: ListCacheServer) => void;
  /** Drops every page whose `conn` is not one of `conns`: a definition that changed or left the set. */
  readonly retain: (conns: ReadonlySet<string>) => void;
  /** What the cache holds: its entries and their bytes. */
  readonly size: () => { readonly entries: number; readonly bytes: number };
  /** Drops every entry and gives the isolate its bytes back: the host object is gone, when it is known to be. */
  readonly dispose: () => void;
};

/** The UTF-8 bytes of `value` as JSON. */
export const jsonBytes = (value: Schema.Json): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** A list cache with the given bounds (the host's are the constants above) charging `isolate`. */
export const makeListCache = (
  bounds: { readonly entryBytes: number; readonly totalBytes: number } = {
    entryBytes: LIST_CACHE_ENTRY_BYTES,
    totalBytes: LIST_CACHE_HOST_BYTES,
  },
  isolate: IsolateBudget = isolateBudget,
): ListCacheService => {
  // A `Map` keeps insertion order: the first entry is the least recently used, since each use puts its entry last.
  const entries = new Map<string, Entry>();
  let total = 0;

  const remove = (key: string) => {
    const gone = entries.get(key);

    if (gone === undefined) return;

    entries.delete(key);
    total -= gone.bytes;
    isolate.release(gone.bytes);

    // Membership follows content, not the cache's life: a host object that is evicted is never told, so its cache
    // stays in the budget for as long as it holds pages, drained by the others' puts as the least recently used,
    // and it leaves when the last one goes.
    if (entries.size === 0) isolate.leave(holder);
  };

  const holder: Holder = {
    oldest: () => entries.values().next().value?.tick,
    evictOldest: () => {
      for (const oldest of entries.keys()) return remove(oldest);
    },
  };

  const sameServer = (a: ListCacheServer, b: ListCacheServer) =>
    a.conn === b.conn && a.workspace === b.workspace;

  return {
    get: (key, epoch, now) => {
      const found = entries.get(key);

      if (found === undefined) return undefined;

      // Past its time, or from before the server initialized again or changed its protocol version.
      if (found.expiresAt <= now || found.epoch !== epoch) {
        remove(key);

        return undefined;
      }

      entries.delete(key);
      entries.set(key, { ...found, tick: isolate.tick() });

      return found.value;
    },
    put: (key, server, epoch, value, ttlMs, now) => {
      remove(key);

      if (!(ttlMs > 0)) return false;

      const bytes = jsonBytes(value);

      if (bytes > bounds.entryBytes) return false;

      entries.set(key, {
        server,
        epoch,
        value,
        bytes,
        expiresAt: now + Math.min(ttlMs, LIST_CACHE_MAX_TTL_MS),
        tick: isolate.tick(),
      });
      total += bytes;
      isolate.charge(bytes);
      isolate.join(holder);

      // This host's own bound first, then the isolate's, which may take the least recently used of another host's.
      for (const oldest of entries.keys()) {
        if (total <= bounds.totalBytes) break;

        remove(oldest);
      }

      isolate.enforce();

      return entries.has(key);
    },
    dropServer: (server) => {
      for (const [key, entry] of entries) {
        if (sameServer(entry.server, server)) remove(key);
      }
    },
    retain: (conns) => {
      for (const [key, entry] of entries) {
        if (!conns.has(entry.server.conn)) remove(key);
      }
    },
    size: () => ({ entries: entries.size, bytes: total }),
    dispose: () => {
      for (const key of entries.keys()) remove(key);
    },
  };
};

/** The host's list cache. Internal to the host. */
export class McpListCache extends Context.Service<McpListCache, ListCacheService>()(
  "@cloudpid/server/mcp/list-cache/McpListCache",
) {
  /**
   * One cache for each host object. Its scope ending gives its bytes back at once, but a host object's runtime is
   * never disposed in production (an evicted Durable Object just goes), so what it held stays in the isolate's budget
   * until the others' puts drain it as the least recently used.
   */
  static readonly layer = Layer.effect(
    McpListCache,
    Effect.acquireRelease(
      Effect.sync(() => makeListCache()),
      (cache) => Effect.sync(cache.dispose),
    ),
  );
}
