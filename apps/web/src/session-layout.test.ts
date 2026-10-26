import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import {
  activityExpanded,
  DEFAULT_LAYOUT,
  layoutOf,
  MAX_LAYOUTS,
  todoListOf,
  withLayout,
  withOpen,
  type SessionLayout,
} from "./session-layout.ts";

const layout = (change: Partial<SessionLayout>): SessionLayout => ({
  ...DEFAULT_LAYOUT,
  ...change,
});

describe("a Session's layout on this device", () => {
  it("is the default for a Session it has not kept", () => {
    expect(layoutOf([], "a")).toEqual(DEFAULT_LAYOUT);
  });

  it("reads back as it was kept", () => {
    const kept = layout({
      panes: { open: ["subagents", "tree"], shown: "tree", hidden: true },
      activity: { expanded: false, list: "Plan" },
      openAgents: [3],
      openCards: [3, 4],
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
});

describe("the subagents open in a layout", () => {
  it("open last and close", () => {
    expect(withOpen([1, 2], 1, true)).toEqual([2, 1]);
    expect(withOpen([1, 2], 2, false)).toEqual([1]);
    expect(withOpen([], 7, false)).toEqual([]);
  });
});

describe("whether the Activity card is expanded", () => {
  it("follows the screen and what is going on until the owner chooses", () => {
    expect(activityExpanded({ choice: undefined, list: "Plan", wide: true, settled: false })).toBe(
      true,
    );
    // A phone keeps the chat in sight; a list all done needs no following.
    expect(activityExpanded({ choice: undefined, list: "Plan", wide: false, settled: false })).toBe(
      false,
    );
    expect(activityExpanded({ choice: undefined, list: "Plan", wide: true, settled: true })).toBe(
      false,
    );
  });

  it("is as the owner left it for the same Todo List", () => {
    const collapsed = { expanded: false, list: "Plan" };
    const expanded = { expanded: true, list: "Plan" };

    expect(activityExpanded({ choice: collapsed, list: "Plan", wide: true, settled: false })).toBe(
      false,
    );
    expect(activityExpanded({ choice: expanded, list: "Plan", wide: false, settled: true })).toBe(
      true,
    );
  });

  it("goes back to its default for a new Todo List", () => {
    const collapsed = { expanded: false, list: "Plan" };

    expect(
      activityExpanded({ choice: collapsed, list: "Other plan", wide: true, settled: false }),
    ).toBe(true);
  });

  it("tells one Todo List from the next by its first Task", () => {
    expect(todoListOf([{ title: "Plan" }, { title: "Build" }])).toBe("Plan");
    expect(todoListOf([])).toBe("");
  });
});
