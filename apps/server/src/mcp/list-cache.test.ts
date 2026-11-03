// The host's list cache (`docs/architecture/mcp-connections.md` → The list cache): its bounds, its LRU order, its
// lifetime, and what drops a server's pages.
// @effect-diagnostics preferEffectArray:off asyncFunction:off strictEffectProvide:off
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import {
  jsonBytes,
  LIST_CACHE_ENTRY_BYTES,
  LIST_CACHE_HOST_BYTES,
  LIST_CACHE_ISOLATE_BYTES,
  LIST_CACHE_MAX_TTL_MS,
  makeIsolateBudget,
  makeListCache,
  isolateBudget,
  McpListCache,
} from "./list-cache.ts";
import { authContextOf } from "./resources.ts";
import { McpProcessEnded, processEnded } from "./stdio.ts";
import { DAY_MS } from "./time.ts";

const MiB = 1024 * 1024;

/** A value that weighs a little over `bytes` as JSON. */
const weighing = (bytes: number) => ({ text: "x".repeat(bytes) });

const DOCS = { conn: "conn-docs" };

describe("the list cache", () => {
  it("keeps a value for its ttl, and gives it back until then", () => {
    const cache = makeListCache(undefined, makeIsolateBudget());

    expect(cache.put("k", DOCS, "e", { a: 1 }, 1000, 0)).toBe(true);
    expect(cache.get("k", "e", 999)).toEqual({ a: 1 });
    expect(cache.get("k", "e", 1000)).toBeUndefined();
    expect(cache.size()).toEqual({ entries: 0, bytes: 0 });
  });

  it("caps the ttl at 24 hours", () => {
    const cache = makeListCache(undefined, makeIsolateBudget());

    cache.put("k", DOCS, "e", { a: 1 }, 30 * DAY_MS, 0);

    expect(LIST_CACHE_MAX_TTL_MS).toBe(DAY_MS);
    expect(cache.get("k", "e", DAY_MS - 1)).toEqual({ a: 1 });
    expect(cache.get("k", "e", DAY_MS)).toBeUndefined();
  });

  it("keeps nothing for a ttl that is not above 0", () => {
    const cache = makeListCache(undefined, makeIsolateBudget());

    expect(cache.put("k", DOCS, "e", {}, 0, 0)).toBe(false);
    expect(cache.put("k", DOCS, "e", {}, -5, 0)).toBe(false);
    expect(cache.put("k", DOCS, "e", {}, Number.NaN, 0)).toBe(false);
    expect(cache.size().entries).toBe(0);
  });

  it("keeps no entry over 4 MiB, and one at it", () => {
    const cache = makeListCache(undefined, makeIsolateBudget());

    expect(LIST_CACHE_ENTRY_BYTES).toBe(4 * MiB);
    expect(cache.put("big", DOCS, "e", weighing(4 * MiB), 1000, 0)).toBe(false);
    expect(cache.put("fits", DOCS, "e", weighing(4 * MiB - 64), 1000, 0)).toBe(true);
    expect(jsonBytes(weighing(10))).toBe(JSON.stringify(weighing(10)).length);
  });

  it("holds 4 MiB a host, dropping the least recently used first", () => {
    const cache = makeListCache(undefined, makeIsolateBudget());
    const piece = weighing(1.5 * MiB);

    expect(LIST_CACHE_HOST_BYTES).toBe(4 * MiB);

    cache.put("a", DOCS, "e", piece, 1000, 0);
    cache.put("b", DOCS, "e", piece, 1000, 0);

    // `a` is used, so `b` is now the least recently used.
    expect(cache.get("a", "e", 1)).toEqual(piece);

    cache.put("c", DOCS, "e", piece, 1000, 0);

    expect(cache.get("b", "e", 1)).toBeUndefined();
    expect(cache.get("a", "e", 1)).toEqual(piece);
    expect(cache.get("c", "e", 1)).toEqual(piece);
    expect(cache.size().bytes).toBeLessThanOrEqual(4 * MiB);
  });

  it("replaces an entry under the same key, counting its bytes once", () => {
    const cache = makeListCache(undefined, makeIsolateBudget());

    cache.put("k", DOCS, "e", weighing(1000), 1000, 0);
    cache.put("k", DOCS, "e", weighing(10), 1000, 0);

    expect(cache.size().entries).toBe(1);
    expect(cache.size().bytes).toBe(jsonBytes(weighing(10)));
  });

  it("gives nothing back to a server that is in another epoch, and drops the entry", () => {
    const cache = makeListCache(undefined, makeIsolateBudget());

    cache.put("k", DOCS, "2026-07-28@1", { a: 1 }, 1000, 0);

    expect(cache.get("k", "2026-07-28@2", 1)).toBeUndefined();
    expect(cache.get("k", "2026-07-28@1", 1)).toBeUndefined();
  });

  it("drops the pages of a server instance, and no other's", () => {
    const cache = makeListCache(undefined, makeIsolateBudget());

    cache.put("a", { conn: "c1", workspace: "ws:1" }, "e", {}, 1000, 0);
    cache.put("b", { conn: "c1", workspace: "ws:2" }, "e", {}, 1000, 0);
    cache.put("c", { conn: "c2", workspace: "ws:1" }, "e", {}, 1000, 0);

    cache.dropServer({ conn: "c1", workspace: "ws:1" });

    expect(cache.get("a", "e", 1)).toBeUndefined();
    expect(cache.get("b", "e", 1)).toEqual({});
    expect(cache.get("c", "e", 1)).toEqual({});
  });

  it("keeps only the pages of the connections still in the set", () => {
    const cache = makeListCache(undefined, makeIsolateBudget());

    cache.put("a", { conn: "old" }, "e", {}, 1000, 0);
    cache.put("b", { conn: "new" }, "e", {}, 1000, 0);

    cache.retain(new Set(["new"]));

    expect(cache.get("a", "e", 1)).toBeUndefined();
    expect(cache.get("b", "e", 1)).toEqual({});
  });
});

