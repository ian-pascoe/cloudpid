// The Browser Pane (#238, ADR-0013): the Session's browser for the owner, in Owner tabs, at any time. It is a tab strip
// (`owner-tab-strip.tsx`: each Owner tab by title, close, and **+**), a URL bar (back, forward, reload, and the tab's
// URL, which Enter navigates) and the screen it shares with the Live View
// (`live-screen.tsx`), over links the Session's `owner_tab_view` mints. Opening it opens an Owner tab when the owner has
// none; closing it leaves the tab open in the browser, so opening it again shows the same page. When the Owner tab is
// gone (closed, or its browser closed or replaced), it says so and offers to open a new Owner tab, and a new one says it
// replaced the one that is gone. An archived Session's Pane opens nothing: it shows an Owner tab still there, if any. It
// opens only from the New pane (or the URL or the Session's layout); it never opens on its own.

import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { ArrowLeft, ArrowRight, Globe, RotateCw, X } from "lucide-react";
import { use, useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { useShownSessionId } from "../chat/conversation.ts";
import { TreeBarScope } from "../chat/tree-actions.ts";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { settledFailureOf } from "../registry.ts";
import { addressOf } from "./address.ts";
import { liveViewStateAtom } from "./atoms.ts";
import {
  browserPaneKey,
  type BrowserPaneKey,
  browserPaneViewAtom,
  dismissReplacedAtom,
  followOwnerTabAtom,
  ownerTabActionAtom,
  ownerTabListAtom,
  ownerTabPageAtom,
  ownerTabReplacedAtom,
} from "./browser-pane-atoms.ts";
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
  const reopen = useAtomRefresh(browserPaneViewAtom(pane));

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
          <Button size="sm" onClick={reopen}>
            Open a new Owner tab
          </Button>
        </>
      )}
    </div>
  );
};

/** The note that the Owner tab shown replaced one that is gone, until dismissed. */
const Replaced = ({ pane }: { pane: BrowserPaneKey }) => {
  const replaced = useAtomValue(ownerTabReplacedAtom(pane));
  const dismiss = useAtomSet(dismissReplacedAtom(pane));

  if (!replaced) return null;

  return (
    <div role="status" className="flex items-start gap-2 border-b px-3 py-1.5 text-xs">
      <p className="flex-1">
        The Owner tab shown before is gone: it was closed, or the browser was closed or replaced.
        This is another.
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

/** The Browser Pane `pane`. */
const BrowserPaneOf = ({ pane }: { pane: BrowserPaneKey }) => {
  const view = browserPaneViewAtom(pane);
  const ended = useAtomValue(liveViewStateAtom(view), (state) => state.status === "ended");
  const reopen = useAtomRefresh(view);
  const focusWhenLive = useRef(false);

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
        ended={ended}
        onNew={() => {
          focusWhenLive.current = true;
        }}
        reopen={reopen}
      />
      <UrlBar pane={pane} focusWhenLive={focusWhenLive} />
      {ended ? (
        <Gone pane={pane} />
      ) : (
        <>
          <Replaced pane={pane} />
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
