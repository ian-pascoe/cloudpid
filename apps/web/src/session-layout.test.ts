import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import {
  DEFAULT_LAYOUT,
  disclosureKey,
  layoutOf,
  MAX_LAYOUTS,
  withLayout,
  withOpen,
  withShown,
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
      activityOpen: true,
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
