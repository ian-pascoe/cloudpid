// @effect-diagnostics preferEffectArray:off -- the tree's rows and a message's siblings are short native arrays rendered as JSX lists.
// @effect-diagnostics missedPipeableOpportunity:off -- an Exit's failure is read once, where a pipe adds nothing.

// The Session tree in the page (GLOSSARY.md → Session tree, Fork, Clone): the bar under the owner's messages and the
// answers of the active branch (the chevrons between sibling branches, Branch, and Fork or Clone), the Session tree
// Pane, and the dialogs a move or a Fork in a new Workspace asks through.

import { ownBranchProblem, type SessionTree, type TreeNode } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  GitBranch,
  GitFork,
  Network,
} from "lucide-react";
import { createContext, use, type ReactNode } from "react";
import { pageProblemAtom } from "../app-state.ts";
import { useCall } from "../calls.ts";
import { Button } from "../components/ui/button.tsx";
import { Dialog } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { Menu, MenuItem } from "../components/ui/menu.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { cn } from "../lib/utils.ts";
import { panesAtom } from "../panes-state.ts";
import { TREE_PANE } from "../panes.ts";
import { exitFailure, messageOf } from "../registry.ts";
import { sessionStateAtom, sessionStatusAtom, sessionViewAtom } from "../session/atoms.ts";
import {
  branchThrough,
  siblingsOf,
  TREE_FILTERS,
  type TreeFilter,
  treeRows,
} from "../session/tree.ts";
import { useShownSessionId } from "./conversation.ts";
import {
  branchAtom,
  forkSessionAtom,
  pendingForkAtom,
  pendingMoveAtom,
  sessionTreeAtom,
  skipSummaryPromptAtom,
  switchBranchAtom,
  type TreePoint,
} from "./tree-state.ts";

/**
 * What the bar under a message may do, provided around the Session's own thread: null inside a subagent's thread,
 * which has no bar. An archived Session's bar only forks and clones.
 */
export const TreeBarScope = createContext<{ readonly archived: boolean } | null>(null);

const WHILE_BUSY = "Wait for the run to end, or stop it, to move to another branch.";

/** The Session tree as of its last answer, or null until it comes. */
const useTree = (sessionId: string): SessionTree | null =>
  useAtomValue(sessionTreeAtom(sessionId), (result) => AsyncResult.getOrElse(result, () => null));

/** Whether the active branch is busy: a Run in progress, so it cannot be left. */
const useBusy = (sessionId: string): boolean =>
  useAtomValue(sessionViewAtom(sessionId), (view) => view.running);

/** Show `failure` on the page, or clear what it shows. */
const useShowFailure = () => useAtomSet(pageProblemAtom);

/** Move the active branch to `point`, through the summary prompt unless the settings skip it. */
export const useMove = (): ((point: TreePoint) => void) => {
  const sessionId = useShownSessionId();
  const skip = useAtomValue(skipSummaryPromptAtom);
  const setPending = useAtomSet(pendingMoveAtom);
  const branch = useCall(branchAtom(sessionId));
  const show = useShowFailure();

  return (point) => {
    if (!skip) {
      setPending({ sessionId, ...point });

      return;
    }

    show(null);
    void branch(point).then((exit) => {
      show(exitFailure(exit));
    });
  };
};

/** Make a Fork from `point`, or a Clone without one, in this Workspace; or ask for the new Workspace's branch. */
export const useFork = (): ((point: TreePoint | undefined, newWorkspace: boolean) => void) => {
  const sessionId = useShownSessionId();
  const fork = useCall(forkSessionAtom);
  const setPending = useAtomSet(pendingForkAtom);
  const show = useShowFailure();

  return (point, newWorkspace) => {
    if (newWorkspace) {
      setPending({ source: sessionId, point });

      return;
    }

    show(null);
    void fork({ source: sessionId, point }).then((exit) => {
      show(exitFailure(exit));
    });
  };
};

