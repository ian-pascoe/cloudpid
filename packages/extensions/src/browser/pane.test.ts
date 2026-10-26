// The Session's side of the Browser Pane: an archived Session opens nothing, the host's "the Owner tab is gone" reaches
// the client in its own words, and an ask that opened an Owner tab is a use of the browser for its idle close.
// @effect-diagnostics strictEffectProvide:off anyUnknownInErrorContext:off
import { OWNER_TAB_GONE } from "@cloudpid/protocol/live-view";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { fakeHandoffHost, LIVE_VIEW_LINKS } from "./host.fixture.ts";
import { BROWSER_IDLE_MS, BrowserError, type BrowserHostService } from "./host.ts";
import { makeBrowserPane } from "./pane.ts";
import { makeBrowserSession } from "./session.ts";

/** A Durable Object's key-value storage, in memory. */
const memoryStorage = () => {
  const map = new Map<string, unknown>();

  return {
    // SAFETY: the service reads back only what it wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
  };
};

/**
 * A host with no Owner tab until an ask with `open` opens one, which it then shows; `gone` makes every ask fail as the
 * real host's call does when the tab is gone.
 */
const fakeHost = (gone = false) => {
  const asked: boolean[] = [];
  let tab = false;

  const host: BrowserHostService = {
    ...fakeHandoffHost().host,
    ownerTabView: (open) =>
      Effect.suspend(() => {
        asked.push(open);

        if (gone || (!open && !tab)) {
          return Effect.fail(
            BrowserError.make({ message: `ownerTabView: Error: ${OWNER_TAB_GONE}` }),
          );
        }

        const opened = !tab;

        tab = true;

        return Effect.succeed({
          ownerTabId: "owner-1",
          ...LIVE_VIEW_LINKS,
          opened,
          replaced: false,
        });
      }),
  };

  return { host, asked };
};

const setup = (options: { readonly archived?: boolean; readonly gone?: boolean } = {}) => {
  const { host, asked } = fakeHost(options.gone);
  const session = makeBrowserSession({ host, storage: memoryStorage() });

  const pane = makeBrowserPane(
    { host, archived: Effect.succeed(options.archived === true) },
    session,
  );

  return { pane, session, asked };
};

const test = (name: string, body: () => Effect.Effect<void, unknown>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))));

const failure = <A>(effect: Effect.Effect<A, BrowserError>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.message));

describe("the Session's Browser Pane", () => {
  test("notes a use of the browser when an ask opened an Owner tab, so the idle close counts from it", () =>
    Effect.gen(function* () {
      const { pane, session } = setup();

      yield* TestClock.adjust(1_000);

      expect(yield* session.closeAt).toBeUndefined();
      expect((yield* pane.view(true)).opened).toBe(true);
      expect(yield* session.closeAt).toBe(1_000 + BROWSER_IDLE_MS);

      // Showing the same tab again, or a reconnect, opens nothing and is not a use.
      yield* TestClock.adjust(1_000);
      yield* pane.view(true);
      yield* pane.view(false);

      expect(yield* session.closeAt).toBe(1_000 + BROWSER_IDLE_MS);
    }));

  test("asks an archived Session's host without opening, so nothing is started or opened", () =>
    Effect.gen(function* () {
      const { pane, session, asked } = setup({ archived: true });

      expect(yield* failure(pane.view(true))).toBe(OWNER_TAB_GONE);
      expect(asked).toEqual([false]);
      expect(yield* session.closeAt).toBeUndefined();
    }));

  test("says the Owner tab is gone in the host's own words", () =>
    Effect.gen(function* () {
      const { pane, asked } = setup({ gone: true });

      expect(yield* failure(pane.view(false))).toBe(OWNER_TAB_GONE);
      expect(yield* failure(pane.view(true))).toBe(OWNER_TAB_GONE);
      expect(asked).toEqual([false, true]);
    }));
});
