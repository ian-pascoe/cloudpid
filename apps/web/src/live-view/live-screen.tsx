// @effect-diagnostics preferEffectArray:off -- a handful of windows rendered as JSX lists.

// The Live View's screen as React (#154, ADR-0013): a strip of the tab's windows, the Desktop layout and keyboard
// buttons on a touch screen, and the screen itself, which `screen.ts` wires to the connection (`connection.ts`). It
// takes the Live View from an atom (`LiveViewAtom`) and knows nothing of what the links are for: a Pane puts its own
// chrome around it (the Live View Pane's header, for a Browser Handoff) and decides when to close.

import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { AlertTriangle, Keyboard, Loader2, Monitor, RotateCw } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "../components/ui/button.tsx";
import { isTouchScreen } from "../lib/device.ts";
import { cn } from "../lib/utils.ts";
import {
  liveViewStateAtom,
  retryLiveViewAtom,
  showLiveViewWindowAtom,
  type LiveViewAtom,
} from "./atoms.ts";
import { LiveViewScreen, type ScreenPage } from "./screen.ts";

/** The screen as what a Pane draws over it reads it (`LiveScreen`'s `overlay`); null until it is wired. */
export const ScreenPageContext = createContext<ScreenPage | null>(null);

/** The edit menu's items, in the order iOS shows them. */
const MENU_ITEMS = ["Copy", "Cut", "Paste", "Select All"] as const;

/** Whether the Live View shows the Desktop layout (a 1280-wide viewport, panned and zoomed here), for one screen. */
const DesktopLayout = ScopedAtom.make(() => Atom.make(false));

/** Keeps the typing textarea focused when a control is touched: its default would move the focus. */
export const keepFocus = {
  onPointerDown: (event: { preventDefault: () => void }) => {
    event.preventDefault();
  },
  onMouseDown: (event: { preventDefault: () => void }) => {
    event.preventDefault();
  },
};

/** The tab and its windows, when it has any; and the Desktop layout and keyboard buttons on a touch screen. */
const Toolbar = ({
  view,
  touch,
  keyboardButton,
  onKeyboard,
}: {
  view: LiveViewAtom;
  touch: boolean;
  keyboardButton: React.RefObject<HTMLButtonElement | null>;
  onKeyboard: () => void;
}) => {
  const strip = useAtomValue(liveViewStateAtom(view), (state) => state.strip);
  const show = useAtomSet(showLiveViewWindowAtom(view));
  const [desktop, setDesktop] = useAtom(DesktopLayout.use());
  const windows = strip?.windows ?? [];

  if (windows.length === 0 && !touch) return null;

  const tabButton = (targetId: string, title: string, key: string) => {
    const selected = strip?.shown === targetId;

    return (
      <button
        key={key}
        type="button"
        aria-pressed={selected}
        onClick={() => {
          show(targetId);
        }}
        className={cn(
          "h-7 max-w-40 shrink-0 truncate rounded-md px-2 text-xs",
          selected
            ? "bg-accent font-medium text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground",
        )}
      >
        {title}
      </button>
    );
  };

  return (
    <div className="flex items-center gap-1 border-b px-2 py-1">
      {windows.length > 0 && strip !== null && (
        <div role="group" aria-label="Windows" className="flex min-w-0 gap-1 overflow-x-auto">
          {tabButton(strip.tab, "Tab", strip.tab)}
          {windows.map((window) =>
            tabButton(window.targetId, window.title || "Window", window.targetId),
          )}
        </div>
      )}
      {touch && (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-pressed={desktop}
            title="Desktop layout: a wide page you pan and zoom with two fingers"
            onClick={() => {
              setDesktop(!desktop);
            }}
            className={cn(
              "flex h-7 items-center gap-1 rounded-md px-2 text-xs [&_svg]:size-3.5",
              desktop
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60",
            )}
          >
            <Monitor aria-hidden />
            Desktop
          </button>
          <button
            ref={keyboardButton}
            type="button"
            aria-label="Open the keyboard"
            title="Open the keyboard"
            {...keepFocus}
            onClick={onKeyboard}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent/60 data-attention:bg-primary data-attention:text-primary-foreground [&_svg]:size-3.5"
          >
            <Keyboard aria-hidden />
            <span className="hidden in-data-attention:inline">Tap to type</span>
          </button>
        </div>
      )}
    </div>
  );
};

