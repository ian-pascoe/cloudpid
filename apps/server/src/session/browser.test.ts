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
          startHandoff: () => Promise.reject(new Error("not here")),
          liveView: () => Promise.reject(new Error("not here")),
          waitHandoff: () => Promise.reject(new Error("not here")),
          endHandoff: () => Promise.reject(new Error("not here")),
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
          startHandoff: () => Promise.reject(new Error("overloaded")),
          liveView: () => Promise.reject(new Error("overloaded")),
          waitHandoff: () => Promise.reject(new Error("overloaded")),
          endHandoff: () => Promise.reject(new Error("overloaded")),
        }),
      },
      "session-1",
    );

    expect(await host.close.pipe(Effect.flip, Effect.runPromise)).toEqual(
      BrowserError.make({ message: "close: Error: overloaded" }),
    );
  });

  it("hands a conversation's tab to the owner, mints its links, waits on the handoff, and ends it, in the object named for the Session", async () => {
    const calls: unknown[] = [];

    const host = remoteBrowserHost(
      {
        getByName: (name) => ({
          describe: () => Promise.resolve("described"),
          run: () => Promise.resolve({ output: [] }),
          close: () => Promise.resolve(true),
          startHandoff: (input) => {
            calls.push({ name, start: input });

            return Promise.resolve({ startedAt: 5 });
          },
          liveView: (requestId) => {
            calls.push({ name, liveView: requestId });

            return Promise.resolve({
              tab: { targetId: "tab-1", link: "wss://live.example/t" },
              windows: [],
            });
          },
          waitHandoff: (requestId, maxMs) => {
            calls.push({ name, wait: [requestId, maxMs] });

            return Promise.resolve({ state: "complete", success: true });
          },
          endHandoff: (requestId) => {
            calls.push({ name, end: requestId });

            return Promise.resolve({ windows: ["https://accounts.example.com"] });
          },
        }),
      },
      "session-1",
    );

    const input = { requestId: "7", conversationId: 3, instructions: "Log in", timeoutMs: 1_000 };

    expect(await Effect.runPromise(host.startHandoff(input))).toEqual({ startedAt: 5 });
    expect(await Effect.runPromise(host.liveView("7"))).toEqual({
      tab: { targetId: "tab-1", link: "wss://live.example/t" },
      windows: [],
    });
    expect(await Effect.runPromise(host.waitHandoff("7", 500))).toEqual({
      state: "complete",
      success: true,
    });
    expect(await Effect.runPromise(host.endHandoff("7"))).toEqual({
      windows: ["https://accounts.example.com"],
    });
    expect(calls).toEqual([
      { name: "session-1", start: input },
      { name: "session-1", liveView: "7" },
      { name: "session-1", wait: ["7", 500] },
      { name: "session-1", end: "7" },
    ]);
  });

  it("fails a handoff the host cannot start with its reason, which says nothing of a link", async () => {
    const host = remoteBrowserHost(
      {
        getByName: () => ({
          describe: () => Promise.resolve(""),
          run: () => Promise.resolve({ output: [] }),
          close: () => Promise.resolve(true),
          startHandoff: () => Promise.reject(new Error("This conversation has no open tab")),
          liveView: () => Promise.reject(new Error("the handoff is over")),
          waitHandoff: () => Promise.resolve({ state: "waiting" }),
          endHandoff: () => Promise.resolve({ windows: [] }),
        }),
      },
      "session-1",
    );

    const error = await Effect.runPromise(
      host
        .startHandoff({ requestId: "7", conversationId: 3, instructions: "x", timeoutMs: 1 })
        .pipe(Effect.flip),
    );

    expect(error.message).toContain("startHandoff: Error: This conversation has no open tab");
  });
});
