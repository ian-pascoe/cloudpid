// The Call diff on an `edit` or `write` card, and on the calls a `codemode` card lists (`docs/architecture/diffs-and-review.md`):
// `+n −m` on the line, and, opened, the diff in place of the arguments, with "Open in Diff pane".

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { Button } from "../components/ui/button.tsx";
import { findChange } from "../diff-pane/changes.ts";
import { DiffTally } from "../diff-pane/parts.tsx";
import { openDiffPaneAtom } from "../diff-pane/target.ts";
import { sameWorkspace } from "../session/agents.ts";
import { changesAtom, taskGraphAtom } from "../session/atoms.ts";
import { lazyChunk } from "../lazy-chunk.ts";
import { LazyView } from "../lazy-view.tsx";
import { useWidth } from "../use-width.ts";
import { useShownChanges, useShownSessionId, useThreadConversation } from "./conversation.ts";
import { type CallDiff, callDiffCounts, capPatch, diffStyleFor } from "../call-diff.ts";
import { type CallRef, useCallAnchor } from "../review/call-anchor.ts";
import type { DiffAnchor } from "../review/drafts.ts";

// The library, its highlighter and its theme are a chunk of their own, fetched when the first diff opens.
const PatchView = lazyChunk(() => import("./patch-view.tsx"));

/** What shows where a Call diff has no patch to show. */
const UNAVAILABLE = "Too large to show here";

/**
 * What a Call diff says on a card's line, after the path: a "new file" mark for a create, then `+n −m`, or "No change"
 * where the call left the file as it was, or that the change is too large to show.
 */
export const CallDiffStats = ({ diff }: { diff: CallDiff }) => {
  const counts = useMemo(() => callDiffCounts(diff), [diff]);

  return (
    <>
      {diff.created === true && (
        <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">new file</span>
      )}
      {diff.unavailable === true ? (
        <span className="min-w-0 truncate text-xs text-muted-foreground">{UNAVAILABLE}</span>
      ) : counts !== undefined ? (
        <DiffTally counts={counts} />
      ) : (
        diff.created !== true && (
          <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
            No change
          </span>
        )
      )}
    </>
  );
};

/** What the opened diff shows in its box: the patch, or why there is none. */
const DiffBox = ({
  diff,
  patch,
  width,
  anchor,
}: {
  diff: CallDiff;
  patch: string | undefined;
  width: number | undefined;
  anchor: DiffAnchor | undefined;
}) => {
  const sessionId = useShownSessionId();

  if (diff.unavailable === true) {
    return <p className="p-2 text-sm text-muted-foreground">{UNAVAILABLE}</p>;
  }

  if (patch === undefined || width === undefined) return null;

  if (callDiffCounts(diff) === undefined) {
    return (
      <p className="p-2 text-sm text-muted-foreground">
        {diff.created === true ? "An empty file." : "No change."}
      </p>
    );
  }

  return (
    <LazyView fallback={<p className="p-2 text-sm text-muted-foreground">Loading the diff…</p>}>
      <PatchView
        patch={patch}
        diffStyle={diffStyleFor(width)}
        sessionId={sessionId}
        anchor={anchor}
      />
    </LazyView>
  );
};

/**
 * "Open in Diff pane": the Changes at the file the call wrote, while it has Changes in the current list; otherwise it says
 * it has none, until a list has it again. The page's Diff pane shows one Workspace's Changes (the Session's, or on a
 * Subagent page the subagent's): a call made in another Workspace (a subagent's in a Subagent Workspace of its own) has
 * none there, and shows nothing.
 */
const OpenInDiffPane = ({ path }: { path: string }) => {
  const key = useShownChanges();
  const open = useAtomSet(openDiffPaneAtom(key));

  // The file's Changes in the current list; `null` before the first list.
  const file = useAtomValue(changesAtom(key), (changes) =>
    changes === null ? null : findChange(changes.repos, path),
  );

  const conversationId = useThreadConversation();

  const elsewhere = useAtomValue(
    taskGraphAtom(key.sessionId),
    (graph) => !sameWorkspace(graph, conversationId, key.conversationId),
  );

  if (elsewhere) return null;

  if (file === undefined) {
    return (
      <span role="status" className="shrink-0 text-xs text-muted-foreground">
        No Changes in this file now
      </span>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs text-muted-foreground"
      onClick={() => {
        open({ file: file?.id ?? null });
      }}
    >
      Open in Diff pane
    </Button>
  );
};

/**
 * What an opened card shows for a Call diff: the file's path (with a "new file" mark for a create) and the diff, split or
 * stacked by the card's width and cut at the line cap until "Show all" is pressed. A card's arguments and result sit
 * behind a toggle; the calls a `codemode` card lists have none. The owner drafts Annotations on it from its gutter.
 */
export const CallDiffBody = ({
  diff,
  path,
  call,
  callRef,
}: {
  diff: CallDiff;
  path: string | undefined;
  /** The card's arguments and result, as they show on a card with no diff. */
  call?: ReactNode;
  /** The call it was drawn from, which drafts on it anchor to. */
  callRef: Omit<CallRef, "path">;
}) => {
  const anchor = useCallAnchor({ ...callRef, path: diff.path ?? path });
  const [showAll, setShowAll] = useState(false);
  const [showCall, setShowCall] = useState(false);
  const { ref, width } = useWidth();
  const callId = useId();

  const capped = useMemo(
    () => (diff.patch === undefined ? undefined : capPatch(diff.patch)),
    [diff.patch],
  );

  return (
    <div ref={ref} className="min-w-0">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{path}</span>
        {diff.created === true && (
          <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">new file</span>
        )}
        {path !== undefined && <OpenInDiffPane path={path} />}
        {call !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={showCall}
            aria-controls={callId}
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => {
              setShowCall(!showCall);
            }}
          >
            Arguments and result
          </Button>
        )}
      </div>
      <div className="mt-2 overflow-hidden rounded border">
        <DiffBox
          diff={diff}
          patch={showAll ? diff.patch : capped?.patch}
          width={width}
          anchor={anchor}
        />
      </div>
      {capped?.capped === true && !showAll && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => {
            setShowAll(true);
          }}
        >
          Show all {capped.lines} lines
        </Button>
      )}
      {showCall && (
        <div id={callId} className="mt-3">
          {call}
        </div>
      )}
    </div>
  );
};
