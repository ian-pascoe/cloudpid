// @effect-diagnostics preferEffectArray:off -- a fake Session recording what it was asked in a native array.

import type { FileMatches } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, beforeEach, vi } from "vitest";
import { sessionStatusAtom } from "../session/atoms.ts";
import { SessionCommandError } from "../session/client.ts";
import { settle } from "../session/client.testing.ts";
import { chatRegistry, live, sent } from "./chat.testing.ts";
import { conversationKey } from "./conversation.ts";
import {
  FILE_ANSWER_TTL_MS,
  FILE_SEARCH_DEBOUNCE_MS,
  fileResults,
  fileSearchAtom,
  makeFileSearch,
  type FileSearch,
  searchFilesAtom,
} from "./file-search.ts";

/** A Session whose `files` requests wait until the test answers or fails them, one by one. */
const sessionOf = () => {
  const asked: {
    query: string;
    conversationId: number | undefined;
    answer: (paths: string[]) => Effect.Effect<void>;
    fail: () => Effect.Effect<void>;
  }[] = [];

  const files = (query: string, conversationId: number | undefined) =>
    Effect.gen(function* () {
      const answer = yield* Deferred.make<FileMatches, SessionCommandError>();

      asked.push({
        query,
        conversationId,
        answer: (paths) => Deferred.succeed(answer, { paths }).pipe(Effect.asVoid),
        fail: () =>
          Deferred.fail(answer, SessionCommandError.make({ message: "unreachable" })).pipe(
            Effect.asVoid,
          ),
      });

      return yield* Deferred.await(answer);
    });

  return { asked, files };
};

/**
 * The `@` menu's requests of each conversation's composer over a fresh Session: `set` says what the menu of
 * `conversationId`'s composer shows, and `view` what it would show for `query`.
 */
const setup = Effect.sync(() => {
  const session = sessionOf();
  const searches = new Map<number | undefined, FileSearch>();

  const searchOf = (
    conversationId: number | undefined,
  ): Effect.Effect<FileSearch, never, Scope.Scope> =>
    Effect.gen(function* () {
      const known = searches.get(conversationId);

      if (known !== undefined) return known;

      const search = yield* makeFileSearch((query) => session.files(query, conversationId));

      searches.set(conversationId, search);

      return search;
    });

  const store = {
    set: (conversationId: number | undefined, query: string | null) =>
      searchOf(conversationId).pipe(
        Effect.flatMap((search) => search.set(query)),
        Effect.andThen(settle),
      ),
    getSnapshot: (conversationId?: number) =>
      searchOf(conversationId).pipe(Effect.flatMap((search) => SubscriptionRef.get(search.state))),
  };

  const view = (conversationId: number | undefined, query: string | null) =>
    store.getSnapshot(conversationId).pipe(Effect.map((state) => fileResults(state, query)));

  return { ...session, store, view };
});

/** Move the clock on by `ms`, and let what it woke run. */
const advance = (ms: number) => TestClock.adjust(ms).pipe(Effect.andThen(settle));

/** Let the answers settle. */
const flush = settle;

