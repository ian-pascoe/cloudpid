/**
 * The server logs of one engine call (`docs/architecture/mcp-connections.md` → Telemetry; #382 D12.2): each
 * `notifications/message` the core hears is kept as an entry, the last 50, and goes back to the host in the call's
 * result, since a discovery passes no hooks and a function stub would not outlive its invocation anyway. Entries are
 * scrubbed of the call's access tokens and of the Secret values the host put into the target (a server may echo what it
 * was sent; both are in the call's `tokens`), and their data is cut to 2 KiB, after the scrub so no token is left cut in half. Nothing here reaches a model.
 */
// @effect-diagnostics preferSchemaOverJson:off -- a server's log data, already decoded by the SDK, serialized once.
import { type McpLog } from "@cloudpid/mcp";
import {
  MCP_LOG_DATA_MAX,
  MCP_LOG_RING,
  type McpEngineTargetEncoded,
  type McpLogEntry,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import { scrubText } from "./results.ts";

/** What is kept of a log's text before the scrub: far past what survives it, and bounding what a server can make us hold. */
const RAW_LIMIT = 64 * 1024;

/** The shortest Secret value scrubbed: a shorter one would redact ordinary words. */
const MIN_SECRET_LENGTH = 4;

/** A log's data as text: a string as it is, anything else as its JSON, or nothing at all for what has none. */
const textOf = (log: McpLog): string => {
  if (Predicate.isString(log.data)) return log.data;

  try {
    return JSON.stringify(log.data) ?? "";
  } catch {
    return "";
  }
};

/**
 * The Secret values the host substituted into `target` (its `redact`), which the call scrubs from everything it hands
 * back; a target without `redact` has none.
 */
export const redactOf = (target: McpEngineTargetEncoded): Array<string> =>
  Arr.filter(target.redact ?? [], (secret) => secret.length >= MIN_SECRET_LENGTH);

type Raw = {
  readonly at: number;
  readonly level: string;
  readonly logger: string | undefined;
  readonly text: string;
};

/** A call's log collector: `hear` each log as it arrives, `entries` what the call gives back. */
export const callLogs = (input: {
  readonly now: () => number;
  /** What to scrub: the tokens the call has sent so far and the Secrets it was given, asked when the entries are made. */
  readonly tokens: () => ReadonlySet<string>;
}) => {
  const raw: Array<Raw> = [];

  return {
    hear: (log: McpLog) => {
      raw.push({
        at: input.now(),
        level: log.level,
        logger: log.logger,
        text: textOf(log).slice(0, RAW_LIMIT),
      });

      if (raw.length > MCP_LOG_RING) raw.shift();
    },
    entries: (): ReadonlyArray<McpLogEntry> => {
      const hidden = input.tokens();

      return Arr.map(raw, (entry): McpLogEntry => {
        const data = scrubText(entry.text, hidden).slice(0, MCP_LOG_DATA_MAX);
        const logger = entry.logger === undefined ? undefined : scrubText(entry.logger, hidden);

        return logger === undefined
          ? { at: entry.at, level: entry.level, data }
          : { at: entry.at, level: entry.level, logger, data };
      });
    },
  };
};
