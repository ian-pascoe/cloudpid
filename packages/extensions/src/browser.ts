// The `browser` extension (`docs/spec.md` → Browser, ADR-0007): the model-facing `browser` tool, which drives the
// Session's one browser over CDP with a tab per conversation, and the keep-alive that closes the browser once the
// Session has been idle past it. The browser itself is hosted by the `apps/browser` Worker (`./browser/host.ts`).
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import { BrowserHost } from "./browser/host.ts";
import { BrowserHandoffs } from "./browser/handoff.ts";
import { BrowserSession } from "./browser/session.ts";
import {
  browserHandoffTool,
  browserTool,
  describeBrowser,
  FALLBACK_DESCRIPTION,
} from "./browser/tool.ts";

export const extensionName = "browser";

export {
  BROWSER_IDLE_MS,
  BROWSER_KEEP_ALIVE_MS,
  BrowserError,
  BrowserHost,
  type BrowserHostService,
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
  OWNER_TAB_GONE,
  type OwnerTabLinks,
} from "./browser/host.ts";

export {
  type BrowserSessionOptions,
  BrowserSession,
  browserSessionLayer,
  type BrowserSessionService,
  type BrowserStorage,
  makeBrowserSession,
} from "./browser/session.ts";

export {
  BrowserHandoffs,
  HANDOFF_POLL_MS,
  type BrowserHandoffOutcome,
  BrowserHandoffRequest,
  browserHandoffsLayer,
  type BrowserHandoffsOptions,
  type BrowserHandoffsService,
  type BrowserHandoffStorage,
  makeBrowserHandoffs,
} from "./browser/handoff.ts";

export {
  imageLimitedModels,
  limitEntryImages,
  limitEventImages,
  limitImages,
  MODEL_IMAGES,
  OMITTED_IMAGE,
  SNAPSHOT_IMAGES,
} from "./browser/images.ts";

export { describeBrowser, describeOutcome } from "./browser/tool.ts";

/** How long the host may take to describe the tool before the Session starts without its description. */
const DESCRIBE_TIMEOUT = "5 seconds";

/**
 * The `browser` extension. Its description is the host's, which wakes the host's object when a Session starts; a host
 * that cannot answer in time leaves the tool with a short one.
 */
export const Browser: Effect.Effect<
  Extension,
  never,
  BrowserHost | BrowserSession | BrowserHandoffs
> = Effect.gen(function* () {
  const host = yield* BrowserHost;
  const session = yield* BrowserSession;
  const handoffs = yield* BrowserHandoffs;

  const description = yield* host.describe.pipe(
    Effect.timeout(DESCRIBE_TIMEOUT),
    Effect.catch((error) =>
      Effect.logWarning("The browser host could not describe its tool", error).pipe(
        Effect.as(FALLBACK_DESCRIPTION),
      ),
    ),
    Effect.map(describeBrowser),
  );

  const tool = yield* browserTool(description).pipe(
    Effect.provideService(BrowserHost, host),
    Effect.provideService(BrowserSession, session),
  );

  const handoff = yield* browserHandoffTool.pipe(
    Effect.provideService(BrowserSession, session),
    Effect.provideService(BrowserHandoffs, handoffs),
  );

  return defineExtension({ name: extensionName, tools: [tool, handoff] });
});
