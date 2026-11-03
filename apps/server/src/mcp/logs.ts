// The server logs a call brought back (`docs/architecture/mcp-connections.md` → Telemetry; #382 D12.2): kept in the
// server's ring (`log-store.ts`), and each `warning` or above also a span event on the span that heard it, with its
// level, logger and data (already cut to 2 KiB and scrubbed of tokens and header values by the engine). Nothing here
// reaches a model or a Session's transcript. A discovery's logs come in its result, since it passes the engine no hooks;
// a request's come the same way.
// @effect-diagnostics missingPipeableSignature:off -- host operations, not combinators.
import { isWarningOrAbove, type McpLogEntry } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { McpHostStore } from "./store.ts";

/** The name of the span event a `warning` or above becomes. */
export const LOG_EVENT = "mcp.log";

/**
 * Keep `entries`, which `conn`'s server sent during a call, and raise a span event for each `warning` or above on the
 * current span, which also counts them (`mcp.logs`, `mcp.log_warnings`). A refused write fails this, as any write of
 * the host's does.
 */
export const recordLogs = (conn: string, entries: ReadonlyArray<McpLogEntry> | undefined) =>
  Effect.gen(function* () {
    if (entries === undefined || entries.length === 0) return;

    const store = yield* McpHostStore;

    store.putLogs(conn, entries);

    const warnings = Arr.filter(entries, (entry) => isWarningOrAbove(entry.level));
    const span = yield* Effect.currentSpan.pipe(Effect.option);

    yield* Effect.annotateCurrentSpan({
      "mcp.logs": entries.length,
      "mcp.log_warnings": warnings.length,
    });

    for (const entry of warnings) {
      const at = yield* Clock.currentTimeNanos;

      Option.map(span, (current) =>
        current.event(LOG_EVENT, at, {
          level: entry.level,
          logger: entry.logger ?? "",
          data: entry.data,
        }),
      );
    }
  });
