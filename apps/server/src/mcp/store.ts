// `McpHost`'s storage (`docs/architecture/mcp-connections.md` → Storage): the MCP server set as received, with the hash
// and the revision the Registry gave it, and per connection key `conn` the MCP inventory, the status, the era row and
// the Legacy session rows. What the host holds is what the Registry pushed, `${NAME}` unresolved, so no resolved value
// is ever here; the rest of the tables (watches, App HTML) come with the slices that use them. Migrations only add,
// and each shipped one has its digest in `migrations.manifest.ts`.
// @effect-diagnostics missingPipeableSignature:off -- store operations, not combinators.
// @effect-diagnostics asyncFunction:off -- the object's `deleteAll` is a Promise, and the wipe is its Promise's.
import { type Migration, migrate, type MigrationStorage } from "@cloudpid/effect-durable/sqlite";
import {
  McpSetSource,
  type McpApplySet,
  type McpEngineState,
  type McpServerState,
  type McpSetRevision,
  readMcpServerState,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";

export const MIGRATIONS: ReadonlyArray<Migration> = [
  // 1: the set as received (`mcp_meta` is one row, which exists once a set has been applied; `revision` is the
  // Registry's order of the sets it hands out, so an older one is refused).
  (sql) => {
    sql.exec(`CREATE TABLE mcp_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      set_hash TEXT NOT NULL,
      revision INTEGER NOT NULL
    ) STRICT`);
    // The revision the host was wiped at (`apply({ kind: "destroy" })`), a floor for any set after it.
    sql.exec(`CREATE TABLE mcp_wiped (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL
    ) STRICT`);
    sql.exec(`CREATE TABLE mcp_servers (
      name TEXT PRIMARY KEY,
      entry_hash TEXT NOT NULL,
      conn TEXT NOT NULL,
      entry_json TEXT NOT NULL,
      position INTEGER NOT NULL
    ) STRICT`);
  },
  // 2: per connection key, the MCP inventory (one row per part: `tools`, `prompts`, `meta`), the status (`left_at`:
  // when its `conn` left the set, for the inventory kept for a revert), the era row and the Legacy session rows (`''`
  // workspace for HTTP), the last two as the engine hands them over, with their own format `v`.
  (sql) => {
    sql.exec(`CREATE TABLE mcp_inventories (
      conn TEXT NOT NULL,
      part TEXT NOT NULL,
      json TEXT NOT NULL,
      hash TEXT NOT NULL,
      PRIMARY KEY (conn, part)
    ) STRICT`);
    sql.exec(`CREATE TABLE mcp_status (
      conn TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      error TEXT,
      since INTEGER NOT NULL,
      failures INTEGER NOT NULL,
      next_retry_at INTEGER,
      last_ok_at INTEGER,
      previous_state TEXT,
      left_at INTEGER
    ) STRICT`);
    sql.exec(`CREATE TABLE mcp_eras (
      conn TEXT PRIMARY KEY,
      json TEXT NOT NULL
    ) STRICT`);
    sql.exec(`CREATE TABLE mcp_sessions (
      conn TEXT NOT NULL,
      workspace TEXT NOT NULL,
      json TEXT NOT NULL,
      spawn TEXT,
      last_used_at INTEGER NOT NULL,
      PRIMARY KEY (conn, workspace)
    ) STRICT`);
  },
  // 3: the inventory's versions as last computed, when a Session last used the host (an HTTP server new to the set is
  // discovered at once only within 24 h of it), and the Registry's MCP sign-ins revision.
  (sql) => {
    sql.exec("ALTER TABLE mcp_meta ADD COLUMN version TEXT");
    sql.exec("ALTER TABLE mcp_meta ADD COLUMN prompts_version TEXT");
    sql.exec("ALTER TABLE mcp_meta ADD COLUMN last_used_at INTEGER");
    sql.exec("ALTER TABLE mcp_meta ADD COLUMN sign_ins_revision INTEGER");
  },
];

/** How long the inventory of a `conn` that left the set is kept, and how many such `conn`s at most. */
export const LEFT_INVENTORY_DAYS = 30;

export const LEFT_INVENTORY_LIMIT = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A server's status row (`mcp_status`), its state read as one this build knows. */
export type StatusRow = {
  readonly conn: string;
  readonly state: McpServerState;
  /** At most 300 characters. */
  readonly error?: string | undefined;
  readonly since: number;
  /** Failures in a row, for the backoff. */
  readonly failures: number;
  readonly nextRetryAt?: number | undefined;
  readonly lastOkAt?: number | undefined;
  /** The state before `connecting`, which a discovery that died returns to. */
  readonly previousState?: McpServerState | undefined;
};

/** One part of an inventory as stored: its canonical JSON, and the hash of it. */
export type InventoryPart = { readonly json: string; readonly hash: string };

/** The parts of a `conn`'s inventory. */
export type InventoryRows = {
  readonly tools: InventoryPart;
  readonly prompts: InventoryPart;
  readonly meta: InventoryPart;
};

/** The rows the engine keeps for a connection, as JSON, absent where none is kept. */
export type PriorRows = { readonly era?: Schema.Json; readonly session?: Schema.Json };

/** What `mcp_meta` holds beyond the set: the versions, the last use and the MCP sign-ins revision. */
export type MetaRow = {
  readonly version?: string | undefined;
  readonly promptsVersion?: string | undefined;
  readonly lastUsedAt?: number | undefined;
  readonly signInsRevision?: number | undefined;
};

/** What `entry_json` holds of a server: the rest of its row is the columns. A reader keeps only the keys it knows. */
const StoredEntry = Schema.Struct({
  source: McpSetSource,
  server: Schema.Record(Schema.String, Schema.Json),
  identity: Schema.String,
});

const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(StoredEntry));

