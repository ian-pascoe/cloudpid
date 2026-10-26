// The Session's hold on its browser: when it was last used, when it falls idle past its keep-alive, and closing it
// then, across an "eviction" (a second service over the same storage).
// @effect-diagnostics strictEffectProvide:off anyUnknownInErrorContext:off
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { fakeHandoffHost } from "./host.fixture.ts";
import { BROWSER_IDLE_MS, BrowserError, type BrowserHostService } from "./host.ts";
import { type BrowserStorage, makeBrowserSession, WATCH_WRITE_MS } from "./session.ts";

/** A Durable Object's key-value storage, in memory. */
const memoryStorage = (): BrowserStorage => {
  const map = new Map<string, unknown>();

  return {
    // SAFETY: the service reads back only what it wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => {
      map.set(key, structuredClone(value));
    },
    delete: (key) => map.delete(key),
  };
};

/** A host that counts the closes it is asked for, and fails them when `failing`. */
const fakeHost = (failing = false) => {
  const closes = { count: 0 };

  const host: BrowserHostService = {
    ...fakeHandoffHost().host,
    describe: Effect.succeed("drives a browser"),
    run: () => Effect.succeed({ output: [] }),
    close: Effect.suspend(() => {
      closes.count += 1;

      return failing
        ? Effect.fail(BrowserError.make({ message: "unreachable" }))
        : Effect.succeed(true);
    }),
  };

  return { host, closes };
};

const test = (name: string, body: () => Effect.Effect<void, unknown>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))));

describe("the Session's browser keep-alive", () => {
  test("has nothing to close, and no reason to wake, before the browser is used", () =>
    Effect.gen(function* () {
      const { host, closes } = fakeHost();
      const session = makeBrowserSession({ host, storage: memoryStorage() });

      expect(yield* session.closeAt).toBeUndefined();

      yield* session.closeIfIdle;

      expect(closes.count).toBe(0);
    }));

  test("keeps the browser until its keep-alive has passed since it was last used", () =>
    Effect.gen(function* () {
      const { host, closes } = fakeHost();
      const session = makeBrowserSession({ host, storage: memoryStorage() });

      yield* TestClock.adjust(1_000);
      yield* session.touch;
      yield* TestClock.adjust(BROWSER_IDLE_MS - 1);

      expect(yield* session.closeAt).toBe(1_000 + BROWSER_IDLE_MS);

      yield* session.closeIfIdle;

      expect(closes.count).toBe(0);
    }));

  test("closes the browser once idle past its keep-alive, once", () =>
    Effect.gen(function* () {
      const { host, closes } = fakeHost();
      const session = makeBrowserSession({ host, storage: memoryStorage() });

      yield* session.touch;
      yield* TestClock.adjust(BROWSER_IDLE_MS);
      yield* session.closeIfIdle;
      yield* session.closeIfIdle;

      expect(closes.count).toBe(1);
      expect(yield* session.closeAt).toBeUndefined();
    }));

  test("counts a later use from then, not from the first", () =>
    Effect.gen(function* () {
      const { host, closes } = fakeHost();
      const session = makeBrowserSession({ host, storage: memoryStorage() });

      yield* session.touch;
      yield* TestClock.adjust(BROWSER_IDLE_MS - 1);
      yield* session.touch;
      yield* TestClock.adjust(BROWSER_IDLE_MS - 1);
      yield* session.closeIfIdle;

      expect(closes.count).toBe(0);
      expect(yield* session.closeAt).toBe(BROWSER_IDLE_MS - 1 + BROWSER_IDLE_MS);
    }));

  test("closes a browser used before the object was evicted", () =>
    Effect.gen(function* () {
      const storage = memoryStorage();
      const { host, closes } = fakeHost();

      yield* makeBrowserSession({ host, storage }).touch;
      yield* TestClock.adjust(BROWSER_IDLE_MS);

      const next = makeBrowserSession({ host, storage });

      expect(yield* next.closeAt).toBe(BROWSER_IDLE_MS);

      yield* next.closeIfIdle;

      expect(closes.count).toBe(1);
    }));

  test("gives up on a close that takes too long, so the Session is not held up", () =>
    Effect.gen(function* () {
      const closes = { count: 0 };

      const host: BrowserHostService = {
        ...fakeHandoffHost().host,
        describe: Effect.succeed("drives a browser"),
        run: () => Effect.succeed({ output: [] }),
        close: Effect.suspend(() => {
          closes.count += 1;

          return Effect.never;
        }),
      };

      const session = makeBrowserSession({ host, storage: memoryStorage() });

      yield* session.touch;
      yield* TestClock.adjust(BROWSER_IDLE_MS);

      const closing = yield* Effect.forkChild(session.closeIfIdle);

      yield* TestClock.adjust(5_000);
      yield* Fiber.join(closing);

      expect(closes.count).toBe(1);
      expect(yield* session.closeAt).toBeUndefined();
    }));

  test("lets go of a browser it cannot close: Browser Run reclaims it itself", () =>
    Effect.gen(function* () {
      const { host, closes } = fakeHost(true);
      const session = makeBrowserSession({ host, storage: memoryStorage() });

      yield* session.touch;
      yield* TestClock.adjust(BROWSER_IDLE_MS);
      yield* session.closeIfIdle;
      yield* session.closeIfIdle;

      expect(closes.count).toBe(1);
      expect(yield* session.closeAt).toBeUndefined();
    }));
});

