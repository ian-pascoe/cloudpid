// @effect-diagnostics preferEffectArray:off -- test code over native arrays.
import type { SessionTree, TreeNode } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { branchThrough, ownerMessages, pathTo, shows, siblingsOf, treeRows } from "./tree.ts";

const node = (
  id: number,
  parent: number | null,
  conversationId: number,
  role: TreeNode["role"],
  final = false,
): TreeNode => ({
  id,
  parent,
  // SAFETY: test IDs; the brand is for the type system only.
  conversationId: conversationId as TreeNode["conversationId"],
  role,
  text: `${role} ${id}`,
  final,
  timestamp: id,
});

/**
 * Branch 1 asks, works with a tool, answers, and goes on; branch 7 forks after the first answer and is active:
 *
 *     1 user ─ 2 assistant ─ 3 tool ─ 4 answer ┬ 5 user ─ 6 answer      (branch 1)
 *                                              └ 8 user ─ 9 answer      (branch 7)
 */
const tree: SessionTree = {
  nodes: [
    node(1, null, 1, "user"),
    node(2, 1, 1, "assistant"),
    node(3, 2, 1, "tool"),
    node(4, 3, 1, "assistant", true),
    node(5, 4, 1, "user"),
    node(6, 5, 1, "assistant", true),
    node(8, 4, 7, "user"),
    node(9, 8, 7, "assistant", true),
  ],
  // SAFETY: test IDs; the brand is for the type system only.
  active: 7 as SessionTree["active"],
  leaf: 9,
  branches: [
    // SAFETY: test IDs; the brand is for the type system only.
    { conversationId: 1 as SessionTree["active"], lastActiveAt: 100 },
    // SAFETY: test IDs; the brand is for the type system only.
    { conversationId: 7 as SessionTree["active"], lastActiveAt: 200 },
  ],
};

describe("the Session tree's filters", () => {
  it("shows the owner's messages, notices and final answers by default", () => {
    expect(shows("default", node(1, null, 1, "user"))).toBe(true);
    expect(shows("default", node(1, null, 1, "notice"))).toBe(true);
    expect(shows("default", node(1, null, 1, "assistant", true))).toBe(true);
    expect(shows("default", node(1, null, 1, "assistant"))).toBe(false);
    expect(shows("default", node(1, null, 1, "tool"))).toBe(false);
    expect(shows("default", node(1, null, 1, "input"))).toBe(false);
  });

  it("hides only tool results, or all but the owner's messages", () => {
    expect(shows("no-tools", node(1, null, 1, "assistant"))).toBe(true);
    expect(shows("no-tools", node(1, null, 1, "tool"))).toBe(false);
    expect(shows("user-only", node(1, null, 1, "user"))).toBe(true);
    expect(shows("user-only", node(1, null, 1, "assistant", true))).toBe(false);
    expect(shows("all", node(1, null, 1, "tool"))).toBe(true);
  });
});

describe("the Session tree's rows", () => {
  it("indents only where the tree branches, and marks the active branch's path", () => {
    expect(treeRows(tree, "default").map((row) => [row.node.id, row.depth, row.active])).toEqual([
      [1, 0, true],
      [4, 0, true],
      [5, 1, false],
      [6, 1, false],
      [8, 1, true],
      [9, 1, true],
    ]);
  });

  it("shows every node under the all filter", () => {
    expect(treeRows(tree, "all").map((row) => row.node.id)).toEqual([1, 2, 3, 4, 5, 6, 8, 9]);
  });

  it("indents several roots", () => {
    const roots: SessionTree = {
      ...tree,
      nodes: [node(1, null, 1, "user"), node(2, null, 2, "user")],
      leaf: 2,
    };

    expect(treeRows(roots, "default").map((row) => [row.node.id, row.depth, row.active])).toEqual([
      [1, 1, false],
      [2, 1, true],
    ]);
  });
});

describe("the Session tree's paths", () => {
  it("walks from the root to a leaf", () => {
    expect(pathTo(tree, 9)).toEqual([1, 2, 3, 4, 8, 9]);
    expect(pathTo(tree, null)).toEqual([]);
  });

  it("finds a node's siblings, oldest first", () => {
    expect(siblingsOf(tree, 5)).toEqual({ siblings: [tree.nodes[4], tree.nodes[6]], index: 0 });
    expect(siblingsOf(tree, 8)?.index).toBe(1);
    expect(siblingsOf(tree, 6)?.siblings).toHaveLength(1);
    expect(siblingsOf(tree, 99)).toBeUndefined();
  });

  it("lands on the branch through a node that was active last", () => {
    expect(branchThrough(tree, 4)).toBe(7);
    expect(branchThrough(tree, 5)).toBe(1);
    expect(branchThrough(tree, 99)).toBeUndefined();
  });

  it("lists the owner's messages on the active branch's path", () => {
    expect(ownerMessages(tree).map((each) => each.id)).toEqual([1, 8]);
  });
});
