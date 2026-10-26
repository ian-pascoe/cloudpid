// @effect-diagnostics globalDate:off -- the owner's clock, for a pause between the Pane's own asks.
// The Browser Pane (#238, ADR-0013): the Session's browser for the owner, in Owner tabs, at any time. It is a tab strip
// (`owner-tab-strip.tsx`: each Owner tab by title, close, and **+**), a URL bar (back, forward, reload, and the tab's
// URL, which Enter navigates) and the screen it shares with the Live View
// (`live-screen.tsx`), over links the Session's `owner_tab_view` mints. Opening it opens an Owner tab when the owner has
// none; closing it leaves the tab open in the browser, so opening it again shows the same page. When the Owner tab is
// gone (closed, or its browser closed or replaced), it says so and offers to open a new Owner tab, and a new one says it
// replaced the one that is gone. An archived Session's Pane opens nothing: it shows an Owner tab still there, if any. It
// opens only from the New pane (or the URL or the Session's layout); it never opens on its own. While a `browser` run
// works in an Owner tab, the tab strip marks it, and over the screen the Pane says the agent (or which subagent) is
// driving the one shown.
//
// While it is in view (shown in the Pane area, the area not hidden, the page visible) its poll of the Owner tabs is the
// heartbeat that keeps the Session's browser (#240); out of view the poll says nothing of it, and the browser closes once
// the idle window passes. When the browser was closed or replaced, the Pane finds its Owner tab gone: in view, it asks to
// open at once, which reopens every Owner tab at its address (no history, scroll, form state or logins) and says so.

import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { OwnerTabDriver } from "@cloudpid/protocol";
import { ArrowLeft, ArrowRight, Bot, Globe, RotateCw, X } from "lucide-react";
import {
  use,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type RefObject,
} from "react";
import { useShownSessionId } from "../chat/conversation.ts";
import { TreeBarScope } from "../chat/tree-actions.ts";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { BROWSER_PANE } from "../panes.ts";
import { panesAtom } from "../panes-state.ts";
import { settledFailureOf } from "../registry.ts";
import { agentLabel } from "../session/agents.ts";
import { ownerTabDriversAtom, taskGraphAtom } from "../session/atoms.ts";
import { addressOf } from "./address.ts";
import { liveViewStateAtom } from "./atoms.ts";
import {
  browserPaneInViewAtom,
  browserPaneKey,
  type BrowserPaneKey,
  browserPaneViewAtom,
  dismissReplacedAtom,
  followOwnerTabAtom,
  ownerTabActionAtom,
  ownerTabCommandAtom,
  ownerTabListAtom,
  ownerTabPageAtom,
  ownerTabReplacedAtom,
  ownerTabsReopenedAtom,
} from "./browser-pane-atoms.ts";
import { drivingNote } from "./driving.ts";
import { keepFocus, LiveScreen } from "./live-screen.tsx";
import { OwnerTabStrip } from "./owner-tab-strip.tsx";

/**
 * Back, forward, reload and the URL bar, over the Owner tab. `focusWhenLive` says the owner asked for a new Owner tab:
 * the field takes the focus once the tab is shown, and the flag is cleared.
 */
const UrlBar = ({
  pane,
  focusWhenLive,
}: {
  pane: BrowserPaneKey;
  focusWhenLive: RefObject<boolean>;
}) => {
  const page = useAtomValue(ownerTabPageAtom(pane));

  const live = useAtomValue(
    liveViewStateAtom(browserPaneViewAtom(pane)),
    (state) => state.status === "live",
  );

  const actionAtom = ownerTabActionAtom(pane);
  const act = useAtomSet(actionAtom);

  const failure = useAtomValue(actionAtom, (result) =>
    AsyncResult.isFailure(result) ? settledFailureOf(result) : null,
  );

  // What the owner is typing, while the field is being edited; else the field shows the tab's URL.
  const [typed, setTyped] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const noteId = useId();
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!live || !focusWhenLive.current) return;

    focusWhenLive.current = false;
    field.current?.focus();
  }, [live, focusWhenLive]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const address = addressOf(typed ?? page.url ?? "");

    if ("refused" in address) {
      setRefused(address.refused);

      return;
    }

    setRefused(null);
    setTyped(null);
    act({ type: "navigate", url: address.url });

    const field = event.currentTarget.elements.namedItem("address");

    if (field instanceof HTMLInputElement) field.blur();
  };

  const note = refused ?? failure;

  return (
    <header className="flex flex-col gap-1 border-b px-2 py-1.5">
      <form className="flex items-center gap-1" onSubmit={submit}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="Back"
          title="Back"
          disabled={!live || !page.canGoBack}
          {...keepFocus}
          onClick={() => {
            act({ type: "back" });
          }}
        >
          <ArrowLeft aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="Forward"
          title="Forward"
          disabled={!live || !page.canGoForward}
          {...keepFocus}
          onClick={() => {
            act({ type: "forward" });
          }}
        >
          <ArrowRight aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="Reload"
          title="Reload"
          disabled={!live}
          {...keepFocus}
          onClick={() => {
            act({ type: "reload" });
          }}
        >
          <RotateCw aria-hidden />
        </Button>
        <Input
          ref={field}
          name="address"
          type="text"
          inputMode="url"
          enterKeyHint="go"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Address"
          aria-describedby={note === null ? undefined : noteId}
          placeholder="Type a URL"
          disabled={!live}
          // 16 px, so iOS does not zoom on focus.
          className="h-8 flex-1 text-base md:text-sm"
          value={typed ?? page.url ?? ""}
          onFocus={(event) => {
            setTyped(event.currentTarget.value);
            event.currentTarget.select();
          }}
          onBlur={() => {
            setTyped(null);
          }}
          onChange={(event) => {
            setTyped(event.currentTarget.value);
            setRefused(null);
          }}
        />
      </form>
      {note !== null && (
        <p id={noteId} role="status" className="px-1 text-xs break-words text-destructive">
          {note}
        </p>
      )}
    </header>
  );
};

