// What the screen is, as atoms over CSS media queries.

import * as Atom from "effect/reactivity/Atom";

/** Whether media query `query` matches, as it changes; true without a window (a test that does not stub one). */
export const mediaQueryAtom = Atom.family((query: string) =>
  Atom.readable((get) => {
    if (!("window" in globalThis)) return true;

    const list = window.matchMedia(query);

    const changed = () => {
      get.setSelf(list.matches);
    };

    list.addEventListener("change", changed);
    get.addFinalizer(() => {
      list.removeEventListener("change", changed);
    });

    return list.matches;
  }),
);

/** Whether the screen is `md` (Tailwind's 48 rem) or wider: the Pane area is a column beside the chat there. */
export const mdScreenAtom = mediaQueryAtom("(min-width: 768px)");
