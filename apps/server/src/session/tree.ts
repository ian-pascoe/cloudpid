// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off asyncFunction:off -- plain functions over pi-durable's records, called from commit callbacks.
// The Session tree (GLOSSARY.md → Session tree, ADR-0017). pi-durable has no tree of entries inside a conversation: each
// Session branch is a conversation of the Session's own, the root conversation or an ownerless fork of one at an
// entry, and the Session keeps which one is the active branch. Entry IDs are Session-wide and only grow, and a fork
// sees its parent's entries up to the entry it was made at, so the branches' own entries, each linked to the one before
// it (a branch's first to the entry it was forked at), make up pi's tree of entries.
import { isSessionBranch, SubagentsDoc } from "@cloudpid/extensions/subagents";
import {
  type ConversationId,
  type SessionTree,
  type TreeBranch,
  type TreeNode,
  type TreeNodeRole,
  type TreePoint,
  pathFromRoot,
  projectEntry,
  USER_ENTRY_KIND,
  userEntryData,
} from "@cloudpid/protocol";
import {
  defineDoc,
  type EntryId,
  type EntryRecord,
  ROOT_CONVERSATION_ID,
  type ConversationId as PiConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import { contentText, textsOf } from "./text.ts";

/** The Session's branches as it keeps them: the active one, and when each was last the active one. */
export type SessionTreeState = {
  active: number;
  branches: Record<string, { createdAt: number; lastActiveAt: number }>;
};

export const SessionTreeDoc = defineDoc<SessionTreeState>({
  kind: "cloudpid.session-tree",
  version: 1,
  scope: "session",
  initial: () => ({ active: ROOT_CONVERSATION_ID, branches: {} }),
  checkpointWhen: () => false,
});

/** The state as read outside a commit: the root conversation active, until the first branch. */
export const EMPTY_TREE: SessionTreeState = SessionTreeDoc.definition.initial();

/** The entry kind of a branch summary, placed at the start of the branch entered. */
export const BRANCH_SUMMARY_KIND = "cloudpid.branch-summary";

/** The longest a node's text is, in characters. */
export const NODE_TEXT_LIMIT = 200;

/** One Session branch with its own entries, oldest first: those after the entry it was forked at. */
export type BranchEntries = {
  readonly id: PiConversationId;
  /** Where it was forked from; absent for the root conversation and for a branch started before the first entry. */
  readonly parent?: { readonly conversationId: PiConversationId; readonly at: EntryId };
  readonly entries: ReadonlyArray<EntryRecord>;
};

/**
 * Make `conversationId` the active branch, in the same commit as the change that made it, if any: the previous one was
 * active until `now`. The subagents follow it: the root agent runs it, and a new branch is the root agent's too.
 */
export const activateBranch = async (
  tx: Tx,
  conversationId: PiConversationId,
  now: number,
): Promise<void> => {
  const tree = await tx.doc(SessionTreeDoc);
  const previous = tree.branches[String(tree.active)];

  if (previous === undefined)
    tree.branches[String(tree.active)] = { createdAt: 0, lastActiveAt: now };
  else previous.lastActiveAt = now;

  const current = tree.branches[String(conversationId)];

  if (current === undefined)
    tree.branches[String(conversationId)] = { createdAt: now, lastActiveAt: now };
  else current.lastActiveAt = now;

  tree.active = conversationId;

  const subagents = await tx.doc(SubagentsDoc);

  if (conversationId === ROOT_CONVERSATION_ID) delete subagents.activeBranch;
  else subagents.activeBranch = conversationId;

  if (!isSessionBranch(subagents, conversationId)) {
    subagents.branches = [...(subagents.branches ?? []), conversationId];
  }
};

/** The Session branches' conversations: the root's first, then each branch made since, oldest first. */
export const branchIds = (state: SessionTreeState): PiConversationId[] => {
  const ids = new Set<number>([ROOT_CONVERSATION_ID]);

  for (const key of Object.keys(state.branches)) ids.add(Number(key));

  // SAFETY: the keys are conversation IDs `activateBranch` wrote.
  return [...ids].sort((left, right) => left - right) as PiConversationId[];
};

/** `text` on one line, cut to `NODE_TEXT_LIMIT` characters. */
const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/gu, " ").trim();

  return flat.length <= NODE_TEXT_LIMIT ? flat : `${flat.slice(0, NODE_TEXT_LIMIT - 1)}…`;
};

