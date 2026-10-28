// The browser the Session's `browser` tool drives (`docs/architecture/browser.md`, ADR-0007): a Durable Object of the
// `apps/browser` Worker, one per Session, which hosts `agents/browser`'s `Browser` on Browser Run and runs the model's
// CDP code in a Worker Loader isolate. This is its contract from the Session's side, in plain data a Durable Object
// RPC carries; the extension depends on it and not on `agents`, which only workerd can load.
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  BrowserRun,
  HandoffEnded,
  HandoffStarted,
  HandoffStartInput,
  HandoffStatus,
  LiveViewLinks,
  OwnerTabLinks,
  OwnerTabListing,
  OwnerTabPageRead,
} from "./contract.ts";

export {
  BROWSER_IDLE_MS,
  BROWSER_KEEP_ALIVE_MS,
  type BrowserOutputPart,
  type BrowserRun,
  HANDOFF_TIMEOUT_MS,
  type HandoffEnded,
  type HandoffStarted,
  type HandoffStartInput,
  type HandoffStatus,
  LIVE_VIEW_HANDOFF_OVER,
  type LiveViewLinks,
  type LiveViewTarget,
  type LiveViewWindow,
  MAX_HANDOFF_INSTRUCTIONS,
  MAX_OWNER_TAB_TITLE,
  originOf,
  OWNER_TAB_GONE,
  type OwnerTabEntry,
  type OwnerTabLinks,
  type OwnerTabListing,
  SHOWN_OWNER_TAB,
  type OwnerTabPageRead,
} from "./contract.ts";

/** The browser could not be reached or failed outside the model's code: the model sees `message` as the error result. */
export class BrowserError extends Schema.TaggedError<
  BrowserError,
  { readonly brand: unique symbol }
>()("BrowserError", { message: Schema.String }) {}

export type BrowserHostService = {
  /** The `browser` tool's description, which tells the model how to drive the browser (written by `agents/browser`). */
  readonly describe: Effect.Effect<string, BrowserError>;
  /**
   * Run `code`, an async arrow function over the `cdp` global, in the tab of conversation `conversationId`: each
   * conversation has an active tab of its own in the Session's one browser, while cookies and logins are shared. Given
   * `ownerTabId`, it runs in that Owner tab instead, leaving the conversation's tab and the Owner tab's size as they are;
   * an Owner tab that is not open, or closes during the call, makes the result an error that says so.
   */
  readonly run: (input: {
    readonly code: string;
    readonly conversationId: number;
    readonly ownerTabId?: string;
  }) => Effect.Effect<BrowserRun, BrowserError>;
  /** Close the Session's browser; says whether there was one. The next `run` starts a new browser. */
  readonly close: Effect.Effect<boolean, BrowserError>;
  /**
   * Hand conversation `conversationId`'s tab to the owner (Browser Run's `Cloudflare.handoff`). Starting a handoff again
   * under the same `requestId` finds the one already started. Fails when the conversation has no tab to hand over.
   */
  readonly startHandoff: (input: HandoffStartInput) => Effect.Effect<HandoffStarted, BrowserError>;
  /**
   * Fresh 60-second Live View links to handoff `requestId`'s tab and the windows it opened, for the one client that
   * asked. Fails (its message holds `LIVE_VIEW_HANDOFF_OVER`) once the handoff has ended.
   */
  readonly liveView: (requestId: string) => Effect.Effect<LiveViewLinks, BrowserError>;
  /**
   * Fresh 60-second Live View links to the Owner tab the owner's Browser Pane shows and the windows it opened, for the
   * one client that asked. With `open` (the Pane opening), the browser is started when none runs and an Owner tab opened
   * and shown when the owner has none. Fails (its message holds `OWNER_TAB_GONE`) when the tab or its browser is gone
   * and `open` is false.
   */
  readonly ownerTabView: (open: boolean) => Effect.Effect<OwnerTabLinks, BrowserError>;
  /**
   * The Owner tabs by title and the one shown. A link a page opened in a new tab joins the list; a pop-up stays a window
   * of its tab. Starts nothing: with no browser running the list is empty.
   */
  readonly ownerTabs: Effect.Effect<OwnerTabListing, BrowserError>;
  /** Open a blank Owner tab and show it, starting the browser when none runs; the list after it. */
  readonly openOwnerTab: Effect.Effect<OwnerTabListing, BrowserError>;
  /** Show Owner tab `id`; the list after it. Fails (its message holds `OWNER_TAB_GONE`) when there is no such tab. */
  readonly showOwnerTab: (id: string) => Effect.Effect<OwnerTabListing, BrowserError>;
  /** Close Owner tab `id` and the windows it opened; the list after it. A tab already gone is not an error. */
  readonly closeOwnerTab: (id: string) => Effect.Effect<OwnerTabListing, BrowserError>;
  /**
   * Read the Owner tabs `ids` for a message they are attached to: URL, title and selected text. Fails (its message holds
   * `OWNER_TAB_GONE`) when one is not still there.
   */
  readonly readOwnerTabPages: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<OwnerTabPageRead>, BrowserError>;
  /** Wait up to `maxMs` for handoff `requestId` to complete, and say where it stands. */
  readonly waitHandoff: (
    requestId: string,
    maxMs: number,
  ) => Effect.Effect<HandoffStatus, BrowserError>;
  /**
   * Finish handoff `requestId`: end it in Browser Run if the owner has not, give the agent its viewport back, and forget
   * it. Says the origins of the windows the tab left open.
   */
  readonly endHandoff: (requestId: string) => Effect.Effect<HandoffEnded, BrowserError>;
};

export class BrowserHost extends Context.Service<BrowserHost, BrowserHostService>()(
  "@cloudpid/extensions/browser/host/BrowserHost",
) {}
