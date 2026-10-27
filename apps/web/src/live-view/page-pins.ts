// @effect-diagnostics globalTimers:off missingPipeableSignature:off -- a repaint waits for the browser's next animation frame; a constructor of a stream, not a combinator.

// Where the Browser Pane's pins go (#243; `docs/spec.md` → Browser → Annotate mode), as atoms (ADR-0011): the drafts'
// elements found again on the page shown, read at once, every `LOCATE_EVERY` while the Pane is in view, and
// `LOCATE_AFTER_MOVE` after the page last scrolled or resized; and a count of the screen's repaints, which move what is
// drawn over it.

import type { PageRect } from "@cloudpid/protocol";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Stream from "effect/Stream";
import { Located, locatedBySelector, locateScript, sameLocated } from "./page-annotations.ts";
import type { ScreenPage } from "./screen.ts";

/** How often the drafts' elements are found again while the page holds still. */
export const LOCATE_EVERY = Duration.seconds(1);

/** How soon after the page last scrolled or resized they are found again. */
export const LOCATE_AFTER_MOVE = Duration.millis(120);

/** Where each selector's element is in the viewport now, or null where the page has none. */
export type LocatedRects = ReadonlyMap<string, PageRect | null>;

/** The screen as the pins read it. */
export type LocatePage = Pick<ScreenPage, "evaluate" | "moved">;

/** Each time `page` scrolls or resizes. */
const movesOf = (page: LocatePage): Stream.Stream<void> =>
  Stream.callback<void>(
    (queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          page.moved(() => {
            Queue.offerUnsafe(queue, undefined);
          }),
        ),
        (stop) => Effect.sync(stop),
      ),
    { bufferSize: 1, strategy: "sliding" },
  );

/**
 * Where the elements of `selectors` are on the page at `url`: read at once, every `LOCATE_EVERY`, and `LOCATE_AFTER_MOVE`
 * after the page last moved, one read at a time; an answer is given only when it is of that page and says something
 * new. Only areas (no selectors): nothing to find.
 */
export const locatedRects = (
  page: LocatePage,
  selectors: readonly string[],
  url: string,
): Stream.Stream<LocatedRects> => {
  if (selectors.length === 0) return Stream.make(new Map());

  const read = Effect.promise(() => page.evaluate(locateScript(selectors), Located)).pipe(
    Effect.map((answer) =>
      answer === undefined ? undefined : locatedBySelector(selectors, answer, url),
    ),
  );

  return Stream.merge(
    Stream.tick(LOCATE_EVERY),
    movesOf(page).pipe(Stream.debounce(LOCATE_AFTER_MOVE)),
  ).pipe(
    // A read still running: the next waits for it, and asks once for all that came meanwhile.
    Stream.buffer({ capacity: 1, strategy: "sliding" }),
    Stream.mapEffect(() => read),
    Stream.filter((rects): rects is LocatedRects => rects !== undefined),
    Stream.changesWith(sameLocated),
  );
};

/** Which drafts' elements to find, on which screen and page, and whether the Pane is in view (out of it, none is). */
export interface LocateKey {
  readonly page: ScreenPage;
  readonly selectors: readonly string[];
  readonly url: string;
  readonly inView: boolean;
}

/** Where the elements of `key.selectors` are on its page now: undefined until the page answered for its URL. */
export const locatedAtom = Atom.family((key: LocateKey) => {
  const answers = Atom.make(
    key.inView ? locatedRects(key.page, key.selectors, key.url) : Stream.never,
  );

  return Atom.make((get): LocatedRects | undefined =>
    get(answers).pipe(AsyncResult.value, Option.getOrUndefined),
  );
});

/** How many times the screen of `page` was drawn again or sized anew, counted once per animation frame at most. */
export const repaintsAtom = Atom.family((page: ScreenPage) =>
  Atom.make((get): number => {
    let frame: number | null = null;
    let count = 0;

    const stop = page.painted(() => {
      if (frame !== null) return;

      frame = requestAnimationFrame(() => {
        frame = null;
        count += 1;
        get.setSelf(count);
      });
    });

    get.addFinalizer(() => {
      stop();

      if (frame !== null) cancelAnimationFrame(frame);
    });

    return count;
  }),
);
