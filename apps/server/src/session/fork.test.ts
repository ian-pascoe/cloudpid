// @effect-diagnostics preferEffectArray:off -- plain arrays of fixtures.
import type { AgentState, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { copiedDraft, copyAgent, exportPage, MAX_COPY_PAGE_SIZE } from "./fork.ts";

type FixtureValue =
  | string
  | number
  | readonly FixtureValue[]
  | { readonly [key: string]: FixtureValue };

type Fixture = { readonly [key: string]: FixtureValue };

// SAFETY: a fixture holds only the fields a copy reads; the other fields of pi's types are never looked at.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const asEntry = (entry: Fixture): EntryRecord => entry as unknown as EntryRecord;

const entry = (id: number, text = `entry ${id}`) =>
  asEntry({ id, kind: "pi.user", model: [{ role: "user", content: text, timestamp: id }] });

describe("a page of the entries a Fork copies", () => {
  it("is every entry left, and the last page, when they all fit", () => {
    expect(exportPage([entry(1), entry(2)], false)).toEqual({
      entries: [entry(1), entry(2)],
      next: null,
    });
  });

  it("says where the next starts while the read has more", () => {
    expect(exportPage([entry(1), entry(2)], true).next).toBe(2);
  });

  it("stops before the entry that does not fit, but always holds one", () => {
    const big = (id: number) => entry(id, "z".repeat(MAX_COPY_PAGE_SIZE / 2));

    const page = exportPage([big(1), big(2), big(3)], false);

    expect(page.entries.map((each) => each.id)).toEqual([1]);
    expect(page.next).toBe(1);

    const huge = exportPage([entry(1, "z".repeat(MAX_COPY_PAGE_SIZE + 1))], false);

    expect(huge.entries).toHaveLength(1);
    expect(huge.next).toBeNull();
  });
});

describe("the draft of a copied entry", () => {
  it("keeps its kind, messages and data", () => {
    const source = asEntry({
      id: 4,
      kind: "pi.compaction",
      model: [{ role: "user", content: "summary", timestamp: 4 }],
      data: { reason: "manual" },
    });

    expect(copiedDraft(source, new Map())).toEqual({
      kind: "pi.compaction",
      model: [{ role: "user", content: "summary", timestamp: 4 }],
      data: { reason: "manual" },
    });
  });

  it("renumbers the head and the edits' targets, its own head as self, and drops what was not copied", () => {
    const ids = new Map([
      [2, 12],
      [3, 13],
    ]);

    const own = copiedDraft(asEntry({ id: 5, kind: "pi.reset", head: 5 }), ids);
    const earlier = copiedDraft(asEntry({ id: 5, kind: "pi.compaction", head: 3 }), ids);
    const lost = copiedDraft(asEntry({ id: 5, kind: "pi.compaction", head: 1 }), ids);

    expect(own.head).toBe("self");
    expect(earlier.head).toBe(13);
    expect(lost).not.toHaveProperty("head");

    const edited = copiedDraft(
      asEntry({
        id: 6,
        kind: "pi.edit",
        edits: [
          { target: 2, type: "hide" },
          { target: 1, type: "hide" },
        ],
      }),
      ids,
    );

    expect(edited.edits).toEqual([{ target: 12, type: "hide" }]);
    expect(
      copiedDraft(asEntry({ id: 6, kind: "pi.edit", edits: [{ target: 1, type: "hide" }] }), ids),
    ).not.toHaveProperty("edits");
  });
});

describe("the agent a copy takes", () => {
  it("is the source's, field for field, without what the source did not set", () => {
    const draft: AgentState = {
      model: { provider: "a", modelId: "old" },
      thinkingLevel: "high",
      tools: ["read"],
    };

    const source: AgentState = {
      model: { provider: "b", modelId: "new" },
      tools: ["read", "bash"],
    };

    copyAgent(draft, source);

    expect(draft).toEqual(source);

    // A copy, not the source's own objects.
    expect(draft.tools).not.toBe(source.tools);
  });
});
