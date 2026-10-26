// Where the Diff pane is asked to go when something opens it (`docs/spec.md` → Diffs and review → Diff pane): the Session
// details' totals and files, and a Call diff card's "Open in Diff pane". The Pane is one per Session,
// so its key carries no file: the place is a request beside it, which the Pane takes once and clears.

import * as Atom from "effect/reactivity/Atom";
import { DIFF_PANE } from "../panes.ts";
import { panesAtom } from "../panes-state.ts";

/** A place to show: a changed file by its ID (`changes.ts`), or the top for `null`; `at` tells two asks apart. */
export interface DiffTarget {
  readonly file: string | null;
  readonly at: number;
}

/** The place Session `sessionId`'s Diff pane is asked to show, until it has. */
export const diffTargetAtom = Atom.family((_sessionId: string) =>
  Atom.make<DiffTarget | null>(null).pipe(Atom.keepAlive),
);

let asks = 0;

/** Open Session `sessionId`'s Diff pane (or show it where it is open) at a changed file, or at the top for `null`. */
export const openDiffPaneAtom = Atom.family((sessionId: string) =>
  Atom.writable(
    (get) => get(diffTargetAtom(sessionId)),
    (ctx, file: string | null) => {
      asks += 1;
      ctx.set(diffTargetAtom(sessionId), { file, at: asks });
      ctx.set(panesAtom, { type: "open", key: DIFF_PANE });
    },
  ),
);
