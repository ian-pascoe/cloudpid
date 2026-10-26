// The Call diff on an `edit` card (`docs/spec.md` → Diffs and review): `+n −m` on the card's line, and, opened, the diff
// in place of the arguments.

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
import { capPatch, diffStyleFor, patchCounts } from "../call-diff.ts";

// The library, its highlighter and its theme are a chunk of their own, fetched when the first diff opens.
const PatchView = lazy(() => import("./patch-view.tsx"));

/** `+n −m` for a patch: the lines it adds in Run Green and the lines it removes in Brick Red. */
export const CallDiffStats = ({ patch }: { patch: string }) => {
  const counts = useMemo(() => patchCounts(patch), [patch]);

  return counts === undefined ? null : (
    <span className="tabular shrink-0 font-mono text-xs whitespace-nowrap">
      <span className="text-success">+{counts.additions}</span>{" "}
      <span className="text-destructive">−{counts.deletions}</span>
    </span>
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

/**
 * What an opened `edit` card shows: the file's path and the diff, split or stacked by the card's width and cut at the
 * line cap until "Show all" is pressed. The call's arguments and result sit behind a toggle.
 */
export const CallDiffBody = ({
  patch,
  path,
  call,
}: {
  patch: string;
  path: string | undefined;
  /** The card's arguments and result, as they show on a card with no diff. */
  call: ReactNode;
}) => {
  const [showAll, setShowAll] = useState(false);
  const [showCall, setShowCall] = useState(false);
  const { ref, width } = useWidth();
  const callId = useId();
  const capped = useMemo(() => capPatch(patch), [patch]);

  return (
    <div ref={ref} className="min-w-0">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{path}</span>
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
      </div>
      <div className="mt-2 overflow-hidden rounded border">
        {width === undefined ? null : (
          <Suspense
            fallback={<p className="p-2 text-sm text-muted-foreground">Loading the diff…</p>}
          >
            <PatchView patch={showAll ? patch : capped.patch} diffStyle={diffStyleFor(width)} />
          </Suspense>
        )}
      </div>
      {capped.capped && !showAll && (
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
