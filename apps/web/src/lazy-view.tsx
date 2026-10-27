// What shows where a lazy part is: its fallback while the chunk loads, and, if the chunk is gone because the app was
// deployed again, "This app was updated — Reload" in place of the part, not a crashed card (`stale-build.ts`).

import { Component, type ReactNode, Suspense } from "react";
import { Button } from "./components/ui/button.tsx";
import { ChunkLoadError } from "./lazy-chunk.ts";

/** The notice for a part whose chunk is gone, with the button that fetches the new build. */
export const UpdatedNotice = () => (
  <div role="alert" className="flex flex-wrap items-center gap-2 p-2 text-sm text-muted-foreground">
    <span>This app was updated —</span>
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        window.location.reload();
      }}
    >
      Reload
    </Button>
  </div>
);

interface BoundaryState {
  readonly failure: { readonly error: Error } | null;
}

/**
 * Catches what the parts below throw: a `ChunkLoadError` shows the notice, anything else is thrown again to the boundary
 * above. An error boundary has no hook form, so it is the one class here; its state is React's own, not UI state of the
 * app's (ADR-0011).
 */
class StaleChunkBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { failure: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { failure: { error } };
  }

  override render() {
    const { failure } = this.state;

    if (failure === null) return this.props.children;

    if (failure.error instanceof ChunkLoadError) return <UpdatedNotice />;

    // eslint-disable-next-line @typescript-eslint/only-throw-error -- passing on whatever was thrown.
    throw failure.error;
  }
}

/** A lazy part: `fallback` while its chunk loads, the "This app was updated" notice if the chunk is gone. */
export const LazyView = ({ fallback, children }: { fallback: ReactNode; children: ReactNode }) => (
  <StaleChunkBoundary>
    <Suspense fallback={fallback}>{children}</Suspense>
  </StaleChunkBoundary>
);
