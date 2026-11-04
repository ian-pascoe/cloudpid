// @effect-diagnostics missedPipeableOpportunity:off -- an Exit's failure is read once, where a pipe adds nothing.

// What the Session tree's parts of the page share (GLOSSARY.md → Session tree, Fork, Clone): the tree as the Session
// last sent it, whether the active branch can be left, and the moves and Forks the bar, the Pane, the dialogs and the
// Slash commands make.

import { callsDroppedBy } from "../app-view/branch.ts";
import { afterBranchTeardown } from "../app-view/teardown.ts";
import type { SessionTree, TreePoint } from "@cloudpid/protocol";
import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type * as Exit from "effect/Exit";
import { createContext, use } from "react";
import { pageProblemAtom } from "../app-state.ts";
import { useCall } from "../calls.ts";
import { exitFailure } from "../registry.ts";
import { appEntries } from "../session/apps.ts";
import { mcpAppsAtom, sessionStateAtom, sessionViewAtom } from "../session/atoms.ts";
import { keptByPoint } from "../session/tree.ts";
import { useShownSessionId } from "./conversation.ts";
import {
  forkingAtom,
  forkSessionAtom,
  navigateAtom,
  pendingForkAtom,
  pendingMoveAtom,
  sessionTreeAtom,
  skipSummaryPromptAtom,
} from "./tree-state.ts";

/**
 * What the bar under a message may do, provided around the Session's own thread: null inside a subagent's thread,
 * which has no bar. An archived Session's bar only forks and clones.
 */
export const TreeBarScope = createContext<{ readonly archived: boolean } | null>(null);

/** Why the active branch cannot be left now. */
export const WHILE_BUSY = "Wait for the run to end, or stop it, to move to another session branch.";

/** Why an archived Session's tree cannot be moved in. */
export const ARCHIVED = "Unarchive the session to move to another session branch.";

/** The Session tree as of its last answer, or null until it comes. */
export const useTree = (sessionId: string): SessionTree | null =>
  useAtomValue(sessionTreeAtom(sessionId), (result) => AsyncResult.getOrElse(result, () => null));

/**
 * Whether the active branch is busy, so it cannot be left: a Run in progress, or messages waiting to be placed. The
 * Session also refuses while a compaction runs, which a client does not see; it says why then.
 */
export const useBusy = (sessionId: string): boolean =>
  useAtomValue(sessionViewAtom(sessionId), (view) => view.running || view.inbox.length > 0);

/** Show `failure` on the page, or clear what it shows. */
export const useShowFailure = () => useAtomSet(pageProblemAtom);

/**
 * What a move of the active branch does about App Views: it unmounts the ones whose calls the branch does not hold, so it
 * first asks those to tear down and waits (`afterBranchTeardown`), and leaves the ones it keeps alone. `keep` names the
 * entries the branch will hold from the tree; with no tree yet it is not known what goes, so no View is asked and the move
 * is made as it is. `move` makes the move and `report` is told why it failed, or null when it worked: a failed move makes
 * the Views that were torn down again.
 */
export const useBranchMove = (
  sessionId: string,
): ((
  keep: (tree: SessionTree) => ReadonlySet<number>,
  move: () => Promise<Exit.Exit<unknown, unknown>>,
  report: (why: string | null) => void,
) => void) => {
  const registry = use(RegistryContext);

  return (keep, move, report) => {
    const tree = AsyncResult.getOrElse(registry.get(sessionTreeAtom(sessionId)), () => null);
    const view = registry.get(sessionViewAtom(sessionId));
    const apps = appEntries(registry.get(mcpAppsAtom(sessionId)));

    const dropped =
      tree === null
        ? new Set<string>()
        : callsDroppedBy([...view.earlier, ...view.messages], apps, keep(tree));

    afterBranchTeardown(dropped, () =>
      move().then((exit) => {
        const why = exitFailure(exit);

        report(why);

        return why === null;
      }),
    );
  };
};

/** Move the active branch to `point`, through the summary prompt unless the settings skip it. */
export const useMove = (): ((point: TreePoint) => void) => {
  const sessionId = useShownSessionId();
  const skip = useAtomValue(skipSummaryPromptAtom(sessionId));
  const setPending = useAtomSet(pendingMoveAtom);
  const navigate = useCall(navigateAtom(sessionId));
  const show = useShowFailure();
  const moveBranch = useBranchMove(sessionId);

  return (point) => {
    if (!skip) {
      setPending({ sessionId, point });

      return;
    }

    show(null);
    moveBranch(
      (tree) => keptByPoint(tree, point),
      () => navigate({ point }),
      show,
    );
  };
};

/** Make a Fork from `point`, or a Clone without one, in this Workspace; or ask for the new Workspace's branch. */
export const useFork = (): ((point: TreePoint | undefined, newWorkspace: boolean) => void) => {
  const sessionId = useShownSessionId();
  const fork = useCall(forkSessionAtom);
  const setPending = useAtomSet(pendingForkAtom);
  const [forking, setForking] = useAtom(forkingAtom(sessionId));
  const show = useShowFailure();

  return (point, newWorkspace) => {
    if (forking) return;

    if (newWorkspace) {
      setPending({ source: sessionId, point });

      return;
    }

    show(null);
    setForking(true);
    void fork({ source: sessionId, point }).then((exit) => {
      setForking(false);
      show(exitFailure(exit));
    });
  };
};

/** Whether the Session is still being filled from the one it is a Fork or Clone of. */
export const useFilling = (sessionId: string): boolean =>
  useAtomValue(sessionStateAtom(sessionId), (state) => state.copying);

/**
 * What the Session's page says of a Fork under way: this Session being filled from the one it was made from, or a Fork
 * or Clone of it being made, which the Registry answers once the new Session is filled.
 */
export const useForkNotice = (sessionId: string): string | undefined => {
  const filling = useFilling(sessionId);
  const forking = useAtomValue(forkingAtom(sessionId));

  if (filling) {
    return "Bringing over the conversation this session was forked or cloned from… It takes messages once that is done.";
  }

  if (forking) return "Making the new session from this one…";

  return undefined;
};
