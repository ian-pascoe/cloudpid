// A stream's reads are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
import { ServerError } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { byteStream, scrubError } from "./results.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stream of `bytes` bytes held for `holdMs`, and how often its hooks ran. */
const counted = (bytes: number, holdMs: number) => {
  const seen = { pulled: 0, done: 0 };

  const stream = byteStream(new Uint8Array(bytes), holdMs, {
    pulled: () => {
      seen.pulled += 1;
    },
    done: () => {
      seen.done += 1;
    },
  });

  return { stream, seen };
};

describe("byteStream", () => {
  it("is read to its end however long the reading takes, while each pull comes in time", async () => {
    const { stream, seen } = counted(4 * 64 * 1024, 50);
    const reader = stream.getReader();
    let read = 0;

    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      read += chunk.value.byteLength;
      await sleep(30);
    }

    expect(read).toBe(4 * 64 * 1024);
    expect(seen).toMatchObject({ done: 1 });
    expect(seen.pulled).toBeGreaterThanOrEqual(4);
  });

  it("errors and lets go once it goes unread for its hold, telling its call once", async () => {
    const { stream, seen } = counted(4 * 64 * 1024, 50);

    await sleep(80);

    expect(seen.done).toBe(1);
    await expect(stream.getReader().read()).rejects.toThrow("not read in time");
  });

  it("tells its call once when it is cancelled", async () => {
    const { stream, seen } = counted(4 * 64 * 1024, 50);

    await stream.cancel();
    await sleep(80);

    expect(seen.done).toBe(1);
  });
});

describe("scrubError", () => {
  it("replaces a token that contains another whole, leaving no remainder", async () => {
    const old = "token-0123";
    const refreshed = `${old}-refreshed`;

    const scrubbed = await Effect.runPromise(
      scrubError(
        ServerError.make({ message: `refused ${refreshed} and ${old}` }),
        new Set([old, refreshed]),
      ),
    );

    expect(scrubbed).toMatchObject({ message: "refused [REDACTED] and [REDACTED]" });
  });
});
