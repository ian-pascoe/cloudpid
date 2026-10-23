// @effect-diagnostics preferEffectArray:off -- the open Panes are a short list of keys, rendered as JSX lists over native arrays.

// The Pane area beside a Session's chat: a tab for each open Pane and the shown one's component under them. A resizable
// right column on `md` and up, its width kept on the device; a full-screen sheet on a phone. Every Pane type lives here:
// none picks its own edge.

import { useAtom } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import { X } from "lucide-react";
import {
  useId,
  useRef,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { SessionTreePane } from "./chat/tree-pane.tsx";
import { TasksPane } from "./chat/tasks-pane.tsx";
import { cn } from "./lib/utils.ts";
import { paneKeyOf, tabForKey, type PaneProps, type PaneTypeId } from "./panes.ts";
import {
  DEFAULT_PANE_WIDTH,
  MAX_PANE_WIDTH,
  MIN_PANE_WIDTH,
  paneWidthAtom,
  paneWidthForKey,
  panesAtom,
} from "./panes-state.ts";

/** The component each Pane type shows. A type in `PANE_TYPES` with none is a type error. */
const PANE_COMPONENTS = { tasks: TasksPane, tree: SessionTreePane } satisfies {
  readonly [Id in PaneTypeId]: ComponentType<PaneProps>;
};

const componentOf = (id: string): ComponentType<PaneProps> | undefined =>
  Option.getOrUndefined(Record.get<string, ComponentType<PaneProps>>(PANE_COMPONENTS, id));

/** The strip between the Pane area and the chat: drag it, or focus it and use the arrow keys, Home and End. */
const ResizeHandle = ({
  area,
  controls,
}: {
  area: RefObject<HTMLElement | null>;
  controls: string;
}) => {
  const [width, setWidth] = useAtom(paneWidthAtom);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = paneWidthForKey(width, event.key, event.shiftKey);

    if (next === undefined) return;

    event.preventDefault();
    setWidth(next);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;

    const right = area.current?.getBoundingClientRect().right;

    if (right !== undefined) setWidth(right - event.clientX);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panes"
      aria-controls={controls}
      aria-valuemin={MIN_PANE_WIDTH}
      aria-valuemax={MAX_PANE_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={onPointerMove}
      onDoubleClick={() => {
        setWidth(DEFAULT_PANE_WIDTH);
      }}
      className="group absolute inset-y-0 -left-1.5 z-10 hidden w-3 cursor-col-resize touch-none select-none outline-none md:block"
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors group-hover:bg-ring group-focus-visible:bg-ring group-active:bg-ring" />
    </div>
  );
};

/** The Pane area of the Session shown: nothing while no Pane is open. */
export const PaneArea = () => {
  const [{ open, shown }, act] = useAtom(panesAtom);
  const [width] = useAtom(paneWidthAtom);
  const base = useId();
  const area = useRef<HTMLElement>(null);
  const tabs = useRef<HTMLDivElement>(null);

  if (shown === undefined) return null;

  const style: CSSProperties & Record<`--${string}`, string> = { "--pane-width": `${width}px` };
  const tabId = (key: string) => `${base}-tab-${open.indexOf(key)}`;
  const panelId = (key: string) => `${base}-panel-${open.indexOf(key)}`;

  // Arrow keys, Home and End move between the tabs, as a tab list does; a tab shows its Pane as it takes the focus.
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab") {
      return;
    }

    const target = tabForKey({ open, shown }, event.key);

    if (target === undefined) return;

    event.preventDefault();
    act({ type: "show", key: target });
    tabs.current?.querySelectorAll<HTMLElement>('[role="tab"]')[open.indexOf(target)]?.focus();
  };

  return (
    <aside
      ref={area}
      id={`${base}-area`}
      aria-label="Panes"
      style={style}
      className="fixed inset-0 z-20 flex flex-col bg-background md:relative md:inset-auto md:z-auto md:w-(--pane-width) md:max-w-[calc(100%-20rem)] md:min-w-72 md:shrink-0 md:border-l"
    >
      <ResizeHandle area={area} controls={`${base}-area`} />
      <header className="border-b px-2 py-1.5">
        <div
          ref={tabs}
          role="tablist"
          aria-label="Open panes"
          onKeyDown={onTabKeyDown}
          className="flex gap-1 overflow-x-auto"
        >
          {open.map((key) => {
            const pane = paneKeyOf(key);
            const label = pane?.type.label(pane.argument) ?? { name: key };
            const selected = key === shown;

            return (
              <div
                key={key}
                className={cn(
                  "flex h-9 shrink-0 items-center rounded-md md:h-8",
                  selected
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  id={tabId(key)}
                  aria-selected={selected}
                  aria-controls={panelId(key)}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => {
                    act({ type: "show", key });
                  }}
                  className="flex h-full max-w-48 items-center gap-1.5 rounded-md pr-1 pl-3 text-sm font-medium"
                >
                  <span className="truncate">{label.name}</span>
                  {label.agent !== undefined && (
                    <span className="truncate font-mono text-xs font-normal text-muted-foreground">
                      {label.agent}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${label.name}`}
                  title={`Close ${label.name}`}
                  onClick={() => {
                    act({ type: "close", key });
                  }}
                  className="touch-target mr-1 flex size-7 items-center justify-center rounded-md hover:bg-accent [&_svg]:size-3.5"
                >
                  <X />
                </button>
              </div>
            );
          })}
        </div>
      </header>
      {/* Every open Pane stays mounted, the ones not shown hidden, so one keeps its state (scroll, a connection) while another is shown. */}
      {open.map((key) => {
        const pane = paneKeyOf(key);
        const Component = pane === undefined ? undefined : componentOf(pane.type.id);

        return (
          <div
            key={key}
            role="tabpanel"
            id={panelId(key)}
            aria-labelledby={tabId(key)}
            hidden={key !== shown}
            className="flex min-h-0 flex-1 flex-col"
          >
            {Component !== undefined && pane !== undefined && (
              <Component
                argument={pane.argument}
                close={() => {
                  act({ type: "close", key });
                }}
              />
            )}
          </div>
        );
      })}
    </aside>
  );
};
