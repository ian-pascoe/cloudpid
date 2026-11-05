// @effect-diagnostics preferEffectArray:off -- plain arrays of fixtures.
import { OMITTED_IMAGE, WATCH_IMAGES } from "@cloudpid/extensions/browser";
import { type EntriesPage, MAX_ENTRIES_PAGE_BYTES } from "@cloudpid/protocol";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { entriesPage } from "./entries-page.ts";

/** The parts of pi's shapes a fixture sets. */
type FixtureValue =
  | string
  | number
  | boolean
  | readonly FixtureValue[]
  | { readonly [key: string]: FixtureValue };

type Fixture = { readonly [key: string]: FixtureValue };

// SAFETY: a fixture holds only the fields a page reads; the other fields of pi's types are never looked at.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const asEntry = (entry: Fixture): EntryRecord => entry as unknown as EntryRecord;

const user = (id: number, text = `message ${id}`) =>
  asEntry({
    id,
    conversationId: 1,
    kind: "pi.user",
    model: [{ role: "user", content: text, timestamp: id }],
  });

const screenshot = (id: number) =>
  asEntry({
    id,
    conversationId: 1,
    kind: "pi.tool",
    model: [
      {
        role: "toolResult",
        toolCallId: `c${id}`,
        toolName: "browser",
        content: [{ type: "image", data: `shot ${id}`, mimeType: "image/jpeg" }],
        isError: false,
        timestamp: id,
      },
    ],
  });

describe("a page of entries", () => {
  it("is the page read, its continuation included", () => {
    const items = [user(3), user(2)];

    expect(entriesPage({ items }, "descending")).toEqual({ items });
    expect(entriesPage({ items, next: { below: 2 } }, "descending")).toEqual({
      items,
      next: { below: 2 },
    });
  });

  it("stops at the entry that passes its bytes, and says more are left", () => {
    const large = "x".repeat(MAX_ENTRIES_PAGE_BYTES / 2);
    const page = entriesPage({ items: [user(5, large), user(4, large), user(3)] }, "descending");

    expect(page.items.map((entry) => entry.id)).toEqual([5, 4]);
    expect(page.next).toBeDefined();
  });

  it("holds one entry however large", () => {
    const page = entriesPage({ items: [user(1, "x".repeat(MAX_ENTRIES_PAGE_BYTES))] }, "ascending");

    expect(page.items).toHaveLength(1);
    expect(page).not.toHaveProperty("next");
  });

  it("bounds its screenshots, keeping the newest in either order", () => {
    const items = Array.from({ length: WATCH_IMAGES + 2 }, (_, index) => screenshot(index + 1));

    const kept = (page: EntriesPage) =>
      page.items.flatMap((entry) => {
        const [message] = entry.model ?? [];

        return message?.role === "toolResult" && message.content[0]?.type === "image"
          ? [entry.id]
          : [];
      });

    const newest = items.slice(2).map((entry) => entry.id);

    expect(kept(entriesPage({ items }, "ascending"))).toEqual(newest);
    expect(kept(entriesPage({ items: items.toReversed() }, "descending"))).toEqual(
      newest.toReversed(),
    );
    expect(JSON.stringify(entriesPage({ items }, "ascending").items[0])).toContain(OMITTED_IMAGE);
  });
});