/** A server of the stored set. */
export type StoredServer = {
  readonly name: string;
  readonly entryHash: string;
  readonly conn: string;
  readonly source: McpSetSource;
  readonly server: Readonly<Record<string, Schema.Json>>;
  readonly identity: string;
};

/** The stored set: its hash, and its servers in the order the Registry gave them. */
export type StoredSet = {
  readonly hash: string;
  readonly revision: number;
  readonly servers: ReadonlyArray<StoredServer>;
};

export type McpHostStoreService = {
  /** The stored set, or null before one was applied. A row that no longer decodes is left out. */
  readonly readSet: () => StoredSet | null;
  /** The hash and revision of the stored set; undefined before one was applied (which reads as the empty set). */
  readonly held: () => McpSetRevision | undefined;
  /** The revision the host was wiped at: a set no newer than it is never kept; undefined when it never was wiped. */
  readonly wipedAt: () => number | undefined;
  /** Replace the stored set with `set`, whole or not at all. */
  readonly replaceSet: (set: McpApplySet) => void;
  /** Keep the set as it is under a newer `revision`. */
  readonly setRevision: (revision: number) => void;
  /**
   * Wipe the storage: every table's rows, and the tables, which are made again empty, keeping `revision` as the floor
   * of the sets that may fill it again. Rejects when the storage cannot.
   */
  readonly destroy: (revision: number) => Promise<void>;
  /** The versions, last use and MCP sign-ins revision; all absent before a set was applied. */
  readonly meta: () => MetaRow;
  /** Keep what `meta` gives: only where a set was applied, since a host with none has no inventory. */
  readonly setMeta: (meta: MetaRow) => void;
  /** Every status row, by `conn`. */
  readonly statuses: () => ReadonlyMap<string, StatusRow>;
  readonly putStatus: (row: StatusRow) => void;
  /** Every inventory, by `conn`; one missing a part is left out. */
  readonly inventories: () => ReadonlyMap<string, InventoryRows>;
  readonly putInventory: (conn: string, rows: InventoryRows) => void;
  /** The era row and the HTTP Legacy session row of `conn`, for the engine's `prior`. */
  readonly prior: (conn: string) => PriorRows;
  /** Keep what a call changed: a row to keep, `null` to drop it, absent to leave it (`McpEngineState`). */
  readonly keepState: (conn: string, state: McpEngineState, now: number) => void;
  /** Drop the era and Legacy session rows of `conns` (a reload, or a `conn` that left the set). */
  readonly dropPrior: (conns: ReadonlyArray<string>) => void;
  /**
   * After a set apply: `conns` are the set's. The others' era and session rows go; their status is marked as left at
   * `now` (cleared for one back in the set), and inventories and statuses that left over 30 days ago, or past the 20
   * most recent, are pruned.
   */
  readonly settle: (conns: ReadonlyArray<string>, now: number) => void;
};

