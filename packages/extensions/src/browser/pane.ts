// @effect-diagnostics missingPipeableSignature:off
// The Session's side of the Browser Pane (`docs/spec.md` → Browser → Browser Pane, ADR-0013): the links to the Owner tab
// the Pane shows, which the browser host mints for the one client that asked (`owner_tab_view`). Like a Browser
// Handoff's Live View links (`./handoff.ts`), none is kept here or sent to another client.
//
// Three rules sit here, between the socket and the host. An archived Session opens nothing: an ask to open is asked
// without, so it shows an Owner tab still there or says there is none, and never starts a browser. The host's "the Owner
// tab is gone" reaches the client in its own words, as `LIVE_VIEW_HANDOFF_OVER` does. And an ask that opened an Owner
// tab (perhaps starting the browser for it) is a use of the browser, so the Session's idle close counts from it: a
// browser the Pane started is closed like any other once the Session has left it idle.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { OWNER_TAB_GONE } from "@cloudpid/protocol/live-view";
import type { OwnerTabLinks } from "./contract.ts";
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
};

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
  session: Pick<BrowserSessionService, "touch">,
): BrowserPaneService => ({
  view: (open) =>
    Effect.gen(function* () {
      const opening = open && !(yield* archived);

      const links = yield* host.ownerTabView(opening).pipe(
        // The host's word for it, as the client reads it, without the call it came through.
        Effect.mapError((error) =>
          error.message.includes(OWNER_TAB_GONE)
            ? BrowserError.make({ message: OWNER_TAB_GONE })
            : error,
        ),
      );

      if (links.opened) yield* session.touch;

      return links;
    }),
});

/** The Session's `BrowserPane` over its host; needs the Session's `BrowserSession`. */
export const browserPaneLayer = (options: BrowserPaneOptions) =>
  Layer.effect(
    BrowserPane,
    Effect.map(Effect.service(BrowserSession), (session) => makeBrowserPane(options, session)),
  );
