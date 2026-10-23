// @effect-diagnostics preferEffectArray:off -- a handful of windows rendered as JSX lists.

// The Live View Pane (#154, ADR-0013): the agent's browser tab, live, for the owner to use while a Browser Handoff
// waits. A header with the agent's instructions, the deadline, Done and Failed; a strip of the tab's windows; and the
// screen, which `screen.ts` wires to the connection (`connection.ts`). It opens only from the handoff card's Take over
// (or a push's link to it) and closes when the handoff ends; closing it does not end the handoff.

import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { AlertTriangle, Check, Keyboard, Loader2, Monitor, RotateCw, X } from "lucide-react";
import { useContext, useEffect, useRef } from "react";
import { useShownSessionId } from "../chat/conversation.ts";
import { Button } from "../components/ui/button.tsx";
import { Dialog } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { isTouchScreen } from "../lib/device.ts";
import { timeOfDay } from "../lib/time.ts";
import { cn } from "../lib/utils.ts";
import type { PaneProps } from "../panes.ts";
import {
  finishLiveViewAtom,
  handoffRequestAtom,
  liveViewAtom,
  liveViewKey,
  liveViewStateAtom,
  retryLiveViewAtom,
  showLiveViewWindowAtom,
  type LiveViewKey,
} from "./atoms.ts";
import { LiveViewScreen } from "./screen.ts";

/** The edit menu's items, in the order iOS shows them. */
const MENU_ITEMS = ["Copy", "Cut", "Paste", "Select All"] as const;

/** Whether the Live View shows the Desktop layout (a 1280-wide viewport, panned and zoomed here), for one Pane. */
const DesktopLayout = ScopedAtom.make(() => Atom.make(false));

/** Whether the Failed form, which asks for an optional reason, is open, for one Pane. */
const Failing = ScopedAtom.make(() => Atom.make(false));

/** Keeps the typing textarea focused when a control is touched: its default would move the focus. */
const keepFocus = {
  onPointerDown: (event: { preventDefault: () => void }) => {
    event.preventDefault();
  },
  onMouseDown: (event: { preventDefault: () => void }) => {
    event.preventDefault();
  },
};

/** Failed, with an optional reason for the agent. */
const FailedDialog = ({ liveView }: { liveView: LiveViewKey }) => {
  const [open, setOpen] = useAtom(Failing.use());
  const finish = useAtomSet(finishLiveViewAtom(liveView));

  return (
    <Dialog
      open={open}
      onClose={() => {
        setOpen(false);
      }}
      title="Tell the agent it failed"
      description="The agent resumes with this. Leave the reason empty to say only that it failed."
    >
      <form
        className="flex flex-col gap-3 p-4 pt-0"
        onSubmit={(event) => {
          event.preventDefault();

          const reason = new FormData(event.currentTarget).get("reason");

          setOpen(false);
          finish(
            reason === null || reason instanceof File || reason.trim() === ""
              ? { success: false }
              : { success: false, reason: reason.trim() },
          );
        }}
      >
        <Input name="reason" aria-label="Reason" placeholder="Reason (optional)" autoFocus />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(false);
            }}
          >
            Cancel
          </Button>
          <Button type="submit" variant="destructive" size="sm">
            Failed
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