describe("the isolate's budget", () => {
  const piece = weighing(3 * MiB);

  it("is 8 MiB, charged by every host's cache in the isolate, the least recently used of all dropped first", () => {
    const isolate = makeIsolateBudget();
    const [first, second, third] = [1, 2, 3].map(() => makeListCache(undefined, isolate));

    expect(LIST_CACHE_ISOLATE_BYTES).toBe(8 * MiB);

    first?.put("a", DOCS, "e", piece, 1000, 0);
    second?.put("b", DOCS, "e", piece, 1000, 0);

    // `a` is used, so `b` is the oldest of all, though it is the only entry of its own cache.
    expect(first?.get("a", "e", 1)).toEqual(piece);

    third?.put("c", DOCS, "e", piece, 1000, 0);

    expect(second?.get("b", "e", 1)).toBeUndefined();
    expect(first?.get("a", "e", 1)).toEqual(piece);
    expect(third?.get("c", "e", 1)).toEqual(piece);
    expect(isolate.bytes()).toBeLessThanOrEqual(8 * MiB);
    expect(isolate.bytes()).toBe(
      (first?.size().bytes ?? 0) + (second?.size().bytes ?? 0) + (third?.size().bytes ?? 0),
    );
  });

  it("is never passed by many hosts each within their own 4 MiB", () => {
    const isolate = makeIsolateBudget();
    const caches = Array.from({ length: 10 }, () => makeListCache(undefined, isolate));

    for (const [index, cache] of caches.entries()) {
      cache.put(`k${index}`, DOCS, "e", weighing(3.5 * MiB), 1000, 0);

      expect(isolate.bytes()).toBeLessThanOrEqual(8 * MiB);
    }
  });

  it("is given back when a cache is disposed, and when an entry is dropped", () => {
    const isolate = makeIsolateBudget();
    const cache = makeListCache(undefined, isolate);

    cache.put("a", { conn: "c1" }, "e", piece, 1000, 0);
    cache.put("b", { conn: "c2" }, "e", piece, 1000, 0);
    cache.dropServer({ conn: "c1" });

    expect(isolate.bytes()).toBe(cache.size().bytes);

    cache.dispose();

    expect(isolate.bytes()).toBe(0);
    expect(cache.size().entries).toBe(0);
  });

  it("is left by a cache that holds nothing, and a cache whose host is gone is drained by the others' puts", () => {
    const isolate = makeIsolateBudget();
    const abandoned = makeListCache(undefined, isolate);

    // Built, it holds nothing of the budget.
    expect(isolate.holders()).toBe(0);

    // Its host object is gone, and nothing told it: never disposed.
    abandoned.put("a", DOCS, "e", piece, 1000, 0);

    expect(isolate.holders()).toBe(1);

    const live = makeListCache(undefined, isolate);
    const other = makeListCache(undefined, isolate);

    live.put("b", DOCS, "e", piece, 1000, 0);

    expect(isolate.holders()).toBe(2);

    // 9 MiB: the abandoned cache's page is the least recently used of all.
    other.put("c", DOCS, "e", piece, 1000, 0);

    expect(abandoned.size()).toEqual({ entries: 0, bytes: 0 });
    expect(isolate.holders()).toBe(2);
    expect(isolate.bytes()).toBe(live.size().bytes + other.size().bytes);
    expect(isolate.bytes()).toBeLessThan(7 * MiB);

    live.dropServer(DOCS);
    other.dropServer(DOCS);

    expect(isolate.holders()).toBe(0);
    expect(isolate.bytes()).toBe(0);
  });

  it("is shared by the host's own layers: three built apart are three caches, past 8 MiB together, charging one budget", async () => {
    const before = isolateBudget.bytes();
    const holdersBefore = isolateBudget.holders();
    const big = weighing(3.9 * MiB);

    const kept = await Effect.runPromise(
      Effect.gen(function* () {
        const one = yield* McpListCache;

        return yield* Effect.gen(function* () {
          const two = yield* McpListCache;

          return yield* Effect.gen(function* () {
            const three = yield* McpListCache;

            one.put("a", DOCS, "e", big, 1000, 0);
            two.put("b", DOCS, "e", big, 1000, 0);
            three.put("c", DOCS, "e", big, 1000, 0);

            // 11.7 MiB asked of an 8 MiB budget: the oldest page, the first host's, went.
            expect(isolateBudget.bytes() - before).toBeLessThanOrEqual(8 * MiB);

            return [one.size().entries, two.size().entries, three.size().entries] as const;
          }).pipe(Effect.provide(Layer.fresh(McpListCache.layer)));
        }).pipe(Effect.provide(Layer.fresh(McpListCache.layer)));
      }).pipe(Effect.provide(Layer.fresh(McpListCache.layer))),
    );

    expect(kept).toEqual([0, 1, 1]);

    // Each scope ended and gave its bytes back.
    expect(isolateBudget.bytes()).toBe(before);
    expect(isolateBudget.holders()).toBe(holdersBefore);
  });
});

