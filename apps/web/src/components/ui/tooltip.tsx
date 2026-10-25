// @effect-diagnostics globalTimers:off -- a hover waits a moment before its tooltip shows, timed by a React handler.
// @effect-diagnostics missingPipeableSignature:off -- a React component, not a combinator.

import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { hidePopover, placePopover } from "./popover.tsx";

/** How long a mouse rests on the control before its tooltip shows, so one passing over a row of buttons shows none. */
const SHOW_AFTER_MS = 400;

/**
 * A short tip on a control, such as what an icon button does or why it is disabled: shown under it (above where there is
 * no room) after a mouse rests on it, or at once when the keyboard focuses it; hidden when the pointer or the focus
 * leaves, on a press, on Escape and on a scroll. A popover in the top layer, so never clipped. The control gets the
 * tip's id through `children`, for its `aria-describedby`. A touch shows nothing: a tap is the press itself.
 *
 * The control is wrapped in a span that hears the pointer, so a disabled button, which hears none, still says why. A
 * popover the control opens (a menu) shows no tip, nor does the control while that popover is open.
 */
export const Tooltip = ({
  content,
  children,
}: {
  content: ReactNode;
  /** The control, given the tip's id. */
  children: (describedBy: string) => ReactNode;
}) => {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);

  const show = () => {
    clearTimeout(timer.current);

    const control = anchor.current;
    const tip = panel.current;

    if (
      control === null ||
      tip === null ||
      tip.matches(":popover-open") ||
      control.querySelector(":popover-open") !== null
    ) {
      return;
    }

    tip.showPopover();
    placePopover(tip, control, "center");
  };

  const hide = () => {
    clearTimeout(timer.current);
    hidePopover(panel.current);
  };

  // Whether an event is the control's, not a popover's it opened: a menu's items are in the wrapper too.
  const onControl = (target: EventTarget) => {
    const opened = target instanceof Element ? target.closest("[popover]") : null;

    return opened === null || anchor.current?.contains(opened) !== true;
  };

  // A tip whose text changes while it shows ("Copied") is placed again for its new width.
  useLayoutEffect(() => {
    if (open && anchor.current !== null && panel.current !== null) {
      placePopover(panel.current, anchor.current, "center");
    }
  }, [open, content]);

  // The control moves away from under the tip when the page scrolls.
  useEffect(() => {
    if (!open) return;

    const close = () => hidePopover(panel.current);

    window.addEventListener("scroll", close, true);

    return () => {
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <>
      <span
        ref={anchor}
        className="inline-flex"
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse" || !onControl(event.target)) return;

          clearTimeout(timer.current);
          timer.current = setTimeout(show, SHOW_AFTER_MS);
        }}
        onPointerLeave={hide}
        onPointerDown={hide}
        onFocus={(event) => {
          if (onControl(event.target) && event.target.matches(":focus-visible")) show();
        }}
        onBlur={hide}
        onKeyDown={(event) => {
          if (event.key === "Escape") hide();
        }}
      >
        {children(id)}
      </span>
      <div
        ref={panel}
        id={id}
        popover="manual"
        role="tooltip"
        onToggle={(event) => setOpen(event.newState === "open")}
        className="pointer-events-none fixed m-0 max-w-64 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-sm"
      >
        {content}
      </div>
    </>
  );
};
