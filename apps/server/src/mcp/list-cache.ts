// The host's list cache (`docs/architecture/mcp-in-a-session.md` → Resource tools, Listing is live;
// `docs/architecture/mcp-connections.md` → The list cache): the pages of `resources/list` and
// `resources/templates/list` a Modern server said may be kept, in the host object's memory.
//
// - **Bounds:** at most 4 MiB an entry and 8 MiB in all, the least recently used dropped first. A value is measured by its
//   JSON as UTF-8, which is what it weighs on the wire and in storage; one that is over 4 MiB is not kept.
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
import * as Layer from "effect/Layer";
import { DAY_MS } from "./time.ts";

/** The most one cached page may weigh. */
export const LIST_CACHE_ENTRY_BYTES = 4 * 1024 * 1024;

/** The most the cache holds in all. */
export const LIST_CACHE_TOTAL_BYTES = 8 * 1024 * 1024;

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
};

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
};

/** The UTF-8 bytes of `value` as JSON. */
export const jsonBytes = (value: Schema.Json): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** A list cache with the given bounds (the host's are the constants above). */
export const makeListCache = (
  bounds: { readonly entryBytes: number; readonly totalBytes: number } = {
    entryBytes: LIST_CACHE_ENTRY_BYTES,
    totalBytes: LIST_CACHE_TOTAL_BYTES,
  },
): ListCacheService => {
  // A `Map` keeps insertion order: the first entry is the least recently used, since each use puts its entry last.
  const entries = new Map<string, Entry>();
  let total = 0;

  const remove = (key: string) => {
    const gone = entries.get(key);

    if (gone === undefined) return;

    entries.delete(key);
    total -= gone.bytes;
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
      entries.set(key, found);

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
      });
      total += bytes;

      for (const oldest of entries.keys()) {
        if (total <= bounds.totalBytes) break;

        remove(oldest);
      }

      return true;
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
  };
};

/** The host's list cache. Internal to the host. */
export class McpListCache extends Context.Service<McpListCache, ListCacheService>()(
  "@cloudpid/server/mcp/list-cache/McpListCache",
) {
  static readonly layer = Layer.sync(McpListCache, () => makeListCache());
}
