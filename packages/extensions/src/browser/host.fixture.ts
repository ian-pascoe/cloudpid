// @effect-diagnostics missingPipeableSignature:off instanceOfSchema:off
// A fake browser host for tests: it answers `describe`, `run`, and `close` as given, and records and scripts Browser
// Browser Handoffs, which the tests of the handoff and the Session's wiring drive.
import * as Effect from "effect/Effect";
import {
  BrowserError,
  type BrowserHostService,
  type BrowserRun,
  type HandoffStarted,
  type HandoffStartInput,
  type HandoffStatus,
  type LiveViewLinks,
} from "./host.ts";

/** The credential in every Live View link the fake host mints, to look for where it must not be. */
export const LIVE_VIEW_TOKEN = "SECRET-LIVE-VIEW-TOKEN";

/** The Live View links the fake host mints: recognisable, so a test can look for them where they must not be. */
export const LIVE_VIEW_LINKS: LiveViewLinks = {
  tab: {
    targetId: "tab-1",
    link: `wss://live.browser.run/api/devtools/browser/s/page/tab-1?jwt=${LIVE_VIEW_TOKEN}`,
  },
  windows: [
    {
      targetId: "popup-1",
      openerId: "tab-1",
      title: "Sign in",
      link: `wss://live.browser.run/api/devtools/browser/s/page/popup-1?jwt=${LIVE_VIEW_TOKEN}`,
    },
  ],
};

/** Browser Handoffs a fake host was asked to start, mint links for, wait on, and end. */
export type HandoffCalls = {
  readonly started: HandoffStartInput[];
  readonly liveViews: string[];
  readonly waits: Array<{ readonly requestId: string; readonly maxMs: number }>;
  readonly ended: string[];
};

/** A fake host whose handoffs are as `waits` scripts them: the status each round of waiting answers, then the last repeats. */
export const fakeHandoffHost = (
  waits: ReadonlyArray<HandoffStatus | BrowserError> = [{ state: "waiting" }],
  options: {
    readonly describe?: string;
    readonly run?: (code: string) => Effect.Effect<BrowserRun, BrowserError>;
    readonly start?: (input: HandoffStartInput) => Effect.Effect<HandoffStarted, BrowserError>;
    readonly now?: () => number;
    /** The origins of the windows the tab leaves open, which ending a handoff says. */
    readonly windowOrigins?: ReadonlyArray<string>;
  } = {},
) => {
  const calls: HandoffCalls = { started: [], liveViews: [], waits: [], ended: [] };
  let round = 0;
  const now = options.now ?? Date.now;

  const host: BrowserHostService = {
    describe: Effect.succeed(
      options.describe ?? "Run JavaScript that drives a persistent Chrome browser.",
    ),
    run: (input) =>
      options.run?.(input.code) ??
      Effect.succeed({ output: [{ type: "text", text: "ok" }], details: { status: "completed" } }),
    close: Effect.succeed(true),
    startHandoff: (input) =>
      Effect.suspend(() => {
        calls.started.push(input);

        return options.start?.(input) ?? Effect.succeed({ startedAt: now() });
      }),
    liveView: (requestId) =>
      Effect.sync(() => {
        calls.liveViews.push(requestId);

        return LIVE_VIEW_LINKS;
      }),
    waitHandoff: (requestId, maxMs) =>
      Effect.suspend((): Effect.Effect<HandoffStatus, BrowserError> => {
        calls.waits.push({ requestId, maxMs });

        const next = waits[Math.min(round, waits.length - 1)] ?? { state: "waiting" as const };

        round += 1;

        if (next instanceof BrowserError) return Effect.fail(next);

        // A round that finds the owner still busy lasts as long as it was asked to.
        return next.state === "waiting"
          ? Effect.as(Effect.sleep(maxMs), next)
          : Effect.succeed(next);
      }),
    endHandoff: (requestId) =>
      Effect.sync(() => {
        calls.ended.push(requestId);

        return { windowOrigins: options.windowOrigins ?? [] };
      }),
  };

  return { host, calls };
};
