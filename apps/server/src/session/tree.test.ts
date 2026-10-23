// @effect-diagnostics preferEffectArray:off preferEffectRecord:off asyncFunction:off -- plain fixtures.
import {
  EMPTY_SUBAGENTS_STATE,
  type SubagentsDoc,
  type SubagentsState,
} from "@cloudpid/extensions/subagents";
import type { ConversationId, EntryId, EntryRecord, Tx } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  abandonedEntries,
  activateBranch,
  type BranchEntries,
  buildSessionTree,
  EMPTY_TREE,
  planNavigation,
  type SessionTreeState,
  SessionTreeDoc,
} from "./tree.ts";

/** The parts of pi's shapes a fixture sets. */
type FixtureValue =
  | string
  | number
  | boolean
  | readonly FixtureValue[]
  | { readonly [key: string]: FixtureValue };

type Fixture = { readonly [key: string]: FixtureValue };

// SAFETY: a fixture holds only the fields the tree reads; the other fields of pi's types are never looked at.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const asEntry = (entry: Fixture): EntryRecord => entry as unknown as EntryRecord;

const user = (id: number, text = `message ${id}`) =>
  asEntry({ id, kind: "pi.user", model: [{ role: "user", content: text, timestamp: id }] });

const answer = (id: number, text = `answer ${id}`) =>
  asEntry({
    id,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        timestamp: id,
      },
    ],
  });

const calling = (id: number) =>
  asEntry({
    id,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: `call-${id}`, name: "bash", arguments: {} }],
        stopReason: "toolUse",
        timestamp: id,
      },
    ],
  });

const system = (id: number) => asEntry({ id, kind: "pi.system", model: [{ role: "system" }] });

// SAFETY: test conversation IDs, as pi-durable brands them.
const conversation = (id: number) => id as ConversationId;

// SAFETY: test entry IDs, as pi-durable brands them.
const entryId = (id: number) => id as EntryId;

/**
 * The root conversation: 1 (owner), 2 (answer), 3 (owner), 4 (answer); branch 5, forked from it at 2: 6 (owner), 7
 * (answer).
 */
const ROOT: BranchEntries = {
  id: conversation(1),
  entries: [user(1), answer(2), user(3), answer(4)],
};

const FORKED: BranchEntries = {
  id: conversation(5),
  parent: { conversationId: conversation(1), at: entryId(2) },
  entries: [user(6), answer(7)],
};

const state = (active: number, lastActive: Record<number, number> = {}): SessionTreeState => ({
  active,
  branches: Object.fromEntries(
    Object.entries(lastActive).map(([id, at]) => [id, { createdAt: 0, lastActiveAt: at }]),
  ),
});

describe("the Session tree a client shows", () => {
  it("links each entry to the one before it on its branch, a branch's first to where it was forked", () => {
    const tree = buildSessionTree([ROOT, FORKED], state(5, { 1: 10, 5: 20 }));

    expect(tree.nodes.map((node) => [node.id, node.parent, node.conversationId])).toEqual([
      [1, null, 1],
      [2, 1, 1],
      [3, 2, 1],
      [4, 3, 1],
      [6, 2, 5],
      [7, 6, 5],
    ]);
    expect(tree.active).toBe(5);
    expect(tree.leaf).toBe(7);
    expect(tree.branches).toEqual([
      { conversationId: 1, lastActiveAt: 10 },
      { conversationId: 5, lastActiveAt: 20 },
    ]);
  });

  it("says what each node is, and marks the answers that end a Run", () => {
    const tree = buildSessionTree([ROOT, FORKED], EMPTY_TREE);

    expect(tree.nodes[0]).toMatchObject({ role: "user", text: "message 1", final: false });
    expect(tree.nodes[1]).toMatchObject({ role: "assistant", text: "answer 2", final: true });

    const calls = buildSessionTree(
      [{ id: conversation(1), entries: [user(1), calling(2)] }],
      EMPTY_TREE,
    );

    expect(calls.nodes[1]).toMatchObject({ role: "assistant", text: "Calls bash", final: false });
  });

  it("leaves out what the transcript does not show, linking past it", () => {
    const tree = buildSessionTree(
      [{ id: conversation(1), entries: [system(1), user(2), system(3), answer(4)] }],
      EMPTY_TREE,
    );

    expect(tree.nodes.map((node) => [node.id, node.parent])).toEqual([
      [2, null],
      [4, 2],
    ]);
    expect(tree.leaf).toBe(4);
  });

  it("lists an empty branch only while it is the active one, its leaf where it was forked", () => {
    const empty: BranchEntries = {
      id: conversation(8),
      parent: { conversationId: conversation(1), at: entryId(2) },
      entries: [],
    };

    expect(buildSessionTree([ROOT, empty], state(1)).branches).toHaveLength(1);

    const active = buildSessionTree([ROOT, empty], state(8));

    expect(active.branches.map((branch) => branch.conversationId)).toEqual([1, 8]);
    expect(active.leaf).toBe(2);
  });
});

