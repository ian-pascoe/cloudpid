// A Browser Handoff's request (`./handoff.ts`): shown to the owner and pushed, waited on until the owner finishes or it
// times out, withdrawn when its call ends, and found again after an eviction (a second store over the same storage).
// @effect-diagnostics strictEffectProvide:off anyUnknownInErrorContext:off
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { type HandoffRequest, makeHandoffs } from "./handoff.ts";
import { fakeHandoffHost, LIVE_VIEW_URL } from "./host.fixture.ts";
import { BrowserError, type BrowserHostService, type HandoffStatus } from "./host.ts";
import type { PushNotice } from "../notify.ts";

const TIMEOUT_MS = 60_000;
const POLL_MS = 1_000;

const memoryStorage = () => {
  const map = new Map<string, unknown>();

  return {
    // SAFETY: the store reads back only what it wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
  };
};

/** A Session's handoffs over `host`, with what the clients were told and what the owner was pushed. */
const sessionOver = (
  host: BrowserHostService,
  storage = memoryStorage(),
  announced: ReadonlyArray<HandoffRequest>[] = [],
  notices: PushNotice[] = [],
) => {
  const uses = { count: 0 };

  const handoffs = makeHandoffs(
    {
      host,
      storage,
      announce: (requests) =>
        Effect.sync(() => {
          announced.push(requests);
        }),
      timeoutMs: TIMEOUT_MS,
      pollMs: POLL_MS,
    },
    {
      touch: Effect.sync(() => {
        uses.count += 1;
      }),
    },
    {
      notify: (event) =>
        Effect.sync(() => {
          if (event.kind === "notice") notices.push(event);
        }),
    },
  );

  return { handoffs, storage, announced, notices, uses };
};

const ASK = { id: "7", conversationId: 3, instructions: "Log in, then press Done" };

const hostWaiting = (...waits: ReadonlyArray<HandoffStatus | BrowserError>) =>
  fakeHandoffHost(waits, { now: () => 0 });

const test = (name: string, body: () => Effect.Effect<void, unknown>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))));

