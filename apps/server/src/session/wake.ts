// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over a few times and services.
// What wakes a Session that has no work live, and what it does when it settles (`./host.ts`'s `wakeAt` and `onIdle`): one
// alarm serves a held Secret's expiry and the browser's keep-alive, so neither needs an alarm of its own.
import type { ApprovalsService } from "@cloudpid/extensions/approvals";
import type { BrowserSessionService, BrowserHandoffsService } from "@cloudpid/extensions/browser";
import type { McpQuestionsService, McpSignInsService } from "@cloudpid/extensions/mcp";
import type { SecretsService } from "@cloudpid/extensions/secrets";
import * as Effect from "effect/Effect";

/** The earliest of the times, ignoring the ones there are none of. */
export const earliest = (...times: ReadonlyArray<number | undefined>): number | undefined => {
  const set = times.filter((time) => time !== undefined);

  return set.length === 0 ? undefined : Math.min(...set);
};

/**
 * When the object must wake although no work is live: when a held Secret expires, the browser falls idle past its
 * keep-alive, or a Session import expires or is to be started again (`importWake`).
 */
export const wakeAt = (
  secrets: Pick<SecretsService, "nextExpiry">,
  browser: Pick<BrowserSessionService, "closeAt">,
  importWake?: Effect.Effect<number | undefined>,
): Effect.Effect<number | undefined> =>
  Effect.gen(function* () {
    const [expiry, close] = yield* Effect.all([secrets.nextExpiry, browser.closeAt]);

    return earliest(expiry, close, importWake === undefined ? undefined : yield* importWake);
  });

/**
 * What the object does whenever it settles with no work live: clears the Secret requests, Browser Handoffs, Approval
 * requests, Sign-in requests and MCP servers' deferred questions a call abandoned, and closes the browser if it fell
 * idle past its keep-alive. Only now is it known that no live run still drives the browser or waits for an answer.
 */
export const onIdle = (
  secrets: Pick<SecretsService, "dropAbandoned">,
  browser: Pick<BrowserSessionService, "closeIfIdle">,
  handoffs: Pick<BrowserHandoffsService, "dropAbandoned">,
  approvals: Pick<ApprovalsService, "dropAbandoned">,
  signIns: Pick<McpSignInsService, "dropAbandoned">,
  questions: Pick<McpQuestionsService, "dropAbandoned">,
): Effect.Effect<void> =>
  Effect.all(
    [
      secrets.dropAbandoned,
      handoffs.dropAbandoned,
      approvals.dropAbandoned,
      signIns.dropAbandoned,
      questions.dropAbandoned,
      browser.closeIfIdle,
    ],
    { discard: true },
  );
