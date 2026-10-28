// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain helpers and an atom family.

// What the composer offers to attach (`docs/architecture/client-and-protocol.md` → Attached pages): the Owner tabs the Browser Pane's tab strip lists
// (`ownerTabsAtom`: their IDs and titles, and the one shown), asked of the Session while a composer of it is open and
// again when its page menu opens, and what attaching one takes: the Browser Pane's latest screen if it is the Owner tab
// shown.

import type { OwnerTabListing } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import type { Frame } from "../live-view/connection.ts";
import { screenFile } from "../live-view/owner-tab-screen.ts";
import { appRuntime } from "../runtime.ts";
import { sessionClientAtom, sessionStatusAtom } from "../session/atoms.ts";
import type { PageToAttach } from "./attachments-state.ts";

/** An Owner tab the composer offers to attach: the tab strip's entry, and whether the Browser Pane shows it. */
export interface OfferedPage {
  readonly ownerTabId: string;
  readonly title: string;
  readonly shown: boolean;
}

/**
 * Asks Session `sessionId` for its Owner tabs once its socket is live (and again on each reconnect and on refresh), for
 * as long as it is mounted; the answer lands in `ownerTabsAtom`, where the strip's own asking lands too. A Session that
 * cannot say has none to offer.
 */
export const askOwnerTabsAtom = Atom.family((sessionId: string) =>
  appRuntime.atom((get) => {
    const live = get(sessionStatusAtom(sessionId)) === "live";

    return Effect.gen(function* () {
      if (!live) return;

      const client = yield* get.result(sessionClientAtom(sessionId));

      yield* Effect.ignore(client.ownerTabs(false));
    }).pipe(Effect.orElseSucceed(() => undefined));
  }),
);

/** The Owner tabs the composer can offer, the one shown first and the others in the order they were opened. */
export const offeredPages = (listing: OwnerTabListing | null): readonly OfferedPage[] => {
  if (listing === null) return [];

  const pages = listing.tabs.map((tab) => ({
    ownerTabId: tab.id,
    title: tab.title,
    shown: tab.id === listing.shown,
  }));

  return [...pages.filter((page) => page.shown), ...pages.filter((page) => !page.shown)];
};

/** What to call a page: its title, else that it has none. */
export const pageLabel = (page: { readonly title: string }): string =>
  page.title.trim() === "" ? "Untitled page" : page.title;

/** The host of a page's URL, for the line under its title; the URL as it is when it has none. */
export const pageHost = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/**
 * `page` as the composer attaches it. The Owner tab the Pane shows takes the Pane's `latest` screen with it (as a picture
 * for the message's image budget), when a Pane of its Session is open and has had a frame; one that is not shown
 * carries no picture.
 */
export const toAttach = (page: OfferedPage, latest: Frame | undefined): PageToAttach => {
  const frame = page.shown ? latest : undefined;

  return {
    ownerTabId: page.ownerTabId,
    title: page.title,
    shown: page.shown,
    screen: frame === undefined ? undefined : screenFile(frame),
  };
};
