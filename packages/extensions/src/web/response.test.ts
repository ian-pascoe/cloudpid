// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
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

  it("succeeds when the body has none", async () => {
    await Effect.runPromise(discardBody(new Response(null, { status: 302 })));
  });

  it("swallows a cancel that rejects", async () => {
    const response = new Response(
      new ReadableStream({
        cancel: () => Promise.reject(new Error("boom")),
      }),
    );

    await expect(Effect.runPromise(discardBody(response))).resolves.toBeUndefined();
  });

  it("swallows a cancel that throws", async () => {
    const response = new Response(
      new ReadableStream({
        cancel: () => {
          throw new Error("boom");
        },
      }),
    );

    await expect(Effect.runPromise(discardBody(response))).resolves.toBeUndefined();
  });
});
