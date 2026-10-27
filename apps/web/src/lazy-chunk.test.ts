// @effect-diagnostics asyncFunction:off -- the helper under test is a promise, awaited here.
import { describe, expect, it } from "vitest";
import { ChunkLoadError, loadChunk } from "./lazy-chunk.ts";

describe("loadChunk", () => {
  it("passes the module through", async () => {
    const module = { default: () => null };

    await expect(loadChunk(() => Promise.resolve(module))).resolves.toBe(module);
  });

  it("turns a failed import into a ChunkLoadError that keeps the cause", async () => {
    const cause = new TypeError("Failed to fetch dynamically imported module");

    const failed = expect(loadChunk(() => Promise.reject(cause))).rejects;

    await failed.toBeInstanceOf(ChunkLoadError);
    await failed.toHaveProperty("cause", cause);
  });

  it("turns the nothing Vite resolves to, after a handled preload error, into a ChunkLoadError", async () => {
    await expect(loadChunk(() => Promise.resolve(undefined))).rejects.toBeInstanceOf(
      ChunkLoadError,
    );
  });
});
