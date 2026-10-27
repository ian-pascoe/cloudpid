// @effect-diagnostics missingPipeableSignature:off asyncFunction:off extendsNativeError:off -- plain helpers over a dynamic import, which React.lazy takes as a promise; a native error, as the import's own rejection is one.

// The lazy parts' chunks (`call-diff-card.tsx` → `patch-view.tsx`, `diff-pane.tsx` → `changes-view.tsx`) are fetched
// when first shown; one that is gone after a deploy is a `ChunkLoadError` (`stale-build.ts`, `lazy-view.tsx`).

import { type ComponentType, lazy, type LazyExoticComponent } from "react";

/** A lazy part's chunk could not be loaded: most likely the page's build is older than the deployed one. */
export class ChunkLoadError extends Error {
  override readonly name = "ChunkLoadError";

  constructor(options?: ErrorOptions) {
    super("A chunk of this app could not be loaded", options);
  }
}

/**
 * Loads a chunk with `load` (a dynamic import). A failure is a `ChunkLoadError` the part's boundary (`LazyView`)
 * recognises, whichever way Vite reports it: it throws the error unless `stale-build.ts` took the event over with
 * `preventDefault`, and then the import resolves to nothing at all.
 */
export const loadChunk = async <T>(load: () => Promise<T>): Promise<T> => {
  // The type says a module is there; after a handled `vite:preloadError` it is not.
  let module: T | undefined;

  try {
    module = await load();
  } catch (error) {
    throw new ChunkLoadError({ cause: error });
  }

  if (module === undefined) throw new ChunkLoadError();

  return module;
};

/** `React.lazy` over `loadChunk`: a chunk that cannot be loaded throws a `ChunkLoadError` where the part renders. */
export const lazyChunk = <P extends object>(
  load: () => Promise<{ readonly default: ComponentType<P> }>,
): LazyExoticComponent<ComponentType<P>> => lazy(() => loadChunk(load));
