// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { discardBody } from "./response.ts";

describe("discardBody", () => {
  it("cancels the body", async () => {
    let cancelled = false;

    const response = new Response(
      new ReadableStream({
        cancel: () => {
          cancelled = true;
        },
      }),
    );

    await Effect.runPromise(discardBody(response));

    expect(cancelled).toBe(true);
  });

  it("swallows a cancel that rejects", async () => {
    const response = new Response(
      new ReadableStream({
        cancel: () => Promise.reject(new Error("boom")),
      }),
    );

    await expect(Effect.runPromise(discardBody(response))).resolves.toBeUndefined();
  });
});
