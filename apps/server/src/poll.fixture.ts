// Waiting, in a test, for what the code under test does in its own time (docs/development/workers.md → workerd tests).
// A loaded CI runner once took over 3 s to answer a first watch (#300), so a wait is bounded by the test's own timeout,
// not by a count of polls, and every wait in a test shares that one deadline.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off missingPipeableSignature:off
import { TestRunner } from "vitest";

/** How long before the test's timeout its waits give up, so the one that was never met fails with its own message. */
const MARGIN_MS = 2_000;

/** How long a wait outside a test (in a hook) lasts. */
const OUTSIDE_A_TEST_MS = 20_000;

/** How often a wait checks. */
const INTERVAL_MS = 10;

/** When the running test's waits give up: `MARGIN_MS` before its timeout, counted from its start (Vitest's `Date.now()`). */
const deadline = (): number => {
  const test = TestRunner.getCurrentTest();
  const start = test?.result?.startTime;
  const timeout = test?.timeout ?? 0;

  return start === undefined || timeout <= 0
    ? Date.now() + OUTSIDE_A_TEST_MS
    : start + timeout - MARGIN_MS;
};

/**
 * Check `check` every 10 ms until it holds. Once the test's waits give up, throw `failure()`'s message, or, without
 * `failure`, return, for a wait the assertions after it check.
 */
export const poll = async (
  check: () => boolean | Promise<boolean>,
  failure?: () => string,
): Promise<void> => {
  const until = deadline();

  while (!(await check())) {
    if (Date.now() >= until) {
      if (failure === undefined) return;

      throw new Error(failure());
    }

    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
};
