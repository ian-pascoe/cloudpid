// What the Session and its browser host (`apps/browser`) agree on, in plain data a Durable Object RPC carries and
// without imports a Worker would have to bundle: the host's Worker takes this file alone, not the extension.
import type { JsonValue } from "@earendil-works/chord";

/**
 * How long Browser Run keeps an idle browser (`keep_alive`): it closes the browser itself once no CDP command has come
 * for this long. Browser Run's default for `agents/browser`, and half its 20-minute maximum.
 */
export const BROWSER_KEEP_ALIVE_MS = 10 * 60_000;

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
};
