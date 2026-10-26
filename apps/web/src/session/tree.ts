// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over the tree's native arrays.

// The Session tree as the web app reads it (GLOSSARY.md → Session tree): the nodes the Session sends, as rows of the
// Session tree Pane under a filter, the siblings the chevrons step through, and the branch a sibling lands on.

import { pathFromRoot, type SessionTree, type TreeNode, type TreePoint } from "@cloudpid/protocol";

/** Whether `node` is a message the owner wrote. */
export const isOwnerNode = (node: TreeNode): boolean => node.role === "user";

/** Whether `node` is an answer that ends its Run. */
export const isFinalAnswer = (node: TreeNode): boolean => node.role === "assistant" && node.final;

/** The point of the Session tree a Fork from `node` carries up to: just before an owner's message, else through it. */
export const pointOf = (node: TreeNode): TreePoint => ({
  entryId: node.id,
  position: isOwnerNode(node) ? "before" : "at",
});

/** The filters of the Session tree Pane, in the order its menu lists them. */
export const TREE_FILTER_VALUES = ["default", "no-tools", "user-only", "all"] as const;

/** What the Session tree Pane shows: the owner's messages and the answers that end a Run, everything but tool results, the owner's messages, or all. */
export type TreeFilter = (typeof TREE_FILTER_VALUES)[number];

export const TREE_FILTERS: ReadonlyArray<{ readonly value: TreeFilter; readonly label: string }> = [
  { value: "default", label: "Messages and answers" },
  { value: "no-tools", label: "All but tool results" },
  { value: "user-only", label: "Your messages" },
  { value: "all", label: "Everything" },
];

/** Whether `filter` shows `node`. */
export const shows = (filter: TreeFilter, node: TreeNode): boolean => {
  switch (filter) {
    case "default":
      return isOwnerNode(node) || isFinalAnswer(node);
    case "no-tools":
      return node.role !== "tool";
    case "user-only":
      return isOwnerNode(node);
    case "all":
      return true;
  }
};

/** One row of the Session tree Pane: a node, how deep it sits, and whether it is on the active branch's path. */
export interface TreeRow {
  readonly node: TreeNode;
  readonly depth: number;
  readonly active: boolean;
}

/** The nodes of `tree` by ID. */
const byId = (tree: SessionTree): Map<number, TreeNode> =>
  new Map(tree.nodes.map((node) => [node.id, node]));

/** The IDs of the nodes on the path to `leaf`, the root's first. */
export const pathTo = (tree: SessionTree, leaf: number | null): ReadonlyArray<number> => {
  const nodes = byId(tree);

  return pathFromRoot(leaf, (id) => nodes.get(id)?.parent);
};

/**
 * The rows `filter` shows, depth first, older siblings first: a hidden node's children take its place, and the children
 * of a node with more than one sit one level deeper than it, as pi's tree view indents only where the tree branches.
 */
export const treeRows = (tree: SessionTree, filter: TreeFilter): TreeRow[] => {
  const active = new Set(pathTo(tree, tree.leaf));
  const children = new Map<number | null, TreeNode[]>();

  for (const node of tree.nodes) {
    const siblings = children.get(node.parent) ?? [];

    siblings.push(node);
    children.set(node.parent, siblings);
  }

  /** The shown nodes below `parent`, each with the depth it shows at. */
  const shownBelow = (parent: number | null): TreeNode[] =>
    (children.get(parent) ?? []).flatMap((node) =>
      shows(filter, node) ? [node] : shownBelow(node.id),
    );

  const rows: TreeRow[] = [];

  const visit = (node: TreeNode, depth: number) => {
    rows.push({ node, depth, active: active.has(node.id) });

    const next = shownBelow(node.id).toSorted((left, right) => left.id - right.id);
    const deeper = next.length > 1 ? depth + 1 : depth;

    for (const child of next) visit(child, deeper);
  };

  const roots = shownBelow(null).toSorted((left, right) => left.id - right.id);

  for (const root of roots) visit(root, roots.length > 1 ? 1 : 0);

  return rows;
};

/** Node `id`'s place among its siblings (the nodes with its parent, oldest first): its index, and how many there are. */
export const siblingsOf = (
  tree: SessionTree,
  id: number,
): { readonly siblings: readonly TreeNode[]; readonly index: number } | undefined => {
  const node = tree.nodes.find((each) => each.id === id);

  if (node === undefined) return undefined;

  const siblings = tree.nodes
    .filter((each) => each.parent === node.parent)
    .toSorted((left, right) => left.id - right.id);

  return { siblings, index: siblings.findIndex((each) => each.id === id) };
};

/**
 * The Session branch to make active to show node `id`: of the branches whose path goes through it, the one active
 * last. Undefined when none does.
 */
export const branchThrough = (tree: SessionTree, id: number): number | undefined => {
  let best: { readonly conversationId: number; readonly at: number } | undefined;

  for (const branch of tree.branches) {
    const own = tree.nodes.filter((node) => node.conversationId === branch.conversationId);
    const tip = own.at(-1)?.id ?? null;

    if (!pathTo(tree, tip).includes(id)) continue;

    if (best === undefined || branch.lastActiveAt > best.at) {
      best = { conversationId: branch.conversationId, at: branch.lastActiveAt };
    }
  }

  return best?.conversationId;
};

/** The pi entry ID a transcript message's ID names, or undefined for a message of no entry (one being streamed). */
export const entryIdOf = (messageId: string): number | undefined =>
  /^\d+$/u.test(messageId) ? Number(messageId) : undefined;

/**
 * The answer the active branch ends with, past any notices after it: the one whose bar offers Clone rather than Fork.
 * Undefined when the branch ends otherwise, as with an owner's message still waiting for its answer.
 */
export const latestAnswer = (tree: SessionTree): number | undefined => {
  const nodes = byId(tree);

  const last = pathTo(tree, tree.leaf)
    .map((id) => nodes.get(id))
    .findLast((node) => node !== undefined && node.role !== "notice");

  return last !== undefined && isFinalAnswer(last) ? last.id : undefined;
};

/** The owner's messages on the active branch's path, oldest first: what `/fork` picks from. */
export const ownerMessages = (tree: SessionTree): TreeNode[] => {
  const nodes = byId(tree);

  return pathTo(tree, tree.leaf).flatMap((id) => {
    const node = nodes.get(id);

    return node !== undefined && isOwnerNode(node) ? [node] : [];
  });
};
