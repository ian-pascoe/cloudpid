// What "Show changes" sums up (`show-changes.tsx`): the totals of the Last run's diff, asked of the Session while the
// link is shown.

import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type { ChangesTotals } from "../diff-pane/changes.ts";
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

/**
 * What the link shows, from its totals' ask: nothing (`hidden`) while they are asked for, or once the Session said the
 * Run's diff lists no file (nothing captured, or nothing changed in what was) or is another Run's; the totals when it
 * lists some; null ("Show changes") when the ask failed, as the Run may still have changed something.
 */
export const runLink = <E>(
  result: AsyncResult.AsyncResult<ChangesTotals | null, E>,
): ChangesTotals | null | "hidden" => {
  if (AsyncResult.isInitial(result)) return "hidden";

  if (!AsyncResult.isSuccess(result)) return null;

  return result.value === null || result.value.files === 0 ? "hidden" : result.value;
};
