// docs/architecture/visuals.md → The frame: Lazy mounting. A Visual's frame mounts when its card comes near the viewport and
// unmounts when it goes far from it, never while it has the focus: two distances, so a card at the edge of one does not
// mount and unmount as the transcript scrolls by a line. Where the page has no `IntersectionObserver` every card is near.
// The watch is a context, so a test says what is near.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- a hook and its seam over the DOM's observers, not combinators.
import { createContext, use, useEffect, useState, type RefObject } from "react";

/** How far from the viewport a card's frame mounts, and how far it unmounts. */
export const NEAR_MARGIN = "1200px 0px";
export const FAR_MARGIN = "3600px 0px";

/** Watch whether `element` is near the viewport: `onChange` is told each time it comes near or goes far; returns the stop. */
export type ViewportWatch = (element: Element, onChange: (near: boolean) => void) => () => void;

/** The page's watch, on two `IntersectionObserver`s. */
export const observeViewport: ViewportWatch = (element, onChange) => {
  if (typeof IntersectionObserver === "undefined") {
    onChange(true);

    return () => undefined;
  }

  const near = new IntersectionObserver(
    (records) => {
      if (records.some((record) => record.isIntersecting)) onChange(true);
    },
    { rootMargin: NEAR_MARGIN },
  );

  const far = new IntersectionObserver(
    (records) => {
      if (records.length > 0 && records.every((record) => !record.isIntersecting)) onChange(false);
    },
    { rootMargin: FAR_MARGIN },
  );

  near.observe(element);
  far.observe(element);

  return () => {
    near.disconnect();
    far.disconnect();
  };
};

export const ViewportWatchContext = createContext<ViewportWatch>(observeViewport);

/** Whether a frame is mounted: near the viewport, or focused (only a mounted frame can be, so it stays while it is). */
export const shouldMount = (near: boolean, focused: boolean): boolean => near || focused;

/**
 * Whether the card `ref` holds is near the viewport, by the context's watch, and whether it has been at all (`seen`), which
 * is when its page is first loaded. Neither before the card has mounted.
 */
export const useNearViewport = (
  ref: RefObject<Element | null>,
): { readonly near: boolean; readonly seen: boolean } => {
  const watch = use(ViewportWatchContext);
  const [state, setState] = useState({ near: false, seen: false });

  useEffect(() => {
    const element = ref.current;

    if (element === null) return;

    return watch(element, (near) => {
      setState((was) =>
        was.near === near && (was.seen || !near) ? was : { near, seen: was.seen || near },
      );
    });
  }, [watch, ref]);

  return state;
};
