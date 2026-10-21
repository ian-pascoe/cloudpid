// The composer's `@` menu on the Session's side: the paths a directory's listing offers, the best of them for a query,
// and the listings held for `LISTING_TTL`, over a test clock.
// @effect-diagnostics strictEffectProvide:off preferEffectArray:off anyUnknownInErrorContext:off
import type { FileListEntry } from "@earendil-works/pi-durable/env";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import {
  fileCandidates,
  type FileIndex,
  fileIndex,
  FileListingError,
  FileListings,
  type FileListingsOptions,
  fileListingsLayer,
  LISTING_TTL,
  matchFiles,
} from "./file-search.ts";

const test = (name: string, body: () => Effect.Effect<void, unknown, Scope.Scope>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.scoped, Effect.provide(TestClock.layer()))));

const REPO = "/workspace/repo";

/** The paths of an index. */
const names = (index: FileIndex) => index.map(({ name }) => name);

const file = (path: string): FileListEntry => ({ path, kind: "file" });

const dir = (path: string): FileListEntry => ({ path, kind: "directory" });

describe("the paths a listing offers", () => {
  it("ends each folder in a slash, and keeps files and links as they are", () => {
    expect(
      fileCandidates([dir("src"), file("src/app.ts"), { path: "latest", kind: "symlink" }], REPO),
    ).toEqual(["src/", "latest", "src/app.ts"]);
  });

  it("adds the folders of a path the listing does not hold itself", () => {
    expect(fileCandidates([file("README.md"), file("apps/web/index.ts")], REPO)).toEqual([
      "README.md",
      "apps/",
      "apps/web/",
      "apps/web/index.ts",
    ]);
    expect(
      fileCandidates([dir("apps"), file("apps/web/index.ts"), file("apps/a.ts")], REPO),
    ).toEqual(["apps/", "apps/web/", "apps/a.ts", "apps/web/index.ts"]);
  });

  it("puts shallower paths first, keeping the listing's order among those as deep", () => {
    expect(
      fileCandidates(
        [
          dir(".agents"),
          dir(".agents/skills"),
          file(".agents/skills/a.md"),
          file(".gitignore"),
          dir("src"),
          file("src/index.ts"),
          file("index.ts"),
        ],
        REPO,
      ),
    ).toEqual([
      ".agents/",
      ".gitignore",
      "src/",
      "index.ts",
      ".agents/skills/",
      "src/index.ts",
      ".agents/skills/a.md",
    ]);
  });
});

describe("the paths a listing leaves out", () => {
  it("leaves out paths holding whitespace, which a mention could not hold", () => {
    expect(
      fileCandidates([file("my notes.md"), dir("a b"), file("a b/c.ts"), file("ok.ts")], REPO),
    ).toEqual(["ok.ts"]);
  });

  it("leaves out the Attachments and the bundled Skills, from wherever it is listed", () => {
    expect(
      fileCandidates(
        [
          dir(".agents"),
          dir(".agents/prompts"),
          dir(".agents/skills"),
          file(".agents/skills/tdd/SKILL.md"),
          dir(".uploads"),
          file(".uploads/s1/a.png"),
          dir("repo"),
        ],
        "/workspace",
      ),
    ).toEqual([".agents/", "repo/", ".agents/prompts/"]);
    expect(fileCandidates([dir("s1"), file("s1/a.png")], "/workspace/.uploads")).toEqual([]);
    // A repo's own `.agents/skills` is its own.
    expect(fileCandidates([dir(".agents/skills")], REPO)).toEqual([".agents/", ".agents/skills/"]);
  });
});

