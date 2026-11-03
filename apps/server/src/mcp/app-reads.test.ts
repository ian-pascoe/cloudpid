// What bounds an App's read in the host (`docs/architecture/mcp-apps.md` → Declaring and reading Apps): the slot a streamed
// answer's decode takes and how long a read waits for it, and the failures remembered up to a hard cap.
// @effect-diagnostics asyncFunction:off strictEffectProvide:off -- Vitest's tests are Promise-based; the test is its entry point.
// The failures are compared as they are written, plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import { MiB, type McpEngineValue } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { APP_SLOT_WAIT_MS, decoding, MAX_REMEMBERED, remember } from "./app-reads.ts";

/** A stream of `bytes` bytes that records whether it was cancelled unread. */
const streamOf = (bytes: number) => {
  const state = { cancelled: false };

  const value: McpEngineValue = {
    kind: "stream",
    body: new ReadableStream<Uint8Array>(
      {
        cancel: () => {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    bytes,
  };

  return { value, state };
};

const decoded = Effect.succeed(Result.succeed("decoded"));

const run = <A>(body: (slot: Semaphore.Semaphore) => Effect.Effect<A, never, never>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* Semaphore.make(1));
    }).pipe(Effect.provide(TestClock.layer())),
  );

describe("the decode slot", () => {
  it("gives a streamed answer up after its wait, cancels the stream and leaves the slot to the one that holds it", async () => {
    const { value, state } = streamOf(2 * MiB);

    const outcome = await run((slot) =>
      Effect.gen(function* () {
        yield* slot.take(1);

        const waiting = yield* Effect.forkChild(decoding(slot, value, decoded));

        yield* TestClock.adjust(APP_SLOT_WAIT_MS - 1);
        expect(waiting.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust(1);

        const result = yield* Fiber.join(waiting);

        // The holder lets go: the slot is free, so the one that gave up left nothing behind.
        yield* slot.release(1);

        return { result, free: yield* slot.withPermitsIfAvailable(1)(Effect.succeed("free")) };
      }),
    );

    expect(state.cancelled).toBe(true);
    expect(Result.isFailure(outcome.result) ? outcome.result.failure : null).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "TimedOut" },
    });
    expect(outcome.free._tag).toBe("Some");
  });

  it("decodes a streamed answer once the slot is free, and lets the slot go", async () => {
    const { value, state } = streamOf(2 * MiB);

    const outcome = await run((slot) =>
      Effect.gen(function* () {
        yield* slot.take(1);

        const waiting = yield* Effect.forkChild(decoding(slot, value, decoded));

        yield* TestClock.adjust(APP_SLOT_WAIT_MS - 1);
        yield* slot.release(1);

        const result = yield* Fiber.join(waiting);

        // Past its wait, the decode is not cut: it has the slot.
        yield* TestClock.adjust(APP_SLOT_WAIT_MS);

        return { result, free: yield* slot.withPermitsIfAvailable(1)(Effect.succeed("free")) };
      }),
    );

    expect(outcome.result).toEqual(Result.succeed("decoded"));
    expect(state.cancelled).toBe(false);
    expect(outcome.free._tag).toBe("Some");
  });

  it("takes no slot for an inline answer, nor for a stream over what a page may weigh", async () => {
    const over = streamOf(13 * MiB);

    const outcomes = await run((slot) =>
      Effect.gen(function* () {
        yield* slot.take(1);

        return [
          yield* decoding(slot, { kind: "inline", value: {} }, decoded),
          yield* decoding(slot, over.value, decoded),
        ];
      }),
    );

    expect(outcomes).toEqual([Result.succeed("decoded"), Result.succeed("decoded")]);
  });

  it("cancels the stream of a read that is cancelled while it waits", async () => {
    const { value, state } = streamOf(2 * MiB);

    await run((slot) =>
      Effect.gen(function* () {
        yield* slot.take(1);

        const waiting = yield* Effect.forkChild(decoding(slot, value, decoded));

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiting);
      }),
    );

    expect(state.cancelled).toBe(true);
  });
});

describe("the failures remembered", () => {
  const held = (until: number) => ({ version: "v1", until });

  it("keeps at most the cap, the ones past their backoff going first, then the oldest", () => {
    const failures = new Map<string, ReturnType<typeof held>>();

    for (let each = 0; each < MAX_REMEMBERED; each++) remember(failures, `k${each}`, held(1000), 0);

    remember(failures, "next", held(1000), 0);

    expect(failures.size).toBe(MAX_REMEMBERED);
    expect(failures.has("k0")).toBe(false);
    expect(failures.has("k1")).toBe(true);
    expect(failures.has("next")).toBe(true);

    // Remembered again, a key is the newest, and none of the rest is kept past its backoff.
    remember(failures, "k1", held(1000), 0);
    expect([...failures.keys()].at(-1)).toBe("k1");

    remember(failures, "after", held(2000), 1000);

    expect([...failures.keys()]).toEqual(["after"]);
  });

  it("drops the expired and not the others when that makes room", () => {
    const failures = new Map<string, ReturnType<typeof held>>();

    for (let each = 0; each < MAX_REMEMBERED; each++) {
      remember(failures, `k${each}`, held(each === 5 ? 10 : 1000), 0);
    }

    remember(failures, "next", held(1000), 10);

    expect(failures.size).toBe(MAX_REMEMBERED);
    expect(failures.has("k5")).toBe(false);
    expect(failures.has("k0")).toBe(true);
  });
});
