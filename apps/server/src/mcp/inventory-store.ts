// The inventory part of `McpHost`'s storage (`docs/architecture/mcp-connections.md` → Storage): per connection key
// `conn`, the MCP inventory's parts, and the rows the engine keeps across calls (the era row, and the Legacy session
// row: one per `conn` for an HTTP server, one per `conn` and Workspace for a stdio server, with the spawn id of the
// child it was opened on), which cross the engine edge as `prior` with their own format `v`. It changes when what a
// discovery keeps does.
// @effect-diagnostics missingPipeableSignature:off -- store operations, not combinators.
import type { MigrationStorage } from "@cloudpid/effect-durable/sqlite";
import type { McpEngineState } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { jsonColumn } from "./sql.ts";
import { DAY_MS } from "./time.ts";

/** A stdio server's session row of a Workspace unused for this long is dropped, at the next write of any. */
export const STDIO_SESSION_DAYS = 7;

/** The `json` of a stdio server's row with no session to keep (a Modern server has none) that holds its spawn id. */
const NO_SESSION = "null";

/** An inventory's parts, one `mcp_inventories` row each. */
export const INVENTORY_PARTS = ["tools", "prompts", "meta"] as const;

export type InventoryPartName = (typeof INVENTORY_PARTS)[number];

/** One part of an inventory as stored: its canonical JSON, and the hash of it. */
export type InventoryPart = { readonly json: string; readonly hash: string };

/** The parts of a `conn`'s inventory. */
export type InventoryRows = { readonly [part in InventoryPartName]: InventoryPart };

/** The rows the engine keeps for a connection, as JSON, absent where none is kept. */
export type PriorRows = { readonly era?: Schema.Json; readonly session?: Schema.Json };

export type InventoryStore = {
  /** Every inventory, by `conn`; one missing a part is left out. */
  readonly inventories: () => ReadonlyMap<string, InventoryRows>;
  readonly putInventory: (conn: string, rows: InventoryRows) => void;
  /**
   * The era row and the Legacy session row of `conn`, for the engine's `prior`: an HTTP server's, or a stdio server's in
   * `workspace` (`ws:<id>`).
   */
  readonly prior: (conn: string, workspace?: string) => PriorRows;
  /**
   * Keep what a call changed: a row to keep, `null` to drop it, absent to leave it (`McpEngineState`). A stdio server's
   * calls say the `workspace` and the `spawn` id the call heard last; the spawn id is kept with the session row (a Modern
   * server has none, and a row of `null` keeps the id). Gives the spawn id the row had before if it is another one: the
   * child it names ended (`processEnded`, `stdio.ts`).
   */
  readonly applyEngineState: (
    conn: string,
    state: McpEngineState,
    now: number,
    where?: { readonly workspace: string; readonly spawn?: string | undefined },
  ) => string | undefined;
  /** Drop the era and Legacy session rows of `conns` (a reload, or a `conn` that left the set). */
  readonly dropPrior: (conns: ReadonlyArray<string>) => void;
  /** Drop the Legacy session rows of `conns`, keeping their eras (a sign-out closes the server's HTTP session). */
  readonly dropSessions: (conns: ReadonlyArray<string>) => void;
};

type InventorySql = {
  readonly conn: string;
  readonly part: string;
  readonly json: string;
  readonly hash: string;
};

/** The rows of `conn` grouped by part, whole only when every part is there. */
const wholeInventory = (byPart: ReadonlyMap<string, InventoryPart>): InventoryRows | undefined => {
  const tools = byPart.get("tools");
  const prompts = byPart.get("prompts");
  const meta = byPart.get("meta");

  return tools === undefined || prompts === undefined || meta === undefined
    ? undefined
    : { tools, prompts, meta };
};

