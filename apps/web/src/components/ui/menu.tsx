// @effect-diagnostics preferEffectArray:off preferEffectRecord:off -- browser code in a React app with no Effect runtime.

import { Ellipsis } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useId, useRef } from "react";
import { cn } from "../../lib/utils.ts";

/** The gap between the button and its menu, and the least room kept from the viewport's edges. */
const GAP = 4;

/** Where each key moves focus among `count` items from `at` (-1 when none has it), if anywhere. */
const MOVES = {
  ArrowDown: (at, count) => (at + 1) % count,
  ArrowUp: (at, count) => (at - 1 + count) % count,
  Home: () => 0,
  End: (_at, count) => count - 1,
} satisfies Readonly<Record<string, (at: number, count: number) => number>>;

const isMoveKey = (key: string): key is keyof typeof MOVES => Object.hasOwn(MOVES, key);

/** The menu's items that can take focus, in order. */
const itemsOf = (menu: HTMLElement): HTMLElement[] => [
  ...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'),
];

/**
 * Place `menu` under `trigger`, its right edge on the trigger's, or above it when there is no room below. The menu is a
 * popover in the top layer, so it is positioned against the viewport.
 */
const place = (menu: HTMLElement, trigger: HTMLElement) => {
  const anchor = trigger.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = menu;

  const below = anchor.bottom + GAP;

  const top =
    below + height > window.innerHeight - GAP && anchor.top - GAP - height >= GAP
      ? anchor.top - GAP - height
      : below;

  const left = Math.min(Math.max(GAP, anchor.right - width), window.innerWidth - width - GAP);

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
};

/**
 * A "⋯" button and the menu it opens: the platform's Popover API, so the menu sits in the top layer, closes on Escape
 * or a click outside, and gives focus back to the button. Arrow keys, Home and End move between the items.
 */
export const Menu = ({
  label,
  icon = <Ellipsis className="size-4" aria-hidden />,
  title,
  children,
  className,
}: {
  /** What the button says to assistive technology, such as "Actions for Fix the build". */
  label: string;
  /** The button's icon: "⋯" unless the menu is better named by another. */
  icon?: ReactNode;
  /** The button's tooltip. */
  title?: string | undefined;
  children: ReactNode;
  className?: string | undefined;
}) => {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = menu.current;

    if (element === null) return;

    const onToggle = (event: Event) => {
      const open = event instanceof ToggleEvent && event.newState === "open";

      trigger.current?.setAttribute("aria-expanded", String(open));

      if (!open || trigger.current === null) return;

      place(element, trigger.current);
      itemsOf(element)[0]?.focus();
    };

    // The menu is placed again while open, so it follows its button when the page scrolls or resizes.
    const follow = () => {
      if (trigger.current !== null && element.matches(":popover-open"))
        place(element, trigger.current);
    };

    element.addEventListener("toggle", onToggle);
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, true);

    return () => {
      element.removeEventListener("toggle", onToggle);
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, true);
    };
  }, []);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-expanded="false"
        aria-label={label}
        title={title}
        className={cn(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
          className,
        )}
      >
        {icon}
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        role="menu"
        aria-label={label}
        onKeyDown={(event) => {
          if (!isMoveKey(event.key)) return;

          const move = MOVES[event.key];

          const items = itemsOf(event.currentTarget);

          const at = items.findIndex((item) => item === document.activeElement);

          const next = items[move(at, items.length)];

          if (next === undefined) return;

          event.preventDefault();
          next.focus();
        }}
        className="fixed m-0 min-w-44 rounded-lg border bg-background p-1 text-foreground shadow-sm"
      >
        {children}
      </div>
    </>
  );
};

/** One action of a `Menu`. It closes the menu, then runs. */
export const MenuItem = ({
  destructive = false,
  onSelect,
  children,
  className,
  ...props
}: Omit<ComponentProps<"button">, "onClick" | "onSelect"> & {
  /** Brick Red: the action deletes. */
  destructive?: boolean;
  onSelect: () => void;
}) => (
  <button
    type="button"
    role="menuitem"
    onClick={(event) => {
      event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
      onSelect();
    }}
    className={cn(
      "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:-outline-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
      destructive
        ? "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10"
        : "hover:text-accent-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </button>
);
