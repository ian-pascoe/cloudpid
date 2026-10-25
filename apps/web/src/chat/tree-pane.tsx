// @effect-diagnostics preferEffectArray:off -- the tree's rows are a short native array rendered as a JSX list.

// The Session tree Pane (GLOSSARY.md → Session tree): every Session branch's messages as a tree under a filter.

import type { TreeNode } from "@cloudpid/protocol";
import { useAtom, useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { use } from "react";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { cn } from "../lib/utils.ts";
import { messageOf } from "../registry.ts";
import { isOwnerNode, pointOf, TREE_FILTERS, type TreeFilter, treeRows } from "../session/tree.ts";
import { useShownSessionId } from "./conversation.ts";
import { ARCHIVED, TreeBarScope, useBusy, useMove, WHILE_BUSY } from "./tree-actions.ts";
import { sessionTreeAtom } from "./tree-state.ts";

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
  const archived = use(TreeBarScope)?.archived === true;
  const busy = useBusy(sessionId) || archived;
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
      {busy && (
        <p className="mb-2 text-xs text-muted-foreground">{archived ? ARCHIVED : WHILE_BUSY}</p>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet: send a message to start.</p>
      ) : (
        <ul aria-label="Session tree" className="flex flex-col">
          {rows.map(({ node, depth, active }) => {
            const leaf = node.id === tree.leaf;
            const point = pointOf(node);

            return (
              <li key={node.id} style={{ paddingLeft: `${depth * 0.75}rem` }}>
                <button
                  type="button"
                  disabled={busy}
                  aria-current={leaf ? "step" : undefined}
                  title={
                    isOwnerNode(node)
                      ? "Go back to before this message, with it in the composer"
                      : "Continue from here"
                  }
                  onClick={() => {
                    // Just after the last node is where the active branch already is.
                    if (leaf && point.position === "at") return;

                    move(point);
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
