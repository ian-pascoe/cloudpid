// The Session's side of the Browser Pane: an archived Session opens nothing, the host's "the Owner tab is gone" reaches
// the client in its own words, and an ask that opened an Owner tab is a use of the browser for its idle close.
// @effect-diagnostics strictEffectProvide:off anyUnknownInErrorContext:off
import { OWNER_TAB_GONE } from "@cloudpid/protocol/live-view";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { fakeHandoffHost, LIVE_VIEW_LINKS } from "./host.fixture.ts";
import { BROWSER_IDLE_MS, BrowserError, type BrowserHostService } from "./host.ts";
import { ARCHIVED_OPENS_NO_OWNER_TAB, makeBrowserPane } from "./pane.ts";
import { makeBrowserSession, WATCH_WRITE_MS } from "./session.ts";

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
  let opens = 0;
  const listed = { count: 0 };

  const host: BrowserHostService = {
    ...fakeHandoffHost().host,
    ownerTabs: Effect.sync(() => {
      listed.count += 1;

      return gone ? { tabs: [] } : { tabs: [{ id: "owner-1", title: "" }], shown: "owner-1" };
    }),
    openOwnerTab: Effect.sync(() => {
      tab = true;
      opens += 1;

      return { tabs: [{ id: "owner-2", title: "" }], shown: "owner-2" };
    }),
    showOwnerTab: () =>
      Effect.fail(BrowserError.make({ message: `showOwnerTab: Error: ${OWNER_TAB_GONE}` })),
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

  return { host, asked, opens: () => opens, listed };
};

const setup = (options: { readonly archived?: boolean; readonly gone?: boolean } = {}) => {
  const { host, asked, opens, listed } = fakeHost(options.gone);
  const session = makeBrowserSession({ host, storage: memoryStorage() });

  const pane = makeBrowserPane(
    { host, archived: Effect.succeed(options.archived === true) },
    session,
  );

  return { pane, session, asked, opens, listed };
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

  test("opens a new Owner tab for the tab strip, a use of the browser, unless the Session is archived", () =>
    Effect.gen(function* () {
      const { pane, session, opens } = setup();

      yield* TestClock.adjust(1_000);
      expect((yield* pane.open).shown).toBe("owner-2");
      expect(opens()).toBe(1);
      expect(yield* session.closeAt).toBe(1_000 + BROWSER_IDLE_MS);

      const archived = setup({ archived: true });

      expect(yield* failure(archived.pane.open)).toBe(ARCHIVED_OPENS_NO_OWNER_TAB);
      expect(archived.opens()).toBe(0);
      expect(yield* archived.session.closeAt).toBeUndefined();
    }));

  test("lists, shows and closes Owner tabs through the host, with the host's gone in its own words", () =>
    Effect.gen(function* () {
      const { pane, session } = setup();

      expect((yield* pane.tabs).shown).toBe("owner-1");
      expect(yield* pane.close("owner-1")).toEqual({ tabs: [] });
      expect(yield* failure(pane.show("nope"))).toBe(OWNER_TAB_GONE);
      // None of these is a use of the browser.
      expect(yield* session.closeAt).toBeUndefined();
    }));

  test("keeps the browser for a Pane in view: its listing is a heartbeat the idle close counts from", () =>
    Effect.gen(function* () {
      const { pane, session, listed } = setup();

      yield* pane.view(true);
      yield* TestClock.adjust(BROWSER_IDLE_MS - 1_000);

      const beat = yield* pane.watchedTabs;

      expect(beat.tabs.shown).toBe("owner-1");
      expect(listed.count).toBe(1);
      expect(yield* session.closeAt).toBe(BROWSER_IDLE_MS - 1_000 + BROWSER_IDLE_MS);
      expect(beat.arm).toBe(false);
    }));

  test("holds nothing for a listing that is not a heartbeat", () =>
    Effect.gen(function* () {
      const { pane, session } = setup();

      yield* pane.view(true);

      const opened = yield* session.closeAt;

      yield* TestClock.adjust(WATCH_WRITE_MS * 2);
      yield* pane.tabs;

      expect(yield* session.closeAt).toBe(opened);
    }));

  test("notes no beat when the host has no Owner tabs: a Pane that finds its browser gone holds nothing open", () =>
    Effect.gen(function* () {
      const { pane, session } = setup({ gone: true });

      expect((yield* pane.watchedTabs).tabs.tabs).toEqual([]);
      expect(yield* session.closeAt).toBeUndefined();
    }));

  test("says the Session must settle to arm the wake only when the beat left no close time before", () =>
    Effect.gen(function* () {
      const { pane, session } = setup();

      yield* pane.view(true);
      // Opening was a use, so a wake is armed already.
      expect((yield* pane.watchedTabs).arm).toBe(false);

      // The idle close ran (the browser is still the host's, as when the close failed): a beat sets a new close time.
      yield* TestClock.adjust(BROWSER_IDLE_MS);
      yield* session.closeIfIdle;

      expect((yield* pane.watchedTabs).arm).toBe(true);
      expect((yield* pane.watchedTabs).arm).toBe(false);
    }));
});
