// @effect-diagnostics preferEffectArray:off -- two times, filtered like `earliest` in the Session's `wake.ts`.
// The Session's hold on its browser (`docs/architecture/browser.md`): when the browser was last used or last watched, and
// closing it once the Session has been idle past its idle window. Browser Run reclaims an idle browser by itself after `keep_alive`; the
// window is shorter, so closing it here frees the browser sooner than that, and retires the browser's record, so no later
// run hits a browser that is already gone. The host's own idle and alarm logic drives it: `closeAt` is a wake time, and
// `closeIfIdle` runs when the Session settles with no work live. It schedules nothing.
//
// A Browser Pane in view keeps the browser: its heartbeat (`watch`, each time the Pane sends one) is a time like a use,
// never a flag, so a Pane that is forgotten, closed or cut off (an eviction, a dropped socket) stops holding the browser
// when its beats stop: the idle window runs from the last of them.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BROWSER_IDLE_MS, type BrowserHostService } from "./host.ts";

/** How long a close may take: it runs while the Session settles, so a slow host must not hold the Session up. */
const CLOSE_TIMEOUT = "5 seconds";

/** The Durable Object's synchronous key-value storage, as the service uses it. */
export type BrowserStorage = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
};

/** Where the time of the browser's last use is kept: the browser outlives the Session DO instance that used it. */
const LAST_USED_KEY = "browser-last-used";

/** Where the time of the last heartbeat of a Browser Pane in view is kept, for the same reason. */
const LAST_WATCHED_KEY = "browser-pane-watched";

/**
 * How often a beat is written down at most: the Pane in view beats every few seconds, and the idle window is minutes, so
 * a beat within this long of the one kept changes nothing worth a write to the Session's storage.
 */
export const WATCH_WRITE_MS = 30_000;

export type BrowserSessionService = {
  /** Note that the browser was used just now. */
  readonly touch: Effect.Effect<void>;
  /**
   * Note that a Browser Pane in view sent a heartbeat just now: it holds the idle close off as a use does (written at
   * most every `WATCH_WRITE_MS`). Says whether there was no close time before, so the Session must settle to arm the wake
   * for this one.
   */
  readonly watch: Effect.Effect<boolean>;
  /**
   * When the browser falls idle past the Session's idle window (from its last use or the last heartbeat of a Browser
   * Pane in view), or undefined while no browser is open.
   */
  readonly closeAt: Effect.Effect<number | undefined>;
  /**
   * Close the browser if it fell idle past the idle window. Run only while the Session is idle, so a browser a live run
   * still drives is never closed. A close that fails or takes over `CLOSE_TIMEOUT` is given up: Browser Run reclaims the
   * browser itself.
   */
  readonly closeIfIdle: Effect.Effect<void>;
};

export class BrowserSession extends Context.Service<BrowserSession, BrowserSessionService>()(
  "@cloudpid/extensions/browser/session/BrowserSession",
) {}

export type BrowserSessionOptions = {
  readonly host: BrowserHostService;
  readonly storage: BrowserStorage;
  /** How long the browser may sit unused before it is closed. Defaults to `BROWSER_IDLE_MS`. */
  readonly idleMs?: number;
};

/** The later of the times, ignoring the ones there are none of. */
const latest = (...times: ReadonlyArray<number | undefined>): number | undefined => {
  const set = times.filter((time) => time !== undefined);

  return set.length === 0 ? undefined : Math.max(...set);
};

export const makeBrowserSession = ({
  host,
  storage,
  idleMs = BROWSER_IDLE_MS,
}: BrowserSessionOptions): BrowserSessionService => {
  const closeAt = Effect.sync(() => {
    const last = latest(storage.get<number>(LAST_USED_KEY), storage.get<number>(LAST_WATCHED_KEY));

    return last === undefined ? undefined : last + idleMs;
  });

  return {
    touch: Effect.map(Clock.currentTimeMillis, (now) => storage.put(LAST_USED_KEY, now)),
    watch: Effect.gen(function* () {
      const armed = (yield* closeAt) !== undefined;
      const now = yield* Clock.currentTimeMillis;
      const last = storage.get<number>(LAST_WATCHED_KEY);

      if (last === undefined || now - last >= WATCH_WRITE_MS) storage.put(LAST_WATCHED_KEY, now);

      return !armed;
    }),
    closeAt,
    closeIfIdle: Effect.gen(function* () {
      const at = yield* closeAt;

      if (at === undefined || (yield* Clock.currentTimeMillis) < at) return;

      // Forgotten first: a close that fails is not retried at every idle, and a use during it starts over.
      yield* Effect.sync(() => {
        storage.delete(LAST_USED_KEY);
        storage.delete(LAST_WATCHED_KEY);
      });
      yield* host.close.pipe(
        Effect.timeout(CLOSE_TIMEOUT),
        Effect.catch((error) => Effect.logWarning("Closing the browser failed", error)),
      );
    }),
  };
};

/** The Session's browser keep-alive over its storage, closing through `host`. */
export const browserSessionLayer = (options: BrowserSessionOptions) =>
  Layer.succeed(BrowserSession, makeBrowserSession(options));
