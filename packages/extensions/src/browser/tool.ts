// `browser`: the model's CDP code, run by the Session's browser host in the calling conversation's tab (`docs/spec.md` →
// Browser). This is the Session's side of `agents/browser`'s `browserTool`: its description and its results come from
// the host, shaped here for the transcript, the socket, and the UI.
import { defineEffectTool } from "@cloudpid/effect-durable";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { BrowserError, BrowserHost, type BrowserOutputPart, type BrowserRun } from "./host.ts";
import { BrowserSession } from "./session.ts";

/**
 * The longest screenshot kept, in base64 characters (about 560 KB). A screenshot enters the conversation, so it is stored
 * in the Session's SQLite, sent to the model with every later request, and sent to each client in the transcript's
 * snapshot: the bound keeps a few of them from outgrowing any of the three. A viewport screenshot as a JPEG is far under
 * it; a full-page PNG often is not.
 */
export const MAX_IMAGE_CHARACTERS = 750_000;

/** The image types a screenshot may be: the UI shows them in an `<img>`, and an SVG or other type from a page is not one. */
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Used when the host cannot say how to drive its browser. */
export const FALLBACK_DESCRIPTION =
  "Run JavaScript that drives a persistent Chrome browser over the Chrome DevTools Protocol (CDP). Write an async arrow function, `async () => { ... }`, and return a small JSON value. Use the `cdp` global: `cdp.send({ method, params?, sessionId?: 'active' })` sends a CDP command and returns its result, and `cdp.attachToTarget({ targetId })` switches tab.";

/** What the host's description cannot know: how this Session uses the browser. */
const SESSION_NOTES = Arr.join(
  [
    "## In this Session",
    "",
    "- The Session has one browser. Each conversation (you, and each subagent) works in a tab of its own; cookies and logins are shared.",
    "- Secret references are not resolved in browser code, which is stored with the run. Page text that matches a Secret's value comes back redacted.",
    "- Every screenshot is kept in the conversation and shown to the user, so take few, of the viewport, as `format: 'jpeg', quality: 60`. One over about 500 KB is left out.",
  ],
  "\n",
);

/** The tool's description: the host's, then what is particular to this Session. */
export const describeBrowser = (hostDescription: string): string =>
  `${hostDescription}\n\n${SESSION_NOTES}`;

const note = (text: string): BrowserOutputPart => ({ type: "text", text });

/** One part of a run's output as the transcript keeps it: a screenshot that is too large or not an image a page may show becomes a note. */
const keep = (part: BrowserOutputPart): BrowserOutputPart => {
  if (part.type === "text") return part;

  if (!IMAGE_TYPES.has(part.mimeType)) {
    return note(
      `An image of type ${part.mimeType} was left out: only PNG, JPEG, and WebP images are kept.`,
    );
  }

  if (part.data.length > MAX_IMAGE_CHARACTERS) {
    const kilobytes = Math.round((part.data.length * 3) / 4 / 1000);

    return note(
      `A screenshot of about ${kilobytes} KB was left out: it is too large to keep in the conversation. Take it again as a viewport screenshot with Page.captureScreenshot's format: 'jpeg', quality: 60, or clip a smaller area.`,
    );
  }

  return part;
};

/** A run as the tool result it becomes. */
export const toToolResult = (run: BrowserRun): ToolExecutionResult => {
  const result: Types.Mutable<ToolExecutionResult> = { output: Arr.map(run.output, keep) };

  if (run.details !== undefined) result.details = run.details;

  if (run.isError === true) result.isError = true;

  return result;
};

const Parameters = Schema.Struct({
  code: Schema.String.annotate({
    description: "An async arrow function that drives the browser with `cdp`",
  }),
});

/**
 * The `browser` tool over the Session's host and keep-alive. It is not replay-safe: the code may have clicked or
 * submitted something, so after an eviction the model gets an interrupted result instead of a rerun. It is sequential:
 * a conversation's runs share its tab.
 */
export const browserTool = (description: string) =>
  defineEffectTool({
    name: "browser",
    description,
    parameters: Parameters,
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ code }, api) =>
      Effect.gen(function* () {
        const host = yield* BrowserHost;
        const session = yield* BrowserSession;

        // Used from the start, and again whatever came of it: a Session evicted during the run still has the time to
        // close the browser from, and the browser may have been started before the call failed.
        yield* session.touch;

        const run = yield* host
          .run({ code, conversationId: Number(api.conversationId) })
          .pipe(Effect.ensuring(session.touch));

        return toToolResult(run);
      }).pipe(
        Effect.mapError((error) =>
          BrowserError.make({ message: `The browser failed: ${error.message}` }),
        ),
      ),
  });