/** The host's storage, as its methods use it: the object's SQLite store, or a fake that fails on demand. */
export class McpHostStore extends Context.Service<McpHostStore, McpHostStoreService>()(
  "@cloudpid/server/mcp/store/McpHostStore",
) {}

/**
 * The part of the object's storage the store uses: its SQLite database, transactions over it, and `deleteAll`, which
 * for a SQLite-backed object takes effect for the next statement though it answers a Promise.
 */
export type McpHostStorage = MigrationStorage & { readonly deleteAll: () => Promise<void> };

type StatusSql = {
  readonly conn: string;
  readonly state: string;
  readonly error: string | null;
  readonly since: number;
  readonly failures: number;
  readonly next_retry_at: number | null;
  readonly last_ok_at: number | null;
  readonly previous_state: string | null;
};

const nullable = <A>(value: A | undefined): A | null => value ?? null;

const optional = <A>(value: A | null): A | undefined => value ?? undefined;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** A stored JSON row, or absent when it no longer parses. */
const jsonRow = (text: string | undefined): Schema.Json | undefined =>
  text === undefined ? undefined : Option.getOrUndefined(decodeJson(text));

type ServerRow = {
  readonly name: string;
  readonly entry_hash: string;
  readonly conn: string;
  readonly entry_json: string;
};

