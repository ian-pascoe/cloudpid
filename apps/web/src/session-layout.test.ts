import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import {
  activityExpanded,
  DEFAULT_LAYOUT,
  disclosureKey,
  layoutOf,
  MAX_LAYOUTS,
  sameTodoList,
  todoItemsOf,
  withLayout,
  withOpen,
  withShown,
  type SessionLayout,
} from "./session-layout.ts";

const layout = (change: Partial<SessionLayout>): SessionLayout => ({
  ...DEFAULT_LAYOUT,
  ...change,
});

const PLAN = todoItemsOf([
  { id: 1, title: "Read" },
  { id: 2, title: "Build" },
]);

describe("a Session's layout on this device", () => {
  it("is the default for a Session it has not kept", () => {
    expect(layoutOf([], "a")).toEqual(DEFAULT_LAYOUT);
  });

  it("reads back as it was kept", () => {
    const kept = layout({
      panes: { open: ["subagents", "tree"], shown: "tree", hidden: true },
      activity: { expanded: false, items: PLAN, settled: false },
      openAgents: [3],
      openCards: [3, 4],
      openDisclosures: ["root/tool:call-1"],
      treeFilter: "user-only",
    });

    expect(layoutOf(withLayout([], "a", kept), "a")).toEqual(kept);
  });

  it("reads a stored field it does not have as its default, and Panes as the Pane types allow", () => {
    expect(
      layoutOf(
        [
          {
            sessionId: "a",
            layout: { panes: { open: ["tasks", "gone"], shown: "tasks", hidden: false } },
          },
        ],
        "a",
      ),
    ).toEqual(layout({ panes: { open: ["subagents"], shown: "subagents", hidden: false } }));
  });

  it("keeps the Session shown last first, and only the last ones shown", () => {
    const many = Arr.reduce(
      Arr.range(1, MAX_LAYOUTS + 5),
      withLayout([], "a", DEFAULT_LAYOUT),
      (stored, n) => withLayout(stored, `s${n}`, DEFAULT_LAYOUT),
    );

    expect(many).toHaveLength(MAX_LAYOUTS);
    expect(many[0]?.sessionId).toBe(`s${MAX_LAYOUTS + 5}`);
    expect(Arr.some(many, (entry) => entry.sessionId === "a")).toBe(false);

    // Kept again, a Session moves to the front instead of being repeated.
    const again = withLayout(many, "s10", layout({ treeFilter: "all" }));

    expect(again).toHaveLength(MAX_LAYOUTS);
    expect(again[0]?.sessionId).toBe("s10");
    expect(layoutOf(again, "s10").treeFilter).toBe("all");
  });

  it("moves a Session shown to the front with its layout as it was, so reading one keeps it", () => {
    const stored = withLayout(
      withLayout([], "a", layout({ treeFilter: "all" })),
      "b",
      DEFAULT_LAYOUT,
    );

    const shown = withShown(stored, "a");

    expect(shown[0]?.sessionId).toBe("a");
    expect(layoutOf(shown, "a").treeFilter).toBe("all");
    // Already the one shown last: nothing to write.
    expect(withShown(shown, "a")).toBe(shown);
  });
});

describe("the things open in a layout", () => {
  it("open last and close", () => {
    expect(withOpen([1, 2], 1, true)).toEqual([2, 1]);
    expect(withOpen([1, 2], 2, false)).toEqual([1]);
    expect(withOpen<number>([], 7, false)).toEqual([]);
  });

  it("keep a disclosure apart from the same one in another thread", () => {
    const root = disclosureKey({ conversationId: undefined, kind: "notice", messageId: "4" });
    const subagent = disclosureKey({ conversationId: 7, kind: "notice", messageId: "4" });

    expect(root).toBe("root/notice:4");
    expect(subagent).toBe("7/notice:4");
    expect(
      disclosureKey({ conversationId: undefined, kind: "thinking", messageId: "4", index: 1 }),
    ).toBe("root/thinking:4:1");
  });
});

describe("whether the Todo List shown is the one a choice was made for", () => {
  it("is while one Todo Item at least is the same", () => {
    // Added to, renamed in part, or with its first Todo Item dropped, it is the same list.
    expect(
      sameTodoList(
        PLAN,
        todoItemsOf([
          { id: 2, title: "Build" },
          { id: 3, title: "Test" },
        ]),
      ),
    ).toBe(true);
    expect(
      sameTodoList(
        PLAN,
        todoItemsOf([
          { id: 1, title: "Read it all" },
          { id: 2, title: "Build" },
        ]),
      ),
    ).toBe(true);
  });

  it("is not once the agent starts afresh, though the first title is the same", () => {
    expect(sameTodoList(PLAN, todoItemsOf([{ id: 7, title: "Read" }]))).toBe(false);
  });

  it("tells no list from a list", () => {
    expect(sameTodoList([], [])).toBe(true);
    expect(sameTodoList([], PLAN)).toBe(false);
    expect(sameTodoList(PLAN, [])).toBe(false);
  });
});

describe("whether the Activity card is expanded", () => {
  it("follows the screen and what is going on until the owner chooses", () => {
    expect(activityExpanded({ choice: undefined, items: PLAN, wide: true, settled: false })).toBe(
      true,
    );
    // A phone keeps the chat in sight; a list all done needs no following.
    expect(activityExpanded({ choice: undefined, items: PLAN, wide: false, settled: false })).toBe(
      false,
    );
    expect(activityExpanded({ choice: undefined, items: PLAN, wide: true, settled: true })).toBe(
      false,
    );
  });

  it("is as the owner left it for the same Todo List", () => {
    const collapsed = { expanded: false, items: PLAN, settled: false };
    const expanded = { expanded: true, items: PLAN, settled: false };

    expect(activityExpanded({ choice: collapsed, items: PLAN, wide: true, settled: false })).toBe(
      false,
    );
    expect(activityExpanded({ choice: expanded, items: PLAN, wide: false, settled: false })).toBe(
      true,
    );
  });

  it("folds into the pill once everything is done, though the owner had expanded it", () => {
    const expanded = { expanded: true, items: PLAN, settled: false };

    expect(activityExpanded({ choice: expanded, items: PLAN, wide: true, settled: true })).toBe(
      false,
    );
    // Expanded again once done, it stays so.
    const again = { expanded: true, items: PLAN, settled: true };

    expect(activityExpanded({ choice: again, items: PLAN, wide: true, settled: true })).toBe(true);
  });

  it("goes back to its default for a new Todo List", () => {
    const collapsed = { expanded: false, items: PLAN, settled: false };
    const fresh = todoItemsOf([{ id: 9, title: "Another" }]);

    expect(activityExpanded({ choice: collapsed, items: fresh, wide: true, settled: false })).toBe(
      true,
    );
  });
});
