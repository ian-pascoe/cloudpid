// What the host has seen a server use that the MCP spec deprecated (`docs/architecture/mcp-server-requests.md` → Sampling
// requests, Deprecation): per connection key `conn`, the names of the features (`sampling`), noted at the first use and
// shown on the server's status as `deprecated`. These notes are in memory only: they live as long as the host object, are
// never written to its SQLite store, and are told again by the next use after the object restarts; a `warning` log goes out
// only at each first note, so it is once per server per host lifetime.
import * as Effect from "effect/Effect";
import type { McpEngineHooks } from "@cloudpid/mcp/types";

export type DeprecationNotes = {
  /** Note that the server of `conn` used `feature`; true the first time, for the caller's one-time log. */
  readonly noteDeprecated: (conn: string, feature: string) => boolean;
  /** The features the server of `conn` used, in the order they were first seen. */
  readonly deprecated: (conn: string) => ReadonlyArray<string>;
};

export const deprecationNotes = (): DeprecationNotes => {
  const seen = new Map<string, Array<string>>();

  return {
    noteDeprecated: (conn, feature) => {
      const features = seen.get(conn) ?? [];

      if (features.includes(feature)) return false;

      seen.set(conn, [...features, feature]);

      return true;
    },
    deprecated: (conn) => seen.get(conn) ?? [],
  };
};

/**
 * The engine's `onDeprecated` hook for the server `who` names, a call's and a discovery's alike: it notes the feature and,
 * the first time, logs a warning through `run` (SEP-2577 deprecates sampling).
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- builds a hook, not a combinator.
export const deprecationHook =
  (
    notes: Pick<DeprecationNotes, "noteDeprecated">,
    who: { readonly conn: string; readonly name: string },
    run: (log: Effect.Effect<void>) => Promise<void>,
  ): NonNullable<McpEngineHooks["onDeprecated"]> =>
  (feature) => {
    if (notes.noteDeprecated(who.conn, feature)) {
      void run(
        Effect.logWarning(
          `${who.name} used ${feature}, which the MCP spec deprecated in 2026-07-28 (SEP-2577) and may remove from the first revision released on or after 2027-07-28`,
        ),
      );
    }
  };
