// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a test helper over a native list of history entries.

// A window whose history a test drives: `navigate`, `replaceSearch` and the back and forward buttons all reach
// `pathAtom` and `searchAtom`, over a real stack of entries, so a test can tell a push from a replace.

import { vi } from "vitest";

const ORIGIN = "https://example.test";

/** Stub `window` at `url` (a path and query); `vi.unstubAllGlobals()` removes it. */
export const stubWindow = (url: string) => {
  const entries = [new URL(url, ORIGIN)];
  let at = 0;

  const page = Object.assign(new EventTarget(), {
    location: {
      get pathname() {
        return entries[at]!.pathname;
      },
      get search() {
        return entries[at]!.search;
      },
    },
    history: {
      pushState: (_state: null, _title: string, to: string) => {
        entries.splice(at + 1, entries.length, new URL(to, ORIGIN));
        at += 1;
      },
      replaceState: (_state: null, _title: string, to: string) => {
        entries[at] = new URL(to, ORIGIN);
      },
    },
  });

  vi.stubGlobal("window", page);
  vi.stubGlobal("PopStateEvent", class extends Event {});

  const go = (to: number) => {
    at += to;
    page.dispatchEvent(new Event("popstate"));
  };

  return {
    /** The browser's back button; false when there is no earlier entry (it would leave the app). */
    back: (): boolean => {
      if (at === 0) return false;

      go(-1);

      return true;
    },
    forward: (): boolean => {
      if (at === entries.length - 1) return false;

      go(1);

      return true;
    },
    /** The path and query of every history entry, oldest first, and which one is current. */
    history: () => ({ entries: entries.map((entry) => entry.pathname + entry.search), at }),
  };
};
