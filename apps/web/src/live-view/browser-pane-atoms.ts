// @effect-diagnostics missingPipeableSignature:off -- a plain constructor of a key, not a combinator.
// The Browser Pane's connection as atoms (ADR-0011): one connection to the Session's shown Owner tab, open while the
// Pane reads it (the Pane stays mounted while another tab is shown), the tab's URL, whether it replaced an Owner tab
// that is gone, and the URL bar's commands. The screen's own atoms (`atoms.ts`) take `browserPaneViewAtom` as the
// connection they follow. Closing the Pane disposes the atom, which closes the scope: the viewport is cleared and the
// sockets close, and the Owner tab stays open in the browser.

import type { OwnerTabListing } from "@cloudpid/protocol";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { appRuntime } from "../runtime.ts";
import { ownerTabsAtom, sessionClientAtom } from "../session/atoms.ts";
import type { SessionClient } from "../session/client.ts";
import { liveViewStateAtom } from "./atoms.ts";
import { INITIAL_OWNER_TAB_PAGE, openBrowserPaneView, type OwnerTabPage } from "./browser-pane.ts";
import { type LiveView, whenEnded } from "./connection.ts";
import { keepScreen, latestScreenAtom } from "./owner-tab-screen.ts";

/** Which Browser Pane: its Session's, and whether that Session is archived (its Pane opens nothing). */
export interface BrowserPaneKey {
  readonly sessionId: string;
  readonly archived: boolean;
}

/** The key of a Browser Pane, with both fields set, so equal keys are equal values. */
export const browserPaneKey = (sessionId: string, archived: boolean): BrowserPaneKey => ({
  sessionId,
  archived,
});

/** How often the Pane asks the Session for its Owner tabs while it is open and the page is visible, for the tabs a page
 * opened and the titles that changed. What a device changes is sent to the others at once. */
const OWNER_TABS_POLL = Duration.seconds(5);

/** How long after a window opened the Owner tabs are asked again: the browser may not list a new page at once. */
const WINDOW_OPENED_RECHECK = Duration.seconds(1);

/** Whether the page is shown: a hidden page does not poll. */
const pageVisible = (): boolean =>
  typeof document === "undefined" || document.visibilityState === "visible";

/** A page of the Owner tab opened a window: ask for the Owner tabs now, and once more in a moment. */
const windowOpenedIn = (client: SessionClient) =>
  Effect.ignore(client.ownerTabs(false)).pipe(
    Effect.andThen(Effect.sleep(WINDOW_OPENED_RECHECK)),
    Effect.andThen(Effect.ignore(client.ownerTabs(false))),
  );

/**
 * The Browser Pane of Session `sessionId`: it connects when first read, with links its Session mints for this client,
 * the first ask opening an Owner tab when the owner has none, unless the Session is archived. Refreshing it (Open a new
 * Owner tab) builds it again.
 */
export const browserPaneViewAtom = Atom.family((key: BrowserPaneKey) =>
  appRuntime.atom((get) => {
    const { sessionId, archived } = key;

    // Annotate mode was turned on in `view`: it is off, and holds nothing of it.
    const leaveAnnotateMode = (view: LiveView) =>
      Effect.sync(() => {
        if (get.once(annotateOnAtom(key)) === view) get.set(annotateOnAtom(key), null);
      });

    return get.result(sessionClientAtom(sessionId)).pipe(
      Effect.flatMap((client) =>
        openBrowserPaneView((open) => client.ownerTabView(open), {
          opens: !archived,
          windowOpened: windowOpenedIn(client),
        }),
      ),
      // The composer attaches the Pane's latest screen with the shown Owner tab, for as long as the Pane is open.
      Effect.tap((view) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            keepScreen(view.frames, (frame) => {
              get.set(latestScreenAtom(sessionId), frame);
            }),
          ),
          (stop) => Effect.sync(stop),
        ),
      ),
      // Annotate mode ends with the Live View it was turned on in, which ends before the Pane is built again.
      Effect.tap((view) =>
        whenEnded(view).pipe(Effect.andThen(leaveAnnotateMode(view)), Effect.forkScoped),
      ),
    );
  }),
);

