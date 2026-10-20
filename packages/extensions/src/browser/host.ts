// The browser the Session's `browser` tool drives (`docs/spec.md` → Browser, ADR-0007): a Durable Object of the
// `apps/browser` Worker, one per Session, which hosts `agents/browser`'s `Browser` on Browser Run and runs the model's
// CDP code in a Worker Loader isolate. This is its contract from the Session's side, in plain data a Durable Object
// RPC carries; the extension depends on it and not on `agents`, which only workerd can load.
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { BrowserRun } from "./contract.ts";

export { BROWSER_KEEP_ALIVE_MS, type BrowserOutputPart, type BrowserRun } from "./contract.ts";

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
   * conversation has an active tab of its own in the Session's one browser, while cookies and logins are shared.
   */
  readonly run: (input: {
    readonly code: string;
    readonly conversationId: number;
  }) => Effect.Effect<BrowserRun, BrowserError>;
  /** Close the Session's browser; says whether there was one. The next `run` starts a new browser. */
  readonly close: Effect.Effect<boolean, BrowserError>;
};

export class BrowserHost extends Context.Service<BrowserHost, BrowserHostService>()(
  "@cloudpid/extensions/browser/host/BrowserHost",
) {}
