// @effect-diagnostics preferEffectArray:off -- a message's siblings and entries are short native arrays rendered as JSX lists.
// @effect-diagnostics missedPipeableOpportunity:off -- an Exit's failure is read once, where a pipe adds nothing.

// The Session tree in the transcript (GLOSSARY.md → Session tree, Fork, Clone): the chevrons on the first message of a
// Session branch that has siblings, and the bar under the owner's messages and the answers of the active branch
// (Branch, and Fork or Clone).

import type { SessionTree, TreeNode } from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDown, ChevronLeft, ChevronRight, GitBranch, GitFork, Split } from "lucide-react";
import { use } from "react";
import { useCall } from "../calls.ts";
import { Menu, MenuItem } from "../components/ui/menu.tsx";
import { cn } from "../lib/utils.ts";
import { exitFailure } from "../registry.ts";
import { sessionStatusAtom } from "../session/atoms.ts";
import {
  branchThrough,
  entryIdOf,
  isFinalAnswer,
  isOwnerNode,
  latestAnswer,
  pointOf,
  siblingsOf,
} from "../session/tree.ts";
import { useShownSessionId } from "./conversation.ts";
import {
  TreeBarScope,
  useBusy,
  useFork,
  useMove,
  useShowFailure,
  useTree,
  WHILE_BUSY,
} from "./tree-actions.ts";
import { forkingAtom, switchBranchAtom } from "./tree-state.ts";

const chevron =
  "touch-target inline-flex size-7 items-center justify-center rounded-md hover:bg-accent disabled:opacity-50";

/**
 * The ‹ n/m › between a node's sibling Session branches: each lands on the branch through it that was active last.
 * None in an archived Session, which only forks and clones.
 */
const Chevrons = ({ tree, id }: { tree: SessionTree; id: number }) => {
  const scope = use(TreeBarScope);
  const sessionId = useShownSessionId();
  const busy = useBusy(sessionId);
  const switchBranch = useCall(switchBranchAtom(sessionId));
  const show = useShowFailure();
  const place = siblingsOf(tree, id);

  if (scope === null || scope.archived || place === undefined || place.siblings.length < 2) {
    return null;
  }

  const { siblings, index } = place;

  const go = (sibling: TreeNode | undefined) => {
    if (sibling === undefined) return;

    const conversationId = branchThrough(tree, sibling.id) ?? sibling.conversationId;

    show(null);
    void switchBranch(conversationId).then((exit) => {
      show(exitFailure(exit));
    });
  };

  return (
    <span className="inline-flex items-center text-xs text-muted-foreground tabular-nums">
      <button
        type="button"
        aria-label="Previous session branch"
        title={busy ? WHILE_BUSY : "Previous session branch"}
        disabled={busy || index === 0}
        onClick={() => {
          go(siblings[index - 1]);
        }}
        className={chevron}
      >
        <ChevronLeft className="size-3.5" aria-hidden />
      </button>
      <span aria-label={`Session branch ${index + 1} of ${siblings.length}`}>
        {index + 1}/{siblings.length}
      </span>
      <button
        type="button"
        aria-label="Next session branch"
        title={busy ? WHILE_BUSY : "Next session branch"}
        disabled={busy || index === siblings.length - 1}
        onClick={() => {
          go(siblings[index + 1]);
        }}
        className={chevron}
      >
        <ChevronRight className="size-3.5" aria-hidden />
      </button>
    </span>
  );
};

/** The chevrons of each entry of `ids` (a message's, in order) that starts a Session branch with siblings. */
export const BranchChevrons = ({ ids }: { ids: readonly number[] }) => {
  const scope = use(TreeBarScope);
  const tree = useTree(useShownSessionId());

  if (scope === null || tree === null) return null;

  const starts = ids.filter((id) => (siblingsOf(tree, id)?.siblings.length ?? 0) > 1);

  return starts.length === 0 ? null : (
    <span className="flex items-center gap-1">
      {starts.map((id) => (
        <Chevrons key={id} tree={tree} id={id} />
      ))}
    </span>
  );
};

const barButton =
  "touch-target inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5";

/** What Branch says it does, or why it cannot. */
const branchTitle = (busy: boolean, owner: boolean, latest: boolean): string => {
  if (latest) return "The session already continues from this answer.";

  if (busy) return WHILE_BUSY;

  return owner
    ? "Branch: go back to before this message, with it in the composer"
    : "Branch: continue from this answer";
};