/** The ‹ n/m › between a node's sibling branches: each lands on the branch through it that was active last. */
const Chevrons = ({ tree, id }: { tree: SessionTree; id: number }) => {
  const sessionId = useShownSessionId();
  const busy = useBusy(sessionId);
  const switchBranch = useCall(switchBranchAtom(sessionId));
  const show = useShowFailure();
  const place = siblingsOf(tree, id);

  if (place === undefined || place.siblings.length < 2) return null;

  const { siblings, index } = place;

  const go = (sibling: TreeNode | undefined) => {
    if (sibling === undefined) return;

    const conversationId = branchThrough(tree, sibling.id) ?? sibling.conversationId;

    show(null);
    void switchBranch(conversationId).then((exit) => {
      show(exitFailure(exit));
    });
  };

  const title = busy ? WHILE_BUSY : undefined;

  return (
    <span className="inline-flex items-center text-xs text-muted-foreground tabular-nums">
      <button
        type="button"
        aria-label="Previous branch"
        title={title ?? "Previous branch"}
        disabled={busy || index === 0}
        onClick={() => {
          go(siblings[index - 1]);
        }}
        className="touch-target inline-flex size-7 items-center justify-center rounded-md hover:bg-accent disabled:opacity-50"
      >
        <ChevronLeft className="size-3.5" aria-hidden />
      </button>
      <span aria-label={`Branch ${index + 1} of ${siblings.length}`}>
        {index + 1}/{siblings.length}
      </span>
      <button
        type="button"
        aria-label="Next branch"
        title={title ?? "Next branch"}
        disabled={busy || index === siblings.length - 1}
        onClick={() => {
          go(siblings[index + 1]);
        }}
        className="touch-target inline-flex size-7 items-center justify-center rounded-md hover:bg-accent disabled:opacity-50"
      >
        <ChevronRight className="size-3.5" aria-hidden />
      </button>
    </span>
  );
};

const barButton =
  "touch-target inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5";

/**
 * The bar under a message of the active branch: the chevrons when its branch has siblings, then Branch (to just before
 * an owner's message, or after an answer), and Fork, a new Session from the same point (Clone under the latest answer),
 * with a menu to make it in a new Workspace. Branch and Fork show on hover or focus with a fine pointer, always on a
 * touch screen.
 */
