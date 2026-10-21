// @effect-diagnostics missingPipeableSignature:off instanceOfSchema:off
// A fake browser host for tests: it answers `describe`, `run`, and `close` as given, and records and scripts Browser
// Handoffs, which the tests of the handoff and the Session's wiring drive.
import * as Effect from "effect/Effect";
import {
  BrowserError,
  type BrowserHostService,
  type BrowserRun,
  type HandoffStarted,
  type HandoffStartInput,
  type HandoffStatus,
} from "./host.ts";

/** The Live View link the fake host mints: recognisable, so a test can look for it where it must not be. */
export const LIVE_VIEW_URL =
  "https://live.browser.run/ui/view?mode=tab&wss=live.browser.run/api/devtools/browser/s/page/t?jwt=SECRET-LIVE-VIEW-TOKEN";

/** Handoffs a fake host was asked to start, wait on, and end. */
export type HandoffCalls = {
  readonly started: HandoffStartInput[];
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
  } = {},
) => {
  const calls: HandoffCalls = { started: [], waits: [], ended: [] };
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

        return options.start?.(input) ?? Effect.succeed({ url: LIVE_VIEW_URL, startedAt: now() });
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
      }),
  };

  return { host, calls };
};
