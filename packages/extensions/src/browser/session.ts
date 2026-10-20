// The Session's hold on its browser (`docs/spec.md` → Browser): when the browser was last used, and closing it once the
// Session has been idle past its keep-alive. Browser Run reclaims an idle browser by itself after `keep_alive`; closing
// it here frees the session as soon as the Session is known to be idle, and retires the browser's record, so no later
// run hits a browser that is already gone. The host's own idle and alarm logic drives it: `closeAt` is a wake time, and
// `closeIfIdle` runs when the Session settles with no work live. It schedules nothing.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BROWSER_KEEP_ALIVE_MS, type BrowserHostService } from "./host.ts";

/** The Durable Object's synchronous key-value storage, as the service uses it. */
export type BrowserStorage = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
};

/** Where the time of the browser's last use is kept: the browser outlives the Session DO instance that used it. */
const LAST_USED_KEY = "browser-last-used";

export type BrowserSessionService = {
  /** Note that the browser was used just now. */
  readonly touch: Effect.Effect<void>;
  /** When the browser falls idle past its keep-alive, or undefined while no browser is open. */
  readonly closeAt: Effect.Effect<number | undefined>;
  /**
   * Close the browser if it fell idle past its keep-alive. Run only while the Session is idle, so a browser a live run
   * still drives is never closed. A close that fails is given up: Browser Run reclaims the browser itself.
   */
  readonly closeIfIdle: Effect.Effect<void>;
};

export class BrowserSession extends Context.Service<BrowserSession, BrowserSessionService>()(
  "@cloudpid/extensions/browser/session/BrowserSession",
) {}

export type BrowserSessionOptions = {
  readonly host: BrowserHostService;
  readonly storage: BrowserStorage;
  /** How long the browser may sit unused. Defaults to `BROWSER_KEEP_ALIVE_MS`, which the browser is launched with. */
  readonly keepAliveMs?: number;
};

export const makeBrowserSession = ({
  host,
  storage,
  keepAliveMs = BROWSER_KEEP_ALIVE_MS,
}: BrowserSessionOptions): BrowserSessionService => {
  const closeAt = Effect.sync(() => {
    const lastUsed = storage.get<number>(LAST_USED_KEY);

    return lastUsed === undefined ? undefined : lastUsed + keepAliveMs;
  });

  return {
    touch: Effect.map(Clock.currentTimeMillis, (now) => storage.put(LAST_USED_KEY, now)),
    closeAt,
    closeIfIdle: Effect.gen(function* () {
      const at = yield* closeAt;

      if (at === undefined || (yield* Clock.currentTimeMillis) < at) return;

      // Forgotten first: a close that fails is not retried at every idle, and a use during it starts over.
      yield* Effect.sync(() => storage.delete(LAST_USED_KEY));
      yield* host.close.pipe(
        Effect.catch((error) => Effect.logWarning("Closing the browser failed", error)),
      );
    }),
  };
};

/** The Session's browser keep-alive over its storage, closing through `host`. */
export const browserSessionLayer = (options: BrowserSessionOptions) =>
  Layer.succeed(BrowserSession, makeBrowserSession(options));