describe("the Session's browser keep-alive while a Browser Pane is in view", () => {
  test("holds the idle close off while the Pane's heartbeat is fresh, and runs it once the heartbeat lapses", () =>
    Effect.gen(function* () {
      const { host, closes } = fakeHost();
      const session = makeBrowserSession({ host, storage: memoryStorage() });

      yield* session.touch;

      // The Pane beats every 5 s for half an hour: the browser is never idle past the window.
      for (let beat = 0; beat < 360; beat++) {
        yield* TestClock.adjust(5_000);
        yield* session.watch;
        yield* session.closeIfIdle;
      }

      expect(closes.count).toBe(0);

      // Written at most every `WATCH_WRITE_MS`, so the close time trails the last beat by less than that.
      const at = (yield* session.closeAt) ?? 0;

      expect(at).toBeGreaterThan(30 * 60_000 - WATCH_WRITE_MS + BROWSER_IDLE_MS);
      expect(at).toBeLessThanOrEqual(30 * 60_000 + BROWSER_IDLE_MS);

      // The Pane goes out of view: the last beat kept counts, and the browser closes once the window has passed since it.
      yield* TestClock.adjust(at - 30 * 60_000 - 1);
      yield* session.closeIfIdle;

      expect(closes.count).toBe(0);

      yield* TestClock.adjust(1);
      yield* session.closeIfIdle;

      expect(closes.count).toBe(1);
      expect(yield* session.closeAt).toBeUndefined();
    }));

  test("keeps a use that came after the last beat, and a beat that came after the last use", () =>
    Effect.gen(function* () {
      const { host } = fakeHost();
      const session = makeBrowserSession({ host, storage: memoryStorage() });

      yield* session.watch;
      yield* TestClock.adjust(1_000);
      yield* session.touch;

      expect(yield* session.closeAt).toBe(1_000 + BROWSER_IDLE_MS);

      yield* TestClock.adjust(WATCH_WRITE_MS);
      yield* session.watch;

      expect(yield* session.closeAt).toBe(1_000 + WATCH_WRITE_MS + BROWSER_IDLE_MS);
    }));

  test("writes a beat down at most every WATCH_WRITE_MS, the first at once", () =>
    Effect.gen(function* () {
      const writes: number[] = [];
      const inner = memoryStorage();
      const { host } = fakeHost();

      const storage: BrowserStorage = {
        ...inner,
        put: (key, value) => {
          writes.push(1);
          inner.put(key, value);
        },
      };

      const session = makeBrowserSession({ host, storage });

      yield* session.watch;

      for (let beat = 0; beat < 5; beat++) {
        yield* TestClock.adjust(5_000);
        yield* session.watch;
      }

      expect(writes).toHaveLength(1);

      yield* TestClock.adjust(WATCH_WRITE_MS);
      yield* session.watch;

      expect(writes).toHaveLength(2);
    }));

  test("says whether a beat set a close time where there was none, for the Session to arm its wake", () =>
    Effect.gen(function* () {
      const { host } = fakeHost();
      const session = makeBrowserSession({ host, storage: memoryStorage() });

      expect(yield* session.watch).toBe(true);
      yield* TestClock.adjust(1_000);
      expect(yield* session.watch).toBe(false);
    }));

  test("holds the idle close off across an eviction, and runs it once the beats stop", () =>
    Effect.gen(function* () {
      const storage = memoryStorage();
      const { host, closes } = fakeHost();

      yield* makeBrowserSession({ host, storage }).touch;
      yield* TestClock.adjust(BROWSER_IDLE_MS - 1_000);
      yield* makeBrowserSession({ host, storage }).watch;

      // The object was evicted and woke at the alarm the first use set: the beat since holds the close off.
      yield* TestClock.adjust(1_000);

      const woken = makeBrowserSession({ host, storage });

      yield* woken.closeIfIdle;

      expect(closes.count).toBe(0);
      expect(yield* woken.closeAt).toBe(BROWSER_IDLE_MS - 1_000 + BROWSER_IDLE_MS);

      // No beat comes: it wakes again at that time and closes.
      yield* TestClock.adjust(BROWSER_IDLE_MS - 1_000);

      const later = makeBrowserSession({ host, storage });

      yield* later.closeIfIdle;

      expect(closes.count).toBe(1);
      expect(yield* later.closeAt).toBeUndefined();
    }));
});