describe("a Browser Handoff", () => {
  test("shows the owner the link and the instructions, pushes it, and resumes when the owner finishes", () =>
    Effect.gen(function* () {
      const { host, calls } = hostWaiting(
        { state: "waiting" },
        { state: "complete", success: true },
      );

      const { handoffs, announced, notices, uses } = sessionOver(host);

      const asking = yield* Effect.forkChild(handoffs.request(ASK));

      yield* TestClock.adjust(POLL_MS);

      expect(yield* Fiber.join(asking)).toEqual({ status: "completed" });
      expect(calls.started).toEqual([
        {
          requestId: "7",
          conversationId: 3,
          instructions: ASK.instructions,
          timeoutMs: TIMEOUT_MS,
        },
      ]);

      const request = { ...ASK, url: LIVE_VIEW_URL, deadline: TIMEOUT_MS };

      // Shown while it waited, withdrawn once it ended, and its handoff ended in the host.
      expect(announced).toEqual([[request], []]);
      expect(calls.ended).toEqual(["7"]);
      expect(notices).toEqual([
        {
          kind: "notice",
          body: "Needs you in the browser: Log in, then press Done",
          url: LIVE_VIEW_URL,
        },
      ]);
      // The browser counts as used while the owner works in it.
      expect(uses.count).toBeGreaterThanOrEqual(2);
      expect(yield* handoffs.pending).toEqual([]);
    }));

  test("says that the owner could not do it, with their reason and never the link", () =>
    Effect.gen(function* () {
      const { host } = hostWaiting({
        state: "complete",
        success: false,
        reason: `captcha is broken at ${LIVE_VIEW_URL}`,
      });

      const { handoffs } = sessionOver(host);

      expect(yield* handoffs.request(ASK)).toEqual({
        status: "failed",
        reason: "captcha is broken at [Live View link]",
      });
    }));

  test("reports a timeout when the owner never answers", () =>
    Effect.gen(function* () {
      const { host, calls } = hostWaiting({ state: "waiting" });
      const { handoffs, announced } = sessionOver(host);

      const asking = yield* Effect.forkChild(handoffs.request(ASK));

      yield* TestClock.adjust(TIMEOUT_MS + 20_000);

      expect(yield* Fiber.join(asking)).toEqual({ status: "timeout" });
      expect(announced.at(-1)).toEqual([]);
      expect(calls.ended).toEqual(["7"]);
    }));

  test("reports a timeout when Browser Run timed the handoff out itself", () =>
    Effect.gen(function* () {
      const { host } = hostWaiting(
        ...Array.from({ length: 55 }, () => ({ state: "waiting" }) as const),
        { state: "complete", success: false, reason: "timeout" },
      );

      const { handoffs } = sessionOver(host);

      const asking = yield* Effect.forkChild(handoffs.request(ASK));

      // Round by round: each round's sleep starts when the last one ends.
      for (let round = 0; round < 60; round++) yield* TestClock.adjust(POLL_MS);

      expect(yield* Fiber.join(asking)).toEqual({ status: "timeout" });
    }));

  test("says that the handoff ended unexplained when Browser Run lost it", () =>
    Effect.gen(function* () {
      const { handoffs } = sessionOver(hostWaiting({ state: "ended" }).host);

      expect(yield* handoffs.request(ASK)).toEqual({ status: "ended" });
    }));

  test("withdraws the request and ends the handoff when its call is aborted", () =>
    Effect.gen(function* () {
      const { host, calls } = hostWaiting({ state: "waiting" });
      const { handoffs, announced } = sessionOver(host);

      const asking = yield* Effect.forkChild(handoffs.request(ASK));

      yield* TestClock.adjust(POLL_MS);
      expect(announced).toHaveLength(1);

      yield* Fiber.interrupt(asking);

      expect(announced.at(-1)).toEqual([]);
      expect(calls.ended).toEqual(["7"]);
      expect(yield* handoffs.pending).toEqual([]);
    }));

  test("keeps a pending handoff across an eviction: the rerun waits for the same one, without starting another", () =>
    Effect.gen(function* () {
      const storage = memoryStorage();

      const { host, calls } = hostWaiting(
        { state: "waiting" },
        { state: "complete", success: true },
      );

      const before = sessionOver(host, storage);

      // The first instance: asked, then cut off. An eviction runs no finalizer, so the request stays stored.
      yield* Effect.forkChild(before.handoffs.request(ASK));
      yield* TestClock.adjust(POLL_MS / 2);
      expect(storage.get("browser-handoffs")).toHaveLength(1);

      const after = sessionOver(host, storage);

      expect(yield* after.handoffs.pending).toEqual([
        { ...ASK, url: LIVE_VIEW_URL, deadline: TIMEOUT_MS },
      ]);

      const asking = yield* Effect.forkChild(after.handoffs.request(ASK));

      yield* TestClock.adjust(POLL_MS);

      expect(yield* Fiber.join(asking)).toEqual({ status: "completed" });
      expect(calls.started).toHaveLength(1);
      // The rerun does not push again: the owner was already told.
      expect(after.notices).toEqual([]);
    }));

  test("fails when the host cannot be reached, but rides out a failure or two", () =>
    Effect.gen(function* () {
      const down = BrowserError.make({ message: "waitHandoff: overloaded" });

      const flaky = sessionOver(hostWaiting(down, down, { state: "complete", success: true }).host);
      const recovering = yield* Effect.forkChild(flaky.handoffs.request(ASK));

      yield* TestClock.adjust(10_000);
      expect(yield* Fiber.join(recovering)).toEqual({ status: "completed" });

      const gone = sessionOver(hostWaiting(down).host);
      const failing = yield* Effect.forkChild(gone.handoffs.request(ASK).pipe(Effect.flip));

      yield* TestClock.adjust(10_000);
      expect(yield* Fiber.join(failing)).toEqual(down);
      expect(yield* gone.handoffs.pending).toEqual([]);
    }));

  test("fails when the browser cannot start a handoff, and shows nothing", () =>
    Effect.gen(function* () {
      const { host } = fakeHandoffHost([], {
        start: () => Effect.fail(BrowserError.make({ message: "The conversation has no tab" })),
      });

      const { handoffs, announced, notices } = sessionOver(host);

      expect((yield* Effect.flip(handoffs.request(ASK))).message).toBe(
        "The conversation has no tab",
      );
      expect(announced).toEqual([]);
      expect(notices).toEqual([]);
    }));

  test("ends the handoffs that no call waits for once the Session is idle, and keeps those one does", () =>
    Effect.gen(function* () {
      const { host, calls } = hostWaiting({ state: "waiting" });
      const stray: HandoffRequest = { ...ASK, id: "99", url: LIVE_VIEW_URL, deadline: TIMEOUT_MS };
      const storage = memoryStorage();

      storage.put("browser-handoffs", [stray]);

      const { handoffs, announced } = sessionOver(host, storage);

      const asking = yield* Effect.forkChild(handoffs.request(ASK));

      yield* TestClock.adjust(1);
      yield* handoffs.dropAbandoned;

      expect(calls.ended).toEqual(["99"]);
      expect(Arr.map(announced.at(-1) ?? [], (request) => request.id)).toEqual(["7"]);

      yield* Fiber.interrupt(asking);
    }));
});
