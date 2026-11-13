// docs/architecture/mcp-apps.md → Lifecycle (Mounting): `tool-input-partial` is throttled to 250 ms, sent only when changed,
// and stops past 1 MiB of arguments.
// @effect-diagnostics missingPipeableSignature:off globalTimers:off -- a fake clock driven by hand.
import { describe, expect, it } from "vite-plus/test";
import {
  createPartialFeed,
  type FeedClock,
  MAX_PARTIAL_INPUT_BYTES,
  PARTIAL_INPUT_INTERVAL_MS,
} from "./partial-input.ts";

/** A clock the test moves; a timer runs when the time reaches it. */
const fakeClock = () => {
  let time = 1000;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();

  const clock: FeedClock = {
    now: () => time,
    setTimeout: (run, ms) => {
      const id = nextId++;

      timers.set(id, { at: time + ms, run });

      // SAFETY: the feed treats a timer as an opaque value; the fake's is its number in `timers`.
      return id as never;
    },
    clearTimeout: (timer) => {
      // SAFETY: only the fake's own numbers are handed back.
      timers.delete(timer as never);
    },
  };

  return {
    clock,
    advance: (ms: number) => {
      time += ms;

      for (const [id, timer] of timers) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.run();
        }
      }
    },
    pending: () => timers.size,
  };
};

describe("the partial input feed", () => {
  it("sends the first arguments at once and then the latest at most every 250 ms", () => {
    const { clock, advance } = fakeClock();
    const sent: unknown[] = [];
    const feed = createPartialFeed((args) => sent.push(args), clock);

    feed.push({ n: 1 });
    feed.push({ n: 2 });
    feed.push({ n: 3 });
    expect(sent).toEqual([{ n: 1 }]);

    advance(PARTIAL_INPUT_INTERVAL_MS - 1);
    expect(sent).toEqual([{ n: 1 }]);

    feed.push({ n: 4 });
    advance(1);
    // The latest, not each: the ones between are dropped.
    expect(sent).toEqual([{ n: 1 }, { n: 4 }]);

    advance(PARTIAL_INPUT_INTERVAL_MS);
    expect(sent).toHaveLength(2);

    // After a quiet interval the next goes at once.
    feed.push({ n: 5 });
    expect(sent.at(-1)).toEqual({ n: 5 });
  });

  it("sends nothing for arguments that did not change", () => {
    const { clock, advance } = fakeClock();
    const sent: unknown[] = [];
    const feed = createPartialFeed((args) => sent.push(args), clock);

    feed.push({ a: "x" });
    advance(300);
    feed.push({ a: "x" });
    advance(300);
    expect(sent).toEqual([{ a: "x" }]);
  });

  it("sends no more once the arguments are past 1 MiB, however they grow", () => {
    const { clock, advance } = fakeClock();
    const sent: unknown[] = [];
    const feed = createPartialFeed((args) => sent.push(args), clock);

    feed.push({ text: "a".repeat(MAX_PARTIAL_INPUT_BYTES - 100) });
    expect(sent).toHaveLength(1);

    advance(300);
    feed.push({ text: "a".repeat(MAX_PARTIAL_INPUT_BYTES + 1) });
    expect(sent).toHaveLength(1);

    advance(300);
    feed.push({ text: "a" });
    advance(300);
    expect(sent).toHaveLength(1);
  });

  it("counts bytes, not characters", () => {
    const { clock } = fakeClock();
    const sent: unknown[] = [];
    const feed = createPartialFeed((args) => sent.push(args), clock);

    // Three bytes each: under a million characters, over a million bytes.
    feed.push({ text: "€".repeat(400_000) });
    expect(sent).toHaveLength(0);
  });

  it("drops what waits when it is stopped", () => {
    const { clock, advance, pending } = fakeClock();
    const sent: unknown[] = [];
    const feed = createPartialFeed((args) => sent.push(args), clock);

    feed.push({ n: 1 });
    feed.push({ n: 2 });
    expect(pending()).toBe(1);

    feed.stop();
    advance(1000);
    feed.push({ n: 3 });
    expect(sent).toEqual([{ n: 1 }]);
    expect(pending()).toBe(0);
  });
});
