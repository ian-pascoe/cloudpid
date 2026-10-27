// The agent in an Owner tab (`./owner-tab-agent.ts`) through the real `BrowserHost` and `agents/browser`'s
// `browserTool`: the model's code runs in a Worker Loader isolate and drives a fake Browser Run over CDP, which records
// what it is sent and in which page (`./host.testing.ts`). The host is built over a Durable Object's own state, with the
// fake as its binding, and called as the Session calls it.
// workerd's WebSocketPair, Durable Object state and RPC are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off preferSchemaOverJson:off globalDate:off
import type { BrowserSource } from "agents/browser/pi";
import { describe, expect, it, vi } from "vitest";
import { type SessionHost, textOf, WHERE, withSessionHost as withHost } from "./host.testing.ts";
import { confinedToOwnerTabs } from "./owner-tab-agent.ts";

/** Open the owner's Owner tab, as the Browser Pane does, and say its ID and page. */
const openOwnerTab = async (host: SessionHost) => {
  const links = await host.ownerTabView(true);

  return { id: links.ownerTabId, page: links.tab.targetId };
};

describe("a call in an Owner tab", () => {
  it("runs there, and leaves the conversation's own tab and active tab as they were", () =>
    withHost(async (host, run) => {
      expect(textOf(await host.run(WHERE, 1))).toContain("in page-1");

      const owner = await openOwnerTab(host);

      expect(owner.page).toBe("page-2");

      const before = run.state.sent.length;
      const inOwnerTab = await host.run(WHERE, 1, owner.id);

      expect(inOwnerTab.isError).not.toBe(true);
      expect(textOf(inOwnerTab)).toContain("in page-2");
      // Nothing opened, and nothing sent to the conversation's tab.
      expect(run.state.sent.slice(before).map((sent) => sent.method)).not.toContain(
        "Target.createTarget",
      );
      expect(run.state.sent.slice(before).filter((sent) => sent.page === "page-1")).toEqual([]);

      // The conversation's next run is in its own tab, and the Owner tab is still the one the Pane shows.
      expect(textOf(await host.run(WHERE, 1))).toContain("in page-1");
      expect((await host.ownerTabView(false)).tab.targetId).toBe("page-2");
      expect(run.state.created).toBe(1);
    }));

  it("names a subagent's run in an Owner tab by the same Owner tab, apart from the subagent's tab", () =>
    withHost(async (host) => {
      const owner = await openOwnerTab(host);

      expect(textOf(await host.run(WHERE, 7, owner.id))).toContain(`in ${owner.page}`);
      expect(textOf(await host.run(WHERE, 7))).not.toContain(`in ${owner.page}`);
    }));

  it("refuses, by name, the commands that would size the Owner tab, capture past its viewport, open a tab, or attach to, show, close or auto-attach to another page", () =>
    withHost(async (host, run) => {
      // The conversation's tab, page-1: another page the Owner tab's call must leave alone.
      await host.run(WHERE, 1);

      const owner = await openOwnerTab(host);
      const before = run.state.sent.length;

      const refusedMethods = [
        "Emulation.setDeviceMetricsOverride",
        "Emulation.clearDeviceMetricsOverride",
        "Page.captureScreenshot",
        "Target.createTarget",
        "Target.closeTarget",
        "Target.activateTarget",
        "Target.setAutoAttach",
      ];

      for (const code of [
        'async () => cdp.send({ method: "Emulation.setDeviceMetricsOverride", params: { width: 1, height: 1, deviceScaleFactor: 1, mobile: false }, sessionId: "active" })',
        'async () => cdp.send({ method: "Emulation.clearDeviceMetricsOverride", sessionId: "active" })',
        'async () => cdp.send({ method: "Page.captureScreenshot", params: { captureBeyondViewport: true }, sessionId: "active" })',
        // A stray field of another type hides nothing.
        'async () => cdp.send({ method: "Page.captureScreenshot", params: { captureBeyondViewport: true, targetId: 1 }, sessionId: "active" })',
        'async () => cdp.send({ method: "Target.createTarget", params: { url: "about:blank" } })',
        'async () => cdp.attachToTarget({ targetId: "page-1" })',
        'async () => cdp.send({ method: "Target.closeTarget", params: { targetId: "page-1" } })',
        'async () => cdp.send({ method: "Target.activateTarget", params: { targetId: "page-1" } })',
        'async () => cdp.send({ method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } })',
      ]) {
        const refused = await host.run(code, 1, owner.id);

        expect(refused.isError).toBe(true);
        expect(textOf(refused)).toMatch(
          /Browser Pane sets its size|resizes the page while it captures|In an Owner tab you work in that tab alone/,
        );
      }

      const sent = run.state.sent.slice(before);

      for (const method of refusedMethods) {
        expect(sent.map((command) => command.method)).not.toContain(method);
      }

      expect(sent.filter((command) => command.page === "page-1")).toEqual([]);
      expect([...run.state.pages.keys()]).toEqual(["page-1", owner.page]);
      expect(textOf(await host.run(WHERE, 1, owner.id))).toContain(`in ${owner.page}`);
    }));

  it("leaves a conversation's tab unconfined after a call in an Owner tab: it opens tabs and sets its size as before", () =>
    withHost(async (host, run) => {
      const owner = await openOwnerTab(host);

      expect(textOf(await host.run(WHERE, 1, owner.id))).toContain(`in ${owner.page}`);

      const before = run.state.sent.length;

      const mine = await host.run(
        'async () => { await cdp.send({ method: "Emulation.setDeviceMetricsOverride", params: { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, sessionId: "active" }); return (await cdp.send({ method: "Target.createTarget", params: { url: "about:blank" } })).targetId; }',
        1,
      );

      expect(mine.isError).not.toBe(true);

      const methods = run.state.sent.slice(before).map((command) => command.method);

      expect(methods).toContain("Emulation.setDeviceMetricsOverride");
      expect(methods.filter((method) => method === "Target.createTarget")).toHaveLength(2);
      expect(
        run.state.sent
          .slice(before)
          .filter((command) => command.method === "Emulation.setDeviceMetricsOverride")
          .map((command) => command.page),
      ).not.toContain(owner.page);
    }));

  it("runs a call queued behind a long one in the same Owner tab only if the tab is still open when its turn comes", () =>
    withHost(async (host, run) => {
      const owner = await openOwnerTab(host);

      const slow = host.run(
        'async () => { await cdp.send({ method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "active" }); await new Promise((done) => setTimeout(done, 500)); return "slow"; }',
        1,
        owner.id,
      );

      const queued = host.run(WHERE, 7, owner.id);

      await vi.waitFor(() =>
        expect(
          run.state.sent.some(
            (command) => command.method === "Runtime.evaluate" && command.page === owner.page,
          ),
        ).toBe(true),
      );

      // The owner closes the tab while the first call works.
      run.state.pages.delete(owner.page);

      const from = run.state.sent.length;
      const [first, second] = await Promise.all([slow, queued]);

      expect(textOf(first)).toMatch(
        new RegExp(`^The Owner tab ${owner.id} was closed during the call`),
      );
      expect(second.isError).toBe(true);
      expect(textOf(second)).toBe(
        `The Owner tab ${owner.id} is closed: the owner closed it, or its browser was closed or replaced. Nothing ran.`,
      );
      expect(run.state.sent.slice(from).map((command) => command.method)).not.toContain(
        "Target.createTarget",
      );
      expect(run.state.pages.size).toBe(0);
      expect(run.state.created).toBe(1);
    }));

  it("fails without running anything when the Owner tab is closed, or there is no such Owner tab", () =>
    withHost(async (host, run) => {
      const owner = await openOwnerTab(host);

      run.state.pages.delete(owner.page);

      const before = run.state.sent.length;
      const closed = await host.run(WHERE, 1, owner.id);

      expect(closed.isError).toBe(true);
      expect(textOf(closed)).toBe(
        `The Owner tab ${owner.id} is closed: the owner closed it, or its browser was closed or replaced. Nothing ran.`,
      );

      const unknown = await host.run(WHERE, 1, "nope");

      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toMatch(/There is no Owner tab nope/);
      expect(run.state.sent.length).toBe(before);
      expect(run.state.pages.size).toBe(0);
    }));

  it("ends with an error that says so when the Owner tab is closed during the call", () =>
    withHost(async (host) => {
      const owner = await openOwnerTab(host);

      const ended = await host.run(
        'async () => cdp.send({ method: "Runtime.evaluate", params: { expression: "close" }, sessionId: "active" })',
        1,
        owner.id,
      );

      expect(ended.isError).toBe(true);
      expect(textOf(ended)).toMatch(
        new RegExp(`^The Owner tab ${owner.id} was closed during the call`),
      );
    }));
});

