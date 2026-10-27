import type { CodeViewDiffItem, DiffLineAnnotation } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import type { AnnotationSlot } from "../review/drafts.ts";
import { placeholderDiff } from "./file-diff.ts";
import { annotatedItems } from "./annotated-items.ts";

const item = (id: string, version = 1): CodeViewDiffItem<undefined> => ({
  id,
  type: "diff",
  fileDiff: placeholderDiff({ name: `${id}.ts`, status: "modified" }),
  version,
});

const draft = (id: string, lineNumber: number): DiffLineAnnotation<AnnotationSlot> => ({
  side: "additions",
  lineNumber,
  metadata: { kind: "draft", id },
});

describe("annotatedItems", () => {
  it("puts each file's annotations on its item, past the plain item's version", () => {
    const a = item("a", 3);
    const made = annotatedItems([a], () => [draft("d1", 4)], new Map());

    expect(made.get("a")?.item).toMatchObject({ id: "a", annotations: [draft("d1", 4)], version: 4 });
  });

  it("keeps the same object while the item and its annotations' places are the same", () => {
    const a = item("a");
    const first = annotatedItems([a], () => [draft("d1", 4)], new Map());
    const again = annotatedItems([a], () => [draft("d1", 4)], first);

    expect(again.get("a")?.item).toBe(first.get("a")?.item);
  });

  it("makes a new version when a draft moves or comes, or the item changes", () => {
    const a = item("a");
    const first = annotatedItems([a], () => [draft("d1", 4)], new Map());
    const moved = annotatedItems([a], () => [draft("d1", 6)], first);

    expect(moved.get("a")?.item.version).toBe(3);

    const next = item("a", 2);
    const redrawn = annotatedItems([next], () => [draft("d1", 6)], moved);

    expect(redrawn.get("a")?.item.version).toBe(4);
    expect(redrawn.get("a")?.item.fileDiff).toBe(next.fileDiff);
  });
});
