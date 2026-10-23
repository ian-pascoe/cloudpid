import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Check, Ellipsis } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useId, useRef } from "react";
import { cn } from "../../lib/utils.ts";
import { type Align, popoverPanel, useAnchoredPopover } from "./popover.tsx";

/** Where each key moves focus among `count` items from `at` (-1 when none has it), if anywhere. */
const MOVES = {
  ArrowDown: (at, count) => (at + 1) % count,
  ArrowUp: (at, count) => (at - 1 + count) % count,
  Home: () => 0,
  End: (_at, count) => count - 1,
} satisfies Readonly<Record<string, (at: number, count: number) => number>>;

// @effect-diagnostics-next-line preferEffectRecord:off -- `key` is any key the DOM reports, not a key of the table.
const isMoveKey = (key: string): key is keyof typeof MOVES => Object.hasOwn(MOVES, key);

/** The menu's items that can take focus, in order. */
const itemsOf = (menu: HTMLElement): HTMLElement[] => [
  ...menu.querySelectorAll<HTMLElement>(
    '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)',
  ),
];

/**
 * A button and the menu it opens: the platform's Popover API, so the menu sits in the top layer, closes on Escape or a
 * click outside, and gives focus back to the button. Arrow keys, Home and End move between the items; opening it
 * focuses the checked item, else the first. The button is a "⋯" unless `icon` gives it other content.
 */
export const Menu = ({
  label,
  icon = <Ellipsis className="size-4" aria-hidden />,
  title,
  disabled = false,
  align = "end",
  onOpenChange,
  children,
  className,
  menuClassName,
}: {
  /** What the button says to assistive technology, such as "Actions for Fix the build". */
  label: string;
  /** What the button shows: "⋯" unless the menu is better named by another icon, or by its value. */
  icon?: ReactNode;
  /** The button's tooltip. */
  title?: string | undefined;
  /** Holds the button, so the menu cannot be opened. */
  disabled?: boolean;
  /** Which edge of the button the menu lines up with. */
  align?: Align;
  /** Hears the menu open and close, for a menu whose items are only worth fetching while it is open. */
  onOpenChange?: ((open: boolean) => void) | undefined;
  children: ReactNode;
  className?: string | undefined;
  menuClassName?: string | undefined;
}) => {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = menu.current;

    if (element === null || onOpenChange === undefined) return;

    const onToggle = (event: Event) => {
      onOpenChange(event instanceof ToggleEvent && event.newState === "open");
    };

    element.addEventListener("toggle", onToggle);

    return () => {
      element.removeEventListener("toggle", onToggle);
    };
  }, [onOpenChange]);

  useAnchoredPopover(trigger, menu, align, (element) => {
    const items = itemsOf(element);

    const first = Arr.findFirst(items, (item) => item.getAttribute("aria-checked") === "true").pipe(
      Option.orElse(() => Arr.head(items)),
      Option.getOrUndefined,
    );

    first?.focus();
  });

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
        disabled={disabled}
        className={cn(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50",
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

          const at = Arr.findFirstIndex(items, (item) => item === document.activeElement).pipe(
            Option.getOrElse(() => -1),
          );

          const next = items[move(at, items.length)];

          if (next === undefined) return;

          event.preventDefault();
          next.focus();
        }}
        className={cn(popoverPanel, "max-h-[70vh] min-w-44 overflow-y-auto", menuClassName)}
      >
        {children}
      </div>
    </>
  );
};

/**
 * One action of a `Menu`. It closes the menu, then runs. With `checked` it is one choice of several (a radio item),
 * marked when it is the one chosen.
 */
export const MenuItem = ({
  destructive = false,
  checked,
  onSelect,
  children,
  className,
  ...props
}: Omit<ComponentProps<"button">, "onClick" | "onSelect"> & {
  /** Brick Red: the action deletes. */
  destructive?: boolean;
  /** Whether this choice is the one chosen; absent for an action. */
  checked?: boolean | undefined;
  onSelect: () => void;
}) => (
  <button
    type="button"
    role={checked === undefined ? "menuitem" : "menuitemradio"}
    aria-checked={checked}
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
    {checked === undefined ? (
      children
    ) : (
      <>
        <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
        <Check className={cn("text-foreground", !checked && "invisible")} aria-hidden />
      </>
    )}
  </button>
);

/** A heading over a group of a `Menu`'s items. */
export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <div role="presentation" className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
    {children}
  </div>
);

/** A line between groups of a `Menu`'s items. */
export const MenuSeparator = () => <div role="separator" className="-mx-1 my-1 h-px bg-border" />;
