// The tab lookup (`./tab.ts`) against records a real `agents/browser` `Browser` makes: it reads them under keys that are
// private to `agents` (0.28.1), so this fails when an upgrade changes how they are stored. And opening an Owner tab
// through that `Browser`, which starts a browser only when none runs.
// workerd's WebSocketPair and the stores' Promise API are not Effect.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off globalDate:off preferSchemaOverJson:off
import {
  Browser,
  type BrowserBinding,
  browserRun,
  type ListableBrowserSessionStore,
  type StoredBrowserSession,
} from "agents/browser";
import { describe, expect, it } from "vitest";
import { forgetScope, openTab, tabIn, tabOf } from "./tab.ts";

const memoryStore = (): ListableBrowserSessionStore & {
  readonly records: Map<string, StoredBrowserSession>;
  /** The keys locked, in order. */
  readonly locked: string[];
} => {
  const records = new Map<string, StoredBrowserSession>();
  const locked: string[] = [];

  return {
    records,
    locked,
    acquireLock: (key) => {
      locked.push(key);

      return { release: () => undefined };
    },
    get: (key) => records.get(key),
    set: (key, value) => void records.set(key, structuredClone(value)),
    delete: (key) => void records.delete(key),
    list: (prefix) => {
      const found = new Map<string, StoredBrowserSession>();

      for (const [key, value] of records) if (key.startsWith(prefix)) found.set(key, value);

      return found;
    },
  };
};

/**
 * A Browser Run that creates sessions `s1`, `s2`, ... and lists the tabs a test sets for each; a CDP connection to one
 * answers `Target.createTarget` with a new tab, `opened-1`, `opened-2`, ..., listed from then on.
 */
const fakeBrowserRun = () => {
  const state = {
    created: 0,
    opened: 0,
    tabs: new Map<string, string[]>(),
    gone: new Set<string>(),
  };

  const requests: string[] = [];

  const binding: BrowserBinding = {
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const method = init?.method ?? "GET";

      requests.push(`${method} ${url.pathname}`);

      if (method === "POST" && url.pathname === "/v1/devtools/browser") {
        state.created += 1;

        return Promise.resolve(Response.json({ sessionId: `s${state.created}` }));
      }

      const session = /^\/v1\/devtools\/browser\/([^/]+)(\/json\/list)?$/.exec(url.pathname);

      if (session === null) return Promise.resolve(new Response("?", { status: 404 }));

      const id = session[1] ?? "";

      if (method === "DELETE") return Promise.resolve(new Response(null, { status: 200 }));

      if (state.gone.has(id)) return Promise.resolve(new Response("gone", { status: 404 }));

      if (session[2] !== undefined) {
        return Promise.resolve(
          Response.json((state.tabs.get(id) ?? []).map((tab) => ({ id: tab }))),
        );
      }

      const pair = new WebSocketPair();
      const server = pair[1];

      server.accept();
      server.addEventListener("message", (event) => {
        const command: { id: number; method: string } = JSON.parse(String(event.data));

        if (command.method !== "Target.createTarget") return;

        state.opened += 1;

        const targetId = `opened-${state.opened}`;

        state.tabs.set(id, [...(state.tabs.get(id) ?? []), targetId]);
        server.send(JSON.stringify({ id: command.id, result: { targetId } }));
      });

      return Promise.resolve(new Response(null, { status: 101, webSocket: pair[0] }));
    },
  };

  return { binding, state, requests };
};

const setup = () => {
  const store = memoryStore();
  const run = fakeBrowserRun();
  const browser = new Browser({ provider: browserRun(run.binding), store });
  const lookup = { name: browser.name, store, binding: run.binding };

  /** Conversation `id` works in `tab`, as `browserTool` leaves it. */
  const work = async (id: number, tab: string) => {
    const connection = await browser.connect({ scope: `conversation:${id}` });

    run.state.tabs.set(connection.sessionId, [
      ...(run.state.tabs.get(connection.sessionId) ?? []),
      tab,
    ]);
    await connection.setActiveTarget(tab);
    connection.cdp.disconnect();

    return connection.sessionId;
  };

  return { browser, store, run, lookup, work };
};