describe("the @ menu's requests", () => {
  it.effect("asks once the owner pauses, not at every key", () =>
    Effect.gen(function* () {
      const { asked, store, view } = yield* setup;

      yield* store.set(undefined, "s");
      yield* store.set(undefined, "sr");
      yield* store.set(undefined, "src");

      expect(yield* view(undefined, "src")).toEqual({
        query: null,
        paths: [],
        searching: true,
        failed: false,
      });

      yield* advance(FILE_SEARCH_DEBOUNCE_MS);

      expect(asked.map(({ query }) => query)).toEqual(["src"]);

      yield* asked[0]!.answer(["src/"]);
      yield* flush;

      expect(yield* view(undefined, "src")).toEqual({
        query: "src",
        paths: ["src/"],
        searching: false,
        failed: false,
      });
    }),
  );

  it.effect("drops an answer overtaken by a newer request's", () =>
    Effect.gen(function* () {
      const { asked, store, view } = yield* setup;

      yield* store.set(undefined, "a");
      yield* advance(FILE_SEARCH_DEBOUNCE_MS);
      yield* store.set(undefined, "ab");
      yield* advance(FILE_SEARCH_DEBOUNCE_MS);

      yield* asked[1]!.answer(["ab.ts"]);
      yield* flush;
      yield* asked[0]!.answer(["a.ts", "ab.ts"]);
      yield* flush;

      expect((yield* view(undefined, "ab")).paths).toEqual(["ab.ts"]);
    }),
  );

  it.effect("says a request failed, then shows the answer once one comes", () =>
    Effect.gen(function* () {
      const { asked, store, view } = yield* setup;

      yield* store.set(undefined, "x");
      yield* advance(FILE_SEARCH_DEBOUNCE_MS);
      yield* asked[0]!.fail();
      yield* flush;

      expect(yield* view(undefined, "x")).toMatchObject({ failed: true, searching: false });

      // Typing on asks again.
      yield* store.set(undefined, "xy");
      expect(yield* view(undefined, "xy")).toMatchObject({ failed: false, searching: true });

      yield* advance(FILE_SEARCH_DEBOUNCE_MS);
      yield* asked[1]!.answer(["xy.ts"]);
      yield* flush;

      expect(yield* view(undefined, "xy")).toEqual({
        query: "xy",
        paths: ["xy.ts"],
        searching: false,
        failed: false,
      });
    }),
  );

  it.effect("clears a failure when the menu closes, and asks again when it opens", () =>
    Effect.gen(function* () {
      const { asked, store } = yield* setup;

      yield* store.set(undefined, "x");
      yield* advance(FILE_SEARCH_DEBOUNCE_MS);
      yield* asked[0]!.fail();
      yield* flush;
      yield* store.set(undefined, null);

      expect((yield* store.getSnapshot()).failed).toBeNull();

      yield* store.set(undefined, "x");
      yield* advance(FILE_SEARCH_DEBOUNCE_MS);

      expect(asked.map(({ query }) => query)).toEqual(["x", "x"]);
    }),
  );

  it.effect("asks again when the menu reopens, showing the last answer meanwhile", () =>
    Effect.gen(function* () {
      const { asked, store, view } = yield* setup;

      yield* store.set(undefined, "");
      yield* advance(FILE_SEARCH_DEBOUNCE_MS);
      yield* asked[0]!.answer(["a.ts"]);
      yield* flush;

      // The same query again while the menu is open is answered already.
      yield* store.set(undefined, "a");
      yield* store.set(undefined, "");
      yield* advance(FILE_SEARCH_DEBOUNCE_MS);

      expect(asked).toHaveLength(1);

      yield* store.set(undefined, null);
      yield* store.set(undefined, "");

      expect((yield* view(undefined, "")).paths).toEqual(["a.ts"]);

      yield* advance(FILE_SEARCH_DEBOUNCE_MS);

      expect(asked).toHaveLength(2);

      yield* asked[1]!.answer(["a.ts", "b.ts"]);
      yield* flush;

      expect((yield* view(undefined, "")).paths).toEqual(["a.ts", "b.ts"]);
    }),
  );

  it.effect("asks again for a query whose answer is older than its time to live", () =>
    Effect.gen(function* () {
      const { asked, store } = yield* setup;

      yield* store.set(undefined, "a");
      yield* advance(FILE_SEARCH_DEBOUNCE_MS);
      yield* asked[0]!.answer(["a.ts"]);
      yield* flush;

      yield* advance(FILE_ANSWER_TTL_MS);
      yield* store.set(undefined, "ab");
      yield* store.set(undefined, "a");
      yield* advance(FILE_SEARCH_DEBOUNCE_MS);

      expect(asked.map(({ query }) => query)).toEqual(["a", "a"]);
    }),
  );

  it.effect("starts over in another conversation, dropping answers for the one before", () =>
    Effect.gen(function* () {
      const { asked, store, view } = yield* setup;

      yield* store.set(undefined, "a");
      yield* advance(FILE_SEARCH_DEBOUNCE_MS);

      yield* store.set(7, "a");

      expect(yield* view(7, "a")).toEqual({
        query: null,
        paths: [],
        searching: true,
        failed: false,
      });

      yield* asked[0]!.answer(["root.ts"]);
      yield* flush;

      expect((yield* view(7, "a")).paths).toEqual([]);

      yield* advance(FILE_SEARCH_DEBOUNCE_MS);

      expect(asked[1]).toMatchObject({ query: "a", conversationId: 7 });

      yield* asked[1]!.answer(["child.ts"]);
      yield* flush;

      expect((yield* view(7, "a")).paths).toEqual(["child.ts"]);
    }),
  );
});

