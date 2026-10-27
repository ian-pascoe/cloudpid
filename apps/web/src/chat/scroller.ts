// The scrollers a thread's cards sit in: the transcript, or a subagent's thread inside it.

import type { MouseEvent } from "react";

/** The element `element` scrolls in: its nearest ancestor that scrolls vertically. */
export const scrollerOf = (element: HTMLElement | null): HTMLElement | null => {
  let parent = element?.parentElement ?? null;

  while (parent !== null) {
    const { overflowY } = getComputedStyle(parent);

    if (overflowY === "auto" || overflowY === "scroll") return parent;

    parent = parent.parentElement;
  }

  return null;
};

/**
 * For the `onClick` of a card's `summary`, the line that sticks to the top of its scroller while the opened card runs
 * past it. Closing the card from its stuck line would leave the scroller where the card's end was; bring the closed card
 * back to the top instead. Only that scroller moves, so closing a card in a subagent's thread leaves the transcript
 * around it where it was.
 */
export const keepClosedInView = (event: MouseEvent<HTMLElement>) => {
  const line = event.currentTarget;
  const details = line.parentElement;

  if (!(details instanceof HTMLDetailsElement) || !details.open) return;

  // A line that is not stuck sits at its card's top; one pixel of slack for the rounding of fractional positions.
  const stuck = line.getBoundingClientRect().top > details.getBoundingClientRect().top + 1;
  const scroller = scrollerOf(details);

  if (!stuck || scroller === null) return;

  // The click closes the card after this handler; its height is the line's only by the next frame.
  requestAnimationFrame(() => {
    if (details.open) return;

    scroller.scrollTop +=
      details.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  });
};
