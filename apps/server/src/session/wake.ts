// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over a few times and services.
// What wakes a Session that has no work live, and what it does when it settles (`./host.ts`'s `wakeAt` and `onIdle`): one
// alarm serves a held Secret's expiry and the browser's keep-alive, so neither needs an alarm of its own.
import type { BrowserSessionService, BrowserHandoffsService } from "@cloudpid/extensions/browser";
import type { SecretsService } from "@cloudpid/extensions/secrets";
import * as Effect from "effect/Effect";

/** The earliest of the times, ignoring the ones there are none of. */
export const earliest = (...times: ReadonlyArray<number | undefined>): number | undefined => {
  const set = times.filter((time) => time !== undefined);

  return set.length === 0 ? undefined : Math.min(...set);
};

/** When the object must wake although no work is live: when a held Secret expires, or the browser falls idle past its keep-alive. */
export const wakeAt = (
  secrets: Pick<SecretsService, "nextExpiry">,
  browser: Pick<BrowserSessionService, "closeAt">,
): Effect.Effect<number | undefined> =>
  Effect.zipWith(secrets.nextExpiry, browser.closeAt, (expiry, close) => earliest(expiry, close));

/**
 * What the object does whenever it settles with no work live: clears the Secret requests and Browser Handoffs a call abandoned, and closes the
 * browser if it fell idle past its keep-alive. Only now is it known that no live run still drives the browser.
 */
export const onIdle = (
  secrets: Pick<SecretsService, "dropAbandoned">,
  browser: Pick<BrowserSessionService, "closeIfIdle">,
  handoffs: Pick<BrowserHandoffsService, "dropAbandoned">,
): Effect.Effect<void> =>
  Effect.all([secrets.dropAbandoned, handoffs.dropAbandoned, browser.closeIfIdle], {
    discard: true,
  });
