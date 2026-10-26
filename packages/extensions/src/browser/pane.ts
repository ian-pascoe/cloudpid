// @effect-diagnostics missingPipeableSignature:off
// The Session's side of the Browser Pane (`docs/spec.md` → Browser → Browser Pane, ADR-0013): the links to the Owner tab
// the Pane shows, which the browser host mints for the one client that asked (`owner_tab_view`), and the Owner tabs of its
// tab strip (`tabs`, `open`, `show`, `close`). Like a Browser Handoff's Live View links (`./handoff.ts`), no link is kept
// here or sent to another client.
//
// Three rules sit here, between the socket and the host. An archived Session opens nothing: an ask to open is asked
// without, so it shows an Owner tab still there or says there is none and never starts a browser, and a new Owner tab
// (`open`) is refused. The host's "the Owner tab is gone" reaches the client in its own words
// (`withGoneInItsOwnWords`), as `LIVE_VIEW_HANDOFF_OVER` does. An ask that opened an Owner tab (perhaps starting the
// browser for it), a link ask or a new Owner tab alike, is a use of the browser, so the Session's idle close counts from
// it: a browser the Pane started is closed like any other once the Session has left it idle. Listing, showing and closing
// Owner tabs are not uses. A Pane in view keeps the browser by its listing asks (`watchedTabs`): a heartbeat the idle
// close counts from, which lapses with the Pane.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { OWNER_TAB_GONE } from "@cloudpid/protocol/live-view";
import type { OwnerTabLinks, OwnerTabListing } from "./contract.ts";
import { BrowserError, type BrowserHostService } from "./host.ts";
import { BrowserSession, type BrowserSessionService } from "./session.ts";

export type BrowserPaneService = {
  /**
   * Fresh links to the Owner tab the Browser Pane shows and its windows, for the client that asked. With `open` (the
   * Pane opening, or the owner asking for a new Owner tab), the host opens one when the owner has none still there,
   * unless the Session is archived. Fails with `OWNER_TAB_GONE` when the tab or its browser is gone and nothing was
   * opened.
   */
  readonly view: (open: boolean) => Effect.Effect<OwnerTabLinks, BrowserError>;
  /** The Owner tabs by title and the one shown; starts nothing. */
  readonly tabs: Effect.Effect<OwnerTabListing, BrowserError>;
  /**
   * `tabs` as a Browser Pane **in view** asks for it (`owner_tab_list` with `watching`): its heartbeat. The listing is
   * itself a command to the browser, so Browser Run's `keep_alive` counts it; and when the host answers with Owner tabs
   * (a browser runs), the Session notes the beat (`BrowserSession.watch`), so its idle close counts from it. `arm` says
   * the Session must settle to arm the wake for the close time the beat set; a beat never starts a browser or opens an
   * Owner tab. No tabs, no beat noted: a Pane that finds its browser gone holds nothing open.
   */
  readonly watchedTabs: Effect.Effect<
    { readonly tabs: OwnerTabListing; readonly arm: boolean },
    BrowserError
  >;
  /**
   * Open a blank Owner tab and show it (the tab strip's **+**), starting the browser when none runs: a use of the browser,
   * as an ask to `view` that opened one is. Fails for an archived Session, which opens nothing.
   */
  readonly open: Effect.Effect<OwnerTabListing, BrowserError>;
  /** Show Owner tab `id`, for every device. Fails with `OWNER_TAB_GONE` when it is not there. */
  readonly show: (id: string) => Effect.Effect<OwnerTabListing, BrowserError>;
  /** Close Owner tab `id` and the windows it opened. */
  readonly close: (id: string) => Effect.Effect<OwnerTabListing, BrowserError>;
};

/** What `open` fails with in an archived Session. */
export const ARCHIVED_OPENS_NO_OWNER_TAB = "An archived session opens no Owner tab";

/** The host's "the Owner tab is gone" in its own words, without the call it came through. */
const withGoneInItsOwnWords = (error: BrowserError): BrowserError =>
  error.message.includes(OWNER_TAB_GONE) ? BrowserError.make({ message: OWNER_TAB_GONE }) : error;

/** The Session's Browser Pane links. */
export class BrowserPane extends Context.Service<BrowserPane, BrowserPaneService>()(
  "@cloudpid/extensions/browser/pane/BrowserPane",
) {}

export type BrowserPaneOptions = {
  readonly host: BrowserHostService;
  /** Whether the Session is archived now; read only for an ask to open. */
  readonly archived: Effect.Effect<boolean, BrowserError>;
};

export const makeBrowserPane = (
  { host, archived }: BrowserPaneOptions,
  session: Pick<BrowserSessionService, "touch" | "watch">,
): BrowserPaneService => ({
  view: (open) =>
    Effect.gen(function* () {
      const opening = open && !(yield* archived);

      // The host's word for it, as the client reads it, without the call it came through.
      const links = yield* host.ownerTabView(opening).pipe(Effect.mapError(withGoneInItsOwnWords));

      if (links.opened) yield* session.touch;

      return links;
    }),
  tabs: host.ownerTabs,
  watchedTabs: Effect.gen(function* () {
    const tabs = yield* host.ownerTabs;
    const arm = tabs.tabs.length > 0 ? yield* session.watch : false;

    return { tabs, arm };
  }),
  open: Effect.gen(function* () {
    if (yield* archived) return yield* BrowserError.make({ message: ARCHIVED_OPENS_NO_OWNER_TAB });

    const tabs = yield* host.openOwnerTab;

    yield* session.touch;

    return tabs;
  }),
  show: (id) => host.showOwnerTab(id).pipe(Effect.mapError(withGoneInItsOwnWords)),
  close: (id) => host.closeOwnerTab(id),
});

/** The Session's `BrowserPane` over its host; needs the Session's `BrowserSession`. */
export const browserPaneLayer = (options: BrowserPaneOptions) =>
  Layer.effect(
    BrowserPane,
    Effect.map(Effect.service(BrowserSession), (session) => makeBrowserPane(options, session)),
  );