/** Why the Owner tab is gone, as the Pane says it. */
const GONE =
  "No Owner tab is open: the last was closed, or the browser it was in was closed or replaced.";

/** What the Pane shows once the Owner tab is gone: why, and a new Owner tab, unless the Session is archived. */
const Gone = ({ pane }: { pane: BrowserPaneKey }) => {
  // Through the Session, like **+**: every device is told, and each Pane follows to the new Owner tab.
  const open = useAtomSet(ownerTabCommandAtom(pane.sessionId));

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <Globe className="size-5 text-muted-foreground" aria-hidden />
      <p className="text-sm">{pane.archived ? "No Owner tab is open." : GONE}</p>
      {pane.archived ? (
        <p className="max-w-sm text-xs text-muted-foreground">
          Unarchive the session to open an Owner tab in its browser.
        </p>
      ) : (
        <>
          <p className="max-w-sm text-xs text-muted-foreground">
            A browser that was closed takes its pages and sign-ins with it. A new Owner tab opens in
            the Session's browser, starting one if none runs.
          </p>
          <Button
            size="sm"
            onClick={() => {
              open({ type: "open" });
            }}
          >
            Open a new Owner tab
          </Button>
        </>
      )}
    </div>
  );
};

/**
 * The note that the Owner tab shown replaced one that is gone, or that the Owner tabs were reopened in a new browser (and
 * what that cost), until dismissed.
 */
const Replaced = ({ pane }: { pane: BrowserPaneKey }) => {
  const replaced = useAtomValue(ownerTabReplacedAtom(pane));
  const reopened = useAtomValue(ownerTabsReopenedAtom(pane));
  const dismiss = useAtomSet(dismissReplacedAtom(pane));

  if (!replaced && reopened === 0) return null;

  return (
    <div role="status" className="flex items-start gap-2 border-b px-3 py-1.5 text-xs">
      <p className="flex-1">
        {reopened > 0
          ? `The browser was closed or replaced, so ${
              reopened === 1 ? "your Owner tab was" : `your ${reopened} Owner tabs were`
            } reopened at ${reopened === 1 ? "its address" : "their addresses"}. Sign-ins and page state were lost.`
          : "The Owner tab shown before is gone: it was closed, or the browser was closed or replaced. This is another."}
      </p>
      <Button
        variant="ghost"
        size="icon"
        className="size-5 shrink-0"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => {
          dismiss();
        }}
      >
        <X aria-hidden />
      </Button>
    </div>
  );
};

/** Whether the page is visible, as the browser says it. */
const useDocumentVisible = (): boolean =>
  useSyncExternalStore(
    (notify) => {
      document.addEventListener("visibilitychange", notify);

      return () => {
        document.removeEventListener("visibilitychange", notify);
      };
    },
    () => document.visibilityState === "visible",
    () => true,
  );

/**
 * Whether the Browser Pane is in view: its tab shown in the Pane area, the area not hidden, and the page visible (a Pane
 * on a phone that was left in the background is not). The poll of the Owner tabs sends it as its heartbeat.
 */
