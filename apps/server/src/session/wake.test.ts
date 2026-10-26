// When the Session wakes with no work live, and what it does when it settles: the browser's keep-alive beside the
// Secrets' expiry, over the real keep-alive so a close really follows an idle Session past it.
// @effect-diagnostics strictEffectProvide:off anyUnknownInErrorContext:off
import {
  BROWSER_IDLE_MS,
  type BrowserHostService,
  makeBrowserSession,
} from "@cloudpid/extensions/browser";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { earliest, onIdle, wakeAt } from "./wake.ts";

const test = (name: string, body: () => Effect.Effect<void, unknown>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))));

/** What the fakes were asked to do, and the time the keep-alive stored. */
class Probe {
  closes = 0;
  dropped = 0;
  handoffsDropped = 0;
  approvalsDropped = 0;
  stored: number | undefined = undefined;
}

const setup = (nextExpiry?: number) => {
  const state = new Probe();

  const host: BrowserHostService = {
    describe: Effect.succeed(""),
    run: () => Effect.succeed({ output: [] }),
    startHandoff: () => Effect.die("no handoff"),
    liveView: () => Effect.die("no handoff"),
    ownerTabView: () => Effect.die("no Browser Pane"),
    waitHandoff: () => Effect.die("no handoff"),
    endHandoff: () => Effect.succeed({ windowOrigins: [] }),
    close: Effect.sync(() => {
      state.closes += 1;

      return true;
    }),
  };

  const browser = makeBrowserSession({
    host,
    storage: {
      // SAFETY: only the last-used time is stored.
      get: <T>() => state.stored as T | undefined,
      put: (_key, value) => {
        state.stored = Number(value);
      },
      delete: () => {
        state.stored = undefined;

        return true;
      },
    },
  });

  const secrets = {
    nextExpiry: Effect.succeed(nextExpiry),
    dropAbandoned: Effect.sync(() => {
      state.dropped += 1;
    }),
  };

  const handoffs = {
    dropAbandoned: Effect.sync(() => {
      state.handoffsDropped += 1;
    }),
  };

  const approvals = {
    dropAbandoned: Effect.sync(() => {
      state.approvalsDropped += 1;
    }),
  };

  return { state, browser, secrets, handoffs, approvals };
};

describe("earliest", () => {
  it("is the soonest of the times there are", () => {
    expect(earliest(300, undefined, 200)).toBe(200);
  });

  it("is nothing when there are none", () => {
    expect(earliest(undefined, undefined)).toBeUndefined();
  });
});

describe("what wakes an idle Session", () => {
  test("is the browser's keep-alive when no Secret is held", () =>
    Effect.gen(function* () {
      const { browser, secrets } = setup();

      yield* browser.touch;

      expect(yield* wakeAt(secrets, browser)).toBe(BROWSER_IDLE_MS);
    }));

  test("is the sooner of a Secret's expiry and the browser's keep-alive", () =>
    Effect.gen(function* () {
      const { browser, secrets } = setup(1_000);

      yield* browser.touch;

      expect(yield* wakeAt(secrets, browser)).toBe(1_000);
    }));

  test("is nothing when no browser is open and no Secret is held", () =>
    Effect.gen(function* () {
      const { browser, secrets } = setup();

      expect(yield* wakeAt(secrets, browser)).toBeUndefined();
    }));
});

describe("what a Session does when it settles", () => {
  test("closes the browser once the Session has been idle past its keep-alive, and clears abandoned Secret requests, Browser Handoffs and Approval requests", () =>
    Effect.gen(function* () {
      const { state, browser, secrets, handoffs, approvals } = setup();

      yield* browser.touch;
      yield* onIdle(secrets, browser, handoffs, approvals);

      expect(state).toMatchObject({
        closes: 0,
        dropped: 1,
        handoffsDropped: 1,
        approvalsDropped: 1,
      });

      yield* TestClock.adjust(BROWSER_IDLE_MS);
      yield* onIdle(secrets, browser, handoffs, approvals);

      expect(state).toMatchObject({
        closes: 1,
        dropped: 2,
        handoffsDropped: 2,
        approvalsDropped: 2,
      });
      expect(yield* wakeAt(secrets, browser)).toBeUndefined();
    }));
});
