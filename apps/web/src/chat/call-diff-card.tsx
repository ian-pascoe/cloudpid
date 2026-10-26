// The Call diff on an `edit` or `write` card, and on the calls a `codemode` card lists (`docs/spec.md` → Diffs and
// review): `+n −m` on the line, and, opened, the diff in place of the arguments.

import {
  lazy,
  Suspense,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "../components/ui/button.tsx";
import {
  type CallDiff,
  callDiffCounts,
  capPatch,
  diffStyleFor,
  type DiffCounts,
} from "../call-diff.ts";

// The library, its highlighter and its theme are a chunk of their own, fetched when the first diff opens.
const PatchView = lazy(() => import("./patch-view.tsx"));

/** What shows where a Call diff has no patch to show. */
const UNAVAILABLE = "Too large to show here";

/** `+n −m`: the lines added in Run Green and the lines removed in Brick Red. */
export const DiffTally = ({ counts }: { counts: DiffCounts }) => (
  <span className="tabular shrink-0 font-mono text-xs whitespace-nowrap">
    <span className="text-success">+{counts.additions}</span>{" "}
    <span className="text-destructive">−{counts.deletions}</span>
  </span>
);

/**
 * What a Call diff says on a card's line, after the path: a "new file" mark for a create, then `+n −m`, or "No change"
 * where the call left the file as it was, or that the change is too large to show.
 */
export const CallDiffStats = ({ diff }: { diff: CallDiff }) => {
  const counts = useMemo(() => callDiffCounts(diff), [diff]);

  return (
    <>
      {diff.created === true && (
        <span className="shrink-0 text-xs whitespace-nowrap">new file</span>
      )}
      {diff.unavailable === true ? (
        <span className="min-w-0 truncate text-xs">{UNAVAILABLE}</span>
      ) : counts !== undefined ? (
        <DiffTally counts={counts} />
      ) : (
        diff.created !== true && (
          <span className="shrink-0 text-xs whitespace-nowrap">No change</span>
        )
      )}
    </>
  );
};

/** The width of an element, measured before it is first painted and kept up to date; undefined until then. */
const useWidth = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>();

  useLayoutEffect(() => {
    const element = ref.current;

    if (element === null) return undefined;

    setWidth(element.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];

      if (entry !== undefined) setWidth(entry.contentRect.width);
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  return { ref, width };
};

/** What the opened diff shows in its box: the patch, or why there is none. */
const DiffBox = ({
  diff,
  patch,
  width,
}: {
  diff: CallDiff;
  patch: string | undefined;
  width: number | undefined;
}) => {
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
    <Suspense fallback={<p className="p-2 text-sm text-muted-foreground">Loading the diff…</p>}>
      <PatchView patch={patch} diffStyle={diffStyleFor(width)} />
    </Suspense>
  );
};

/**
 * What an opened card shows for a Call diff: the file's path (with a "new file" mark for a create) and the diff, split or
 * stacked by the card's width and cut at the line cap until "Show all" is pressed. A card's arguments and result sit
 * behind a toggle; the calls a `codemode` card lists have none.
 */
export const CallDiffBody = ({
  diff,
  path,
  call,
}: {
  diff: CallDiff;
  path: string | undefined;
  /** The card's arguments and result, as they show on a card with no diff. */
  call?: ReactNode;
}) => {
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
        <DiffBox diff={diff} patch={showAll ? diff.patch : capped?.patch} width={width} />
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