/** What covers the screen while it is not live: connecting, or lost (or never built) with a way to try again. */
const Status = ({ view }: { view: LiveViewAtom }) => {
  const stateAtom = liveViewStateAtom(view);
  const state = useAtomValue(stateAtom);
  const retry = useAtomSet(retryLiveViewAtom(view));

  if (state.status === "live" || state.status === "ended") return null;

  if (state.status === "lost") {
    return (
      <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-background/90 p-6 text-center">
        <AlertTriangle className="size-5 text-destructive" aria-hidden />
        <p className="text-sm">The Live View is not connected.</p>
        {state.failure !== null && (
          <p className="max-w-sm text-xs break-words text-muted-foreground">{state.failure}</p>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            retry();
          }}
        >
          <RotateCw aria-hidden />
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center gap-2 bg-background/70 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {state.status === "connecting" ? "Connecting to the browser…" : "Reconnecting…"}
    </div>
  );
};

const Screen = ({
  view,
  label,
  overlay,
}: {
  view: LiveViewAtom;
  label: string;
  overlay: ReactNode;
}) => {
  // Reading the Live View keeps it connected while the Pane is open, shown or not.
  const live = useAtomValue(view, (result) =>
    result.pipe(AsyncResult.value, Option.getOrUndefined),
  );

  const desktopAtom = DesktopLayout.use();
  const desktop = useAtomValue(desktopAtom);
  const registry = useContext(RegistryContext);
  const pasteId = useId();

  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const pickSelect = useRef<HTMLSelectElement>(null);
  const pickInput = useRef<HTMLInputElement>(null);
  const pasteBox = useRef<HTMLDivElement>(null);
  const pasteField = useRef<HTMLTextAreaElement>(null);
  const keyboardButton = useRef<HTMLButtonElement>(null);
  const screen = useRef<LiveViewScreen | null>(null);
  const [page, setPage] = useState<ScreenPage | null>(null);
  const touch = isTouchScreen();

  useEffect(() => {
    const elements = {
      container: container.current,
      canvas: canvas.current,
      textarea: textarea.current,
      menu: menu.current,
      pickSelect: pickSelect.current,
      pickInput: pickInput.current,
      pasteBox: pasteBox.current,
      pasteField: pasteField.current,
    };

    if (
      live === undefined ||
      elements.container === null ||
      elements.canvas === null ||
      elements.textarea === null ||
      elements.menu === null ||
      elements.pickSelect === null ||
      elements.pickInput === null ||
      elements.pasteBox === null ||
      elements.pasteField === null
    ) {
      return;
    }

    const made = new LiveViewScreen(
      {
        container: elements.container,
        canvas: elements.canvas,
        textarea: elements.textarea,
        menu: elements.menu,
        pickSelect: elements.pickSelect,
        pickInput: elements.pickInput,
        pasteBox: elements.pasteBox,
        pasteField: elements.pasteField,
        keyboardButton: keyboardButton.current,
      },
      live,
      {
        get: () => registry.get(desktopAtom),
        subscribe: (listener) => registry.subscribe(desktopAtom, listener),
      },
      { touch },
    );

    screen.current = made;
    setPage(made.page);

    return () => {
      made.dispose();
      screen.current = null;
      setPage(null);
    };
  }, [live, registry, desktopAtom, touch]);

  const local =
    "absolute z-20 rounded-md border-2 border-ring bg-background text-base text-foreground";

  return (
    <>
      <Toolbar
        view={view}
        touch={touch}
        keyboardButton={keyboardButton}
        onKeyboard={() => {
          screen.current?.forceKeyboard();
        }}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-muted">
        <div
          ref={container}
          tabIndex={0}
          aria-label={label}
          className={cn(
            "absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            desktop ? "overflow-auto" : "overflow-hidden",
          )}
        >
          <canvas ref={canvas} className="mx-auto block touch-none select-none" />
        </div>
        <ScreenPageContext value={page}>{overlay}</ScreenPageContext>
        {/* What the phone's keyboard types into: invisible, and 16 px so iOS does not zoom on focus. */}
        <textarea
          ref={textarea}
          aria-label="Type into the browser"
          autoComplete="off"
          rows={1}
          className="pointer-events-none absolute top-0 left-0 size-px resize-none overflow-hidden border-0 p-0 text-base opacity-0"
        />
        <div
          ref={menu}
          hidden
          role="menu"
          aria-label="Edit"
          className="absolute z-20 flex overflow-hidden rounded-lg bg-foreground text-sm text-background shadow-sm select-none [&>button+button]:border-l [&>button+button]:border-background/20 [&[hidden]]:hidden"
        >
          {MENU_ITEMS.map((item) => (
            <button
              key={item}
              type="button"
              role="menuitem"
              data-action={item}
              className="px-3 py-2 whitespace-nowrap active:bg-background/20 [&[hidden]]:hidden"
            >
              {item}
            </button>
          ))}
        </div>
        <select ref={pickSelect} hidden aria-label="Choose" className={local} />
        <input ref={pickInput} hidden aria-label="Choose" className={local} />
        <div
          ref={pasteBox}
          hidden
          className="absolute inset-x-3 bottom-3 z-30 flex flex-col gap-2 rounded-lg border bg-background p-3 shadow-sm [&[hidden]]:hidden"
        >
          <label className="text-sm font-medium" htmlFor={pasteId}>
            Paste here to type it into the page
          </label>
          <textarea
            ref={pasteField}
            id={pasteId}
            rows={2}
            className="resize-none rounded-md border border-input bg-background px-3 py-2 text-base"
          />
          <Button
            size="sm"
            variant="outline"
            className="self-end"
            onClick={() => {
              if (pasteBox.current !== null) pasteBox.current.hidden = true;
            }}
          >
            Cancel
          </Button>
        </div>
        <Status view={view} />
      </div>
    </>
  );
};

/**
 * The screen of the Live View `view` holds: its window strip and buttons above the page. Render it in a flex column
 * that gives it the height (it fills what its Pane's own chrome leaves), and read `liveViewStateAtom(view)` for when the
 * Live View ends. `label` names the page for assistive technology (the agent's browser, by default). `overlay` is drawn
 * over the screen, in its wrapper's coordinates, reading it through `ScreenPageContext` (the Browser Pane's pins and
 * Annotate mode).
 */
export const LiveScreen = ({
  view,
  label = "The agent's browser",
  overlay = null,
}: {
  view: LiveViewAtom;
  label?: string;
  overlay?: ReactNode;
}) => (
  <DesktopLayout.Provider>
    <Screen view={view} label={label} overlay={overlay} />
  </DesktopLayout.Provider>
);
