// `browser`: the model's CDP code, run by the Session's browser host in the calling conversation's tab (`docs/spec.md` →
// Browser). This is the Session's side of `agents/browser`'s `browserTool`: its description and its results come from
// the host, shaped here for the transcript, the socket, and the UI.
import { defineEffectTool } from "@cloudpid/effect-durable";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { BrowserHandoffs, type BrowserHandoffOutcome } from "./handoff.ts";
import {
  BrowserError,
  BrowserHost,
  type BrowserOutputPart,
  type BrowserRun,
  HANDOFF_TIMEOUT_MS,
  MAX_HANDOFF_INSTRUCTIONS,
} from "./host.ts";
import { BrowserSession } from "./session.ts";
import { MAX_IMAGE_CHARACTERS } from "../images.ts";

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
    "- A step only the user can do (signing in, a CAPTCHA, multi-factor authentication) is `browser_handoff`: it gives them live control of your tab and waits.",
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

  // The bound every image in a conversation is held to: a viewport JPEG is far under it, a full-page PNG often is not.
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

/**
 * What `browser_handoff` tells the model of how a handoff ended, and of the windows the tab left open, by origin only:
 * a window's URL may carry an OAuth code. It never holds a Live View link.
 */
export const describeOutcome = (outcome: BrowserHandoffOutcome): string => {
  const origins = outcome.windowOrigins;
  const count = origins?.length ?? 0;

  const windows =
    origins === undefined
      ? " Whether the tab left windows it opened (pop-ups or new tabs) open is not known: check with `browser`."
      : count === 0
        ? ""
        : ` The tab opened ${count === 1 ? "a window that is" : `${count} windows that are`} still open (pop-ups or new tabs): ${Arr.join(origins, ", ")}.`;

  const look = `The page may have changed: look at it with \`browser\` before you continue.${windows}`;

  switch (outcome.status) {
    case "completed":
      return `The user finished the handoff. ${look}`;
    case "failed":
      return `The user reported that they could not complete the handoff${outcome.reason === undefined ? "" : `: ${outcome.reason}`}. ${look}`;
    case "timeout":
      return `The handoff timed out after ${HANDOFF_TIMEOUT_MS / 60_000} minutes without the user finishing it. Do not assume the step was done; ${look}`;
    case "ended":
      return `The handoff ended, but Browser Run did not say how. ${look}`;
  }
};

const HandoffParameters = Schema.Struct({
  instructions: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_HANDOFF_INSTRUCTIONS),
  ).annotate({
    description:
      "What the user should do in the browser, and when to press Done: specific and actionable, such as 'Log in to GitHub, complete the two-factor prompt, then press Done'",
  }),
});

/**
 * `browser_handoff`: give the user live control of the calling conversation's tab and wait for them to finish. The user
 * opens a Live View from the UI or the push, which mints its own links; the model never sees one. The wait is durable: a
 * call cut off by an eviction reruns and waits for the same handoff, so it is `safe` to replay.
 */
export const browserHandoffTool = defineEffectTool({
  name: "browser_handoff",
  description: Arr.join(
    [
      `Hand the browser to the user for a step you cannot do, such as signing in, a CAPTCHA, or multi-factor authentication, and wait until they are done (at most ${HANDOFF_TIMEOUT_MS / 60_000} minutes).`,
      "The user is told in their app and by a push notification, and takes over your current tab in a private Live View, where they see your instructions. Open the page you need done with `browser` first.",
      "Never ask the user to type a password or code to you in the chat. Say what to do in `instructions` and where to press Done. Afterwards take a look at the page: the result says only how the handoff ended.",
    ],
    "\n\n",
  ),
  parameters: HandoffParameters,
  executionMode: "sequential",
  replay: "safe",
  execute: ({ instructions }, api) =>
    Effect.gen(function* () {
      const handoffs = yield* BrowserHandoffs;
      const session = yield* BrowserSession;

      yield* session.touch;

      const outcome = yield* handoffs
        .request({
          id: String(api.taskId),
          conversationId: Number(api.conversationId),
          instructions,
        })
        .pipe(Effect.ensuring(session.touch));

      return {
        output: [{ type: "text" as const, text: describeOutcome(outcome) }],
        details: { status: outcome.status },
      };
    }).pipe(
      Effect.mapError((error) =>
        BrowserError.make({ message: `The browser handoff failed: ${error.message}` }),
      ),
    ),
});
