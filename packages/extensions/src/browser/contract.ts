// What the Session and its browser host (`apps/browser`) agree on, in plain data a Durable Object RPC carries and
// without imports a Worker would have to bundle: the host's Worker takes this file alone, not the extension, and of
// `@cloudpid/protocol` only types and its import-free `live-view` module.
import type { LiveViewLinks, OwnerTabLinks, OwnerTabListing } from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";

/**
 * How long Browser Run keeps an idle browser (`keep_alive`): it closes the browser itself once no CDP command has come
 * for this long. Browser Run's default for `agents/browser`, and half its 20-minute maximum.
 */
export const BROWSER_KEEP_ALIVE_MS = 10 * 60_000;

/**
 * How long the Session lets its browser sit unused before it closes it. Shorter than `keep_alive`, which also covers a
 * long gap in the middle of a turn: a Session that has settled idle does not pay for the rest of it.
 */
export const BROWSER_IDLE_MS = 5 * 60_000;

/** How long a Browser Handoff waits for the owner before the tool gives up: Browser Run's own maximum. */
export const HANDOFF_TIMEOUT_MS = 30 * 60_000;

/** The longest instructions Browser Run takes. */
export const MAX_HANDOFF_INSTRUCTIONS = 4096;

/** How a host call asks to start a Browser Handoff in a conversation's tab. */
export type HandoffStartInput = {
  /** Names the handoff, so starting it again (a rerun after an eviction) finds the same one. */
  readonly requestId: string;
  readonly conversationId: number;
  readonly instructions: string;
  readonly timeoutMs: number;
};

/**
 * A started Browser Handoff. It carries no Live View link: the owner's client mints one with `liveView` when the owner
 * takes over.
 */
export type HandoffStarted = {
  /** When the handoff began, epoch milliseconds. */
  readonly startedAt: number;
  /** The handoff is over already: a start that came again after the owner finished. Nothing is left to show. */
  readonly over?: boolean;
};

/**
 * `live_view`'s answer (`@cloudpid/protocol`'s `LiveViewLinks`): fresh Live View links to the handed-over tab and to each
 * window it opened that is still open. Each `link` is the `webSocketDebuggerUrl` of a `Cloudflare.getLiveView`, a Browser
 * Run `wss` URL that speaks CDP: a bearer credential for the owner alone, which opens every page of the browser session
 * and connects any number of times until it expires, 60 s after it was minted (an open connection outlives that). It
 * goes to the client that asked and nowhere else.
 */
export type { LiveViewLinks, LiveViewTarget, LiveViewWindow } from "@cloudpid/protocol";

/** What `liveView` fails with once the handoff has ended (or was never started), exactly. */
export { LIVE_VIEW_HANDOFF_OVER } from "@cloudpid/protocol/live-view";

/**
 * `owner_tab_view`'s answer (`@cloudpid/protocol`'s `OwnerTabLinks`): the Owner tab the Browser Pane shows, with fresh
 * Live View links to it and its windows, minted as `liveView`'s are and for the asking client alone.
 */
export type { OwnerTabEntry, OwnerTabLinks, OwnerTabListing } from "@cloudpid/protocol";

/** What `ownerTabView` fails with when the Owner tab shown, or its browser, is gone, exactly. */
export { OWNER_TAB_GONE } from "@cloudpid/protocol/live-view";

/** What the agent names the Owner tab the Browser Pane shows by, whatever its ID: `browser`'s `tab`. */
export const SHOWN_OWNER_TAB = "shown";

/**
 * What the agent may know of a page's address: its origin, never its URL (an OAuth redirect carries a code, a link a
 * token). `about:blank` for a blank page, the scheme of another page without an origin, and `(unknown)` for an address
 * that does not parse. A Browser Handoff's windows and the Owner tabs are told this way.
 */
export const originOf = (url: string): string => {
  if (!URL.canParse(url)) return "(unknown)";

  const parsed = new URL(url);

  if (parsed.origin !== "null") return parsed.origin;

  return parsed.href === "about:blank" ? "about:blank" : parsed.protocol;
};

/** The longest Owner tab title the agent is told (`browser_owner_tabs`); the page's own words. */
export const MAX_OWNER_TAB_TITLE = 200;

/** The bounds a page's URL, title and selected text are cut to when the owner attaches it to a message, and the host's read guard. */
export {
  MAX_PAGE_SELECTION,
  MAX_PAGE_SELECTION_READ,
  MAX_PAGE_TITLE,
  MAX_PAGE_URL,
} from "@cloudpid/protocol/live-view";

/**
 * What the host read of an Owner tab the owner attached to a message: its URL and title now and the text selected in it,
 * for the Owner tab shown only (at most `MAX_PAGE_SELECTION_READ` units; the Session redacts and cuts it). All of it comes from the page, so it is untrusted: the Session fences it before the model
 * sees it. No `selection` when nothing is selected or it could not be read.
 */
