// What "Show changes" sums up (`show-changes.tsx`): the totals of the Last run's diff, asked of the Session while the
// link is shown.

import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import { runTotals } from "../diff-pane/last-run.ts";
import { appRuntime } from "../runtime.ts";
import { sessionClientAtom } from "../session/atoms.ts";

/** A Run of a Session, as the link's totals are kept. */
export interface RunKey {
  readonly sessionId: string;
  readonly run: string;
}

/**
 * The totals of Run `run`'s diff, asked of Session `sessionId` once while its link is shown: the link is drawn only once
 * the Run ended, when the Session keeps its list, so the ask reads that list and never starts the Container. Null when
 * the answer is of another Run (a newer one took its place).
 */
export const runTotalsAtom = Atom.family(({ sessionId, run }: RunKey) =>
  appRuntime.atom((get) =>
    Effect.gen(function* () {
      const client = yield* get.result(sessionClientAtom(sessionId));

      return runTotals(run, yield* client.runDiff);
    }),
  ),
);
