// The Browser Pane (#238, ADR-0013): the Session's browser for the owner, in an Owner tab, at any time. It is a URL bar
// (back, forward, reload, and the tab's URL, which Enter navigates) around the Live View's screen (`live-screen.tsx`),
// over links the Session's `owner_tab_view` mints. Opening it opens an Owner tab when the owner has none; closing it
// leaves the tab open in the browser, so opening it again shows the same page. When the Owner tab's browser was closed
// or replaced, it says so and offers to open a new Owner tab. It opens only from the New pane (or the URL or the
// Session's layout); it never opens on its own.

import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { ArrowLeft, ArrowRight, Globe, RotateCw } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { useShownSessionId } from "../chat/conversation.ts";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { settledFailureOf } from "../registry.ts";
import { addressOf } from "./address.ts";
import { liveViewStateAtom } from "./atoms.ts";
import { browserPaneViewAtom, ownerTabActionAtom, ownerTabPageAtom } from "./browser-pane-atoms.ts";
import { keepFocus, LiveScreen } from "./live-screen.tsx";

/** Back, forward, reload and the URL bar, over the Owner tab. */
const UrlBar = ({ sessionId }: { sessionId: string }) => {
  const page = useAtomValue(ownerTabPageAtom(sessionId));

  const live = useAtomValue(
    liveViewStateAtom(browserPaneViewAtom(sessionId)),
    (state) => state.status === "live",
  );

  const actionAtom = ownerTabActionAtom(sessionId);
  const act = useAtomSet(actionAtom);

  const failure = useAtomValue(actionAtom, (result) =>
    AsyncResult.isFailure(result) ? settledFailureOf(result) : null,
  );

  // What the owner is typing, while the field is being edited; else the field shows the tab's URL.
  const [typed, setTyped] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const noteId = useId();

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

/** What the Pane shows once the Owner tab is gone: why, and a new Owner tab. */
const Gone = ({ sessionId }: { sessionId: string }) => {
  const reopen = useAtomRefresh(browserPaneViewAtom(sessionId));

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <Globe className="size-5 text-muted-foreground" aria-hidden />
      <p className="text-sm">The browser was closed or replaced, and this tab with it.</p>
      <p className="max-w-sm text-xs text-muted-foreground">
        Pages and sign-ins of the old browser are gone. A new Owner tab opens in the Session's browser, starting one
        if none runs.
      </p>
      <Button size="sm" onClick={reopen}>
        Open a new Owner tab
      </Button>
    </div>
  );
};

/** The Browser Pane of Session `sessionId`. */
const BrowserPaneOf = ({ sessionId }: { sessionId: string }) => {
  const view = browserPaneViewAtom(sessionId);
  const ended = useAtomValue(liveViewStateAtom(view), (state) => state.status === "ended");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <UrlBar sessionId={sessionId} />
      {ended ? <Gone sessionId={sessionId} /> : <LiveScreen view={view} label="The browser" />}
    </div>
  );
};

/** The Browser Pane: one per Session, so it takes no argument. */
export const BrowserPane = () => <BrowserPaneOf sessionId={useShownSessionId()} />;
