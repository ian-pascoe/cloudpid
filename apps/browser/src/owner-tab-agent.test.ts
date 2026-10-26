// The agent in an Owner tab (`./owner-tab-agent.ts`) through the real `BrowserHost` and `agents/browser`'s
// `browserTool`: the model's code runs in a Worker Loader isolate and drives a fake Browser Run over CDP, which records
// what it is sent and in which page. The host is built over a Durable Object's own state, with the fake as its binding.
// workerd's WebSocketPair, Durable Object state and RPC are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off preferSchemaOverJson:off globalDate:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { BrowserRun } from "@cloudpid/extensions/browser/contract";
import type { BrowserBinding } from "agents/browser";
import { describe, expect, it } from "vitest";
import { BrowserHost } from "./BrowserHost.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly LOADER: WorkerLoader;
    }
  }
}

type Command = {
  readonly id: number;
  readonly method: string;
  readonly params?: { readonly targetId?: string; readonly expression?: string };
  readonly sessionId?: string;
};

/** A page of the fake browser. */
type FakePage = { url: string; title: string };

/**
 * A Browser Run with one browser at a time (`s1`, `s2`, ...), whose pages a test can set and close. Over CDP it opens
 * pages (`page-1`, `page-2`, ...), attaches to them (session `in-<targetId>`), answers `Runtime.evaluate` with the page it
 * ran in (or, for the expression `close`, closes that page first and fails as Chrome does), and mints Live View links.
 */
const fakeBrowserRun = () => {
  /** Every command, with the page its session is in. */
  const sent: Array<{ readonly method: string; readonly page?: string }> = [];
  const state = { created: 0, opened: 0, pages: new Map<string, FakePage>(), sent };

  const targetOf = (sessionId: string | undefined) => sessionId?.replace(/^in-/, "");

  const answer = ({ method, params, sessionId }: Command) => {
    switch (method) {
      case "Target.getTargets":
        return {
          targetInfos: [...state.pages].map(([targetId, page]) => ({
            targetId,
            type: "page",
            attached: false,
            ...page,
          })),
        };
      case "Target.createTarget": {
        state.opened += 1;

        const targetId = `page-${state.opened}`;

        state.pages.set(targetId, { url: "about:blank", title: "" });

        return { targetId };
      }

      case "Target.attachToTarget": {
        const targetId = params?.targetId ?? "";

        return state.pages.has(targetId) ? { sessionId: `in-${targetId}` } : undefined;
      }

      case "Runtime.evaluate": {
        const page = targetOf(sessionId);

        if (page === undefined || !state.pages.has(page)) return undefined;

        if (params?.expression === "close") {
          state.pages.delete(page);

          return undefined;
        }

        return { result: { type: "string", value: `in ${page}` } };
      }

      case "Cloudflare.getLiveView":
        return { webSocketDebuggerUrl: `wss://live.example/${params?.targetId ?? "newest"}` };
      default:
        return {};
    }
  };

  const binding: BrowserBinding = {
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const method = init?.method ?? "GET";

      if (method === "POST" && url.pathname === "/v1/devtools/browser") {
        state.created += 1;
        state.pages.clear();

        return Promise.resolve(Response.json({ sessionId: `s${state.created}` }));
      }

      const session = /^\/v1\/devtools\/browser\/([^/]+)(\/json\/list)?$/.exec(url.pathname);

      if (session === null || session[1] !== `s${state.created}`) {
        return Promise.resolve(new Response("gone", { status: 404 }));
      }

      if (method === "DELETE") return Promise.resolve(new Response(null, { status: 200 }));

      if (session[2] !== undefined) {
        return Promise.resolve(
          Response.json([...state.pages].map(([id, page]) => ({ id, type: "page", ...page }))),
        );
      }

      const pair = new WebSocketPair();
      const server = pair[1];

      server.accept();
      server.addEventListener("message", (event) => {
        // SAFETY: what `agents/browser` and the host send is a CDP command, with only the params read here typed.
        const command = JSON.parse(String(event.data)) as Command;
        const page = targetOf(command.sessionId);

        state.sent.push(
          page === undefined ? { method: command.method } : { method: command.method, page },
        );

        const result = answer(command);

        server.send(
          JSON.stringify(
            result === undefined
              ? { id: command.id, error: { code: -32000, message: "Target closed" } }
              : { id: command.id, result },
          ),
        );
      });

      return Promise.resolve(new Response(null, { status: 101, webSocket: pair[0] }));
    },
  };

  return { binding, state };
};

/** Code that reads which page its active tab is. */
const WHERE =
  'async () => (await cdp.send({ method: "Runtime.evaluate", params: { expression: "1", returnByValue: true }, sessionId: "active" })).result.value';

const textOf = (run: BrowserRun) =>
  run.output.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

let objects = 0;

/** `test` with a `BrowserHost` over a fresh Durable Object's state and a fake Browser Run. */
const withHost = (
  test: (host: BrowserHost, run: ReturnType<typeof fakeBrowserRun>) => Promise<void>,
) => {
  objects += 1;

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: `BROWSER_HOST` is the namespace of the `BrowserHost` class; the global types it by its RPC methods only (`worker.workerd.test.ts`).
  const stub = env.BROWSER_HOST.getByName(
    `owner-tab-agent-${objects}`,
  ) as unknown as DurableObjectStub;

  return runInDurableObject(stub, async (_instance, state) => {
    const run = fakeBrowserRun();

    await test(new BrowserHost(state, { BROWSER: run.binding, LOADER: env.LOADER }), run);
  });
};

/** Open the owner's Owner tab, as the Browser Pane does, and say its ID and page. */
const openOwnerTab = async (host: BrowserHost) => {
  const links = await host.ownerTabView(true);

  return { id: links.ownerTabId, page: links.tab.targetId };
};

describe("a run in an Owner tab", () => {
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

  it("never changes the Owner tab's size, and never opens or switches to another tab", () =>
    withHost(async (host, run) => {
      const owner = await openOwnerTab(host);

      for (const code of [
        'async () => cdp.send({ method: "Emulation.setDeviceMetricsOverride", params: { width: 1, height: 1, deviceScaleFactor: 1, mobile: false }, sessionId: "active" })',
        'async () => cdp.send({ method: "Emulation.clearDeviceMetricsOverride", sessionId: "active" })',
        'async () => cdp.send({ method: "Target.createTarget", params: { url: "about:blank" } })',
        'async () => cdp.attachToTarget({ targetId: "page-9" })',
      ]) {
        const refused = await host.run(code, 1, owner.id);

        expect(refused.isError).toBe(true);
        expect(textOf(refused)).toMatch(
          /Browser Pane sets its size|In an Owner tab you work in that tab alone/,
        );
      }

      expect(run.state.sent.map((sent) => sent.method)).not.toContain(
        "Emulation.setDeviceMetricsOverride",
      );
      expect(run.state.sent.map((sent) => sent.method)).not.toContain(
        "Emulation.clearDeviceMetricsOverride",
      );
      expect(run.state.pages.size).toBe(1);
      expect(textOf(await host.run(WHERE, 1, owner.id))).toContain(`in ${owner.page}`);
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

  it("ends with an error that says so when the Owner tab is closed during the run", () =>
    withHost(async (host) => {
      const owner = await openOwnerTab(host);

      const ended = await host.run(
        'async () => cdp.send({ method: "Runtime.evaluate", params: { expression: "close" }, sessionId: "active" })',
        1,
        owner.id,
      );

      expect(ended.isError).toBe(true);
      expect(textOf(ended)).toMatch(
        new RegExp(`^The Owner tab ${owner.id} was closed during the run`),
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
