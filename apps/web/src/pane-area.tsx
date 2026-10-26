// @effect-diagnostics preferEffectArray:off -- the open Panes are a short list of keys, rendered as JSX lists over native arrays.

// The Pane area beside a Session's chat: a tab for each open Pane and the shown one's component under them. A resizable
// right column on `md` and up, its width kept on the device; a full-screen sheet on a phone. Every Pane type lives here:
// none picks its own edge. One button in the Session's header (`PaneAreaToggle`) opens the area on the New pane, which
// offers the Pane types, and hides and shows it after; the tab bar's + opens another New pane.

import { useAtom, useAtomMount, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import { PanelRightClose, PanelRightOpen, Plus, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { useShownSessionId } from "./chat/conversation.ts";
import { SessionTreePane } from "./chat/tree-pane.tsx";
import { SubagentPane } from "./chat/subagent-pane.tsx";
import { SubagentsPane, useSubagentsWorking } from "./chat/subagents-pane.tsx";
import { Button } from "./components/ui/button.tsx";
import { DiffPane } from "./diff-pane/diff-pane.tsx";
import { cn } from "./lib/utils.ts";
import { BrowserPane } from "./live-view/browser-pane.tsx";
import { LiveViewPane } from "./live-view/live-view-pane.tsx";
import { handoffAgentsAtom } from "./live-view/handoff-atoms.ts";
import { NewPane } from "./new-pane.tsx";
import {
  NEW_PANE,
  paneKeyOf,
  SUBAGENTS_PANE,
  tabForKey,
  type PaneLookups,
  type PaneProps,
  type PaneTypeId,
} from "./panes.ts";
import { agentLabel } from "./session/agents.ts";
import { taskGraphAtom } from "./session/atoms.ts";
import {
  DEFAULT_PANE_WIDTH,
  MAX_PANE_WIDTH,
  MIN_CHAT_WIDTH,
  MIN_PANE_WIDTH,
  paneWidthAtom,
  paneWidthForKey,
  panesAtom,
  rememberPanesAtom,
  widestPaneIn,
} from "./panes-state.ts";

/** The component each Pane type shows. A type in `PANE_TYPES` with none is a type error. */
const PANE_COMPONENTS = {
  new: NewPane,
  subagents: SubagentsPane,
  subagent: SubagentPane,
  tree: SessionTreePane,
  browser: BrowserPane,
  "live-view": LiveViewPane,
  diff: DiffPane,
} satisfies {
  readonly [Id in PaneTypeId]: ComponentType<PaneProps>;
};

const componentOf = (id: string): ComponentType<PaneProps> | undefined =>
  Option.getOrUndefined(Record.get<string, ComponentType<PaneProps>>(PANE_COMPONENTS, id));

/**
 * The width in px of the element `area` is in (the chat and the Pane area together), as it changes; undefined until it
 * is laid out.
 */
const useRoom = (area: RefObject<HTMLElement | null>): number | undefined => {
  const [room, setRoom] = useState<number>();

  useEffect(() => {
    const page = area.current?.parentElement;

    if (page === null || page === undefined) return;

    const observer = new ResizeObserver(() => {
      setRoom(page.clientWidth);
    });

    observer.observe(page);

    return () => {
      observer.disconnect();
    };
  }, [area]);

  return room;
};

/** The strip between the Pane area and the chat: drag it, or focus it and use the arrow keys, Home and End. */
const ResizeHandle = ({
  area,
  controls,
}: {
  area: RefObject<HTMLElement | null>;
  controls: string;
}) => {
  const [width, setWidth] = useAtom(paneWidthAtom);
  // The area may take all of the page's room but the chat's least width.
  const room = useRoom(area);
  const widest = room === undefined ? MAX_PANE_WIDTH : widestPaneIn(room);
  // A width kept from a wider window shows as the widest this one has room for, and the keys move from there.
  const shown = Math.min(width, widest);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = paneWidthForKey(shown, event.key, event.shiftKey, widest);

    if (next === undefined) return;

    event.preventDefault();
    setWidth(next);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;

    const right = area.current?.getBoundingClientRect().right;

    if (right !== undefined) setWidth(Math.min(widest, right - event.clientX));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panes"
      aria-controls={controls}
      aria-valuemin={MIN_PANE_WIDTH}
      aria-valuemax={widest}
      aria-valuenow={shown}
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

/**
 * What the tabs' labels look up in the Session shown: whose Browser Handoff a Live View is for, and which agent a
 * Subagent Pane shows.
 */
const usePaneLookups = (): PaneLookups => {
  const sessionId = useShownSessionId();
  const handoffAgents = useAtomValue(handoffAgentsAtom(sessionId));
  const graph = useAtomValue(taskGraphAtom(sessionId));

  return {
    agentOfHandoff: (requestId) => handoffAgents.get(requestId),
    agentOfConversation: (conversationId) => agentLabel(graph, conversationId),
  };
};

/** The Pane area's element, which the header's button controls: a Session page has one. */
const PANE_AREA_ID = "pane-area";

/**
 * The header's button for the Pane area: it opens the New pane while no Pane is open, else hides the area or shows it
 * again. While subagents work and the Subagents Pane is not in sight, it says how many.
 */
export const PaneAreaToggle = () => {
  const [{ open, shown, hidden }, act] = useAtom(panesAtom);
  const working = useSubagentsWorking();
  const visible = open.length > 0 && !hidden;
  const label = visible ? "Hide panes" : open.length > 0 ? "Show panes" : "Open a pane";
  const badge = working > 0 && !(visible && shown === SUBAGENTS_PANE);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={badge ? `${label} (${working} working)` : label}
      aria-expanded={visible}
      aria-controls={open.length > 0 ? PANE_AREA_ID : undefined}
      title={label}
      onClick={() => {
        act({ type: "toggleArea" });
      }}
      className="relative size-8 text-muted-foreground"
    >
      {visible ? <PanelRightClose /> : <PanelRightOpen />}
      {badge && (
        <span
          aria-hidden
          className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.625rem] leading-none font-medium text-primary-foreground tabular-nums"
        >
          {working}
        </span>
      )}
    </Button>
  );
};

/**
 * The Pane area of the Session shown: nothing while no Pane is open. Hidden, it keeps its Panes mounted, so a Live View
 * stays connected and every Pane comes back as it was. What it has open is kept in the Session's layout, so it opens
 * again as it was when the owner comes back to the Session.
 */
export const PaneArea = () => {
  useAtomMount(rememberPanesAtom(useShownSessionId()));

  const [{ open, shown, hidden }, act] = useAtom(panesAtom);
  const lookups = usePaneLookups();
  const [width] = useAtom(paneWidthAtom);
  const base = useId();
  const area = useRef<HTMLElement>(null);
  const tabs = useRef<HTMLDivElement>(null);

  if (shown === undefined) return null;

  const style: CSSProperties & Record<`--${string}`, string> = {
    "--pane-width": `${width}px`,
    "--min-chat-width": `${MIN_CHAT_WIDTH}px`,
  };

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
      id={PANE_AREA_ID}
      aria-label="Panes"
      hidden={hidden}
      style={style}
      className="fixed inset-0 z-20 flex flex-col bg-background md:relative md:inset-auto md:z-auto md:w-(--pane-width) md:max-w-[calc(100%-var(--min-chat-width))] md:min-w-72 md:shrink-0 md:border-l"
    >
      <ResizeHandle area={area} controls={PANE_AREA_ID} />
      <header className="flex items-center gap-1 border-b px-2 py-1.5">
        <div
          ref={tabs}
          role="tablist"
          aria-label="Open panes"
          onKeyDown={onTabKeyDown}
          className="flex min-w-0 gap-1 overflow-x-auto"
        >
          {open.map((key) => {
            const pane = paneKeyOf(key);
            const label = pane?.type.label(pane.argument, lookups) ?? { name: key };
            // Several tabs of a type read apart by their agent.
            const named = label.agent === undefined ? label.name : `${label.name} ${label.agent}`;
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
                  aria-label={`Close ${named}`}
                  title={`Close ${named}`}
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
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="New pane"
          title="New pane"
          onClick={() => {
            act({ type: "open", key: NEW_PANE });
          }}
          className="touch-target size-8 text-muted-foreground"
        >
          <Plus />
        </Button>
        {/* On a phone the area covers the header and its button, so it has its own. */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Hide panes"
          title="Hide panes"
          aria-expanded
          aria-controls={PANE_AREA_ID}
          onClick={() => {
            act({ type: "hide" });
          }}
          className="touch-target ml-auto size-8 text-muted-foreground md:hidden"
        >
          <PanelRightClose />
        </Button>
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
