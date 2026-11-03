/**
 * Server logs (`docs/architecture/mcp-in-a-session.md` → Server logging; `docs/architecture/mcp-connections.md` →
 * Telemetry): the entry an engine call hands the host, and the levels. Like everything in `./types`, this never loads
 * the SDK.
 */
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

/** MCP's logging levels, least to most severe (RFC 5424), as `notifications/message` names them. */
export const MCP_LOG_LEVELS = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
] as const;

/** The level the core asks every server that declares `logging` for, in both eras (`docs/architecture/mcp-in-a-session.md` → Server logging). */
export const MCP_LOG_LEVEL = "warning";

/** How many log entries the host keeps per server, and a call hands back at most (`docs/architecture/mcp-connections.md` → Telemetry). */
export const MCP_LOG_RING = 50;

/** The most characters of a log entry's `data`: 2 KiB. */
export const MCP_LOG_DATA_MAX = 2048;

/**
 * One `notifications/message` a server sent during a call: when the engine received it, its `level` (a string, so a
 * level this build does not know is kept), the server's `logger` name, and its `data` as JSON text, cut to
 * `MCP_LOG_DATA_MAX` characters and scrubbed of the call's tokens and header values. Never shown to the model.
 */
export const McpLogEntry = Schema.Struct({
  at: Schema.Finite,
  level: Schema.String,
  logger: Schema.optionalKey(Schema.String),
  data: Schema.String,
});

export type McpLogEntry = typeof McpLogEntry.Type;

const RANK: Readonly<Record<string, number>> = Record.fromEntries(
  Arr.map(MCP_LOG_LEVELS, (level, rank) => [level, rank] as const),
);

/** Whether `level` is `warning` or above: what becomes a span event. A level this build does not know counts as one. */
export const isWarningOrAbove = (level: string): boolean =>
  (RANK[level] ?? Infinity) >= (RANK[MCP_LOG_LEVEL] ?? 0);
