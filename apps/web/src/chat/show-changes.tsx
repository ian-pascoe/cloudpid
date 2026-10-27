// "Show changes" under the final answer of the Session's latest writing Run (`docs/spec.md` → Diffs and review → Run
// diff): it opens the Diff pane on the Last run. Only that one answer has it: not an older Run's, not while the Run is
// live, and not a Run that changed no file (a `bash` call that only read). Only on the Session's page: the Runs are the
// Session's, and a Subagent page's Diff pane shows another Workspace's Changes.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- reads a derived atom; no combinators.

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/reactivity/Atom";
import { runAnswerId } from "../diff-pane/last-run.ts";
import { openDiffPaneAtom } from "../diff-pane/target.ts";
import { lastRunAtom, sessionViewAtom } from "../session/atoms.ts";
import { useShownChanges, useShownSessionId, useShownSubagent } from "./conversation.ts";

/**
 * The entry the Last run's final answer is, in the transcript the Session's page shows: undefined while the Run is live,
 * when it changed nothing, or when its answer is not among the messages loaded. The view is read only when there is a Run
 * with something to show.
 */
const runAnswerAtom = Atom.family((sessionId: string) =>
  Atom.make((get): number | undefined => {
    const run = get(lastRunAtom(sessionId));

    if (run === null || run.until === null || run.empty === true) return undefined;

    const view = get(sessionViewAtom(sessionId));

    return runAnswerId(run, [...view.earlier, ...view.messages]);
  }),
);

/** The link under `answer` (the entry its turn ended with), if that is the Last run's final answer. */
export const ShowChanges = ({ answer }: { answer: number | undefined }) => {
  const sessionId = useShownSessionId();
  const final = useAtomValue(runAnswerAtom(sessionId));
  const open = useAtomSet(openDiffPaneAtom(useShownChanges()));
  const onSubagentPage = useShownSubagent() !== undefined;

  if (onSubagentPage || answer === undefined || final !== answer) return null;

  return (
    <button
      type="button"
      onClick={() => {
        open({ file: null, source: "run" });
      }}
      className="touch-target mt-1 rounded px-1 py-0.5 text-sm font-medium text-foreground underline hover:bg-accent"
    >
      Show changes
    </button>
  );
};
