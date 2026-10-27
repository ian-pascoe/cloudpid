// "Show changes" under the final answer of the Session's latest writing Run (`docs/spec.md` → Diffs and review → Run
// diff): what the Run changed, summed up as the Session details sum up the Changes ("1 file +13 −0"), which opens the
// Diff pane on the Last run. Only that one answer has it: not an older Run's, not while the Run is live, and not a Run
// that changed no file (a `bash` call that only read). Only on the Session's page: the Runs are the Session's, and a
// Subagent page's Diff pane shows another Workspace's Changes.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- reads a derived atom; no combinators.

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { FileDiff, PanelRightOpen } from "lucide-react";
import { filesLabel, totalsText } from "../diff-pane/changes.ts";
import { runAnswerId } from "../diff-pane/last-run.ts";
import { DiffTally } from "../diff-pane/parts.tsx";
import { openDiffPaneAtom } from "../diff-pane/target.ts";
import { lastRunAtom, sessionViewAtom } from "../session/atoms.ts";
import { useShownChanges, useShownSessionId, useShownSubagent } from "./conversation.ts";
import { runTotalsAtom } from "./show-changes-state.ts";

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

/**
 * The link under `answer` (the entry its turn ended with), if that is the Last run's final answer: the Run's files and
 * lines once the Session has said them, "Show changes" until then, or when it could not, or no repo was captured.
 */
export const ShowChanges = ({ answer }: { answer: number | undefined }) => {
  const sessionId = useShownSessionId();
  const final = useAtomValue(runAnswerAtom(sessionId));
  const run = useAtomValue(lastRunAtom(sessionId));
  const onSubagentPage = useShownSubagent() !== undefined;

  if (onSubagentPage || answer === undefined || final !== answer || run === null) return null;

  return <RunSummary sessionId={sessionId} run={run.run} />;
};

/** Run `run`'s summary, which opens the Diff pane on it. */
const RunSummary = ({ sessionId, run }: { sessionId: string; run: string }) => {
  const open = useAtomSet(openDiffPaneAtom(useShownChanges()));
  const result = useAtomValue(runTotalsAtom({ sessionId, run }));
  const totals = AsyncResult.isSuccess(result) ? result.value : null;
  const summed = totals !== null && totals.files > 0;

  return (
    <button
      type="button"
      onClick={() => {
        open({ file: null, source: "run" });
      }}
      aria-label={summed ? `Show changes: ${totalsText(totals)}` : undefined}
      title="Show the changes in the Diff pane"
      className="touch-target mt-2 inline-flex max-w-full items-center gap-2 rounded-md border px-2 py-1 text-sm hover:bg-accent [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
    >
      <FileDiff aria-hidden />
      {summed ? (
        <>
          <span className="font-medium">{filesLabel(totals.files)}</span>
          <DiffTally counts={totals} approximate={totals.approximate} />
        </>
      ) : (
        <span className="font-medium">Show changes</span>
      )}
      <PanelRightOpen aria-hidden />
    </button>
  );
};