describe("a conversation's file search atoms", () => {
  const ROOT = conversationKey("s1", undefined);

  /** A live Session whose root composer's `@` menu is open. */
  const atoms = Effect.gen(function* () {
    const chat = chatRegistry();

    chat.registry.mount(sessionStatusAtom("s1"));
    chat.registry.mount(fileSearchAtom(ROOT));
    chat.registry.mount(searchFilesAtom(ROOT));
    yield* settle;
    yield* live(chat.latest());

    const type = (query: string | null) =>
      Effect.sync(() => {
        chat.registry.set(searchFilesAtom(ROOT), query);
      }).pipe(Effect.andThen(settle));

    const wait = (ms: number) =>
      Effect.sync(() => {
        vi.advanceTimersByTime(ms);
      }).pipe(Effect.andThen(settle));

    const asked = () => sent(chat.latest(), "files");

    const answer = (index: number, paths: string[]) =>
      chat.latest().say({ type: "result", id: asked()[index]?.id, result: { paths } });

    const view = (query: string | null) =>
      fileResults(chat.registry.get(fileSearchAtom(ROOT)), query);

    return { ...chat, type, wait, asked, answer, view };
  });

  beforeEach(() => {
    vi.stubGlobal("window", { location: { href: "https://example.test/sessions/s1" } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.effect("send the query once the owner pauses for 120 ms", () =>
    Effect.gen(function* () {
      const { type, wait, asked, answer, view } = yield* atoms;

      yield* type("s");
      yield* wait(FILE_SEARCH_DEBOUNCE_MS - 1);
      yield* type("sr");
      yield* wait(FILE_SEARCH_DEBOUNCE_MS - 1);

      expect(asked()).toEqual([]);

      yield* wait(1);

      expect(asked()).toEqual([{ type: "files", id: asked()[0]?.id, query: "sr" }]);

      yield* answer(0, ["src/"]);

      expect(view("sr")).toEqual({ query: "sr", paths: ["src/"], searching: false, failed: false });
    }),
  );

  it.effect("keep the last answer to narrow while the next is asked for", () =>
    Effect.gen(function* () {
      const { type, wait, answer, view } = yield* atoms;

      yield* type("s");
      yield* wait(FILE_SEARCH_DEBOUNCE_MS);
      yield* answer(0, ["src/", "scripts/"]);
      yield* type("sr");

      expect(view("sr")).toEqual({
        query: "s",
        paths: ["src/", "scripts/"],
        searching: true,
        failed: false,
      });
    }),
  );

  it.effect("serve an answer for 30 s while the menu stays open, then ask again", () =>
    Effect.gen(function* () {
      const { type, wait, asked, answer } = yield* atoms;

      yield* type("a");
      yield* wait(FILE_SEARCH_DEBOUNCE_MS);
      yield* answer(0, ["a.ts"]);
      yield* type("ab");
      yield* type("a");
      yield* wait(FILE_SEARCH_DEBOUNCE_MS);

      expect(asked()).toHaveLength(1);

      // The page's clock alone, so the socket's heartbeat does not run.
      // @effect-diagnostics-next-line globalDateInEffect:off
      vi.setSystemTime(Date.now() + FILE_ANSWER_TTL_MS);
      yield* type("ab");
      yield* type("a");
      yield* wait(FILE_SEARCH_DEBOUNCE_MS);

      expect(asked().map((command) => command.query)).toEqual(["a", "a"]);
    }),
  );

  it.effect("say when the search failed, until the menu closes", () =>
    Effect.gen(function* () {
      const { registry, latest, type, wait, asked, view } = yield* atoms;

      yield* type("x");
      yield* wait(FILE_SEARCH_DEBOUNCE_MS);
      yield* latest().say({ type: "error", id: asked()[0]?.id, message: "No Machine" });

      expect(view("x")).toMatchObject({ failed: true, searching: false });

      yield* type(null);

      expect(registry.get(fileSearchAtom(ROOT)).failed).toBeNull();
    }),
  );
});