/** Migrate the tables and return the store over them. Run it from the object's constructor. */
export const openMcpHostStore = (storage: McpHostStorage): McpHostStoreService => {
  migrate(storage, MIGRATIONS);

  const { sql } = storage;

  const held = (): McpSetRevision | undefined => {
    const [meta] = sql
      .exec<{ set_hash: string; revision: number }>(
        "SELECT set_hash, revision FROM mcp_meta WHERE id = 1",
      )
      .toArray();

    return meta === undefined ? undefined : { hash: meta.set_hash, revision: meta.revision };
  };

  return {
    held,

    wipedAt: () =>
      sql.exec<{ revision: number }>("SELECT revision FROM mcp_wiped WHERE id = 1").toArray()[0]
        ?.revision,

    readSet: () => {
      const meta = held();

      if (meta === undefined) return null;

      const rows = sql
        .exec<ServerRow>(
          "SELECT name, entry_hash, conn, entry_json FROM mcp_servers ORDER BY position",
        )
        .toArray();

      return {
        hash: meta.hash,
        revision: meta.revision,
        servers: Arr.filterMap(rows, (row) => {
          const entry = decodeEntry(row.entry_json);

          return Option.isNone(entry)
            ? Result.failVoid
            : Result.succeed<StoredServer>({
                name: row.name,
                entryHash: row.entry_hash,
                conn: row.conn,
                ...entry.value,
              });
        }),
      };
    },

    replaceSet: (set) => {
      storage.transactionSync(() => {
        sql.exec("DELETE FROM mcp_servers");

        for (const [position, entry] of Arr.map(
          set.entries,
          (held, index) => [index, held] as const,
        )) {
          sql.exec(
            "INSERT INTO mcp_servers (name, entry_hash, conn, entry_json, position) VALUES (?, ?, ?, ?, ?)",
            entry.name,
            entry.hash,
            entry.conn,
            JSON.stringify({
              source: entry.source,
              server: entry.server,
              identity: entry.identity,
            }),
            position,
          );
        }

        sql.exec(
          `INSERT INTO mcp_meta (id, set_hash, revision) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET set_hash = excluded.set_hash, revision = excluded.revision`,
          set.hash,
          set.revision,
        );
      });
    },

    setRevision: (revision) => {
      sql.exec("UPDATE mcp_meta SET revision = ? WHERE id = 1", revision);
    },

    destroy: async (revision) => {
      await storage.deleteAll();
      migrate(storage, MIGRATIONS);
      sql.exec("INSERT INTO mcp_wiped (id, revision) VALUES (1, ?)", revision);
    },

    meta: () => {
      const [row] = sql
        .exec<{
          version: string | null;
          prompts_version: string | null;
          last_used_at: number | null;
          sign_ins_revision: number | null;
        }>(
          "SELECT version, prompts_version, last_used_at, sign_ins_revision FROM mcp_meta WHERE id = 1",
        )
        .toArray();

      return row === undefined
        ? {}
        : {
            version: optional(row.version),
            promptsVersion: optional(row.prompts_version),
            lastUsedAt: optional(row.last_used_at),
            signInsRevision: optional(row.sign_ins_revision),
          };
    },

    setMeta: (meta) => {
      sql.exec(
        `UPDATE mcp_meta SET version = coalesce(?, version), prompts_version = coalesce(?, prompts_version),
         last_used_at = coalesce(?, last_used_at), sign_ins_revision = coalesce(?, sign_ins_revision) WHERE id = 1`,
        nullable(meta.version),
        nullable(meta.promptsVersion),
        nullable(meta.lastUsedAt),
        nullable(meta.signInsRevision),
      );
    },

    statuses: () =>
      new Map(
        Arr.map(
          sql
            .exec<StatusSql>(
              "SELECT conn, state, error, since, failures, next_retry_at, last_ok_at, previous_state FROM mcp_status",
            )
            .toArray(),
          (row): [string, StatusRow] => [
            row.conn,
            {
              conn: row.conn,
              state: readMcpServerState(row.state),
              error: optional(row.error),
              since: row.since,
              failures: row.failures,
              nextRetryAt: optional(row.next_retry_at),
              lastOkAt: optional(row.last_ok_at),
              previousState:
                row.previous_state === null ? undefined : readMcpServerState(row.previous_state),
            },
          ],
        ),
      ),

    putStatus: (row) => {
      sql.exec(
        `INSERT INTO mcp_status (conn, state, error, since, failures, next_retry_at, last_ok_at, previous_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (conn) DO UPDATE SET state = excluded.state, error = excluded.error, since = excluded.since,
           failures = excluded.failures, next_retry_at = excluded.next_retry_at, last_ok_at = excluded.last_ok_at,
           previous_state = excluded.previous_state`,
        row.conn,
        row.state,
        nullable(row.error),
        row.since,
        row.failures,
        nullable(row.nextRetryAt),
        nullable(row.lastOkAt),
        nullable(row.previousState),
      );
    },

    inventories: () => {
      const rows = sql
        .exec<{ conn: string; part: string; json: string; hash: string }>(
          "SELECT conn, part, json, hash FROM mcp_inventories",
        )
        .toArray();

      const parts = new Map<string, Map<string, InventoryPart>>();

      for (const row of rows) {
        const byPart = parts.get(row.conn) ?? new Map<string, InventoryPart>();

        byPart.set(row.part, { json: row.json, hash: row.hash });
        parts.set(row.conn, byPart);
      }

      return new Map(
        Arr.filterMap([...parts], ([conn, byPart]) => {
          const tools = byPart.get("tools");
          const prompts = byPart.get("prompts");
          const meta = byPart.get("meta");

          return tools === undefined || prompts === undefined || meta === undefined
            ? Result.failVoid
            : Result.succeed([conn, { tools, prompts, meta }] as const);
        }),
      );
    },

    putInventory: (conn, rows) => {
      storage.transactionSync(() => {
        for (const [part, row] of [
          ["tools", rows.tools],
          ["prompts", rows.prompts],
          ["meta", rows.meta],
        ] as const) {
          sql.exec(
            `INSERT INTO mcp_inventories (conn, part, json, hash) VALUES (?, ?, ?, ?)
             ON CONFLICT (conn, part) DO UPDATE SET json = excluded.json, hash = excluded.hash`,
            conn,
            part,
            row.json,
            row.hash,
          );
        }
      });
    },

    prior: (conn) => {
      const era = jsonRow(
        sql.exec<{ json: string }>("SELECT json FROM mcp_eras WHERE conn = ?", conn).toArray()[0]
          ?.json,
      );

      const session = jsonRow(
        sql
          .exec<{
            json: string;
          }>("SELECT json FROM mcp_sessions WHERE conn = ? AND workspace = ''", conn)
          .toArray()[0]?.json,
      );

      const rows: Mutable<PriorRows> = {};

      if (era !== undefined) rows.era = era;

      if (session !== undefined) rows.session = session;

      return rows;
    },

    keepState: (conn, state, now) => {
      storage.transactionSync(() => {
        if (state.era === null) sql.exec("DELETE FROM mcp_eras WHERE conn = ?", conn);
        else if (state.era !== undefined) {
          sql.exec(
            "INSERT INTO mcp_eras (conn, json) VALUES (?, ?) ON CONFLICT (conn) DO UPDATE SET json = excluded.json",
            conn,
            JSON.stringify(state.era),
          );
        }

        if (state.session === null) {
          sql.exec("DELETE FROM mcp_sessions WHERE conn = ? AND workspace = ''", conn);
        } else if (state.session !== undefined) {
          sql.exec(
            `INSERT INTO mcp_sessions (conn, workspace, json, last_used_at) VALUES (?, '', ?, ?)
             ON CONFLICT (conn, workspace) DO UPDATE SET json = excluded.json, last_used_at = excluded.last_used_at`,
            conn,
            JSON.stringify(state.session),
            now,
          );
        }
      });
    },

    dropPrior: (conns) => {
      storage.transactionSync(() => {
        for (const conn of conns) {
          sql.exec("DELETE FROM mcp_eras WHERE conn = ?", conn);
          sql.exec("DELETE FROM mcp_sessions WHERE conn = ?", conn);
        }
      });
    },

    settle: (conns, now) => {
      const current = JSON.stringify(conns);

      storage.transactionSync(() => {
        const inSet = "SELECT value FROM json_each(?)";

        sql.exec(`DELETE FROM mcp_eras WHERE conn NOT IN (${inSet})`, current);
        sql.exec(`DELETE FROM mcp_sessions WHERE conn NOT IN (${inSet})`, current);
        sql.exec(`UPDATE mcp_status SET left_at = NULL WHERE conn IN (${inSet})`, current);
        sql.exec(
          `UPDATE mcp_status SET left_at = ? WHERE left_at IS NULL AND conn NOT IN (${inSet})`,
          now,
          current,
        );
        // The statuses kept: the set's, and the most recent of those that left within the retention.
        sql.exec(
          `DELETE FROM mcp_status WHERE left_at IS NOT NULL AND (left_at < ? OR conn NOT IN (
             SELECT conn FROM mcp_status WHERE left_at IS NOT NULL ORDER BY left_at DESC, conn LIMIT ?))`,
          now - LEFT_INVENTORY_DAYS * DAY_MS,
          LEFT_INVENTORY_LIMIT,
        );
        // An inventory goes with its status: every discovery that stores one writes one first.
        sql.exec("DELETE FROM mcp_inventories WHERE conn NOT IN (SELECT conn FROM mcp_status)");
      });
    },
  };
};
