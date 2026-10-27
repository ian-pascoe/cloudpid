// What shows where a lazy part is: its fallback while the chunk loads, and, if the chunk is gone because the app was
// deployed again, a notice with a Reload button in place of the part (`stale-build.ts`), not a crashed card.

import { Component, type ReactNode, Suspense } from "react";
import { ChunkLoadError } from "./lazy-chunk.ts";

/** The notice for a part whose chunk is gone, in the voice of the sign-in notice (`session-chat.tsx`). */
const UpdatedNotice = () => (
  <p role="status" className="p-2 text-sm text-muted-foreground">
    The app was updated.{" "}
    <button
      type="button"
      className="font-medium text-foreground underline underline-offset-2"
      onClick={() => {
        window.location.reload();
      }}
    >
      Reload
    </button>{" "}
    to open this.
  </p>
);

interface BoundaryState {
  readonly error: Error | null;
}

/**
 * Catches what the parts below throw: a `ChunkLoadError` shows the notice, anything else is thrown again to the boundary
 * above. An error boundary has no hook form, so it is the one class here; its state is React's own, not UI state of the
 * app's (ADR-0011).
 */
class StaleChunkBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override render() {
    const { error } = this.state;

    if (error === null) return this.props.children;

    if (error instanceof ChunkLoadError) return <UpdatedNotice />;

    throw error;
  }
}

/** A lazy part: `fallback` while its chunk loads, the "The app was updated" notice if the chunk is gone. */
export const LazyView = ({ fallback, children }: { fallback: ReactNode; children: ReactNode }) => (
  <StaleChunkBoundary>
    <Suspense fallback={fallback}>{children}</Suspense>
  </StaleChunkBoundary>
);
