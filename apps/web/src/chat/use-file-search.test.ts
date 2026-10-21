// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferEffectArray:off -- tests of browser code with no Effect runtime.
import type { FileMatches } from "@cloudpid/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FILE_ANSWER_TTL_MS,
  FILE_SEARCH_DEBOUNCE_MS,
  fileResults,
  FileSearchStore,
} from "./use-file-search.ts";

/** A Session whose `files` requests wait until the test answers or fails them, one by one. */
const sessionOf = () => {
  const asked: {
    query: string;
    conversationId: number | undefined;
    answer: (paths: string[]) => void;
    fail: () => void;
  }[] = [];

  const files = (query: string, conversationId: number | undefined) =>
    new Promise<FileMatches>((resolve, reject) => {
      asked.push({
        query,
        conversationId,
        answer: (paths) => {
          resolve({ paths });
        },
        fail: () => {
          reject(new Error("unreachable"));
        },
      });
    });

  return { asked, files };
};

/** A store over a fresh Session, and what the menu would show for `query` in `conversationId`'s composer. */
const setup = () => {
  const session = sessionOf();
  const store = new FileSearchStore(session.files);

  const view = (conversationId: number | undefined, query: string | null) =>
    fileResults(store.getSnapshot(), conversationId, query);

  return { ...session, store, view };
};

/** Let the answers settle. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the @ menu's requests", () => {
  it("asks once the owner pauses, not at every key", async () => {
    const { asked, store, view } = setup();

    store.set(undefined, "s");
    store.set(undefined, "sr");
    store.set(undefined, "src");

    expect(view(undefined, "src")).toEqual({
      query: null,
      paths: [],
      searching: true,
      failed: false,
    });

    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);

    expect(asked.map(({ query }) => query)).toEqual(["src"]);

    asked[0]?.answer(["src/"]);
    await flush();

    expect(view(undefined, "src")).toEqual({
      query: "src",
      paths: ["src/"],
      searching: false,
      failed: false,
    });
  });

  it("drops an answer overtaken by a newer request's", async () => {
    const { asked, store, view } = setup();

    store.set(undefined, "a");
    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);
    store.set(undefined, "ab");
    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);

    asked[1]?.answer(["ab.ts"]);
    await flush();
    asked[0]?.answer(["a.ts", "ab.ts"]);
    await flush();

    expect(view(undefined, "ab").paths).toEqual(["ab.ts"]);
  });

  it("says a request failed, then shows the answer once one comes", async () => {
    const { asked, store, view } = setup();

    store.set(undefined, "x");
    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);
    asked[0]?.fail();
    await flush();

    expect(view(undefined, "x")).toMatchObject({ failed: true, searching: false });

    // Typing on asks again.
    store.set(undefined, "xy");
    expect(view(undefined, "xy")).toMatchObject({ failed: false, searching: true });

    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);
    asked[1]?.answer(["xy.ts"]);
    await flush();

    expect(view(undefined, "xy")).toEqual({
      query: "xy",
      paths: ["xy.ts"],
      searching: false,
      failed: false,
    });
  });

  it("clears a failure when the menu closes, and asks again when it opens", async () => {
    const { asked, store } = setup();

    store.set(undefined, "x");
    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);
    asked[0]?.fail();
    await flush();
    store.set(undefined, null);

    expect(store.getSnapshot().failed).toBeNull();

    store.set(undefined, "x");
    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);

    expect(asked.map(({ query }) => query)).toEqual(["x", "x"]);
  });

  it("asks again when the menu reopens, showing the last answer meanwhile", async () => {
    const { asked, store, view } = setup();

    store.set(undefined, "");
    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);
    asked[0]?.answer(["a.ts"]);
    await flush();

    // The same query again while the menu is open is answered already.
    store.set(undefined, "a");
    store.set(undefined, "");
    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);

    expect(asked).toHaveLength(1);

    store.set(undefined, null);
    store.set(undefined, "");

    expect(view(undefined, "").paths).toEqual(["a.ts"]);

    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);

    expect(asked).toHaveLength(2);

    asked[1]?.answer(["a.ts", "b.ts"]);
    await flush();

    expect(view(undefined, "").paths).toEqual(["a.ts", "b.ts"]);
  });

  it("asks again for a query whose answer is older than its time to live", async () => {
    const { asked, store } = setup();

    store.set(undefined, "a");
    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);
    asked[0]?.answer(["a.ts"]);
    await flush();

    await vi.advanceTimersByTimeAsync(FILE_ANSWER_TTL_MS);
    store.set(undefined, "ab");
    store.set(undefined, "a");
    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);

    expect(asked.map(({ query }) => query)).toEqual(["a", "a"]);
  });

  it("starts over in another conversation, dropping answers for the one before", async () => {
    const { asked, store, view } = setup();

    store.set(undefined, "a");
    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);

    store.set(7, "a");

    expect(view(7, "a")).toEqual({ query: null, paths: [], searching: true, failed: false });

    asked[0]?.answer(["root.ts"]);
    await flush();

    expect(view(7, "a").paths).toEqual([]);

    await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);

    expect(asked[1]).toMatchObject({ query: "a", conversationId: 7 });

    asked[1]?.answer(["child.ts"]);
    await flush();

    expect(view(7, "a").paths).toEqual(["child.ts"]);
  });
});
