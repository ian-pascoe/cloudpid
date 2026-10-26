// @effect-diagnostics missingPipeableSignature:off -- a plain constructor of a key, not a combinator.
// The Browser Pane's connection as atoms (ADR-0011): one connection to the Session's shown Owner tab, open while the
// Pane reads it (the Pane stays mounted while another tab is shown), the tab's URL, whether it replaced an Owner tab
// that is gone, and the URL bar's commands. The screen's own atoms (`atoms.ts`) take `browserPaneViewAtom` as the
// connection they follow. Closing the Pane disposes the atom, which closes the scope: the viewport is cleared and the
// sockets close, and the Owner tab stays open in the browser.

import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { appRuntime } from "../runtime.ts";
import { sessionClientAtom } from "../session/atoms.ts";
import { INITIAL_OWNER_TAB_PAGE, openBrowserPaneView, type OwnerTabPage } from "./browser-pane.ts";

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

/**
 * The Browser Pane of Session `sessionId`: it connects when first read, with links its Session mints for this client,
 * the first ask opening an Owner tab when the owner has none, unless the Session is archived. Refreshing it (Open a new
 * Owner tab) builds it again.
 */
export const browserPaneViewAtom = Atom.family(({ sessionId, archived }: BrowserPaneKey) =>
  appRuntime.atom((get) =>
    get
      .result(sessionClientAtom(sessionId))
      .pipe(
        Effect.flatMap((client) =>
          openBrowserPaneView((open) => client.ownerTabView(open), { opens: !archived }),
        ),
      ),
  ),
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

/** Dismiss the note that the Owner tab shown replaced one that is gone. */
export const dismissReplacedAtom = Atom.family((key: BrowserPaneKey) =>
  appRuntime.fn((_: void, get) =>
    get.result(browserPaneViewAtom(key)).pipe(Effect.flatMap((view) => view.dismiss)),
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
