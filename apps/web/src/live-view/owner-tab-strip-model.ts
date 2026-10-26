// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- a plain view of a few tabs.
// What the Browser Pane's tab strip shows of the Session's Owner tabs (`owner-tab-strip.tsx`), apart from React: each
// tab by its title with the one shown marked, and whether **+** is offered. The strip is the same whether or not the
// Pane has a tab to show: with none (the last was closed, or its browser was) it is **+** alone, and the URL bar stays.

import type { OwnerTabListing } from "@cloudpid/protocol";

/** What a tab with no title is called: a blank page, or one still loading. */
const BLANK_TAB_TITLE = "New tab";

export interface StripTab {
  readonly id: string;
  readonly title: string;
  readonly shown: boolean;
}

export interface Strip {
  readonly tabs: readonly StripTab[];
  /** Whether **+** is offered: an archived Session opens no Owner tab. */
  readonly canOpen: boolean;
}

/** The strip for `listing` (null: not heard yet); the titles are the pages' own, page content shown as text. */
export const stripOf = (listing: OwnerTabListing | null, archived: boolean): Strip => ({
  tabs: (listing?.tabs ?? []).map((tab) => ({
    id: tab.id,
    title: tab.title.trim() === "" ? BLANK_TAB_TITLE : tab.title,
    shown: tab.id === listing?.shown,
  })),
  canOpen: !archived,
});