describe("the tab a conversation works in", () => {
  it("is the tab the conversation's scope record names in the current browser", async () => {
    const { lookup, work } = setup();
    const sessionId = await work(5, "tab-1");

    expect(await tabOf(lookup, 5)).toEqual({ browserSessionId: sessionId, targetId: "tab-1" });
  });

  it("is none for a conversation that never worked in the browser, and starts no browser and writes nothing", async () => {
    const { lookup, store, run } = setup();

    expect(await tabOf(lookup, 5)).toBeUndefined();
    expect(run.requests).toEqual([]);
    expect([...store.records]).toEqual([]);

    // A browser exists, but not for this conversation: still nothing created or moved.
    const { lookup: other, store: otherStore, work, run: otherRun } = setup();

    await work(6, "tab-1");

    const before = JSON.stringify([...otherStore.records]);
    const created = otherRun.state.created;

    expect(await tabOf(other, 5)).toBeUndefined();
    expect(otherRun.state.created).toBe(created);
    expect(JSON.stringify([...otherStore.records])).toBe(before);
  });

  it("is none when the conversation's tab is no longer open, or Browser Run lost the browser", async () => {
    const { lookup, work, run } = setup();
    const sessionId = await work(5, "tab-1");

    run.state.tabs.set(sessionId, ["other"]);
    expect(await tabOf(lookup, 5)).toBeUndefined();

    run.state.tabs.set(sessionId, ["tab-1"]);
    run.state.gone.add(sessionId);
    expect(await tabOf(lookup, 5)).toBeUndefined();
  });

  it("is none for a conversation whose browser was closed or replaced since", async () => {
    const { lookup, work, browser } = setup();

    await work(5, "tab-1");
    expect(await browser.close()).toBe(true);
    expect(await tabOf(lookup, 5)).toBeUndefined();

    // A new browser: conversation 5's record still names the old one; conversation 6's is current.
    const sessionId = await work(6, "tab-9");

    expect(await tabOf(lookup, 5)).toBeUndefined();
    expect(await tabOf(lookup, 6)).toEqual({ browserSessionId: sessionId, targetId: "tab-9" });
  });
});

describe("opening an Owner tab", () => {
  it("opens it in the browser that runs, starting none, as its scope's tab, apart from the conversations' tabs", async () => {
    const { browser, lookup, run, work } = setup();
    const sessionId = await work(5, "tab-1");

    expect(await openTab(browser, "owner-tab:a")).toEqual({
      browserSessionId: sessionId,
      targetId: "opened-1",
    });
    expect(run.state.created).toBe(1);
    expect(await tabIn(lookup, "owner-tab:a")).toEqual({
      browserSessionId: sessionId,
      targetId: "opened-1",
    });
    expect(await tabOf(lookup, 5)).toEqual({ browserSessionId: sessionId, targetId: "tab-1" });
  });

  it("starts a browser when none runs, and once the browser is closed the tab is gone until another opens", async () => {
    const { browser, lookup, run } = setup();

    const first = await openTab(browser, "owner-tab:a");

    expect(run.state.created).toBe(1);
    expect(await tabIn(lookup, "owner-tab:a")).toEqual(first);

    expect(await browser.close()).toBe(true);
    expect(await tabIn(lookup, "owner-tab:a")).toBeUndefined();

    const second = await openTab(browser, "owner-tab:b");

    expect(run.state.created).toBe(2);
    expect(second.browserSessionId).not.toBe(first.browserSessionId);
    expect(await tabIn(lookup, "owner-tab:a")).toBeUndefined();
    expect(await tabIn(lookup, "owner-tab:b")).toEqual(second);
  });

  it("forgets an Owner tab's scope record under the scope records' lock, leaving the others", async () => {
    const { browser, lookup, store, work } = setup();
    const sessionId = await work(5, "tab-1");

    await openTab(browser, "owner-tab:a");

    const scopes = () =>
      [...store.records.keys()].filter((key) => key.startsWith("browser:scope:"));

    expect(scopes()).toHaveLength(2);

    // The lock `Browser` itself takes to write a scope record, so a forget never races one.
    const lock = store.locked.at(-1);

    store.locked.length = 0;
    await forgetScope(lookup, "owner-tab:a");

    expect(store.locked).toEqual([lock]);
    expect(scopes()).toHaveLength(1);
    expect(scopes()[0]).toContain("conversation:5");
    expect(await tabIn(lookup, "owner-tab:a")).toBeUndefined();
    expect(await tabOf(lookup, 5)).toEqual({ browserSessionId: sessionId, targetId: "tab-1" });
  });
});
