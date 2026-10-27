import type { ConversationId, DiffAnnotation, PageAnnotation } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  chipLabel,
  draftsOn,
  draftsTo,
  editedDraft,
  lineAnnotationsOf,
  newDraft,
  reviewLaneText,
} from "./drafts.ts";

// SAFETY: conversation IDs the Session named.
const root = 1 as ConversationId;

// SAFETY: as `root`.
const subagent = 7 as ConversationId;

const onPage = (overrides: Partial<PageAnnotation> = {}): PageAnnotation => ({
  id: "p1",
  source: {
    kind: "page",
    url: "https://app.test/login?next=1",
    ownerTabId: "tab-1",
    element: { selector: "#login > button", tag: "button" },
    box: { x: 0, y: 0, width: 10, height: 10 },
    scroll: { x: 0, y: 0 },
    viewport: { width: 100, height: 100 },
  },
  quote: ["Sign in"],
  more: 0,
  text: "Bigger.",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const draft = (overrides: Partial<DiffAnnotation> = {}): DiffAnnotation => ({
  id: "d1",
  source: { kind: "call", conversationId: root, callId: "c1", tool: "edit" },
  path: "/workspace/app/src/a.ts",
  side: "new",
  start: 3,
  end: 5,
  quote: ["a", "b", "c"],
  more: 0,
  text: "Why?",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe("drafts", () => {
  it("on a diff are those of its call, or its repo's Changes, and its file", () => {
    const onCall = draft();

    const otherCall = draft({
      id: "d2",
      source: { kind: "call", conversationId: root, callId: "c2", tool: "edit" },
    });

    const onChanges = draft({
      id: "d4",
      source: { kind: "changes", repo: "app", head: "abc" },
      path: "src/a.ts",
    });

    const otherFile = draft({ ...onChanges, id: "d3", path: "src/b.ts" });
    const all = [onCall, otherCall, otherFile, onChanges, onPage()];

    // A call's diff is of one file, whose path the Session made absolute: the card may name it relative.
    expect(draftsOn(all, { source: onCall.source, path: "src/a.ts" })).toEqual([onCall]);
    // The Changes at any HEAD: a draft keeps the one it was written against.
    expect(
      draftsOn(all, { source: { kind: "changes", repo: "app", head: "def" }, path: "src/a.ts" }),
    ).toEqual([onChanges]);
  });

  it("go to the composer of the conversation they name, the active branch's when none", () => {
    const toRoot = draft();
    const toSubagent = draft({ id: "d2", conversationId: subagent });

    expect(draftsTo([toRoot, toSubagent, onPage()], undefined)).toEqual([toRoot, onPage()]);
    expect(draftsTo([toRoot, toSubagent], 7)).toEqual([toSubagent]);
  });

  it("show under their last line, and the editor of a new one under its lines", () => {
    expect(
      lineAnnotationsOf([draft({ side: "old", end: 9 })], {
        side: "new",
        start: 2,
        end: 4,
        quote: [],
        more: 0,
      }),
    ).toEqual([
      { side: "deletions", lineNumber: 9, metadata: { kind: "draft", id: "d1" } },
      { side: "additions", lineNumber: 4, metadata: { kind: "new" } },
    ]);
  });

  it("are made from the picked lines, going to the anchor's conversation", () => {
    expect(
      newDraft(
        "n1",
        {
          source: { kind: "changes", repo: "app", head: null },
          path: "src/b.ts",
          oldPath: "src/a.ts",
          conversationId: 7,
        },
        { side: "old", start: 1, end: 1, quote: ["x"], more: 0 },
        "Keep this.",
      ),
    ).toEqual({
      id: "n1",
      source: { kind: "changes", repo: "app", head: null },
      path: "src/b.ts",
      oldPath: "src/a.ts",
      conversationId: 7,
      side: "old",
      start: 1,
      end: 1,
      quote: ["x"],
      more: 0,
      text: "Keep this.",
    });
  });

  it("edited keep everything but the text, without what the Session stamps", () => {
    expect(editedDraft(draft({ status: "outdated" }), "Better.")).toEqual({
      ...draft(),
      createdAt: undefined,
      updatedAt: undefined,
      text: "Better.",
    });

    const { createdAt: _created, updatedAt: _updated, ...page } = onPage();

    expect(editedDraft(onPage(), "Smaller.")).toStrictEqual({ ...page, text: "Smaller." });
  });

  it("are named by file and range, and a Review's lane by its summary and count", () => {
    expect(chipLabel(draft())).toBe("a.ts:3–5");
    expect(chipLabel(draft({ end: 3 }))).toBe("a.ts:3");
    expect(chipLabel(onPage())).toBe("<button> · app.test/login");

    const { element: _element, ...area } = onPage().source;

    expect(chipLabel(onPage({ source: { ...area, url: "https://app.test/" } }))).toBe(
      "Area · app.test",
    );
    expect(reviewLaneText("", 2)).toBe("Review: 2 Annotations");
    expect(reviewLaneText("Look", 1)).toBe("Look · Review: 1 Annotation");
  });
});