const useInView = (sessionId: string): boolean => {
  const shown = useAtomValue(
    panesAtom,
    ({ shown: tab, hidden }) => tab === BROWSER_PANE && !hidden,
  );

  const visible = useDocumentVisible();
  const inView = shown && visible;
  const setInView = useAtomSet(browserPaneInViewAtom(sessionId));

  useEffect(() => {
    setInView(inView);
  }, [inView, setInView]);

  // Unmounted, the Pane is not in view: nothing says so, the beats just stop.
  useEffect(
    () => () => {
      setInView(false);
    },
    [setInView],
  );

  return inView;
};

/** The least time between two asks the Pane makes by itself to reopen its Owner tabs. */
const AUTO_REOPEN_MIN_MS = 30_000;

/**
 * When the Owner tab is gone with Owner tabs on record (`lost`: the browser they were in was closed or replaced, not the
 * last one closed by the owner) and the Pane is in view, ask to open at once (`owner_tab_view` with `open`, as the Pane's
 * opening does): the Session's browser starts anew and every Owner tab is reopened at its address. Once per
 * `AUTO_REOPEN_MIN_MS` at most, so a browser that cannot be kept does not make the Pane start one after another; Open a
 * new Owner tab asks again by hand.
 */
const useReopenWhenInView = (pane: BrowserPaneKey, ended: boolean, inView: boolean): void => {
  const reopen = useAtomRefresh(browserPaneViewAtom(pane));

  const onRecord = useAtomValue(
    ownerTabListAtom(pane.sessionId),
    (listing) => (listing?.lost ?? 0) > 0,
  );

  const last = useRef<number | null>(null);

  useEffect(() => {
    if (!ended || !inView || !onRecord || pane.archived) return;

    const now = Date.now();

    if (last.current !== null && now - last.current < AUTO_REOPEN_MIN_MS) return;

    last.current = now;
    reopen();
  }, [ended, inView, onRecord, pane.archived, reopen]);
};

/** Who drives the Owner tab shown, named from the task graph, which is watched only while a run drives it. */
const DrivingNote = ({
  pane,
  drivers,
  ownerTabId,
}: {
  pane: BrowserPaneKey;
  drivers: readonly OwnerTabDriver[];
  ownerTabId: string;
}) => {
  const graph = useAtomValue(taskGraphAtom(pane.sessionId));

  const note = drivingNote(drivers, ownerTabId, (conversationId) =>
    agentLabel(graph, conversationId),
  );

  if (note === null) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b bg-primary/10 px-3 py-1.5 text-xs font-medium"
    >
      <Bot className="size-3.5 shrink-0 animate-pulse" aria-hidden />
      <p className="flex-1">{note}</p>
    </div>
  );
};

/** That the agent is driving the Owner tab shown (`shown`), while a `browser` run works in it. */
const Driving = ({
  pane,
  shown: ownerTabId,
}: {
  pane: BrowserPaneKey;
  shown: string | undefined;
}) => {
  const drivers = useAtomValue(ownerTabDriversAtom(pane.sessionId));

  if (
    ownerTabId === undefined ||
    !Arr.some(drivers, (driver) => driver.ownerTabId === ownerTabId)
  ) {
    return null;
  }

  return <DrivingNote pane={pane} drivers={drivers} ownerTabId={ownerTabId} />;
};

/** The Browser Pane `pane`. */
const BrowserPaneOf = ({ pane }: { pane: BrowserPaneKey }) => {
  const view = browserPaneViewAtom(pane);
  const ended = useAtomValue(liveViewStateAtom(view), (state) => state.status === "ended");
  const focusWhenLive = useRef(false);
  const inView = useInView(pane.sessionId);

  useReopenWhenInView(pane, ended, inView);

  // The Owner tab shown is the Session's, so every device shows the same: this one's connection moves to it.
  const shown = useAtomValue(ownerTabListAtom(pane.sessionId), (listing) => listing?.shown);
  const follow = useAtomSet(followOwnerTabAtom(pane));

  useEffect(() => {
    follow(shown);
  }, [shown, follow]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OwnerTabStrip
        pane={pane}
        onNew={() => {
          focusWhenLive.current = true;
        }}
      />
      <UrlBar pane={pane} focusWhenLive={focusWhenLive} />
      {ended ? (
        <Gone pane={pane} />
      ) : (
        <>
          <Replaced pane={pane} />
          <Driving pane={pane} shown={shown} />
          <LiveScreen view={view} label="Owner tab" />
        </>
      )}
    </div>
  );
};

/**
 * The Browser Pane: one per Session, so it takes no argument. An archived Session's opens nothing (as its tree Pane
 * moves nowhere).
 */
export const BrowserPane = () => {
  const sessionId = useShownSessionId();
  const archived = use(TreeBarScope)?.archived === true;

  return <BrowserPaneOf pane={browserPaneKey(sessionId, archived)} />;
};
