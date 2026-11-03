// `McpHost`'s storage (`docs/architecture/mcp-connections.md` → Storage): the migrations, and the store over them,
// made of three parts that change for different reasons: the set and `mcp_meta` (`set-store.ts`), the statuses
// (`status-store.ts`), and per connection key `conn` the MCP inventory and the rows the engine keeps (`inventory-
// store.ts`). Here are what spans them: the wipe, and the pruning after a set apply. What the host holds is what the
// Registry pushed, `${NAME}` unresolved, so no resolved value is ever here; the rest of the tables (watches, App HTML)
// come with the slices that use them. Migrations only add, and each shipped one has its digest in
// `migrations.manifest.ts`. `mcp_sessions.spawn` is unused until the stdio bridge (#460) gives spawn ids.
// @effect-diagnostics missingPipeableSignature:off -- store operations, not combinators.
// @effect-diagnostics asyncFunction:off -- the object's `deleteAll` is a Promise, and the wipe is its Promise's.
import { type Migration, migrate, type MigrationStorage } from "@cloudpid/effect-durable/sqlite";
import * as Context from "effect/Context";
import { type InventoryStore, inventoryStore } from "./inventory-store.ts";
import { type SetStore, setStore } from "./set-store.ts";
import { type StatusStore, statusStore } from "./status-store.ts";
import { DAY_MS } from "./time.ts";

export {
  INVENTORY_PARTS,
  type InventoryPart,
  type InventoryPartName,
  type InventoryRows,
  type PriorRows,
} from "./inventory-store.ts";

export type { MetaRow, StoredServer, StoredSet } from "./set-store.ts";

export type { StatusRow } from "./status-store.ts";

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

export type McpHostStoreService = SetStore &
  StatusStore &
  InventoryStore & {
    /**
     * Wipe the storage: every table's rows, and the tables, which are made again empty, keeping `revision` as the
     * floor of the sets that may fill it again. Rejects when the storage cannot.
     */
    readonly destroy: (revision: number) => Promise<void>;
    /**
     * After a set apply, `conns` being the set's: the others' era and session rows go; their status is marked as left
     * at `now` (cleared for one back in the set), and inventories and statuses that left over 30 days ago, or past the
     * 20 most recent, are pruned.
     */
    readonly pruneOutsideSet: (conns: ReadonlyArray<string>, now: number) => void;
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

/** Migrate the tables and return the store over them. Run it from the object's constructor. */
export const openMcpHostStore = (storage: McpHostStorage): McpHostStoreService => {
  migrate(storage, MIGRATIONS);

  const { sql } = storage;

  return {
    ...setStore(storage),
    ...statusStore(storage),
    ...inventoryStore(storage),

    destroy: async (revision) => {
      await storage.deleteAll();
      migrate(storage, MIGRATIONS);
      sql.exec("INSERT INTO mcp_wiped (id, revision) VALUES (1, ?)", revision);
    },

    pruneOutsideSet: (conns, now) => {
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