export type OwnerTabPageRead = {
  readonly ownerTabId: string;
  readonly url: string;
  readonly title: string;
  readonly selection?: string;
};

/**
 * How a Browser Handoff was left: the origins (never the URLs) of the windows the tab opened that are still open, or no
 * `windowOrigins` when the host could not tell.
 */
export type HandoffEnded = { readonly windowOrigins?: ReadonlyArray<string> };

/** Where a Browser Handoff stands. */
export type HandoffStatus =
  /** The owner has not finished. */
  | { readonly state: "waiting" }
  /** The owner finished (`success`) or reported they could not, or Browser Run timed the handoff out. */
  | { readonly state: "complete"; readonly success: boolean; readonly reason?: string }
  /** Browser Run no longer has the handoff, and did not say how it ended. */
  | { readonly state: "ended" }
  /** The host has no such handoff. */
  | { readonly state: "unknown" };

/** A part of what a run returns: text, or a screenshot the UI shows. */
export type BrowserOutputPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/** What one run of the model's code returned, as the tool result it becomes. */
export type BrowserRun = {
  readonly output: ReadonlyArray<BrowserOutputPart>;
  /** What a UI can show without reading the output: the run's status, and tabs the page opened. */
  readonly details?: JsonValue;
  readonly isError?: boolean;
};

/** The browser host Durable Object's RPC methods, as the Session calls them. */
export type BrowserHostRpc = {
  /** The `browser` tool's description. */
  describe(): Promise<string>;
  /**
   * Run `code` in conversation `conversationId`'s tab or, given `ownerTabId`, in that Owner tab (its own scope), leaving
   * the conversation's tab and the Owner tab's size as they are. An Owner tab that is not open when the call's turn
   * comes, or that closes during the call, makes the result an error that says so.
   */
  run(code: string, conversationId: number, ownerTabId?: string): Promise<BrowserRun>;
  /** Close the browser; false when there was none. */
  close(): Promise<boolean>;
  /**
   * Hand the tab of conversation `input.conversationId` to the owner: note its viewport and send `Cloudflare.handoff`.
   * Idempotent by `requestId`: a handoff already started under it answers as it did. Fails when the conversation has no
   * tab.
   */
  startHandoff(input: HandoffStartInput): Promise<HandoffStarted>;
  /**
   * Mint fresh Live View links (60 s) to handoff `requestId`'s tab and the windows it opened, for the owner's client
   * that asked. Fails with `LIVE_VIEW_HANDOFF_OVER` once the handoff has ended.
   */
  liveView(requestId: string): Promise<LiveViewLinks>;
  /**
   * Mint fresh Live View links (60 s) to the Owner tab the Browser Pane shows and the windows it opened, for the owner's
   * client that asked. With `open` (the Pane opening), the browser is started when none runs and an Owner tab opened and
   * shown when the owner has none, and the answer says whether it opened one and whether the one shown before is gone.
   * Fails with `OWNER_TAB_GONE` when the tab or its browser is gone and `open` is false.
   */
  ownerTabView(open: boolean): Promise<OwnerTabLinks>;
  /**
   * The Owner tabs by title and the one shown (`owner_tab_list`'s answer), as the browser has them now; a page an Owner
   * tab opened with a link joins the list. Starts nothing: with no browser running the list is empty.
   */
  ownerTabs(): Promise<OwnerTabListing>;
  /** Open a blank Owner tab and show it, starting the browser when none runs; answers the list after it. */
  openOwnerTab(): Promise<OwnerTabListing>;
  /** Show Owner tab `id`; answers the list after it. Fails with `OWNER_TAB_GONE` when there is no such tab. */
  showOwnerTab(id: string): Promise<OwnerTabListing>;
  /** Close Owner tab `id` and the windows it opened; answers the list after it. A tab already gone is not an error. */
  closeOwnerTab(id: string): Promise<OwnerTabListing>;
  /**
   * Read the Owner tabs `ids` for a message they are attached to: URL, title and selected text, in the order asked.
   * Fails with `OWNER_TAB_GONE` when one is not still there, reading none.
   */
  readOwnerTabPages(ids: ReadonlyArray<string>): Promise<OwnerTabPageRead[]>;
  /** Wait up to `maxMs` for handoff `requestId` to complete, and say where it stands. */
  waitHandoff(requestId: string, maxMs: number): Promise<HandoffStatus>;
  /**
   * Finish handoff `requestId`: if the owner has not, end it in Browser Run; give the agent its viewport back; then
   * forget it. Says the origins of the tab's windows that are still open.
   */
  endHandoff(requestId: string): Promise<HandoffEnded>;
};