describe("two Owner tabs", () => {
  it("runs in the Owner tab named, shown or not, and never in the other", () =>
    withHost(async (host, run) => {
      const first = await openOwnerTab(host);
      const { shown: second } = await host.openOwnerTab();
      const secondPage = (await host.ownerTabView(false)).tab.targetId;
      const listing = await host.ownerTabs();

      expect(listing.tabs.map(({ id }) => id)).toEqual([first.id, second]);
      expect(listing.shown).toBe(second);
      expect(secondPage).not.toBe(first.page);

      const before = run.state.sent.length;

      // The one not shown, by its ID, then the one shown.
      expect(textOf(await host.run(WHERE, 1, first.id))).toContain(`in ${first.page}`);
      expect(textOf(await host.run(WHERE, 1, second ?? ""))).toContain(`in ${secondPage}`);
      expect(textOf(await host.run(WHERE, 1, first.id))).toContain(`in ${first.page}`);

      const evaluated = run.state.sent
        .slice(before)
        .flatMap((sent) => (sent.method === "Runtime.evaluate" ? [sent.page] : []));

      expect(evaluated).toEqual([first.page, secondPage, first.page]);
      // The run in one Owner tab showed nothing else: the one shown is still the second.
      expect((await host.ownerTabs()).shown).toBe(second);
    }));

  it("are listed with each page's title and URL, for the Session to tell the agent the origin of, without a run or a new browser", () =>
    withHost(async (host, run) => {
      expect(await host.ownerTabs()).toEqual({ tabs: [] });
      expect(run.state.created).toBe(0);

      const owner = await openOwnerTab(host);

      run.state.pages.set(owner.page, {
        url: "https://news.example.com/a/story?token=abc#top",
        title: "A story",
      });

      expect(await host.ownerTabs()).toEqual({
        tabs: [
          { id: owner.id, title: "A story", url: "https://news.example.com/a/story?token=abc#top" },
        ],
        shown: owner.id,
      });
      expect(run.state.sent.map((sent) => sent.method)).not.toContain("Runtime.evaluate");
      expect(run.state.created).toBe(1);
    }));
});

