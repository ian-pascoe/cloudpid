// The notices a Session shows of its Workspace's held stops (docs/architecture/container.md → Idle stop).
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { projectEntry } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import type { HeldStop } from "../workspace/idle.ts";
import { HELD_STOPS_SEEN_KEY, heldStopEntry, showHeldStops } from "./held-stops.ts";

const MINUTE = 60_000;

const kv = () => {
  const values = new Map<string, unknown>();

  return {
    // SAFETY: the test reads back what it wrote.
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: <T>(key: string, value: T) => {
      values.set(key, value);
    },
  };
};

const stop = (at: number): HeldStop => ({ at, lastActivity: at - 60 * MINUTE, holds: 1 });

describe("showHeldStops", () => {
  it("shows nothing at its first check, and every held stop after it once", async () => {
    const store = kv();
    const written: unknown[] = [];
    const asked: number[] = [];
    const kept = [stop(2_000_000), stop(3_000_000)];

    const check = (now: number) =>
      showHeldStops({
        kv: store,
        now,
        read: async (after) => {
          asked.push(after);

          return kept.filter((each) => each.at > after);
        },
        write: async (draft) => {
          written.push(draft);
        },
      });

    // A Session's first check only marks where it starts: a stop before the Session was not its own.
    await check(1_500_000);
    expect(asked).toEqual([]);
    expect(written).toEqual([]);

    await check(4_000_000);
    expect(asked).toEqual([1_500_000]);
    expect(written).toEqual([heldStopEntry(kept[0]!), heldStopEntry(kept[1]!)]);

    // Shown once: the next check asks only for later stops.
    await check(5_000_000);
    expect(asked).toEqual([1_500_000, 3_000_000]);
    expect(written).toHaveLength(2);
  });

  it("asks again for a stop whose notice could not be written", async () => {
    const store = kv();
    const kept = [stop(2_000_000)];
    let fail = true;
    const written: unknown[] = [];

    const check = () =>
      showHeldStops({
        kv: store,
        now: 4_000_000,
        read: async (after) => kept.filter((each) => each.at > after),
        write: async (draft) => {
          if (fail) throw new Error("storage unavailable");
          written.push(draft);
        },
      });

    store.put(HELD_STOPS_SEEN_KEY, 1_000_000);
    await expect(check()).rejects.toThrow("storage unavailable");

    fail = false;
    await check();
    expect(written).toEqual([heldStopEntry(kept[0]!)]);
  });
});

describe("heldStopEntry", () => {
  it("is a display-only write the transcript shows as a notice, once per stop", () => {
    const draft = heldStopEntry(stop(2_000_000));

    expect(draft.type).toBe("write");
    expect(draft.requestId).toBe("container-held-stop:2000000");
    expect(draft.entry).not.toHaveProperty("model");

    // SAFETY: an entry record is the draft's entry with its IDs; the projection reads only its kind and data.
    const projected = projectEntry({ ...draft.entry, id: 1, conversationId: 1 } as never);

    expect(projected).toMatchObject({
      role: "notice",
      title: "Container stopped: held for 60 minutes without owner or agent activity",
    });
  });
});
