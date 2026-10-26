// @effect-diagnostics missingPipeableSignature:off -- a plain constructor of a Live View.

// What the Browser Pane adds to a Live View's connection (#238, ADR-0013), on the Owner tab it shows: the tab's URL as
// it navigates and whether it can go back or forward, read on the tab's own connection (`AttachTab`), and the URL bar's
// navigate, back, forward and reload sent there. The links come from the Session's `owner_tab_view`: the first ask opens
// (the browser is started when none runs, an Owner tab opened when the owner has none), later ones (a reconnect, a
// window opening or closing) only read, and one that finds the Owner tab gone ends the Live View, for the Pane to offer
// a new one. The connection (`connection.ts`) knows none of this, nor do the handoff's files.

import { OWNER_TAB_GONE, type OwnerTabLinks } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { LiveViewError } from "./cdp-socket.ts";
import {
  LiveViewOver,
  make,
  type AttachTab,
  type LinkSource,
  type LiveView,
  type TabHandle,
} from "./connection.ts";

/** What the Browser Pane shows of the Owner tab: its URL (null until read), and whether it can go back or forward. */
export interface OwnerTabPage {
  readonly url: string | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export const INITIAL_OWNER_TAB_PAGE: OwnerTabPage = {
  url: null,
  canGoBack: false,
  canGoForward: false,
};

/** `Page.getNavigationHistory`'s answer: the tab's history and where it is in it. */
const NavigationHistory = Schema.Struct({
  currentIndex: Schema.Finite,
  entries: Schema.Array(Schema.Struct({ id: Schema.Finite, url: Schema.String })),
});

type NavigationHistory = typeof NavigationHistory.Type;

/** `Page.frameNavigated`: a frame of the page navigated; the tab's own has no parent. */
const FrameNavigated = Schema.Struct({
  frame: Schema.Struct({ parentId: Schema.optional(Schema.String) }),
});

/** `Page.navigate`'s answer: `errorText` when the page could not be opened. */
const Navigated = Schema.Struct({ errorText: Schema.optional(Schema.String) });

const Ignored = Schema.Unknown;

/** A Live View of the Owner tab, with its URL and the URL bar's commands. */
export interface BrowserPaneView extends LiveView {
  /** The tab's URL and history: the same object until one changes. */
  readonly page: SubscriptionRef.SubscriptionRef<OwnerTabPage>;
  /** Open `url` in the tab (an address the URL bar took: `address.ts`); fails with why the page could not be opened. */
  readonly navigate: (url: string) => Effect.Effect<void, LiveViewError>;
  /** Back and forward in the tab's history; nothing when there is nowhere to go. */
  readonly back: Effect.Effect<void, LiveViewError>;
  readonly forward: Effect.Effect<void, LiveViewError>;
  readonly reload: Effect.Effect<void, LiveViewError>;
}

const pageOf = (history: NavigationHistory): OwnerTabPage => ({
  url: history.entries[history.currentIndex]?.url ?? null,
  canGoBack: history.currentIndex > 0,
  canGoForward: history.currentIndex < history.entries.length - 1,
});

/**
 * The Browser Pane's Live View of the Owner tab, for as long as the scope is open, with `mint` asking the Session for
 * fresh links (`SessionClient.ownerTabView`): opening on the first ask that succeeds, reading after it. It connects at
 * once. Closing the scope closes its connections; the Owner tab stays open in the browser.
 */
export const openBrowserPaneView = Effect.fnUntraced(function* (
  mint: (open: boolean) => Effect.Effect<OwnerTabLinks, { readonly message: string }>,
) {
  const page = yield* SubscriptionRef.make(INITIAL_OWNER_TAB_PAGE);
  let opened = false;

  const links: LinkSource = Effect.suspend(() => mint(!opened)).pipe(
    Effect.map(({ tab, windows }) => {
      opened = true;

      return { tab, windows };
    }),
    Effect.mapError((error) =>
      error.message === OWNER_TAB_GONE
        ? LiveViewOver.make({ message: error.message })
        : LiveViewError.make({ message: error.message }),
    ),
  );

  const historyOf = (tab: TabHandle) =>
    tab.call("Page.getNavigationHistory", {}, NavigationHistory);

  /** Read the tab's history again and show where it is. */
  const refresh = (tab: TabHandle) =>
    historyOf(tab).pipe(
      Effect.flatMap((history) => SubscriptionRef.set(page, pageOf(history))),
      Effect.ignore,
    );

  const attach: AttachTab = (tab) =>
    Effect.gen(function* () {
      tab.on("Page.frameNavigated", FrameNavigated, ({ frame }) =>
        frame.parentId === undefined ? refresh(tab) : Effect.void,
      );
      tab.on("Page.navigatedWithinDocument", Ignored, () => refresh(tab));

      yield* refresh(tab);
    });

  const view = yield* make(links, attach);

  /** Go `step` entries through the tab's history, when there is an entry there. */
  const go = (step: -1 | 1) =>
    view.withTab((tab) =>
      Effect.gen(function* () {
        const history = yield* historyOf(tab);
        const entry = history.entries[history.currentIndex + step];

        if (entry === undefined) return;

        yield* tab.call("Page.navigateToHistoryEntry", { entryId: entry.id }, Ignored);
      }),
    );

  const pane: BrowserPaneView = {
    ...view,
    page,
    navigate: (url) =>
      view.withTab((tab) =>
        tab.call("Page.navigate", { url }, Navigated).pipe(
          Effect.flatMap(({ errorText }) =>
            errorText === undefined || errorText === ""
              ? Effect.void
              : Effect.fail(LiveViewError.make({ message: `The page did not open: ${errorText}` })),
          ),
        ),
      ),
    back: go(-1),
    forward: go(1),
    reload: view.withTab((tab) => tab.call("Page.reload", {}, Ignored)).pipe(Effect.asVoid),
  };

  return pane;
});
