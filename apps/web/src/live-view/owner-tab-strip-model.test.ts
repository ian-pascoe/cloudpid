// @effect-diagnostics preferEffectArray:off
import type { ConversationId, OwnerTabDriver } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { stripOf } from "./owner-tab-strip-model.ts";

const driver = (ownerTabId: string, conversationId: number): OwnerTabDriver => ({
  ownerTabId,
  // SAFETY: a test's conversations are plain numbers, as pi-durable's are.
  conversationId: conversationId as ConversationId,
});

describe("the Browser Pane's tab strip", () => {
  it("lists the Owner tabs by title, marks the one shown, and calls a page without a title a new tab", () => {
    expect(
      stripOf(
        {
          tabs: [
            { id: "a", title: "Docs" },
            { id: "b", title: "  " },
          ],
          shown: "b",
        },
        false,
      ),
    ).toEqual({
      tabs: [
        { id: "a", title: "Docs", shown: false, driven: false },
        { id: "b", title: "New tab", shown: true, driven: false },
      ],
      canOpen: true,
    });
  });

  it("is + alone once the last Owner tab is closed (or before any is heard of), and offers none in an archived Session", () => {
    expect(stripOf({ tabs: [] }, false)).toEqual({ tabs: [], canOpen: true });
    expect(stripOf(null, false)).toEqual({ tabs: [], canOpen: true });
    expect(stripOf({ tabs: [{ id: "a", title: "Docs" }], shown: "a" }, true).canOpen).toBe(false);
  });

  it("marks the Owner tabs a browser call is driving, whether shown or not, and only those", () => {
    const { tabs } = stripOf(
      {
        tabs: [
          { id: "a", title: "Docs" },
          { id: "b", title: "Mail" },
          { id: "c", title: "News" },
        ],
        shown: "a",
      },
      false,
      [driver("b", 1), driver("b", 4), driver("gone", 2)],
    );

    expect(tabs.map(({ id, driven }) => [id, driven])).toEqual([
      ["a", false],
      ["b", true],
      ["c", false],
    ]);
  });
});