/** The header: what the agent asked for, until when, and Done and Failed. */
const Header = ({ liveView }: { liveView: LiveViewKey }) => {
  const state = useAtomValue(liveViewStateAtom(liveView));

  const request = useAtomValue(handoffRequestAtom(liveView)) ?? undefined;
  const finish = useAtomSet(finishLiveViewAtom(liveView));
  const setFailing = useAtomSet(Failing.use());

  const instructions = state.instructions ?? request?.instructions;
  const deadline = state.deadline ?? request?.deadline;
  const live = state.status === "live";

  return (
    <header className="flex flex-col gap-2 border-b px-3 py-2">
      {instructions !== undefined && (
        <p className="line-clamp-3 text-sm break-words whitespace-pre-wrap" title={instructions}>
          {instructions}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {deadline !== undefined && (
          <span className="text-xs text-muted-foreground">Waits until {timeOfDay(deadline)}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!live}
            {...keepFocus}
            onClick={() => {
              setFailing(true);
            }}
          >
            <X aria-hidden />
            Failed
          </Button>
          <Button
            size="sm"
            disabled={!live}
            {...keepFocus}
            onClick={() => {
              finish({ success: true });
            }}
          >
            <Check aria-hidden />
            Done
          </Button>
        </div>
      </div>
      <FailedDialog liveView={liveView} />
    </header>
  );
};

/** The tab and its windows, when it has any; and the Desktop layout and keyboard buttons on a touch screen. */
const Toolbar = ({
  liveView,
  touch,
  keyboardButton,
  onKeyboard,
}: {
  liveView: LiveViewKey;
  touch: boolean;
  keyboardButton: React.RefObject<HTMLButtonElement | null>;
  onKeyboard: () => void;
}) => {
  const strip = useAtomValue(liveViewStateAtom(liveView), (state) => state.strip);
  const show = useAtomSet(showLiveViewWindowAtom(liveView));
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
const Status = ({ liveView }: { liveView: LiveViewKey }) => {
  const state = useAtomValue(liveViewStateAtom(liveView));
  const retry = useAtomSet(retryLiveViewAtom(liveView));

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

const LiveViewOf = ({ liveView, close }: { liveView: LiveViewKey; close: () => void }) => {
  // Reading the Live View keeps it connected while the Pane is open, shown or not.
  const view = useAtomValue(liveViewAtom(liveView), (result) =>
    result.pipe(AsyncResult.value, Option.getOrUndefined),
  );

  const status = useAtomValue(liveViewStateAtom(liveView), (state) => state.status);
  const desktopAtom = DesktopLayout.use();
  const desktop = useAtomValue(desktopAtom);
  const registry = useContext(RegistryContext);

  // Null once a list of the Session's handoffs came without it: the handoff is over.
  const over = useAtomValue(handoffRequestAtom(liveView), (request) => request === null);

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
  const touch = isTouchScreen();

  // The handoff ended (Done, Failed, from here or another device, Stop, or its timeout): the Pane closes.
  useEffect(() => {
    if (status === "ended" || over) close();
  }, [status, over, close]);

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
      view === undefined ||
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
      view,
      {
        get: () => registry.get(desktopAtom),
        subscribe: (listener) => registry.subscribe(desktopAtom, listener),
      },
      { touch },
    );

    screen.current = made;

    return () => {
      made.dispose();
      screen.current = null;
    };
  }, [view, registry, desktopAtom, touch]);

  const local =
    "absolute z-20 rounded-md border-2 border-ring bg-background text-base text-foreground";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header liveView={liveView} />
      <Toolbar
        liveView={liveView}
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
          aria-label="The agent's browser"
          className={cn(
            "absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            desktop ? "overflow-auto" : "overflow-hidden",
          )}
        >
          <canvas ref={canvas} className="mx-auto block touch-none select-none" />
        </div>
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
          <label className="text-sm font-medium" htmlFor={`${liveView.requestId}-paste`}>
            Paste here to type it into the page
          </label>
          <textarea
            ref={pasteField}
            id={`${liveView.requestId}-paste`}
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
        <Status liveView={liveView} />
      </div>
    </div>
  );
};

/** The Live View of the Browser Handoff the Pane's argument names. */
export const LiveViewPane = ({ argument, close }: PaneProps) => {
  const sessionId = useShownSessionId();

  if (argument === undefined) return null;

  return (
    <DesktopLayout.Provider>
      <Failing.Provider>
        <LiveViewOf liveView={liveViewKey(sessionId, argument)} close={close} />
      </Failing.Provider>
    </DesktopLayout.Provider>
  );
};
