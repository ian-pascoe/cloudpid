// @effect-diagnostics missingPipeableSignature:off -- a React hook and components, not combinators.

import { type ReactNode, type RefObject, useEffect, useId, useRef } from "react";
import { cn } from "../../lib/utils.ts";

/** The gap between the button and its panel, and the least room kept from the viewport's edges. */
const GAP = 4;

/** Which edge of its button a panel lines up with: its left edge, its middle, or its right edge. */
export type Align = "start" | "center" | "end";

/**
 * Place `panel` under `trigger`, lined up with it by `align`, or above it when there is no room below. The panel is a
 * popover in the top layer, so it is positioned against the viewport.
 */
export const placePopover = (panel: HTMLElement, trigger: HTMLElement, align: Align) => {
  const anchor = trigger.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = panel;

  const below = anchor.bottom + GAP;

  const top =
    below + height > window.innerHeight - GAP && anchor.top - GAP - height >= GAP
      ? anchor.top - GAP - height
      : below;

  const wanted = {
    start: anchor.left,
    center: anchor.left + anchor.width / 2 - width / 2,
    end: anchor.right - width,
  }[align];

  const left = Math.min(Math.max(GAP, wanted), window.innerWidth - width - GAP);

  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
};

/** Close the popover `panel` if it is open (`hidePopover` throws on one that is not). */
export const hidePopover = (panel: HTMLElement | null) => {
  if (panel?.matches(":popover-open") === true) panel.hidePopover();
};

/**
 * Keep the popover `panel` placed against `trigger` while it is open: on opening, when the page scrolls or resizes, and
 * when its own size changes (items that arrive after it opened). `onOpen` runs once it is placed, to move the focus in;
 * the button's `aria-expanded` follows the panel.
 */
export const useAnchoredPopover = (
  trigger: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  align: Align,
  onOpen: (panel: HTMLElement) => void,
): void => {
  // The latest `onOpen`, read when the panel opens, so the listeners are added once.
  const onOpenRef = useRef(onOpen);

  onOpenRef.current = onOpen;

  useEffect(() => {
    const element = panel.current;

    if (element === null) return;

    const onToggle = (event: Event) => {
      const open = event instanceof ToggleEvent && event.newState === "open";

      trigger.current?.setAttribute("aria-expanded", String(open));

      if (!open || trigger.current === null) return;

      placePopover(element, trigger.current, align);
      onOpenRef.current(element);
    };

    const follow = () => {
      if (trigger.current !== null && element.matches(":popover-open")) {
        placePopover(element, trigger.current, align);
      }
    };

    const resized = new ResizeObserver(follow);

    element.addEventListener("toggle", onToggle);
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, true);
    resized.observe(element);

    return () => {
      element.removeEventListener("toggle", onToggle);
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, true);
      resized.disconnect();
    };
  }, [trigger, panel, align]);
};

/** The panel of a popover: a bordered 10 px surface in the top layer, with the small shadow of what waits on the owner. */
export const popoverPanel =
  "fixed m-0 rounded-lg border bg-background p-1 text-foreground shadow-sm";

/** What can take the focus inside a panel, in order. */
const FOCUSABLE =
  'input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

/**
 * A button and the panel it opens, for a small form or a note beside a control: the platform's Popover API, so the
 * panel sits in the top layer, closes on Escape, Return in a field, or a click outside, and gives focus back to the
 * button. Opening it focuses its first field.
 */
export const Popover = ({
  label,
  title,
  trigger: content,
  align = "start",
  disabled = false,
  children,
  className,
  panelClassName,
}: {
  /** What the panel is, to assistive technology, such as "Branch". */
  label: string;
  /** The button's tooltip. */
  title?: string | undefined;
  /** What the button shows. */
  trigger: ReactNode;
  align?: Align;
  disabled?: boolean;
  children: ReactNode;
  className?: string | undefined;
  panelClassName?: string | undefined;
}) => {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useAnchoredPopover(trigger, panel, align, (element) => {
    element.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  });

  return (
    <>
      <button
        ref={trigger}
        type="button"
        popoverTarget={id}
        aria-haspopup="dialog"
        aria-expanded="false"
        title={title}
        disabled={disabled}
        className={className}
      >
        {content}
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={label}
        // Return in a field is done with the form: it closes the panel, rather than submitting a form around it.
        onKeyDown={(event) => {
          if (
            event.key !== "Enter" ||
            event.nativeEvent.isComposing ||
            !(event.target instanceof HTMLInputElement)
          ) {
            return;
          }

          event.preventDefault();
          event.currentTarget.hidePopover();
        }}
        className={cn(popoverPanel, panelClassName)}
      >
        {children}
      </div>
    </>
  );
};
