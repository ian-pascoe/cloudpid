// @effect-diagnostics preferEffectArray:off -- plain arrays of fixtures.
import { MAX_HISTORY_BYTES, MAX_HISTORY_ENTRIES } from "@cloudpid/protocol";
import type { Cursor, EntryRecord } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { historyPage, type ReadEntries } from "./history.ts";

/** The parts of pi's shapes a fixture sets. */
type FixtureValue =
  | string
  | number
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

const system = (id: number) =>
  asEntry({ id, conversationId: 1, kind: "pi.system", model: [{ role: "system" }] });

/** A reader over `entries` (oldest first) as pi-durable pages them: newest first, a cursor while any are left. */
const reader = (entries: readonly EntryRecord[]) => {
  const reads: number[] = [];

  const read: ReadEntries<never> = (maxEntryId, limit, cursor) =>
    Effect.sync(() => {
      reads.push(limit);

      const below = Number(cursor?.["below"] ?? maxEntryId + 1);
      const newest = entries.filter((entry) => entry.id < below).reverse();
      const items = newest.slice(0, limit);
      const last = items.at(-1);

      const next: Cursor | undefined =
        newest.length > limit && last !== undefined ? { below: last.id } : undefined;

      return next === undefined ? { items } : { items, next };
    });

  return { read, reads };
};

const run = (entries: readonly EntryRecord[], before: number) =>
  Effect.runSync(historyPage(reader(entries).read, before));

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => user(from + index));

describe("a page of History", () => {
  it("holds the entries before the one asked for, oldest first, and nothing more when they are all", () => {
    const page = run(range(1, 10), 6);

    expect(page.entries.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5]);
    expect(page.before).toBeNull();
  });

  it("leaves out what a transcript does not show, but reads past it", () => {
    const page = run([system(1), user(2), system(3), user(4)], 5);

    expect(page.entries.map((entry) => entry.id)).toEqual([2, 4]);
    expect(page.before).toBeNull();
  });

  it(`stops after ${MAX_HISTORY_ENTRIES} entries and says where to go on`, () => {
    const page = run(range(1, MAX_HISTORY_ENTRIES + 50), MAX_HISTORY_ENTRIES + 51);

    expect(page.entries).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(page.entries[0]?.id).toBe(51);
    expect(page.before).toBe(51);

    const rest = run(range(1, MAX_HISTORY_ENTRIES + 50), 51);

    expect(rest.entries.map((entry) => entry.id)).toEqual(range(1, 50).map((entry) => entry.id));
    expect(rest.before).toBeNull();
  });

  it("stops once its entries pass the size bound, keeping the one that passed it", () => {
    const large = "x".repeat(MAX_HISTORY_BYTES / 2);
    const page = run([user(1), user(2, large), user(3, large), user(4)], 5);

    expect(page.entries.map((entry) => entry.id)).toEqual([2, 3, 4]);
    expect(page.before).toBe(2);
  });

  it("asks for nothing before the first entry", () => {
    const { read, reads } = reader(range(1, 3));

    expect(Effect.runSync(historyPage(read, 1))).toEqual({ entries: [], before: null });
    expect(reads).toEqual([]);
  });
});