describe("the paths that match a query", () => {
  const candidates = fileCandidates(
    [
      dir("src"),
      dir("src/chat"),
      file("src/chat/menu.ts"),
      file("src/chat/composer.tsx"),
      file("src/index.ts"),
      file("index.ts"),
      file("docs/menu.md"),
    ],
    REPO,
  );

  it("ranks them as the menu does, the shallower first among equals", () => {
    expect(matchFiles("menu", fileIndex(candidates))).toEqual(["docs/menu.md", "src/chat/menu.ts"]);
    expect(matchFiles("index", fileIndex(candidates))).toEqual(["index.ts", "src/index.ts"]);
    // A folder's own name first, then what is in it.
    expect(matchFiles("chat", fileIndex(candidates))).toEqual([
      "src/chat/",
      "src/chat/menu.ts",
      "src/chat/composer.tsx",
    ]);
  });

  it("narrows into a folder once the query names it", () => {
    expect(matchFiles("src/chat/", fileIndex(candidates))).toEqual([
      "src/chat/",
      "src/chat/menu.ts",
      "src/chat/composer.tsx",
    ]);
  });

  it("answers the top level first for an empty query, and at most 50", () => {
    const many = fileCandidates(
      Array.from({ length: 80 }, (_, index) => file(`deep/f${String(index)}.ts`)),
      REPO,
    );

    const paths = matchFiles("", fileIndex(many));

    expect(paths).toHaveLength(50);
    expect(paths[0]).toBe("deep/");
  });
});

/** A listing of `paths` that counts its calls and takes `delay` on the test clock. */
const lister = (delay: Duration.Input = "1 second") => {
  let calls = 0;

  return {
    calls: () => calls,
    list: (paths: readonly string[]) =>
      Effect.sync(() => {
        calls += 1;
      }).pipe(Effect.andThen(Effect.sleep(delay)), Effect.as(fileIndex(paths))),
  };
};

/** Let the forked fibers run until they wait. */
const settled = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
});

/** The listings, made fresh with `options` in the test's scope. */
const listings = (options?: FileListingsOptions) =>
  Layer.build(fileListingsLayer(options)).pipe(
    Effect.map((context) => Context.get(context, FileListings)),
  );

