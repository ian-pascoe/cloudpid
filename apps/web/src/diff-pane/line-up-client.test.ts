// @effect-diagnostics preferEffectArray:off -- the fakes record what they were sent in native arrays.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { LineUpRequest } from "./line-up.ts";
import { lineUpClient, type WorkerLike } from "./line-up-client.ts";

/** A worker that answers only when told to, and records what it was sent. */
const fakeWorker = () => {
  const listeners = new Map<string, (event: { readonly data?: unknown }) => void>();
  const sent: { readonly id: number; readonly request: LineUpRequest }[] = [];
  let terminated = false;

  const worker: WorkerLike = {
    postMessage: (message) => {
      sent.push(message);
    },
    terminate: () => {
      terminated = true;
    },
    addEventListener: (type, listener) => {
      listeners.set(type, listener);
    },
  };

  return {
    worker,
    sent,
    terminated: () => terminated,
    answer: (id: number, patch: string) => {
      listeners.get("message")?.({ data: { id, result: { patch, replaced: false } } });
    },
    fail: () => {
      listeners.get("error")?.({});
    },
  };
};

const request = (name: string): LineUpRequest => ({
  oldName: name,
  newName: name,
  oldText: "a\n",
  newText: "b\n",
});

/** Let the forked fibers run up to their waits. */
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 5 }));

describe("lineUpClient", () => {
  it.effect("answers each pair under the ID it was asked with", () =>
    Effect.gen(function* () {
      const fake = fakeWorker();
      const client = lineUpClient(() => fake.worker);
      const first = yield* Effect.forkChild(client.lineUp(request("a")));
      const second = yield* Effect.forkChild(client.lineUp(request("b")));

      yield* settle;
      fake.answer(2, "B");
      fake.answer(1, "A");

      expect((yield* Fiber.join(first)).patch).toBe("A");
      expect((yield* Fiber.join(second)).patch).toBe("B");
    }),
  );

  it.effect("fails what a dead worker held, and starts another for the next pair", () =>
    Effect.gen(function* () {
      const workers = [fakeWorker(), fakeWorker()];
      let spawned = 0;
      const client = lineUpClient(() => workers[spawned++]!.worker);
      const held = yield* Effect.forkChild(client.lineUp(request("a")));

      yield* settle;
      workers[0]!.fail();

      expect(Exit.isFailure(yield* Fiber.await(held))).toBe(true);

      const next = yield* Effect.forkChild(client.lineUp(request("b")));

      yield* settle;
      expect(spawned).toBe(2);
      workers[1]!.answer(workers[1]!.sent[0]!.id, "B");
      expect((yield* Fiber.join(next)).patch).toBe("B");
    }),
  );

  it.effect("replaces a stuck worker: the pair waited for fails, the others are asked again", () =>
    Effect.gen(function* () {
      const workers = [fakeWorker(), fakeWorker()];
      let spawned = 0;
      const client = lineUpClient(() => workers[spawned++]!.worker, "10 seconds");
      const stuck = yield* Effect.forkChild(client.lineUp(request("a")));

      yield* TestClock.adjust("5 seconds");

      const later = yield* Effect.forkChild(client.lineUp(request("b")));

      yield* settle;
      yield* TestClock.adjust("5 seconds");

      expect(Exit.isFailure(yield* Fiber.await(stuck))).toBe(true);
      expect(workers[0]!.terminated()).toBe(true);
      expect(workers[1]!.sent.map((message) => message.request.newName)).toEqual(["b"]);

      workers[1]!.answer(workers[1]!.sent[0]!.id, "B");
      expect((yield* Fiber.join(later)).patch).toBe("B");
    }),
  );
});
