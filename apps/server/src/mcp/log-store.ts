// The log ring of `McpHost`'s storage (`docs/architecture/mcp-connections.md` → Storage, Telemetry): per connection key
// `conn`, the last 50 `notifications/message` entries its server sent, oldest first. They are what an engine call
// handed back (already scrubbed and cut), cut again here, since the host trusts no length; they go with the `conn`'s
// status when it leaves the set. Read through `serverLog`, which never starts a Container.
// @effect-diagnostics missingPipeableSignature:off -- store operations, not combinators.
import type { MigrationStorage } from "@cloudpid/effect-durable/sqlite";
import { MCP_LOG_DATA_MAX, MCP_LOG_RING, type McpLogEntry } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import { nullable, optional } from "./sql.ts";

/** The longest `logger` and `level` kept: a server's own words, bounded. */
const MAX_NAME = 128;

export type LogStore = {
  /** `conn`'s ring, oldest first. */
  readonly logs: (conn: string) => ReadonlyArray<McpLogEntry>;
  /** Append `entries` to `conn`'s ring and drop what falls past the 50 most recent. */
  readonly putLogs: (conn: string, entries: ReadonlyArray<McpLogEntry>) => void;
};

type LogSql = {
  readonly at: number;
  readonly level: string;
  readonly logger: string | null;
  readonly data: string;
};

const entryOfRow = (row: LogSql): McpLogEntry => {
  const logger = optional(row.logger);

  return logger === undefined
    ? { at: row.at, level: row.level, data: row.data }
    : { at: row.at, level: row.level, logger, data: row.data };
};

/** The ring's store over the object's migrated SQLite storage. */
export const logStore = (storage: MigrationStorage): LogStore => ({
  logs: (conn) =>
    Arr.map(
      storage.sql
        .exec<LogSql>(
          "SELECT at, level, logger, data FROM mcp_logs WHERE conn = ? ORDER BY seq",
          conn,
        )
        .toArray(),
      entryOfRow,
    ),

  putLogs: (conn, entries) => {
    if (entries.length === 0) return;

    storage.transactionSync(() => {
      const { sql } = storage;

      const next =
        sql
          .exec<{ readonly seq: number }>(
            "SELECT COALESCE(MAX(seq), 0) AS seq FROM mcp_logs WHERE conn = ?",
            conn,
          )
          .one().seq + 1;

      Arr.forEach(Arr.takeRight(entries, MCP_LOG_RING), (entry, index) => {
        sql.exec(
          "INSERT INTO mcp_logs (conn, seq, at, level, logger, data) VALUES (?, ?, ?, ?, ?, ?)",
          conn,
          next + index,
          entry.at,
          entry.level.slice(0, MAX_NAME),
          nullable(entry.logger?.slice(0, MAX_NAME)),
          entry.data.slice(0, MCP_LOG_DATA_MAX),
        );
      });

      sql.exec(
        "DELETE FROM mcp_logs WHERE conn = ? AND seq <= (SELECT MAX(seq) FROM mcp_logs WHERE conn = ?) - ?",
        conn,
        conn,
        MCP_LOG_RING,
      );
    });
  },
});
