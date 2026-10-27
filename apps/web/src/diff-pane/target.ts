// Where the Diff pane is asked to go when something opens it (`docs/spec.md` → Diffs and review → Diff pane): the Session
// details' totals and files, and a Call diff card's "Open in Diff pane". The Pane is one per page (the Session's, or a
// Subagent page's, each on its own Changes), so its key carries no file: the place is a request beside it, kept by the
// Changes' key, which the Pane takes once and clears.

import * as Atom from "effect/reactivity/Atom";
import { DIFF_PANE } from "../panes.ts";
import { panesAtom } from "../panes-state.ts";
import type { ConversationKey } from "../session/conversation-key.ts";

/** A place to show: a changed file by its ID (`changes.ts`), or the top for `null`; `at` tells two asks apart. */
export interface DiffTarget {
  readonly file: string | null;
  readonly at: number;
  /** The source to show it in: the Last run's ("Show changes"); absent, the Changes. */
  readonly source?: "run";
}

/** The place the Diff pane on the Changes `key` names is asked to show, until it has. */
export const diffTargetAtom = Atom.family((_key: ConversationKey) =>
  Atom.make<DiffTarget | null>(null).pipe(Atom.keepAlive),
);

let asks = 0;

/**
 * Open the page's Diff pane on the Changes `key` names (or show it where it is open) at a changed file, or at the top
 * for a `null` file, in the Changes or, for `source: "run"` ("Show changes"), in the Last run.
 */
export const openDiffPaneAtom = Atom.family((key: ConversationKey) =>
  Atom.writable(
    (get) => get(diffTargetAtom(key)),
    (ctx, where: Omit<DiffTarget, "at">) => {
      asks += 1;
      ctx.set(diffTargetAtom(key), { ...where, at: asks });
      ctx.set(panesAtom, { type: "open", key: DIFF_PANE });
    },
  ),
);