/** What Fork or Clone says it does, or why it cannot. */
const forkTitle = (refused: boolean, forking: boolean, clone: boolean, owner: boolean): string => {
  if (refused) return "Wait for the run to end, or stop it, to clone the session.";

  if (forking) return "Making the new session…";

  if (clone) return "Clone: a new session with this conversation, in this workspace";

  return owner
    ? "Fork: a new session from before this message, in this workspace"
    : "Fork: a new session through this answer, in this workspace";
};

/**
 * The bar under a message of the active branch: the chevrons when it starts a Session branch with siblings, then
 * Branch (to just before an owner's message, or after an answer) and Fork, a new Session from the same point (Clone
 * under the latest answer, where Branch has nowhere to go), with a menu to make it in a new Workspace. Branch and Fork
 * show on hover or focus with a fine pointer, always on a touch screen. An archived Session's bar only forks.
 */
const Bar = ({ node, tree }: { node: TreeNode; tree: SessionTree }) => {
  const scope = use(TreeBarScope);
  const sessionId = useShownSessionId();
  const busy = useBusy(sessionId);
  const live = useAtomValue(sessionStatusAtom(sessionId), (status) => status === "live");
  const forking = useAtomValue(forkingAtom(sessionId));
  const move = useMove();
  const fork = useFork();

  if (scope === null) return null;

  const owner = isOwnerNode(node);
  const latest = !owner && latestAnswer(tree) === node.id;
  const point = pointOf(node);
  const forkWord = latest ? "Clone" : "Fork";
  const forkPoint = latest ? undefined : point;
  const clone = forkPoint === undefined;
  const refusedWhileRunning = clone && busy;
  const ForkIcon = clone ? Split : GitFork;

  return (
    <div className={cn("flex items-center gap-1", owner ? "justify-end" : "justify-start")}>
      {owner && <Chevrons tree={tree} id={node.id} />}
      <span className="flex items-center gap-0.5 pointer-fine:opacity-0 pointer-fine:group-focus-within/message:opacity-100 pointer-fine:group-hover/message:opacity-100">
        {!scope.archived && (
          <button
            type="button"
            className={barButton}
            disabled={busy || !live || latest}
            title={branchTitle(busy, owner, latest)}
            onClick={() => {
              move(point);
            }}
          >
            <GitBranch aria-hidden />
            Branch
          </button>
        )}
        <button
          type="button"
          className={barButton}
          disabled={refusedWhileRunning || forking}
          title={forkTitle(refusedWhileRunning, forking, clone, owner)}
          onClick={() => {
            fork(forkPoint, false);
          }}
        >
          <ForkIcon aria-hidden />
          {forkWord}
        </button>
        <Menu
          label={`More ways to ${forkWord.toLowerCase()}`}
          title={`More ways to ${forkWord.toLowerCase()}`}
          icon={<ChevronDown className="size-3.5" aria-hidden />}
          className="size-7"
        >
          <MenuItem
            disabled={busy || forking}
            title={busy ? "Wait for the run to end, or stop it, to carry the files." : undefined}
            onSelect={() => {
              fork(forkPoint, true);
            }}
          >
            <ForkIcon aria-hidden />
            {forkWord} in a new workspace…
          </MenuItem>
        </Menu>
      </span>
    </div>
  );
};

/**
 * Under a user message, whose id is its pi entry's: the bar of an owner's message, or the chevrons of another input (a
 * subagent's report) that starts a Session branch.
 */
export const OwnerMessageBar = ({ messageId }: { messageId: string }) => {
  const tree = useTree(useShownSessionId());
  const id = entryIdOf(messageId);
  const node = id === undefined ? undefined : tree?.nodes.find((each) => each.id === id);

  if (tree === null || node === undefined) return null;

  return isOwnerNode(node) ? (
    <Bar node={node} tree={tree} />
  ) : (
    <div className="flex justify-end">
      <BranchChevrons ids={[node.id]} />
    </div>
  );
};

/** The bar under an answer, given the entry it ended with: only one that ends a Run has one. */
export const AnswerBar = ({ answer }: { answer: number | undefined }) => {
  const tree = useTree(useShownSessionId());
  const node = answer === undefined ? undefined : tree?.nodes.find((each) => each.id === answer);

  return tree === null || node === undefined || !isFinalAnswer(node) ? null : (
    <Bar node={node} tree={tree} />
  );
};
