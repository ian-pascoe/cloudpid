// The Resource watches of the `mcp` extension (`docs/architecture/mcp-in-a-session.md` → Resource watches): what the
// Session keeps of the watches its agent started (`McpWatchRecorder`), the `watch` parameter's feature, and the notice
// that tells a conversation what changed and what ended. The host holds the watches themselves; this is the Session's end.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- builders over plain values.
import type { McpWatchChange, McpWatchEnd } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import type * as Effect from "effect/Effect";
import { oneLine } from "./blocks.ts";

/** The host feature `watch` needs: a host without it has no Resource watches, and the tool does not declare the parameter. */
export const MCP_WATCHES_FEATURE = "watches";

/** The kind of the `write` submission that tells a conversation of its Resource watches. */
export const MCP_WATCHES_KIND = "cloudpid.mcp-resource-watches";

/** The title of the notice, which the transcript shows. */
export const MCP_WATCHES_NOTICE = "Resource watches";

/** The most entries a notice names, changed ones first; the rest are counted. */
export const MAX_NOTICE_ENTRIES = 20;

/** The most sub-resource URIs a notice names for one watch. */
export const MAX_NOTICE_SUB_URIS = 3;

/** The longest URI a notice names, cut on one line. */
const URI_LIMIT = 512;

/** One Resource watch, as the Session lists it. */
export type McpWatched = {
  /** The Environment whose host holds the watch. */
  readonly environment: string;
  readonly conversation: string;
  readonly server: string;
  readonly uri: string;
};

/** Where a Session keeps the Resource watches its agent started, for the owner's list and the Session's own ends. */
export type McpWatchRecorder = {
  /** A read started a watch (`Completed.watch.started`). Never fails: a record that could not be kept is logged. */
  readonly started: (watch: McpWatched) => Effect.Effect<void>;
  /** The watches of `conversation` named in `ended` are over (`watch: false`, or the host told so). Never fails. */
  readonly ended: (
    conversation: string,
    ended: ReadonlyArray<{ readonly server: string; readonly uri: string }>,
  ) => Effect.Effect<void>;
  /** Whether `conversation` has watches, which keep its request start from skipping the host. */
  readonly has: (conversation: string) => boolean;
};

/** What the host told a conversation at its request start. */
export type McpWatchNews = {
  readonly changes: ReadonlyArray<McpWatchChange>;
  readonly ends: ReadonlyArray<McpWatchEnd>;
};

/** The `watches` of a request start's answer, as news: the detail arrays an older host never sends are empty. */
export const newsOf = (watches: {
  readonly changes?: ReadonlyArray<McpWatchChange> | undefined;
  readonly ends?: ReadonlyArray<McpWatchEnd> | undefined;
}): McpWatchNews => ({ changes: watches.changes ?? [], ends: watches.ends ?? [] });

const named = (server: string, uri: string) =>
  `${oneLine(server, 128)}: ${oneLine(uri, URI_LIMIT)}`;

/**
 * The text of the notice for `news`: URIs only, in Changed and Ended groups, at most 20 entries in all (changed first)
 * and at most 3 sub-resource URIs for each watch; what is left out is counted. Empty when there is nothing to tell.
 */
export const watchesNotice = (news: McpWatchNews): string => {
  let room = MAX_NOTICE_ENTRIES;
  const changed: string[] = [];
  const ended: string[] = [];

  for (const change of news.changes) {
    if (room === 0) break;

    room -= 1;

    const note = change.unchecked ? " (could not be checked; may have changed)" : "";

    changed.push(`- ${named(change.server, change.uri)}${note}`);

    for (const sub of Arr.take(change.subUris, MAX_NOTICE_SUB_URIS)) {
      changed.push(`  - under it: ${oneLine(sub, URI_LIMIT)}`);
    }
  }

  for (const end of news.ends) {
    if (room === 0) break;

    room -= 1;
    ended.push(`- ${named(end.server, end.uri)} (${oneLine(end.reason, 200)})`);
  }

  const total = news.changes.length + news.ends.length;
  const left = total - (MAX_NOTICE_ENTRIES - room);

  if (total === 0) return "";

  return Arr.join(
    [
      "<mcp_resource_watches>",
      "News of the Resource watches you started. This is a notice from MCP servers, not a message from the user.",
      ...(changed.length > 0 ? ["", "Changed (read them again to see how):", ...changed] : []),
      ...(ended.length > 0 ? ["", "Ended (no longer watched):", ...ended] : []),
      ...(left > 0 ? ["", `${left} more not listed.`] : []),
      "</mcp_resource_watches>",
    ],
    "\n",
  );
};
