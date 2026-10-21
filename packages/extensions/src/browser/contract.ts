// What the Session and its browser host (`apps/browser`) agree on, in plain data a Durable Object RPC carries and
// without imports a Worker would have to bundle: the host's Worker takes this file alone, not the extension.
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
 * A started Browser Handoff. `url` is the Live View link, a bearer credential for the owner alone: it is kept out of
 * every tool result, transcript entry, and model request.
 */
export type HandoffStarted = {
  readonly url: string;
  /** When the handoff began, epoch milliseconds. */
  readonly startedAt: number;
};

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
  /** Run `code` in conversation `conversationId`'s tab. */
  run(code: string, conversationId: number): Promise<BrowserRun>;
  /** Close the browser; false when there was none. */
  close(): Promise<boolean>;
  /**
   * Hand the tab of conversation `input.conversationId` to the owner: send `Cloudflare.handoff` and mint the Live View
   * link. Idempotent by `requestId`: a handoff already started under it answers with the same link. Fails when the
   * conversation has no tab.
   */
  startHandoff(input: HandoffStartInput): Promise<HandoffStarted>;
  /** Wait up to `maxMs` for handoff `requestId` to complete, and say where it stands. */
  waitHandoff(requestId: string, maxMs: number): Promise<HandoffStatus>;
  /** Finish handoff `requestId`: if the owner has not, end it in Browser Run, then forget it. */
  endHandoff(requestId: string): Promise<void>;
};
