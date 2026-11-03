// The status part of `McpHost`'s storage (`docs/architecture/mcp-connections.md` → Storage, States): per connection
// key `conn`, the server's state, its last error, its failures in a row and the backoff they set. It changes when the
// state machine does.
// @effect-diagnostics missingPipeableSignature:off -- store operations, not combinators.
import type { MigrationStorage } from "@cloudpid/effect-durable/sqlite";
import { type McpServerState, readMcpServerState } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import { nullable, optional } from "./sql.ts";

/** A server's status row (`mcp_status`), its state read as one this build knows. */
export type StatusRow = {
  readonly conn: string;
  readonly state: McpServerState;
  /** At most 300 characters. */
  readonly error?: string | undefined;
  readonly since: number;
  /** Failures in a row, for the backoff. */
  readonly failures: number;
  /** Not discovered again on demand before this time. */
  readonly nextRetryAt?: number | undefined;
  readonly lastOkAt?: number | undefined;
  /** The state before `connecting`, which a discovery that died returns to. */
  readonly previousState?: McpServerState | undefined;
};

export type StatusStore = {
  /** Every status row, by `conn`. */
  readonly statuses: () => ReadonlyMap<string, StatusRow>;
  readonly putStatus: (row: StatusRow) => void;
};

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

const statusOfRow = (row: StatusSql): StatusRow => ({
  conn: row.conn,
  state: readMcpServerState(row.state),
  error: optional(row.error),
  since: row.since,
  failures: row.failures,
  nextRetryAt: optional(row.next_retry_at),
  lastOkAt: optional(row.last_ok_at),
  previousState: row.previous_state === null ? undefined : readMcpServerState(row.previous_state),
});

/** The statuses' store over the object's migrated SQLite storage. */
export const statusStore = ({ sql }: MigrationStorage): StatusStore => ({
  statuses: () =>
    new Map(
      Arr.map(
        sql
          .exec<StatusSql>(
            "SELECT conn, state, error, since, failures, next_retry_at, last_ok_at, previous_state FROM mcp_status",
          )
          .toArray(),
        (row): [string, StatusRow] => [row.conn, statusOfRow(row)],
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
});