describe("a connection to an Owner tab's scope", () => {
  /** A source that records the scopes it is asked to connect, and connects none. */
  const recording = () => {
    const asked: Array<string | undefined> = [];

    const source: BrowserSource = {
      name: "recording",
      connect: (options) => {
        asked.push(options?.scope);

        return Promise.reject(new Error("connected"));
      },
    };

    return { source, asked };
  };

  it("is not made while the Owner tab is not open, so no browser starts and no blank tab opens in its place", async () => {
    const { source, asked } = recording();
    const confined = confinedToOwnerTabs(source, () => Promise.resolve(undefined));

    await expect(confined.connect({ scope: "owner-tab:a" })).rejects.toThrow(
      "The Owner tab a is closed: the owner closed it, or its browser was closed or replaced. Nothing ran.",
    );
    expect(asked).toEqual([]);

    // A conversation's scope is connected as it is, whatever the Owner tabs.
    await expect(confined.connect({ scope: "conversation:1" })).rejects.toThrow("connected");
    expect(asked).toEqual(["conversation:1"]);
  });

  it("is made while the Owner tab is open", async () => {
    const { source, asked } = recording();

    const confined = confinedToOwnerTabs(source, () =>
      Promise.resolve({ browserSessionId: "s1", targetId: "page-1" }),
    );

    await expect(confined.connect({ scope: "owner-tab:a" })).rejects.toThrow("connected");
    expect(asked).toEqual(["owner-tab:a"]);
  });
});