/** Whether `entry` is a message the owner wrote: one they submitted, as typed or expanded. */
export const isOwnerMessage = (entry: EntryRecord): boolean =>
  entry.kind === "pi.user" || entry.kind === USER_ENTRY_KIND;

/** What the owner typed in message `entry`: the text before any expansion, its text parts joined. */
export const ownerMessageText = (entry: EntryRecord): string => {
  const data = userEntryData(entry);

  if (data !== undefined) return data.display;

  const message = entry.model?.[0];

  if (message?.role !== "user") return "";

  return contentText(message.content);
};

/** What the tree shows of `entry`, or nothing for one the transcript does not show. */
export const nodeOf = (
  entry: EntryRecord,
): Pick<TreeNode, "role" | "text" | "final" | "timestamp"> | undefined => {
  const message = projectEntry(entry);

  if (message === undefined || (message.role === "notice" && message.title === undefined)) {
    return undefined;
  }

  const texts = textsOf(message.parts);
  const calls = message.parts.flatMap((part) => (part.type === "tool-call" ? [part.name] : []));

  switch (message.role) {
    case "user": {
      const role: TreeNodeRole = isOwnerMessage(entry) ? "user" : "input";

      return { role, text: oneLine(texts.join(" ")), final: false, timestamp: message.timestamp };
    }

    case "assistant": {
      const final = calls.length === 0 && message.stopReason !== "toolUse";
      const said = oneLine(texts.join(" "));

      return {
        role: "assistant",
        text: said === "" && calls.length > 0 ? oneLine(`Calls ${calls.join(", ")}`) : said,
        final,
        timestamp: message.timestamp,
      };
    }

    case "tool": {
      const result = message.parts[0];
      const name = result?.type === "tool-result" ? result.name : "tool";

      const output = result?.type === "tool-result" ? textsOf(result.content).join(" ") : "";

      return {
        role: "tool",
        text: oneLine(`${name}: ${output}`),
        final: false,
        timestamp: message.timestamp,
      };
    }

    case "notice":
      return {
        role: "notice",
        text: oneLine(message.title ?? ""),
        final: false,
        timestamp: message.timestamp,
      };
  }
};

/** The entry before each entry of `branches` in its branch (null before a branch's first), by entry ID. */
export const entryParents = (
  branches: ReadonlyArray<BranchEntries>,
): Map<number, number | null> => {
  const parents = new Map<number, number | null>();

  for (const branch of branches) {
    let previous: number | null = branch.parent?.at ?? null;

    for (const entry of branch.entries) {
      parents.set(entry.id, previous);
      previous = entry.id;
    }
  }

  return parents;
};

/** The last entry of `branch`'s path: its own last entry, else the entry it was forked at. */
export const tipOf = (branch: BranchEntries): number | null =>
  branch.entries.at(-1)?.id ?? branch.parent?.at ?? null;

/** The Session tree a client shows, from the branches' own entries and the state the Session keeps. */
export const buildSessionTree = (
  branches: ReadonlyArray<BranchEntries>,
  state: SessionTreeState,
): SessionTree => {
  const parents = entryParents(branches);
  const shown = new Set<number>();
  const nodes: Array<{ -readonly [K in keyof TreeNode]: TreeNode[K] }> = [];

  for (const branch of branches) {
    for (const entry of branch.entries) {
      const node = nodeOf(entry);

      if (node === undefined) continue;

      shown.add(entry.id);
      nodes.push({
        id: entry.id,
        parent: null,
        conversationId: branch.id,
        ...node,
      });
    }
  }

  /** The nearest shown entry at or before `id` on its path. */
  const shownAtOrBefore = (id: number | null): number | null => {
    let at = id;

    while (at !== null && !shown.has(at)) at = parents.get(at) ?? null;

    return at;
  };

  for (const node of nodes) node.parent = shownAtOrBefore(parents.get(node.id) ?? null);

  nodes.sort((left, right) => left.id - right.id);

  const active = branches.find((branch) => branch.id === state.active);

  const listed: TreeBranch[] = branches.flatMap((branch) =>
    branch.entries.length > 0 || branch.id === state.active
      ? [
          {
            conversationId: branch.id,
            lastActiveAt: state.branches[String(branch.id)]?.lastActiveAt ?? 0,
          },
        ]
      : [],
  );

  return {
    nodes,
    // SAFETY: a pi-durable conversation ID, as the protocol brands it.
    active: state.active as ConversationId,
    leaf: active === undefined ? null : shownAtOrBefore(tipOf(active)),
    branches: listed,
  };
};