describe("a stdio server's process ending", () => {
  it("drops the pages the cache kept of it, and tells the handler", async () => {
    const cache = makeListCache(undefined, makeIsolateBudget());
    const told: Array<string> = [];

    cache.put("a", { conn: "c1", workspace: "ws:1" }, "e", {}, 1000, 0);
    cache.put("b", { conn: "c1", workspace: "ws:2" }, "e", {}, 1000, 0);

    await Effect.runPromise(
      processEnded("c1", "ws:1", undefined).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(McpListCache, cache),
            Layer.succeed(McpProcessEnded, (conn, workspace) =>
              Effect.sync(() => {
                told.push(`${conn}/${workspace}`);
              }),
            ),
          ),
        ),
      ),
    );

    expect(told).toEqual(["c1/ws:1"]);
    expect(cache.get("a", "e", 1)).toBeUndefined();
    expect(cache.get("b", "e", 1)).toEqual({});
  });
});

describe("the auth context", () => {
  const http = (url: string, headers: Record<string, string> = {}) =>
    ({ kind: "http", conn: "c", name: "docs", url, headers }) as const;

  const of = (target: Parameters<typeof authContextOf>[0], token?: string) =>
    authContextOf(target, token);

  it("is a SHA-256 that differs by URL, token and each header, and not by the order of the headers", async () => {
    const base = of(http("https://a.test/mcp", { A: "1", B: "2" }), "tok");

    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(of(http("https://a.test/mcp", { B: "2", A: "1" }), "tok")).toBe(base);
    expect(of(http("https://b.test/mcp", { A: "1", B: "2" }), "tok")).not.toBe(base);
    expect(of(http("https://a.test/mcp", { A: "1", B: "2" }), "other")).not.toBe(base);
    expect(of(http("https://a.test/mcp", { A: "1", B: "2" }))).not.toBe(base);
    expect(of(http("https://a.test/mcp", {}), "tok")).not.toBe(base);
    expect(of(http("https://a.test/mcp", { A: "1", B: "3" }), "tok")).not.toBe(base);
  });

  it("is a stdio server's command, arguments, env and cwd", async () => {
    const stdio = (env: Record<string, string>) =>
      ({
        kind: "stdio",
        conn: "c",
        name: "fs",
        workspace: "ws:1",
        start: true,
        command: "node",
        args: ["server.js"],
        env,
      }) as const;

    expect(of(stdio({ KEY: "1" }))).not.toBe(of(stdio({ KEY: "2" })));
    expect(of(stdio({ KEY: "1" }))).toBe(of(stdio({ KEY: "1" })));
  });
});
