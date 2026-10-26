// When the owner comes back to a Session's page, its Changes are listed again (`docs/spec.md` → Diffs and review → Diff
// pane): the page shown again (`visibilitychange`), or the window focused again after it had really lost the focus. A
// focus that comes back from a frame of the page (the Live View, the Browser Pane) is not a return: the page had it all
// along. Returns within `RETURN_GAP` of the last refresh ask nothing more.
// @effect-diagnostics missingPipeableSignature:off -- a program over the page's events, not a combinator.

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/** Within this time of the last refresh, a return asks for none. */
export const RETURN_GAP = Duration.seconds(2);

/** What the program needs of the page: `window` and `document`, or a test's fake. */
export interface PageEvents {
  /** Listen to `type` on the window (`focus`, `blur`) or the document (`visibilitychange`); returns the unlisten. */
  readonly listen: (
    type: "focus" | "blur" | "visibilitychange",
    listener: () => void,
  ) => () => void;
  readonly visible: () => boolean;
  /** Whether the page has the focus, a frame of it included (`document.hasFocus`). */
  readonly hasFocus: () => boolean;
}

/** The page itself. */
export const browserPage: PageEvents = {
  listen: (type, listener) => {
    const target = type === "visibilitychange" ? document : window;

    target.addEventListener(type, listener);

    return () => {
      target.removeEventListener(type, listener);
    };
  },
  visible: () => document.visibilityState === "visible",
  hasFocus: () => document.hasFocus(),
};

/** Run `refresh` each time the owner comes back to the page, for as long as `Scope` is open. */
export const refreshOnReturn = (
  page: PageEvents,
  refresh: Effect.Effect<void>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>();
    const now = () => Effect.runSyncWith(services)(Clock.currentTimeMillis);
    const run = (effect: Effect.Effect<void>) => Effect.runForkWith(services)(effect);
    let last = Number.NEGATIVE_INFINITY;
    // The window lost the focus to another window or app, not to a frame of the page.
    let away = false;

    const back = () => {
      const at = now();

      if (at - last < Duration.toMillis(RETURN_GAP)) return;

      last = at;
      run(refresh);
    };

    const listeners: Array<() => void> = [];

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        listeners.push(
          page.listen("visibilitychange", () => {
            if (page.visible()) back();
          }),
          page.listen("blur", () => {
            // The focus has moved by the next task: into a frame of the page, or away from it.
            // @effect-diagnostics-next-line globalTimers:off -- the next task, once the focus has moved; not a delay.
            setTimeout(() => {
              away = !page.hasFocus();
            }, 0);
          }),
          page.listen("focus", () => {
            if (!away) return;

            away = false;
            back();
          }),
        );
      }),
      () =>
        Effect.sync(() => {
          for (const unlisten of listeners) unlisten();
        }),
    );
  });