/** Where `/tree` goes, as the Session's branches stand. */
export type NavigationPlan =
  /** The point is the tip of a branch (or an empty branch was made there before): make it active. */
  | { readonly kind: "switch"; readonly conversationId: PiConversationId }
  /** Fork `from` at `at`, the point. */
  | { readonly kind: "fork"; readonly from: PiConversationId; readonly at: EntryId }
  /** Before the Session's very first message: a branch of no entries. */
  | { readonly kind: "fresh" };

/** Why a point cannot be navigated to. */
export type NavigationRefusal = { readonly refused: string };

/**
 * Where navigating to `point` goes: just `before` its entry (an owner's message) or just after it (`at`). An existing
 * branch's tip is made active rather than forked again, preferring the one active last; an empty branch already made
 * at the point is taken again.
 */
export const planNavigation = (
  branches: ReadonlyArray<BranchEntries>,
  state: SessionTreeState,
  { entryId, position }: TreePoint,
): NavigationPlan | NavigationRefusal => {
  const owner = branches.find((branch) => branch.entries.some((entry) => entry.id === entryId));
  const entry = owner?.entries.find((each) => each.id === entryId);

  if (owner === undefined || entry === undefined) {
    return { refused: `Entry ${entryId} is not in the Session tree.` };
  }

  if (position === "before" && !isOwnerMessage(entry)) {
    return { refused: "Only an owner's message has a point just before it to move to." };
  }

  const point = position === "at" ? entryId : (entryParents(branches).get(entryId) ?? null);

  const lastActive = (candidates: ReadonlyArray<BranchEntries>): PiConversationId | undefined =>
    candidates
      .map((branch) => ({
        id: branch.id,
        at: state.branches[String(branch.id)]?.lastActiveAt ?? 0,
      }))
      .sort((left, right) => right.at - left.at)[0]?.id;

  const tips = branches.filter((branch) => tipOf(branch) === point);
  const found = lastActive(tips);

  if (found !== undefined) return { kind: "switch", conversationId: found };

  if (point === null) return { kind: "fresh" };

  const from = branches.find((branch) => branch.entries.some((each) => each.id === point));

  return from === undefined
    ? { refused: `Entry ${point} is not in the Session tree.` }
    : // SAFETY: an entry ID of the Session's own.
      { kind: "fork", from: from.id, at: point as EntryId };
};

/**
 * The entries of the branch being left that the branch entered does not share: those of `from`'s path after the last
 * entry the two paths have in common, oldest first (pi's `collectEntriesForBranchSummary`).
 */
export const abandonedEntries = (
  branches: ReadonlyArray<BranchEntries>,
  from: PiConversationId,
  to: number | null,
): EntryRecord[] => {
  const parents = entryParents(branches);
  const byId = new Map<number, EntryRecord>();

  for (const branch of branches) for (const entry of branch.entries) byId.set(entry.id, entry);

  const pathTo = (id: number | null): ReadonlyArray<number> =>
    pathFromRoot(id, (at) => parents.get(at));

  const left = branches.find((branch) => branch.id === from);

  if (left === undefined) return [];

  const kept = new Set(pathTo(to));

  return pathTo(tipOf(left)).flatMap((id) => {
    const entry = byId.get(id);

    return kept.has(id) || entry === undefined ? [] : [entry];
  });
};