const pageRefAtom = Atom.family((key: BrowserPaneKey) =>
  appRuntime.subscriptionRef((get) =>
    get.result(browserPaneViewAtom(key)).pipe(Effect.map((view) => view.page)),
  ),
);

/** The Owner tab's URL and history, empty until the Pane is connected. */
export const ownerTabPageAtom = Atom.family((key: BrowserPaneKey) =>
  Atom.make((get): OwnerTabPage =>
    AsyncResult.getOrElse(get(pageRefAtom(key)), () => INITIAL_OWNER_TAB_PAGE),
  ),
);

const replacedRefAtom = Atom.family((key: BrowserPaneKey) =>
  appRuntime.subscriptionRef((get) =>
    get.result(browserPaneViewAtom(key)).pipe(Effect.map((view) => view.replaced)),
  ),
);

/** Whether the Owner tab shown replaced one that is gone, until the owner dismisses the note. */
export const ownerTabReplacedAtom = Atom.family((key: BrowserPaneKey) =>
  Atom.make((get): boolean => AsyncResult.getOrElse(get(replacedRefAtom(key)), () => false)),
);

const reopenedRefAtom = Atom.family((key: BrowserPaneKey) =>
  appRuntime.subscriptionRef((get) =>
    get.result(browserPaneViewAtom(key)).pipe(Effect.map((view) => view.reopened)),
  ),
);

/**
 * How many Owner tabs the Pane's opening reopened at their addresses in a new browser (none: 0), until the owner
 * dismisses the note.
 */
export const ownerTabsReopenedAtom = Atom.family((key: BrowserPaneKey) =>
  Atom.make((get): number => AsyncResult.getOrElse(get(reopenedRefAtom(key)), () => 0)),
);

/** Dismiss the notes that the Owner tab shown replaced one that is gone, and that Owner tabs were reopened. */
export const dismissReplacedAtom = Atom.family((key: BrowserPaneKey) =>
  appRuntime.fn((_: void, get) =>
    get.result(browserPaneViewAtom(key)).pipe(Effect.flatMap((view) => view.dismiss)),
  ),
);

/** Whether a window of the Owner tab (a pop-up) is shown in the Pane instead of its page. */
export const ownerTabWindowShownAtom = Atom.family((key: BrowserPaneKey) =>
  Atom.make((get): boolean => {
    const { strip } = get(liveViewStateAtom(browserPaneViewAtom(key)));

    return strip !== null && strip.shown !== strip.tab;
  }),
);

/** The Live View Annotate mode was turned on in, by Pane; null while it is off. */
const annotateOnAtom = Atom.family((_key: BrowserPaneKey) =>
  Atom.make<LiveView | null>(null).pipe(Atom.keepAlive),
);

/**
 * Whether the Browser Pane is in Annotate mode (`page-annotations-layer.tsx`): turned on by its toggle, for the Live View
 * it was turned on in while it lasts (a new one, after the Owner tab was gone, starts with the page's input), and not
 * while a window of the tab is shown. Write it to turn the mode on or off.
 */
export const annotateModeAtom = Atom.family((key: BrowserPaneKey) =>
  Atom.writable(
    (get): boolean => {
      const view = browserPaneViewAtom(key);
      const live = AsyncResult.getOrElse(get(view), () => null);
      const on = get(annotateOnAtom(key));

      return (
        on !== null &&
        on === live &&
        get(liveViewStateAtom(view)).status !== "ended" &&
        !get(ownerTabWindowShownAtom(key))
      );
    },
    (ctx, on: boolean) => {
      ctx.set(
        annotateOnAtom(key),
        on ? AsyncResult.getOrElse(ctx.get(browserPaneViewAtom(key)), () => null) : null,
      );
    },
  ),
);