describe("the listings the Session holds", () => {
  test("shares one listing between requests that come while it is made", () =>
    Effect.gen(function* () {
      const cache = yield* listings();
      const { calls, list } = lister();

      const first = yield* Effect.forkChild(cache.get("/workspace/a", list(["x"])));
      const second = yield* Effect.forkChild(cache.get("/workspace/a", list(["y"])));

      yield* TestClock.adjust("1 second");

      expect(names(yield* Fiber.join(first))).toEqual(["x"]);
      expect(names(yield* Fiber.join(second))).toEqual(["x"]);
      expect(calls()).toBe(1);
    }));

  test("lists again once the listing is older than its time to live", () =>
    Effect.gen(function* () {
      const cache = yield* listings();
      const { calls, list } = lister("0 millis");

      expect(names(yield* cache.get("/workspace/a", list(["old"])))).toEqual(["old"]);

      yield* TestClock.adjust(Duration.toMillis(LISTING_TTL) - 1);

      expect(names(yield* cache.get("/workspace/a", list(["new"])))).toEqual(["old"]);
      expect(calls()).toBe(1);

      yield* TestClock.adjust("1 millis");

      expect(names(yield* cache.get("/workspace/a", list(["new"])))).toEqual(["new"]);
      expect(calls()).toBe(2);
    }));

  test("holds a fresh listing until it expires, then forgets it", () =>
    Effect.gen(function* () {
      const cache = yield* listings({ ttl: "30 seconds" });
      const { calls, list } = lister("0 millis");

      yield* cache.get("/workspace/a", list(["a"]));
      yield* TestClock.adjust("29 seconds");

      expect(names(yield* cache.get("/workspace/a", list(["b"])))).toEqual(["a"]);
      expect(calls()).toBe(1);

      yield* TestClock.adjust("1 second");
      // Another directory's request sweeps the stale one out.
      yield* cache.get("/workspace/b", list(["b"]));

      expect(yield* cache.held).toEqual(["/workspace/b"]);
    }));

  test("keeps at most so many directories, forgetting the least recently asked", () =>
    Effect.gen(function* () {
      const cache = yield* listings({ maxDirectories: 2 });
      const { calls, list } = lister("0 millis");

      yield* cache.get("/a", list(["1"]));
      yield* cache.get("/b", list(["2"]));
      yield* cache.get("/a", list(["1"]));
      yield* cache.get("/c", list(["3"]));

      expect(yield* cache.held).toEqual(["/a", "/c"]);
      expect(calls()).toBe(3);
    }));

  test("keeps at most so many paths across directories", () =>
    Effect.gen(function* () {
      const cache = yield* listings({ maxEntries: 5 });
      const { list } = lister("0 millis");

      yield* cache.get("/a", list(["1", "2", "3"]));
      yield* cache.get("/b", list(["4", "5"]));

      expect(yield* cache.held).toEqual(["/a", "/b"]);

      yield* cache.get("/c", list(["6"]));

      expect(yield* cache.held).toEqual(["/b", "/c"]);
    }));

  test("does not hold a listing that failed", () =>
    Effect.gen(function* () {
      const cache = yield* listings();
      let calls = 0;

      const failing = Effect.suspend(() => {
        calls += 1;

        return Effect.fail(FileListingError.make({ message: "unreachable" }));
      });

      expect((yield* Effect.flip(cache.get("/a", failing))).message).toBe("unreachable");
      expect(yield* cache.held).toEqual([]);
      expect(names(yield* cache.get("/a", Effect.succeed(fileIndex(["back"]))))).toEqual(["back"]);
      expect(calls).toBe(1);
    }));

  test("finishes a listing for the others when the request that started it is interrupted", () =>
    Effect.gen(function* () {
      const cache = yield* listings();
      const { calls, list } = lister();

      const first = yield* Effect.forkChild(cache.get("/a", list(["x"])));
      const second = yield* Effect.forkChild(cache.get("/a", list(["y"])));

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(first);
      yield* TestClock.adjust("1 second");

      expect(names(yield* Fiber.join(second))).toEqual(["x"]);
      expect(calls()).toBe(1);
    }));

  test("fails a listing that takes too long, and lists again at the next request", () =>
    Effect.gen(function* () {
      const cache = yield* listings({ timeout: "10 seconds" });
      let calls = 0;

      const hanging = Effect.suspend(() => {
        calls += 1;

        return Effect.never;
      });

      const first = yield* Effect.forkChild(cache.get("/a", hanging));

      yield* TestClock.adjust("10 seconds");

      expect((yield* Fiber.join(first).pipe(Effect.flip)).message).toMatch(/took longer than 10s/);
      expect(yield* cache.held).toEqual([]);
      expect(names(yield* cache.get("/a", Effect.succeed(fileIndex(["back"]))))).toEqual(["back"]);
      expect(calls).toBe(1);
    }));

  test("never drops a listing being made to keep its bounds", () =>
    Effect.gen(function* () {
      const cache = yield* listings({ maxDirectories: 1, maxInFlight: 2 });
      const { calls, list } = lister();

      const slow = yield* Effect.forkChild(cache.get("/a", list(["a"])));

      yield* Effect.yieldNow;
      yield* Effect.forkChild(cache.get("/b", list(["b"])));
      yield* Effect.yieldNow;

      // `/a` is still being made: a request for it waits for that listing rather than starting another.
      const again = yield* Effect.forkChild(cache.get("/a", list(["a2"])));

      yield* TestClock.adjust("1 second");

      expect(names(yield* Fiber.join(slow))).toEqual(["a"]);
      expect(names(yield* Fiber.join(again))).toEqual(["a"]);
      expect(calls()).toBe(2);
    }));

  test("makes at most so many listings at once", () =>
    Effect.gen(function* () {
      const cache = yield* listings({ maxInFlight: 1 });
      const { calls, list } = lister();

      const a = yield* Effect.forkChild(cache.get("/a", list(["a"])));
      const b = yield* Effect.forkChild(cache.get("/b", list(["b"])));

      yield* settled;

      expect(calls()).toBe(1);

      yield* TestClock.adjust("1 second");
      yield* settled;

      expect(calls()).toBe(2);

      yield* TestClock.adjust("1 second");

      expect(names(yield* Fiber.join(a))).toEqual(["a"]);
      expect(names(yield* Fiber.join(b))).toEqual(["b"]);
    }));
});
