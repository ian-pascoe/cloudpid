// The App HTML of `McpHost`'s storage (`docs/architecture/mcp-connections.md` → Storage; `docs/architecture/mcp-apps.md`
// → Declaring and reading Apps): per (`conn`, `ui://` URI) the hash of the page last read and the inventory `version` it
// was read at (`mcp_app_ui`); per hash the page's size, its `_meta.ui` and when it was last mounted
// (`mcp_app_html_meta`), and its HTML as UTF-8 chunks (`mcp_app_html`). A page is kept once however many servers or URIs
// give it, at most 64 MiB of them per Environment, the least recently mounted evicted at each write. An App record
// pins a hash, so a page outlives the `mcp_app_ui` row that named it until it is evicted.
// Noting a mount (`touchApp`) is a write apart from the read (`readApp`), so a refused note (a replaced instance,
// `mcp-connections.md` → Deploys) never costs the page that was read.
// @effect-diagnostics missingPipeableSignature:off -- store operations, not combinators.
import type { MigrationStorage } from "@cloudpid/effect-durable/sqlite";
import { McpAppUiMeta, MiB } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { jsonColumn } from "./sql.ts";

/** At most this much HTML is kept for an Environment; the least recently mounted pages go first. */
export const MAX_APP_STORE_BYTES = 64 * MiB;

/** A page is stored in rows of at most this many bytes, well under the row limit. */
export const APP_CHUNK_BYTES = MiB;

/** A page as it is read from the server and kept: its hash, its HTML and what its View is mounted with. */
export type AppPage = {
  readonly hash: string;
  readonly html: string;
  readonly meta: McpAppUiMeta;
};

/** What `mcp_app_ui` holds for a (`conn`, URI): the page's hash, and the inventory `version` it was read at. */
export type AppUiRow = { readonly hash: string; readonly version: string };

export type AppStore = {
  /** The page last read for `uri` of `conn`, if it is still kept. */
  readonly appUi: (conn: string, uri: string) => AppUiRow | undefined;
  /**
   * Keep `page` as what `uri` of `conn` reads at `version`: once if it is kept already (then only marked mounted at
   * `now`), then evict the least recently mounted pages past 64 MiB, never this one, and prune the rows that name a page
   * no longer kept. Gives the hash kept.
   */
  readonly putApp: (
    conn: string,
    uri: string,
    version: string,
    page: AppPage,
    now: number,
  ) => string;
  /** The page kept under `hash`, marked mounted at `now`; absent when it was evicted or never kept. */
  readonly appHtml: (hash: string, now: number) => AppPage | undefined;
  /** The page kept under `hash` as `appHtml` reads it, marked nowhere: the read alone, which a refused write cannot fail. */
  readonly readApp: (hash: string) => AppPage | undefined;
  /** Mark the page under `hash` mounted at `now`, so the pages evicted first are those no View mounted lately. */
  readonly touchApp: (hash: string, now: number) => void;
};

const utf8 = new TextEncoder();

const decoder = new TextDecoder();

const decodeMeta = Schema.decodeUnknownOption(McpAppUiMeta);

/** The app store over the object's migrated SQLite storage. */
export const appStore = (storage: MigrationStorage): AppStore => {
  const { sql } = storage;

  /** Evicts until the pages fit the bound; `keep` is the page just written and stays whatever its size. */
  const evict = (keep: string) => {
    let total = sql
      .exec<{ readonly total: number }>(
        "SELECT COALESCE(SUM(bytes), 0) AS total FROM mcp_app_html_meta",
      )
      .one().total;

    while (total > MAX_APP_STORE_BYTES) {
      const oldest = sql
        .exec<{ readonly hash: string; readonly bytes: number }>(
          "SELECT hash, bytes FROM mcp_app_html_meta WHERE hash <> ? ORDER BY last_mounted_at, hash LIMIT 1",
          keep,
        )
        .toArray()[0];

      if (oldest === undefined) break;

      sql.exec("DELETE FROM mcp_app_html WHERE hash = ?", oldest.hash);
      sql.exec("DELETE FROM mcp_app_html_meta WHERE hash = ?", oldest.hash);
      total -= oldest.bytes;
    }

    sql.exec("DELETE FROM mcp_app_ui WHERE hash NOT IN (SELECT hash FROM mcp_app_html_meta)");
  };

  const store: Omit<AppStore, "appHtml"> = {
    appUi: (conn, uri) =>
      sql
        .exec<AppUiRow>(
          `SELECT u.hash AS hash, u.version AS version FROM mcp_app_ui u
             JOIN mcp_app_html_meta m ON m.hash = u.hash WHERE u.conn = ? AND u.uri = ?`,
          conn,
          uri,
        )
        .toArray()[0],

    putApp: (conn, uri, version, page, now) => {
      const bytes = utf8.encode(page.html);

      storage.transactionSync(() => {
        const kept = sql
          .exec("SELECT 1 FROM mcp_app_html_meta WHERE hash = ?", page.hash)
          .toArray();

        if (kept.length === 0) {
          sql.exec(
            "INSERT INTO mcp_app_html_meta (hash, bytes, meta_json, last_mounted_at) VALUES (?, ?, ?, ?)",
            page.hash,
            bytes.byteLength,
            JSON.stringify(page.meta),
            now,
          );

          for (let at = 0, seq = 0; at < bytes.byteLength; at += APP_CHUNK_BYTES, seq++) {
            sql.exec(
              "INSERT INTO mcp_app_html (hash, seq, chunk) VALUES (?, ?, ?)",
              page.hash,
              seq,
              bytes.slice(at, at + APP_CHUNK_BYTES).buffer,
            );
          }
        } else {
          sql.exec(
            "UPDATE mcp_app_html_meta SET last_mounted_at = ? WHERE hash = ?",
            now,
            page.hash,
          );
        }

        sql.exec(
          `INSERT INTO mcp_app_ui (conn, uri, hash, version) VALUES (?, ?, ?, ?)
             ON CONFLICT (conn, uri) DO UPDATE SET hash = excluded.hash, version = excluded.version`,
          conn,
          uri,
          page.hash,
          version,
        );

        evict(page.hash);
      });

      return page.hash;
    },

    readApp: (hash) => {
      const meta = sql
        .exec<{
          readonly bytes: number;
          readonly meta_json: string;
        }>("SELECT bytes, meta_json FROM mcp_app_html_meta WHERE hash = ?", hash)
        .toArray()[0];

      if (meta === undefined) return undefined;

      const chunks = sql
        .exec<{ readonly chunk: ArrayBuffer }>(
          "SELECT chunk FROM mcp_app_html WHERE hash = ? ORDER BY seq",
          hash,
        )
        .toArray();

      const whole = new Uint8Array(meta.bytes);
      let at = 0;

      Arr.forEach(chunks, ({ chunk }) => {
        const part = new Uint8Array(chunk);

        // A page whose chunks do not add up to its size is not served: it reads as evicted.
        if (at + part.byteLength <= whole.byteLength) whole.set(part, at);

        at += part.byteLength;
      });

      if (at !== meta.bytes) return undefined;

      return {
        hash,
        html: decoder.decode(whole),
        meta: Option.getOrElse(decodeMeta(jsonColumn(meta.meta_json)), () => ({})),
      };
    },

    touchApp: (hash, now) => {
      sql.exec("UPDATE mcp_app_html_meta SET last_mounted_at = ? WHERE hash = ?", now, hash);
    },
  };

  return {
    ...store,
    appHtml: (hash, now) => {
      const page = store.readApp(hash);

      if (page !== undefined) store.touchApp(hash, now);

      return page;
    },
  };
};