/** What the URL bar does to the Owner tab. */
export type OwnerTabAction =
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "back" }
  | { readonly type: "forward" }
  | { readonly type: "reload" };

/** Navigate, back, forward or reload, on the tab's connection: its failure (a page that did not open) is the result. */
export const ownerTabActionAtom = Atom.family((key: BrowserPaneKey) =>
  appRuntime.fn((action: OwnerTabAction, get) =>
    get.result(browserPaneViewAtom(key)).pipe(
      Effect.flatMap((view) => {
        switch (action.type) {
          case "navigate":
            return view.navigate(action.url);
          case "back":
            return view.back;
          case "forward":
            return view.forward;
          case "reload":
            return view.reload;
        }
      }),
    ),
  ),
);

/**
 * Whether Session `sessionId`'s Browser Pane is in view on this device: its tab shown in the Pane area, the area not
 * hidden, the page visible. The Pane sets it (`browser-pane.tsx`) and the poll of the Owner tabs reads it: a Pane in view
 * asks as the heartbeat that keeps the Session's browser (#240), one that is not asks as it always did and keeps nothing.
 */
export const browserPaneInViewAtom = Atom.family((_sessionId: string) =>
  Atom.make(false).pipe(Atom.keepAlive),
);

/**
 * Asks the Session for its Owner tabs now and every `OWNER_TABS_POLL` while the page is visible, for as long as mounted,
 * as the heartbeat (`watching`) while the Pane is in view. The one poll is the only heartbeat: it lapses with the Pane
 * going out of view or the page being hidden, never an open/closed flag.
 */
const pollOwnerTabsAtom = Atom.family((sessionId: string) =>
  appRuntime.atom((get) => {
    const inView = get(browserPaneInViewAtom(sessionId));

    return get
      .result(sessionClientAtom(sessionId))
      .pipe(
        Effect.flatMap((client) =>
          Effect.suspend(() =>
            pageVisible() ? Effect.ignore(client.ownerTabs(inView)) : Effect.void,
          ).pipe(Effect.andThen(Effect.sleep(OWNER_TABS_POLL)), Effect.forever),
        ),
      );
  }),
);

/**
 * The Owner tabs of Session `sessionId`'s Browser Pane and the one shown, as the Session last said (to this client, or to
 * all of them when a device changed them); null until it has. Reading it keeps them asked for.
 */
export const ownerTabListAtom = Atom.family((sessionId: string) =>
  Atom.make((get): OwnerTabListing | null => {
    get.mount(pollOwnerTabsAtom(sessionId));

    return get(ownerTabsAtom(sessionId));
  }),
);

/** What the tab strip does to the Session's Owner tabs. */
export type OwnerTabCommand =
  | { readonly type: "open" }
  | { readonly type: "show"; readonly id: string }
  | { readonly type: "close"; readonly id: string };

/**
 * Open, show or close an Owner tab, for every device: the Session sends the Owner tabs back to all of them, and each
 * Pane follows (`followOwnerTabAtom`). Its failure (an archived Session opens none; the tab is gone) is the result.
 */
export const ownerTabCommandAtom = Atom.family((sessionId: string) =>
  appRuntime.fn((command: OwnerTabCommand, get) =>
    get.result(sessionClientAtom(sessionId)).pipe(
      Effect.flatMap((client) => {
        switch (command.type) {
          case "open":
            return client.openOwnerTab;
          case "show":
            return client.showOwnerTab(command.id);
          case "close":
            return client.closeOwnerTab(command.id);
        }
      }),
      Effect.asVoid,
    ),
  ),
);

/** Show the Owner tab the Session says is shown: the Pane's connection moves to it when it shows another. */
export const followOwnerTabAtom = Atom.family((key: BrowserPaneKey) =>
  appRuntime.fn(
    (shown: string | undefined, get) =>
      get.result(browserPaneViewAtom(key)).pipe(Effect.flatMap((view) => view.follow(shown))),
    { concurrent: true },
  ),
);
