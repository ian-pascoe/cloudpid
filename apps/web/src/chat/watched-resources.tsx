import type { McpWatchEntry } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import { X } from "lucide-react";

/**
 * The Resource watches the agent holds (`docs/architecture/mcp-in-a-session.md` → Resource watches, UI): the server and
 * URI of each, with the subagent that holds it when it is not the root, and a ✕ that ends it, so the agent is told at its
 * next request. Nothing when there are none; the ✕ is off while the Session is not live.
 */
export const WatchedResources = ({
  watches,
  holder,
  live,
  onEnd,
}: {
  readonly watches: ReadonlyArray<McpWatchEntry>;
  /** The subagent that holds `watch`: none for the root agent. */
  readonly holder: (watch: McpWatchEntry) => string | undefined;
  readonly live: boolean;
  readonly onEnd: (watch: McpWatchEntry) => void;
}) => {
  if (watches.length === 0) return null;

  return (
    <section aria-label="Watched resources">
      <h4 className="text-xs font-medium text-muted-foreground">Watched resources</h4>
      <ul className="mt-1 text-sm">
        {Arr.map(watches, (watch) => {
          const by = holder(watch);

          return (
            <li
              key={`${watch.conversationId}\0${watch.server}\0${watch.uri}`}
              className="flex items-center justify-between gap-2"
            >
              <span className="min-w-0 break-words">
                <span className="font-medium">{watch.server}</span>{" "}
                <span className="font-mono text-[0.8125rem]">{watch.uri}</span>
                {by !== undefined && <span className="text-xs text-muted-foreground"> ({by})</span>}
              </span>
              <button
                type="button"
                disabled={!live}
                aria-label={`Stop watching ${watch.uri} on ${watch.server}`}
                title="Stop watching: the agent is told at its next request"
                onClick={() => {
                  onEnd(watch);
                }}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5"
              >
                <X aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
