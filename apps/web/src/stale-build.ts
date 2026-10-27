// @effect-diagnostics missingPipeableSignature:off globalDate:off preferEffectArray:off -- plain functions over the page's events, storage, clock and DOM fields, not combinators.

// Recovering from a stale build: the one place that explains it, with `docs/spec.md` → UI → Serving and deploys. The main
// Worker keeps only the current build's files, so a tab left open across a deploy asks for chunks and stylesheets
// (`/assets/<name>-<hash>.js`) that are gone. Vite then fires `vite:preloadError` on `window`; the page reloads once to
// fetch the new build, unless a reload has just been made (it would loop) or the owner has typed something a reload
// would lose. Then the lazy part shows the notice with a Reload button (`lazy-view.tsx`).

/** Where the time of the last reload is kept: the tab's `sessionStorage`, which a reload keeps and a new tab starts without. */
const RELOAD_STAMP_KEY = "cloudpid:stale-build-reload";

/** A reload this soon after the last one is not made again: the build the first one fetched is the one that fails. */
export const RELOAD_GAP_MS = 60_000;

/** What the page does with a failed chunk: `reload` at once, or `ask` the owner to, where the part shows it. */
export type StaleBuildAction = "reload" | "ask";

/** The time `raw` (a stored stamp) holds, or null when there is none or it is not a time. */
export const parseStamp = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined) return null;

  const at = Number(raw);

  return raw.trim() !== "" && Number.isFinite(at) ? at : null;
};

/**
 * Whether to reload for a chunk that failed at `now`: not within `RELOAD_GAP_MS` after `lastReloadAt` (a clock that went
 * back counts as within it), and not while a field holds text that has not been sent.
 */
export const staleBuildAction = (input: {
  readonly lastReloadAt: number | null;
  readonly now: number;
  readonly unsentText: boolean;
}): StaleBuildAction => {
  if (input.unsentText) return "ask";

  if (input.lastReloadAt !== null && input.now - input.lastReloadAt < RELOAD_GAP_MS) return "ask";

  return "reload";
};

/** What the reload needs of the page: its events, its storage, its clock and its fields. A test supplies a fake. */
export interface StaleBuildPage {
  readonly now: () => number;
  /** The stamp kept by the last reload; may throw where `sessionStorage` is off. */
  readonly readStamp: () => string | null;
  /** Keeps the stamp; may throw where `sessionStorage` is off. */
  readonly writeStamp: (value: string) => void;
  /** Whether the page holds text or Attachments that are not sent: a text field with text, or a draft kept off screen. */
  readonly unsentText: () => boolean;
  readonly reload: () => void;
  /** Listens for Vite's `vite:preloadError`; returns the unlisten. */
  readonly onPreloadError: (
    listener: (event: { preventDefault: () => void }) => void,
  ) => () => void;
}

/** The page itself; `draftHeld` says whether the new-Session draft, which outlives its page, holds anything. */
export const browserPage = (draftHeld: () => boolean): StaleBuildPage => ({
  now: () => Date.now(),
  readStamp: () => window.sessionStorage.getItem(RELOAD_STAMP_KEY),
  writeStamp: (value) => {
    window.sessionStorage.setItem(RELOAD_STAMP_KEY, value);
  },
  unsentText: () =>
    Array.from(document.querySelectorAll("textarea")).some((field) => field.value.trim() !== "") ||
    draftHeld(),
  reload: () => {
    window.location.reload();
  },
  onPreloadError: (listener) => {
    window.addEventListener("vite:preloadError", listener);

    return () => {
      window.removeEventListener("vite:preloadError", listener);
    };
  },
});

/**
 * What the page does on `vite:preloadError`: reload and take the error over (`preventDefault`, so Vite does not throw
 * it), or leave it to throw into the lazy part's boundary. Where the stamp cannot be read or kept, the guard cannot
 * hold, so it never reloads.
 */
export const handlePreloadError =
  (page: StaleBuildPage) =>
  (event: { preventDefault: () => void }): StaleBuildAction => {
    try {
      const now = page.now();

      const action = staleBuildAction({
        lastReloadAt: parseStamp(page.readStamp()),
        now,
        unsentText: page.unsentText(),
      });

      if (action === "ask") return "ask";

      // The stamp goes first: a reload that cannot be recorded could repeat.
      page.writeStamp(String(now));
      event.preventDefault();
      page.reload();

      return "reload";
    } catch {
      return "ask";
    }
  };

/** Reloads the page, once in `RELOAD_GAP_MS`, when a chunk of an older build is gone. Returns the unlisten. */
export const installStaleBuildReload = (page: StaleBuildPage): (() => void) => {
  const handle = handlePreloadError(page);

  return page.onPreloadError((event) => {
    handle(event);
  });
};
