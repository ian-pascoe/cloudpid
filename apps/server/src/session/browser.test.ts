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
          ownerTabView: () => Promise.reject(new Error("not here")),
          ownerTabs: () => Promise.reject(new Error("not here")),
          openOwnerTab: () => Promise.reject(new Error("not here")),
          showOwnerTab: () => Promise.reject(new Error("not here")),
          closeOwnerTab: () => Promise.reject(new Error("not here")),
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
          ownerTabView: () => Promise.reject(new Error("overloaded")),
          ownerTabs: () => Promise.reject(new Error("overloaded")),
          openOwnerTab: () => Promise.reject(new Error("overloaded")),
          showOwnerTab: () => Promise.reject(new Error("overloaded")),
          closeOwnerTab: () => Promise.reject(new Error("overloaded")),
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
          ownerTabView: () => Promise.reject(new Error("not here")),
          ownerTabs: () => Promise.reject(new Error("not here")),
          openOwnerTab: () => Promise.reject(new Error("not here")),
          showOwnerTab: () => Promise.reject(new Error("not here")),
          closeOwnerTab: () => Promise.reject(new Error("not here")),
          waitHandoff: (requestId, maxMs) => {
            calls.push({ name, wait: [requestId, maxMs] });

            return Promise.resolve({ state: "complete", success: true });
          },
          endHandoff: (requestId) => {
            calls.push({ name, end: requestId });

            return Promise.resolve({ windowOrigins: ["https://accounts.example.com"] });
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
      windowOrigins: ["https://accounts.example.com"],
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
          ownerTabView: () => Promise.reject(new Error("the Owner tab is gone")),
          ownerTabs: () => Promise.reject(new Error("the Owner tab is gone")),
          openOwnerTab: () => Promise.reject(new Error("the Owner tab is gone")),
          showOwnerTab: () => Promise.reject(new Error("the Owner tab is gone")),
          closeOwnerTab: () => Promise.reject(new Error("the Owner tab is gone")),
          waitHandoff: () => Promise.resolve({ state: "waiting" }),
          endHandoff: () => Promise.resolve({ windowOrigins: [] }),
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

  it("mints the Browser Pane's links in the object named for the Session, opening an Owner tab only when asked", async () => {
    const calls: unknown[] = [];

    const links = {
      ownerTabId: "owner-1",
      tab: { targetId: "tab-9", link: "wss://live.example/o" },
      windows: [],
      opened: true,
      replaced: false,
    };

    const host = remoteBrowserHost(
      {
        getByName: (name) => ({
          describe: () => Promise.resolve(""),
          run: () => Promise.resolve({ output: [] }),
          close: () => Promise.resolve(true),
          startHandoff: () => Promise.reject(new Error("not here")),
          liveView: () => Promise.reject(new Error("not here")),
          ownerTabView: (open) => {
            calls.push({ name, open });

            return open
              ? Promise.resolve(links)
              : Promise.reject(new Error("the Owner tab is gone"));
          },
          ownerTabs: () => Promise.reject(new Error("not here")),
          openOwnerTab: () => Promise.reject(new Error("not here")),
          showOwnerTab: () => Promise.reject(new Error("not here")),
          closeOwnerTab: () => Promise.reject(new Error("not here")),
          waitHandoff: () => Promise.reject(new Error("not here")),
          endHandoff: () => Promise.reject(new Error("not here")),
        }),
      },
      "session-1",
    );

    expect(await Effect.runPromise(host.ownerTabView(true))).toEqual(links);
    expect((await Effect.runPromise(host.ownerTabView(false).pipe(Effect.flip))).message).toBe(
      "ownerTabView: Error: the Owner tab is gone",
    );
    expect(calls).toEqual([
      { name: "session-1", open: true },
      { name: "session-1", open: false },
    ]);
  });

  it("lists, opens, shows and closes the Owner tabs in the object named for the Session", async () => {
    const calls: unknown[] = [];
    const listing = { tabs: [{ id: "a", title: "Docs" }], shown: "a" };

    const host = remoteBrowserHost(
      {
        getByName: (name) => ({
          describe: () => Promise.resolve(""),
          run: () => Promise.resolve({ output: [] }),
          close: () => Promise.resolve(true),
          startHandoff: () => Promise.reject(new Error("not here")),
          liveView: () => Promise.reject(new Error("not here")),
          ownerTabView: () => Promise.reject(new Error("not here")),
          ownerTabs: () => {
            calls.push({ name, call: "list" });

            return Promise.resolve(listing);
          },
          openOwnerTab: () => {
            calls.push({ name, call: "open" });

            return Promise.resolve(listing);
          },
          showOwnerTab: (id) => {
            calls.push({ name, call: "show", id });

            return Promise.reject(new Error("the Owner tab is gone"));
          },
          closeOwnerTab: (id) => {
            calls.push({ name, call: "close", id });

            return Promise.resolve({ tabs: [] });
          },
          waitHandoff: () => Promise.reject(new Error("not here")),
          endHandoff: () => Promise.reject(new Error("not here")),
        }),
      },
      "session-1",
    );

    expect(await Effect.runPromise(host.ownerTabs)).toEqual(listing);
    expect(await Effect.runPromise(host.openOwnerTab)).toEqual(listing);
    expect((await Effect.runPromise(host.showOwnerTab("b").pipe(Effect.flip))).message).toBe(
      "showOwnerTab: Error: the Owner tab is gone",
    );
    expect(await Effect.runPromise(host.closeOwnerTab("a"))).toEqual({ tabs: [] });
    expect(calls).toEqual([
      { name: "session-1", call: "list" },
      { name: "session-1", call: "open" },
      { name: "session-1", call: "show", id: "b" },
      { name: "session-1", call: "close", id: "a" },
    ]);
  });
});