const Bar = ({ id, owner }: { id: number; owner: boolean }) => {
  const scope = use(TreeBarScope);
  const sessionId = useShownSessionId();
  const tree = useTree(sessionId);
  const busy = useBusy(sessionId);
  const live = useAtomValue(sessionStatusAtom(sessionId), (status) => status === "live");
  const move = useMove();
  const fork = useFork();

  if (scope === null || tree === null) return null;

  const node = tree.nodes.find((each) => each.id === id);

  // Only a message the tree shows as the owner's, or an answer that ends a Run.
  if (
    node === undefined ||
    (owner ? node.role !== "user" : node.role !== "assistant" || !node.final)
  ) {
    return null;
  }

  const latest = !owner && tree.leaf === id;
  const point: TreePoint = { entryId: id, position: owner ? "before" : "at" };
  const forkWord = latest ? "Clone" : "Fork";
  const forkPoint = latest ? undefined : point;
  const clone = forkPoint === undefined;
  const refusedWhileRunning = clone && busy;

  return (
    <div className={cn("flex items-center gap-1", owner ? "justify-end" : "justify-start")}>
      {owner && <Chevrons tree={tree} id={id} />}
      <span className="flex items-center gap-0.5 pointer-fine:opacity-0 pointer-fine:group-focus-within/message:opacity-100 pointer-fine:group-hover/message:opacity-100">
        {!scope.archived && !latest && (
          <button
            type="button"
            className={barButton}
            disabled={busy || !live}
            title={
              busy
                ? WHILE_BUSY
                : owner
                  ? "Branch: go back to before this message, with it in the composer"
                  : "Branch: continue from this answer"
            }
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
          disabled={refusedWhileRunning}
          title={
            refusedWhileRunning
              ? "Wait for the run to end, or stop it, to clone the session."
              : clone
                ? "Clone: a new session with this conversation, in this workspace"
                : owner
                  ? "Fork: a new session from before this message, in this workspace"
                  : "Fork: a new session through this answer, in this workspace"
          }
          onClick={() => {
            fork(forkPoint, false);
          }}
        >
          {clone ? <Copy aria-hidden /> : <GitFork aria-hidden />}
          {forkWord}
        </button>
        <Menu
          label={`More ways to ${forkWord.toLowerCase()}`}
          title={`More ways to ${forkWord.toLowerCase()}`}
          icon={<ChevronDown className="size-3.5" aria-hidden />}
          className="size-7"
        >
          <MenuItem
            disabled={busy}
            title={busy ? "Wait for the run to end, or stop it, to carry the files." : undefined}
            onSelect={() => {
              fork(forkPoint, true);
            }}
          >
            {clone ? <Copy aria-hidden /> : <GitFork aria-hidden />}
            {forkWord} in a new workspace…
          </MenuItem>
        </Menu>
      </span>
    </div>
  );
};

/** The bar under an owner's message: its id is its pi entry's. */
export const OwnerMessageBar = ({ messageId }: { messageId: string }) =>
  /^\d+$/u.test(messageId) ? <Bar id={Number(messageId)} owner /> : null;

/** The bar under an answer, given the entry it ended with. */
export const AnswerBar = ({ answer }: { answer: number | undefined }) =>
  answer === undefined ? null : <Bar id={answer} owner={false} />;

/** Chevrons on a notice that starts a branch (a branch summary), when its branch has siblings. */
export const NoticeChevrons = ({ messageId }: { messageId: string }) => {
  const scope = use(TreeBarScope);
  const sessionId = useShownSessionId();
  const tree = useTree(sessionId);

  if (scope === null || tree === null || !/^\d+$/u.test(messageId)) return null;

  return <Chevrons tree={tree} id={Number(messageId)} />;
};

/** The filter the Session tree Pane shows with. */
const PaneFilter = ScopedAtom.make(() => Atom.make<TreeFilter>("default"));

const RoleMark = ({ node }: { node: TreeNode }) => {
  switch (node.role) {
    case "user":
      return <span className="text-foreground">You</span>;
    case "assistant":
      return <span>{node.final ? "Answer" : "Agent"}</span>;
    case "tool":
      return <span>Tool</span>;
    case "input":
      return <span>Input</span>;
    case "notice":
      return <span>Notice</span>;
  }
};

const TreeList = () => {
  const sessionId = useShownSessionId();
  const result = useAtomValue(sessionTreeAtom(sessionId));
  const [filter, setFilter] = useAtom(PaneFilter.use());
  const busy = useBusy(sessionId);
  const move = useMove();
  const tree = AsyncResult.getOrElse(result, () => null);

  if (tree === null) {
    return AsyncResult.isFailure(result) ? (
      <p role="alert" className="text-sm text-destructive">
        {messageOf(result.cause)}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">Loading…</p>
    );
  }

  const rows = treeRows(tree, filter);

  return (
    <>
      <label className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
        Show
        <NativeSelect
          value={filter}
          onChange={(event) => {
            const picked = TREE_FILTERS.find((known) => known.value === event.target.value);

            if (picked !== undefined) setFilter(picked.value);
          }}
          className="h-8 text-xs"
        >
          {TREE_FILTERS.map((known) => (
            <option key={known.value} value={known.value}>
              {known.label}
            </option>
          ))}
        </NativeSelect>
      </label>
      {busy && <p className="mb-2 text-xs text-muted-foreground">{WHILE_BUSY}</p>}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet: send a message to start.</p>
      ) : (
        <ul aria-label="Session tree" className="flex flex-col">
          {rows.map(({ node, depth, active }) => {
            const leaf = node.id === tree.leaf;

            return (
              <li key={node.id} style={{ paddingLeft: `${depth * 0.75}rem` }}>
                <button
                  type="button"
                  disabled={busy}
                  aria-current={leaf ? "step" : undefined}
                  title={
                    node.role === "user"
                      ? "Go back to before this message, with it in the composer"
                      : "Continue from here"
                  }
                  onClick={() => {
                    move({ entryId: node.id, position: node.role === "user" ? "before" : "at" });
                  }}
                  className={cn(
                    "flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent disabled:pointer-events-none",
                    active ? "text-foreground" : "text-muted-foreground",
                    leaf && "bg-accent",
                  )}
                >
                  <span className="w-14 shrink-0 text-xs text-muted-foreground">
                    <RoleMark node={node} />
                  </span>
                  <span className={cn("min-w-0 flex-1 truncate", active && "font-medium")}>
                    {node.text === "" ? "…" : node.text}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
};

/**
 * The Session tree Pane: every Session branch's messages as a tree, the active branch's path in Ink and its last node
 * marked; picking a node moves the active branch there (just before an owner's message, which goes back in the
 * composer, or just after anything else).
 */
export const SessionTreePane = () => (
  <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
    <PaneFilter.Provider>
      <TreeList />
    </PaneFilter.Provider>
  </div>
);

/** The button that opens the Session tree Pane, and closes it when it is shown. */
export const TreePaneToggle = () => {
  const [{ shown }, act] = useAtom(panesAtom);
  const open = shown === TREE_PANE;

  return (
    <Button
      type="button"
      variant={open ? "default" : "outline"}
      size="sm"
      aria-pressed={open}
      aria-label="Session tree"
      title="Session tree"
      onClick={() => {
        act({ type: "toggle", key: TREE_PANE });
      }}
    >
      <Network />
    </Button>
  );
};

/** What the summary dialog's own form holds: the focus typed, once the owner asked to give one, and its run. */
const SummaryForm = ScopedAtom.make(() =>
  Atom.make<{
    readonly focus: string | null;
    readonly running: boolean;
    readonly failure: string | null;
  }>({ focus: null, running: false, failure: null }),
);

const SummaryChoices = ({ close }: { close: () => void }) => {
  const pending = useAtomValue(pendingMoveAtom);
  const [{ focus, running, failure }, setForm] = useAtom(SummaryForm.use());
  const branch = useCall(branchAtom(pending?.sessionId ?? ""));

  if (pending === null) return null;

  const setFocus = (next: string) => {
    setForm({ focus: next, running, failure });
  };

  const go = (summary: { readonly instructions?: string } | undefined) => {
    setForm({ focus, running: true, failure: null });
    void branch({ entryId: pending.entryId, position: pending.position, summary }).then((exit) => {
      const why = exitFailure(exit);

      setForm({ focus, running: false, failure: why });

      if (why === null) close();
    });
  };

  return (
    <>
      {focus !== null && (
        <label className="flex flex-col gap-1.5 text-sm">
          What the summary should keep
          <textarea
            autoFocus
            rows={3}
            value={focus}
            disabled={running}
            onChange={(event) => {
              setFocus(event.target.value);
            }}
            className="rounded-md border border-input bg-background px-2.5 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
          />
        </label>
      )}
      {failure !== null && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={running}
          onClick={() => {
            go(undefined);
          }}
        >
          No summary
        </Button>
        {focus === null ? (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={running}
              onClick={() => {
                setFocus("");
              }}
            >
              Summarize with a focus…
            </Button>
            <Button
              type="button"
              disabled={running}
              onClick={() => {
                go({});
              }}
            >
              {running ? "Summarizing…" : "Summarize"}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            disabled={running}
            onClick={() => {
              go(focus.trim() === "" ? {} : { instructions: focus.trim() });
            }}
          >
            {running ? "Summarizing…" : "Summarize"}
          </Button>
        )}
      </div>
    </>
  );
};

/** Asks whether to carry a summary of the branch left, for the move waiting in `pendingMoveAtom`. */
const SummaryDialog = () => {
  const [pending, setPending] = useAtom(pendingMoveAtom);

  const close = () => {
    setPending(null);
  };

  return (
    <Dialog
      open={pending !== null}
      onClose={close}
      title="Summarize the branch you leave?"
      description="A summary of what this branch did starts the branch you go to, so the agent keeps it in mind. It is a model request on this session's usage."
    >
      <SummaryForm.Provider>
        <SummaryChoices close={close} />
      </SummaryForm.Provider>
    </Dialog>
  );
};

/** What the new-workspace dialog's own form holds: the branch typed, and its run. */
const ForkForm = ScopedAtom.make(() =>
  Atom.make<{
    readonly branch: string;
    readonly running: boolean;
    readonly failure: string | null;
  }>({ branch: "", running: false, failure: null }),
);

const ForkFields = ({ close }: { close: () => void }) => {
  const pending = useAtomValue(pendingForkAtom);
  const [{ branch, running, failure }, setForm] = useAtom(ForkForm.use());
  const fork = useCall(forkSessionAtom);

  if (pending === null) return null;

  const problem = branch.trim() === "" ? undefined : ownBranchProblem(branch.trim());

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();

        if (problem !== undefined || running) return;

        setForm({ branch, running: true, failure: null });
        void fork({ ...pending, newWorkspace: true, branch }).then((exit) => {
          const why = exitFailure(exit);

          setForm({ branch, running: false, failure: why });

          if (why === null) close();
        });
      }}
    >
      <label className="flex flex-col gap-1.5 text-sm">
        Branch
        <Input
          autoFocus
          value={branch}
          placeholder="cloudpid/<workspace id>"
          spellCheck={false}
          aria-invalid={problem !== undefined}
          disabled={running}
          className="font-mono"
          onChange={(event) => {
            setForm({ branch: event.target.value, running, failure });
          }}
        />
      </label>
      {(problem ?? failure) !== null && (problem ?? failure) !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {problem ?? failure}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" disabled={running} onClick={close}>
          Cancel
        </Button>
        <Button type="submit" disabled={running || problem !== undefined}>
          {running ? "Carrying the files…" : pending.point === undefined ? "Clone" : "Fork"}
        </Button>
      </div>
    </form>
  );
};

/** Asks for the branch of a Fork or Clone's new Workspace, for the one waiting in `pendingForkAtom`. */
const ForkDialog = () => {
  const [pending, setPending] = useAtom(pendingForkAtom);
  const clone = pending?.point === undefined;

  return (
    <Dialog
      open={pending !== null}
      onClose={() => {
        setPending(null);
      }}
      title={clone ? "Clone in a new workspace" : "Fork in a new workspace"}
      description="The new workspace starts from this one's files as they are now, uncommitted changes included: each repo's HEAD is pushed to its remote as the new workspace's branch. Leave the branch empty for cloudpid/<workspace id>."
    >
      <ForkForm.Provider>
        <ForkFields
          close={() => {
            setPending(null);
          }}
        />
      </ForkForm.Provider>
    </Dialog>
  );
};

/** The dialogs of the Session tree: mounted once on the Session's page. */
export const TreeDialogs = (): ReactNode => (
  <>
    <SummaryDialog />
    <ForkDialog />
  </>
);

/** Whether the Session is still being copied from the one it is a Fork or Clone of. */
export const useCopying = (sessionId: string): boolean =>
  useAtomValue(sessionStateAtom(sessionId), (state) => state.copying);
