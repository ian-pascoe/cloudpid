// @effect-diagnostics missingPipeableSignature:off -- reads of the page, not a combinator.
// docs/architecture/mcp-apps.md → The bridge (hostContext). What the open page tells the host context: its theme and
// tokens, its locale, its device and the card's size. The one place of the App View code that reads the DOM for it.
import { isTouchScreen } from "../lib/device.ts";
import type { HostEnvironment } from "./host-context.ts";
import { inlineMaxHeight } from "./host-context.ts";

/** The nearest ancestor of `element` that scrolls vertically (the transcript's scroller), or the page's own element. */
export const scrollerOf = (element: HTMLElement): HTMLElement => {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;

    if (overflow === "auto" || overflow === "scroll") return at;
  }

  return document.documentElement;
};

/** The page's environment for a card whose frame is `width` px wide, in a scroller `scrollerHeight` px tall. */
export const readEnvironment = (width: number, scrollerHeight: number): HostEnvironment => {
  const root = getComputedStyle(document.documentElement);

  return {
    dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    readProperty: (property) => root.getPropertyValue(property),
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: navigator.userAgent,
    mobile: !window.matchMedia("(min-width: 768px)").matches,
    touch: isTouchScreen(),
    hover: window.matchMedia("(hover: hover)").matches,
    width,
    maxHeight: inlineMaxHeight(scrollerHeight),
  };
};

/**
 * The insets the device keeps clear (a notch, the home indicator), in px, as `env(safe-area-inset-*)` resolves them: read
 * through a probe element, since CSS gives them out only to a property. Zero where the device has none.
 */
export const readSafeAreaInsets = () => {
  const probe = document.createElement("div");

  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;" +
    "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.append(probe);

  const style = getComputedStyle(probe);
  const inset = (value: string): number => Number.parseFloat(value) || 0;

  const insets = {
    top: inset(style.paddingTop),
    right: inset(style.paddingRight),
    bottom: inset(style.paddingBottom),
    left: inset(style.paddingLeft),
  };

  probe.remove();

  return insets;
};