describe("planning where /tree goes", () => {
  it("forks the branch that holds the point, just before an owner's message", () => {
    expect(planNavigation([ROOT, FORKED], state(1), { entryId: 3, position: "before" })).toEqual({
      kind: "fork",
      from: 1,
      at: 2,
    });
  });

  it("makes a branch active when the point is its tip, the one active last of several", () => {
    expect(planNavigation([ROOT, FORKED], state(1), { entryId: 7, position: "at" })).toEqual({
      kind: "switch",
      conversationId: 5,
    });

    const again: BranchEntries = {
      id: conversation(9),
      parent: { conversationId: conversation(1), at: entryId(4) },
      entries: [],
    };

    expect(
      planNavigation([ROOT, FORKED, again], state(1, { 1: 30, 9: 10 }), {
        entryId: 4,
        position: "at",
      }),
    ).toEqual({
      kind: "switch",
      conversationId: 1,
    });
    expect(
      planNavigation([ROOT, FORKED, again], state(1, { 1: 10, 9: 30 }), {
        entryId: 4,
        position: "at",
      }),
    ).toEqual({
      kind: "switch",
      conversationId: 9,
    });
  });

  it("starts a branch of no entries before the Session's first message, or takes one made before", () => {
    expect(planNavigation([ROOT], state(1), { entryId: 1, position: "before" })).toEqual({
      kind: "fresh",
    });

    const fresh: BranchEntries = { id: conversation(8), entries: [] };

    expect(planNavigation([ROOT, fresh], state(1), { entryId: 1, position: "before" })).toEqual({
      kind: "switch",
      conversationId: 8,
    });
  });

  it("refuses a point before anything but an owner's message, and one not in the tree", () => {
    expect(planNavigation([ROOT], state(1), { entryId: 2, position: "before" })).toHaveProperty(
      "refused",
    );
    expect(planNavigation([ROOT], state(1), { entryId: 42, position: "at" })).toHaveProperty(
      "refused",
    );
  });
});

describe("what a branch summary covers", () => {
  it("is the branch left after the last entry it shares with the point", () => {
    const ids = (entries: ReadonlyArray<EntryRecord>) => entries.map((entry) => entry.id);

    expect(ids(abandonedEntries([ROOT, FORKED], conversation(5), 4))).toEqual([6, 7]);
    expect(ids(abandonedEntries([ROOT, FORKED], conversation(1), 2))).toEqual([3, 4]);
    expect(ids(abandonedEntries([ROOT, FORKED], conversation(1), null))).toEqual([1, 2, 3, 4]);
    expect(ids(abandonedEntries([ROOT, FORKED], conversation(1), 4))).toEqual([]);
  });
});

describe("making a branch active", () => {
  /** A commit over the two documents `activateBranch` writes. */
  const commit = () => {
    const tree: SessionTreeState = structuredClone(SessionTreeDoc.definition.initial());
    const subagents: SubagentsState = structuredClone(EMPTY_SUBAGENTS_STATE);

    // SAFETY: `activateBranch` reads only these two documents.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const tx = {
      doc: async (definition: typeof SessionTreeDoc | typeof SubagentsDoc) =>
        definition === SessionTreeDoc ? tree : subagents,
    } as unknown as Tx;

    return { tree, subagents, tx };
  };

  it("records when each branch was last active, and hands the root agent the branch", async () => {
    const { tree, subagents, tx } = commit();

    await activateBranch(tx, conversation(5), 100);

    expect(tree.active).toBe(5);
    expect(tree.branches).toEqual({
      1: { createdAt: 0, lastActiveAt: 100 },
      5: { createdAt: 100, lastActiveAt: 100 },
    });
    expect(subagents.activeBranch).toBe(5);
    expect(subagents.branches).toEqual([5]);

    await activateBranch(tx, conversation(1), 200);

    expect(tree.branches[5]?.lastActiveAt).toBe(200);
    expect(subagents.activeBranch).toBeUndefined();
    expect(subagents.branches).toEqual([5]);

    // A branch made before is not listed again.
    await activateBranch(tx, conversation(5), 300);

    expect(subagents.branches).toEqual([5]);
  });
});
