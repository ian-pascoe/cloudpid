// Approval requests (docs/spec.md → Approval): asked by a call, answered by the owner, and kept across an "eviction" (a
// second store over the same storage), withdrawn when the call is stopped or gone.
// @effect-diagnostics strictEffectProvide:off preferEffectArray:off asyncFunction:off
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import {
  type ApprovalAsk,
  type ApprovalCall,
  type ApprovalChange,
  type ApprovalStorage,
  makeApprovals,
  withApproval,
} from "./approvals.ts";

/** A Durable Object's key-value storage, in memory. */
const memoryStorage = (): ApprovalStorage => {
  const map = new Map<string, unknown>();

  return {
    // SAFETY: the store reads back only what it wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => {
      map.set(key, structuredClone(value));
    },
    delete: (key) => map.delete(key),
  };
};

/** A store over `storage`, recording every list of waiting requests it announces and each new request. */
const open = (storage: ApprovalStorage) =>
  Effect.gen(function* () {
    const announced: (readonly ApprovalAsk[])[] = [];
    const asked: ApprovalAsk[] = [];

    const approvals = yield* makeApprovals({
      storage,
      announce: (requests) =>
        Effect.sync(() => {
          announced.push(requests);
        }),
      asked: (request) =>
        Effect.sync(() => {
          asked.push(request);
        }),
    });

    return { approvals, announced, asked };
  });

const CHANGE: ApprovalChange = {
  tool: "settings_spend_limit_set",
  target: "the Settings",
  change: "Spend limit per Session",
  before: "$5",
  after: "$10",
  reason: "The refactor needs more requests",
  expected: 5,
};

const API: ApprovalCall = { taskId: 7, conversationId: 1 };

const REQUEST: ApprovalAsk = { ...CHANGE, id: "7", conversationId: 1 };

/** A moment for the fibers forked so far to run. */
const settle = Effect.sleep("20 millis");

describe("Approval requests", () => {
  it("show the request to every client, notify the owner once, and hand the call the owner's Approve", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { approvals, announced, asked } = yield* open(memoryStorage());

        const call = yield* Effect.forkChild(
          withApproval(approvals, API, CHANGE, (answer) => Effect.succeed(answer)),
        );

        yield* settle;

        expect(yield* approvals.pending).toEqual([REQUEST]);
        expect(announced.at(-1)).toEqual([REQUEST]);
        expect(asked).toEqual([REQUEST]);

        yield* approvals.answer("7", { approve: true });

        const answer = yield* Fiber.join(call);

        expect(announced.at(-1)).toEqual([]);
        expect(yield* approvals.pending).toEqual([]);

        return answer;
      }),
    );

    expect(result).toEqual({ approved: true, expected: 5 });
  });

  it("hand the call a Decline with the owner's reason, and refuse an answer to a request that does not wait", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { approvals } = yield* open(memoryStorage());

        const call = yield* Effect.forkChild(
          withApproval(approvals, API, CHANGE, (answer) => Effect.succeed(answer)),
        );

        yield* settle;
        yield* approvals.answer("7", { approve: false, reason: "  Too much  " });

        const answer = yield* Fiber.join(call);
        const late = yield* Effect.exit(approvals.answer("7", { approve: true }));

        return { answer, late };
      }),
    );

    expect(result.answer).toEqual({ approved: false, reason: "Too much", expected: 5 });
    expect(Exit.isFailure(result.late)).toBe(true);
  });

  it("keep the request through an eviction: the rerun waits for the one the owner sees, not one it reads again", async () => {
    const storage = memoryStorage();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* open(storage);

        // The call that asked is cut off by the eviction: nothing of it runs on.
        yield* Effect.forkDetach(first.approvals.ask(REQUEST));
        yield* settle;

        const second = yield* open(storage);

        expect(yield* second.approvals.pending).toEqual([REQUEST]);

        const call = yield* Effect.forkChild(
          withApproval(second.approvals, API, { ...CHANGE, before: "$6", expected: 6 }, (answer) =>
            Effect.succeed(answer),
          ),
        );

        yield* settle;

        // Not asked again: the owner's notification and card are the first call's.
        expect(second.asked).toEqual([]);
        expect(yield* second.approvals.pending).toEqual([REQUEST]);

        yield* second.approvals.answer("7", { approve: true });

        return yield* Fiber.join(call);
      }),
    );

    expect(result).toEqual({ approved: true, expected: 5 });
  });

  it("keep an answer the owner gave while no call waited, for the rerun to take", async () => {
    const storage = memoryStorage();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* open(storage);

        yield* Effect.forkDetach(first.approvals.ask(REQUEST));
        yield* settle;

        const second = yield* open(storage);

        yield* second.approvals.answer("7", { approve: false });

        const answer = yield* withApproval(second.approvals, API, CHANGE, (given) =>
          Effect.succeed(given),
        );

        // Settled with the call: a later rerun would ask again.
        return { answer, pending: yield* second.approvals.pending };
      }),
    );

    expect(result).toEqual({
      answer: { approved: false, reason: undefined, expected: 5 },
      pending: [],
    });
  });

  it("withdraw the request when the call is stopped, so the card goes on every client", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { approvals, announced } = yield* open(memoryStorage());

        const call = yield* Effect.forkChild(
          withApproval(approvals, API, CHANGE, (answer) => Effect.succeed(answer)),
        );

        yield* settle;
        yield* Fiber.interrupt(call);

        return { pending: yield* approvals.pending, last: announced.at(-1) };
      }),
    );

    expect(result).toEqual({ pending: [], last: [] });
  });

  it("withdraw, once idle, the requests whose call is gone, and keep the ones a call waits for", async () => {
    const storage = memoryStorage();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* open(storage);

        yield* Effect.forkDetach(first.approvals.ask(REQUEST));
        yield* settle;

        const second = yield* open(storage);
        const waiting = yield* Effect.forkChild(second.approvals.ask({ ...REQUEST, id: "8" }));

        yield* settle;
        yield* second.approvals.dropAbandoned;

        const pending = yield* second.approvals.pending;

        yield* Fiber.interrupt(waiting);

        return pending;
      }),
    );

    expect(result).toEqual([{ ...REQUEST, id: "8" }]);
  });
});