/** The inventories' store over the object's migrated SQLite storage. */
export const inventoryStore = (storage: MigrationStorage): InventoryStore => {
  const { sql } = storage;

  return {
    inventories: () => {
      const rows = sql
        .exec<InventorySql>("SELECT conn, part, json, hash FROM mcp_inventories")
        .toArray();

      const byConn = new Map<string, Map<string, InventoryPart>>();

      for (const row of rows) {
        const byPart = byConn.get(row.conn) ?? new Map<string, InventoryPart>();

        byPart.set(row.part, { json: row.json, hash: row.hash });
        byConn.set(row.conn, byPart);
      }

      return new Map(
        Arr.filterMap([...byConn], ([conn, byPart]) => {
          const whole = wholeInventory(byPart);

          return whole === undefined ? Result.failVoid : Result.succeed([conn, whole] as const);
        }),
      );
    },

    putInventory: (conn, rows) => {
      storage.transactionSync(() => {
        for (const part of INVENTORY_PARTS) {
          sql.exec(
            `INSERT INTO mcp_inventories (conn, part, json, hash) VALUES (?, ?, ?, ?)
             ON CONFLICT (conn, part) DO UPDATE SET json = excluded.json, hash = excluded.hash`,
            conn,
            part,
            rows[part].json,
            rows[part].hash,
          );
        }
      });
    },

    prior: (conn, workspace = "") => {
      const era = jsonColumn(
        sql.exec<{ json: string }>("SELECT json FROM mcp_eras WHERE conn = ?", conn).toArray()[0]
          ?.json,
      );

      const session = jsonColumn(
        sql
          .exec<{
            json: string;
          }>("SELECT json FROM mcp_sessions WHERE conn = ? AND workspace = ?", conn, workspace)
          .toArray()[0]?.json,
      );

      const rows: Mutable<PriorRows> = {};

      if (era !== undefined) rows.era = era;

      // A row of `null` only keeps a spawn id.
      if (session !== undefined && session !== null) rows.session = session;

      return rows;
    },

    applyEngineState: (conn, state, now, where) =>
      storage.transactionSync(() => {
        const workspace = where?.workspace ?? "";
        const spawn = where?.spawn;

        if (state.era === null) sql.exec("DELETE FROM mcp_eras WHERE conn = ?", conn);
        else if (state.era !== undefined) {
          sql.exec(
            "INSERT INTO mcp_eras (conn, json) VALUES (?, ?) ON CONFLICT (conn) DO UPDATE SET json = excluded.json",
            conn,
            JSON.stringify(state.era),
          );
        }

        const before = sql
          .exec<{
            json: string;
            spawn: string | null;
          }>(
            "SELECT json, spawn FROM mcp_sessions WHERE conn = ? AND workspace = ?",
            conn,
            workspace,
          )
          .toArray()[0];

        if (spawn !== undefined) {
          const json =
            state.session === undefined
              ? (before?.json ?? NO_SESSION)
              : JSON.stringify(state.session);

          sql.exec(
            `INSERT INTO mcp_sessions (conn, workspace, json, spawn, last_used_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (conn, workspace) DO UPDATE SET json = excluded.json, spawn = excluded.spawn, last_used_at = excluded.last_used_at`,
            conn,
            workspace,
            json,
            spawn,
            now,
          );
        } else if (state.session === null) {
          sql.exec("DELETE FROM mcp_sessions WHERE conn = ? AND workspace = ?", conn, workspace);
        } else if (state.session !== undefined) {
          sql.exec(
            `INSERT INTO mcp_sessions (conn, workspace, json, last_used_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (conn, workspace) DO UPDATE SET json = excluded.json, last_used_at = excluded.last_used_at`,
            conn,
            workspace,
            JSON.stringify(state.session),
            now,
          );
        }

        if (workspace !== "") {
          sql.exec(
            "DELETE FROM mcp_sessions WHERE workspace <> '' AND last_used_at < ?",
            now - STDIO_SESSION_DAYS * DAY_MS,
          );
        }

        return before?.spawn != null && spawn !== undefined && before.spawn !== spawn
          ? before.spawn
          : undefined;
      }),

    dropSessions: (conns) => {
      storage.transactionSync(() => {
        for (const conn of conns) sql.exec("DELETE FROM mcp_sessions WHERE conn = ?", conn);
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
  };
};
