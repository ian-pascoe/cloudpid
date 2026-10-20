// The Session's browser host as the Session DO reaches it: a failed call is a typed failure.
// @effect-diagnostics asyncFunction:off
import { BrowserError } from "@cloudpid/extensions/browser";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { remoteBrowserHost } from "./browser.ts";

describe("the Session's browser host", () => {
  it("runs code in the object named for the Session, in the conversation's tab", async () => {
    const calls: unknown[] = [];

    const host = remoteBrowserHost(
      {
        getByName: (name) => ({
          describe: () => Promise.resolve("described"),
          run: (code, conversationId) => {
            calls.push({ name, code, conversationId });

            return Promise.resolve({ output: [{ type: "text", text: "ok" }] });
          },
          close: () => Promise.resolve(true),
        }),
      },
      "session-1",
    );

    expect(await Effect.runPromise(host.run({ code: "async () => 1", conversationId: 3 }))).toEqual(
      { output: [{ type: "text", text: "ok" }] },
    );
    expect(calls).toEqual([{ name: "session-1", code: "async () => 1", conversationId: 3 }]);
  });

  it("fails with a BrowserError that names the call when the object cannot be reached", async () => {
    const host = remoteBrowserHost(
      {
        getByName: () => ({
          describe: () => Promise.reject(new Error("overloaded")),
          run: () => Promise.reject(new Error("overloaded")),
          close: () => Promise.reject(new Error("overloaded")),
        }),
      },
      "session-1",
    );

    expect(await host.close.pipe(Effect.flip, Effect.runPromise)).toEqual(
      BrowserError.make({ message: "close: Error: overloaded" }),
    );
  });
});
