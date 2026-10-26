// The Browser Pane's Live View as atoms (ADR-0011): one connection to the Session's shown Owner tab, open while the Pane
// reads it (the Pane stays mounted while another tab is shown), the tab's URL, and the URL bar's commands. The screen's
// own atoms (`atoms.ts`) take `browserPaneViewAtom` as the Live View they follow. Closing the Pane disposes the atom,
// which closes the scope: the viewport is cleared and the sockets close, and the Owner tab stays open in the browser.

import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { appRuntime } from "../runtime.ts";
import { sessionClientAtom } from "../session/atoms.ts";
import { INITIAL_OWNER_TAB_PAGE, openBrowserPaneView, type OwnerTabPage } from "./browser-pane.ts";

/**
 * The Browser Pane of Session `sessionId`: it connects when first read, with links its Session mints for this client,
 * the first ask opening an Owner tab when the owner has none. Refreshing it (Open a new Owner tab) builds it again.
 */
export const browserPaneViewAtom = Atom.family((sessionId: string) =>
  appRuntime.atom((get) =>
    get
      .result(sessionClientAtom(sessionId))
      .pipe(
        Effect.flatMap((client) => openBrowserPaneView((open) => client.ownerTabView(open))),
      ),
  ),
);

const pageRefAtom = Atom.family((sessionId: string) =>
  appRuntime.subscriptionRef((get) =>
    get.result(browserPaneViewAtom(sessionId)).pipe(Effect.map((view) => view.page)),
  ),
);

/** The Owner tab's URL and history, empty until the Pane is connected. */
export const ownerTabPageAtom = Atom.family((sessionId: string) =>
  Atom.make((get): OwnerTabPage =>
    AsyncResult.getOrElse(get(pageRefAtom(sessionId)), () => INITIAL_OWNER_TAB_PAGE),
  ),
);

/** What the URL bar does to the Owner tab. */
export type OwnerTabAction =
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "back" }
  | { readonly type: "forward" }
  | { readonly type: "reload" };

/** Navigate, back, forward or reload, on the tab's connection: its failure (a page that did not open) is the result. */
export const ownerTabActionAtom = Atom.family((sessionId: string) =>
  appRuntime.fn((action: OwnerTabAction, get) =>
    get.result(browserPaneViewAtom(sessionId)).pipe(
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
