// @effect-diagnostics missingPipeableSignature:off -- plain helpers over text.
// The names a Browser Handoff's Live View is known by on both sides of the Session socket (`docs/spec.md` → Browser):
// its Pane's key and the query that opens it, and the words `live_view` fails with once the handoff is over; and the
// words `owner_tab_view` fails with when the Browser Pane's Owner tab is gone. No imports, so the browser host's Worker
// can take this module alone (`@cloudpid/protocol/live-view`).

/** What `live_view` fails with once its handoff has ended (or for a handoff the Session does not have), exactly. */
export const LIVE_VIEW_HANDOFF_OVER = "the handoff is over";

/**
 * What `owner_tab_view` fails with when the Owner tab the Browser Pane shows is gone, exactly: its browser was closed or
 * replaced, or the tab was closed, and the request did not ask to open one.
 */
export const OWNER_TAB_GONE = "the Owner tab is gone";

/**
 * The longest URL, title and selected text of a page the owner attaches to a message, in code points (`attached-pages.ts`).
 * Here, import-free, because the browser host's Worker may import only this module.
 */
export const MAX_PAGE_URL = 2048;

export const MAX_PAGE_TITLE = 300;

export const MAX_PAGE_SELECTION = 4000;

/**
 * The most of a page's selected text the host reads, in UTF-16 units: a guard on what crosses from the page, larger than
 * `MAX_PAGE_SELECTION` so that the Session redacts Secrets from the text before `clampPage` (the one place it is cut)
 * keeps the first `MAX_PAGE_SELECTION` code points of it.
 */
export const MAX_PAGE_SELECTION_READ = 16_000;

/** The key of the Live View Pane of the Browser Handoff `requestId` names: `live-view:<requestId>`, as it is. */
export const liveViewPaneKey = (requestId: string): string => `live-view:${requestId}`;

/**
 * The query of the Session's page that opens that Pane (`?pane=live-view:12`), as the web app writes a Pane key: encoded
 * but for the `:` after the type, so `URLSearchParams` reads back the key `liveViewPaneKey` gives.
 */
export const liveViewPaneQuery = (requestId: string): string =>
  `?pane=${encodeURIComponent(liveViewPaneKey(requestId)).replaceAll("%3A", ":")}`;
