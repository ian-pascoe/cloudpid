// The Browser Pane's Owner tabs in the browser host (`./owner-tabs.ts`), over the scripted CDP connection the handoff
// tests use: opening the Pane opens an Owner tab only when the owner has none, the host keeps the Owner tabs as a list
// with the one shown, each ask mints 60-second links named by their target for the tab and its windows, and a tab whose
// browser is gone is said to be gone rather than replaced unasked.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off
import { MAX_PAGE_SELECTION_READ, OWNER_TAB_GONE } from "@cloudpid/extensions/browser/contract";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import { BrowserGoneError } from "./cdp.ts";
import { fakeTransport, linkTo, page, records, TOKEN } from "./cdp.testing.ts";
import { OwnerTabs, ownerTabScope, SELECTION } from "./owner-tabs.ts";
import type { TabState } from "./tab.ts";

type Tab = { readonly browserSessionId: string; readonly targetId: string };

/**
 * Owner tabs over a fake browser: `tabs` is what the stored records say each scope works in (an open tab of the current
 * browser), `openTab` opens `owner-<n>` in `browser-1`, and each connection is the next of `transports`.
 */
const ownerTabsOver = (
  transports: ReturnType<typeof fakeTransport>[],
  store = records(),
  tabs = new Map<string, Tab>(),
  unreachable?: Error,
  options: {
    readonly adoptFails?: boolean;
    readonly refuse?: string;
    /** Scopes whose tab was closed in the browser that runs, as against taken with a browser that was replaced. */
    readonly closed?: ReadonlySet<string>;
    /** Scopes whose tab went with a replaced browser although others are open (a reopening that failed part way). */
    readonly replaced?: ReadonlySet<string>;
    /** A scope whose tab cannot be opened, at its address or blank, for this once. */
    readonly failOnce?: string;
  } = {},
) => {
  const { adoptFails = false, refuse, closed = new Set<string>() } = options;
  const replaced = options.replaced ?? new Set<string>();
  let failOnce = options.failOnce;
  let failures = 0;
  const opened: string[] = [];
  const urls: string[] = [];
  const adopted: Array<readonly [string, string]> = [];
  const connected: string[] = [];
  const forgotten: string[] = [];
  let ids = 0;

  const ownerTabs = new OwnerTabs({
    records: store,
    newId: () => `id-${++ids}`,
    browser: {
      tabOf: (scope) => Promise.resolve(tabs.get(scope)),
      tabsOf: (scopes) =>
        Promise.resolve(
          new Map(
            scopes.flatMap((scope) => {
              const tab = tabs.get(scope);

              return tab === undefined ? [] : [[scope, tab] as const];
            }),
          ),
        ),
      statesOf: (scopes) =>
        Promise.resolve(
          new Map(
            scopes.map((scope): [string, TabState] => {
              const tab = tabs.get(scope);

              if (tab !== undefined) return [scope, { state: "open", tab }];

              // Some tab open: the browser runs, so one that is not was closed in it. None: the browser was replaced.
              return [
                scope,
                {
                  state:
                    replaced.has(scope) || (!closed.has(scope) && tabs.size === 0)
                      ? "replaced"
                      : "closed",
                },
              ];
            }),
          ),
        ),
      adoptTab: (scope, targetId) => {
        if (adoptFails)
          return Promise.reject(new Error("The browser was closed while the tab was recorded"));

        adopted.push([scope, targetId]);

        const tab = { browserSessionId: "browser-1", targetId };

        tabs.set(scope, tab);

        return Promise.resolve(tab);
      },
      openTab: async (scope, url) => {
        opened.push(scope);
        urls.push(url ?? "about:blank");

        if (url !== undefined && url === refuse) throw new Error("The browser refused the address");

        if (scope === failOnce) {
          failures += 1;

          if (failures === 2) failOnce = undefined;

          throw new Error("The browser closed while the tab opened");
        }

        // Opening takes a moment, so two opens at once would both see no tab.
        await new Promise((resolve) => setTimeout(resolve, 5));

        const tab = { browserSessionId: "browser-1", targetId: `owner-${opened.length}` };

        tabs.set(scope, tab);

        return tab;
      },
      forget: (scope) => {
        forgotten.push(scope);
        tabs.delete(scope);

        return Promise.resolve();
      },
      connect: (browserSessionId) => {
        connected.push(browserSessionId);

        if (unreachable !== undefined) return Promise.reject(unreachable);

        const next = transports.shift();

        return next === undefined
          ? Promise.reject(new Error("no more connections"))
          : Promise.resolve(next.transport);
      },
    },
  });

  return { ownerTabs, store, tabs, opened, urls, adopted, connected, forgotten };
};

/** The targets of a browser with Owner tab `owner-1` and a pop-up it opened, which opened one of its own. */
const withWindows = () =>
  fakeTransport({
    "Target.getTargets": {
      targetInfos: [
        page("owner-1"),
        page("conversation-tab"),
        page("popup-1", { openerId: "owner-1", canAccessOpener: true, title: "Sign in" }),
        page("popup-2", { openerId: "popup-1", canAccessOpener: true, title: "Consent" }),
      ],
    },
  });

const gone = async (promise: Promise<unknown>) =>
  expect(await promise.then(String, (error: Error) => error.message)).toBe(OWNER_TAB_GONE);

describe("the Browser Pane's Owner tabs", () => {
  it("opens an Owner tab when the owner has none, shows it, and mints 60-second links to it and its windows", async () => {
    const cdp = withWindows();
    const { ownerTabs, opened, connected } = ownerTabsOver([cdp]);

    expect(await ownerTabs.view(true)).toEqual({
      ownerTabId: "id-1",
      tab: { targetId: "owner-1", link: linkTo("owner-1") },
      windows: [
        { targetId: "popup-1", openerId: "owner-1", title: "Sign in", link: linkTo("popup-1") },
        { targetId: "popup-2", openerId: "popup-1", title: "Consent", link: linkTo("popup-2") },
      ],
      opened: true,
      replaced: false,
    });

    expect(opened).toEqual([ownerTabScope("id-1")]);
    expect(connected).toEqual(["browser-1"]);
    expect(ownerTabs.list()).toEqual({ tabs: [{ id: "id-1" }], shown: "id-1" });

    // Every link is Browser Run's shortest, and names its page.
    expect(cdp.sent.filter((command) => command.method === "Cloudflare.getLiveView")).toEqual([
      {
        method: "Cloudflare.getLiveView",
        params: { mode: "tab", expiresInMs: 60_000, targetId: "owner-1" },
      },
      {
        method: "Cloudflare.getLiveView",
        params: { mode: "tab", expiresInMs: 60_000, targetId: "popup-1" },
      },
      {
        method: "Cloudflare.getLiveView",
        params: { mode: "tab", expiresInMs: 60_000, targetId: "popup-2" },
      },
    ]);

    // The connection that minted them is closed, and none is kept.
    expect(cdp.state.closed).toBe(true);
  });

  it("shows the same Owner tab when the Pane opens again or on another device, opening none", async () => {
    const { ownerTabs, opened } = ownerTabsOver([fakeTransport(), withWindows(), withWindows()]);

    await ownerTabs.view(true);

    const again = await ownerTabs.view(true);
    const reconnect = await ownerTabs.view(false);

    expect(opened).toHaveLength(1);
    expect(again.ownerTabId).toBe("id-1");
    expect(again.tab).toEqual({ targetId: "owner-1", link: linkTo("owner-1") });
    expect([again.opened, again.replaced]).toEqual([false, false]);
    expect(reconnect.tab.targetId).toBe("owner-1");
    expect([reconnect.opened, reconnect.replaced]).toEqual([false, false]);
    expect(ownerTabs.list()).toEqual({ tabs: [{ id: "id-1" }], shown: "id-1" });
  });

  it("opens one Owner tab when two devices open the Pane at once", async () => {
    const { ownerTabs, opened } = ownerTabsOver([fakeTransport(), fakeTransport()]);

    const [first, second] = await Promise.all([ownerTabs.view(true), ownerTabs.view(true)]);

    expect(opened).toHaveLength(1);
    expect(first.ownerTabId).toBe("id-1");
    expect(second.ownerTabId).toBe("id-1");
  });

  it("finds the Owner tabs again after the host restarts", async () => {
    const store = records();
    const tabs = new Map<string, Tab>();

    await ownerTabsOver([fakeTransport()], store, tabs).ownerTabs.view(true);

    const restarted = ownerTabsOver([withWindows()], store, tabs);

    expect((await restarted.ownerTabs.view(false)).ownerTabId).toBe("id-1");
    expect(restarted.opened).toEqual([]);
  });

  it("says the Owner tab is gone, opening nothing, when it is not opening and the owner has none", async () => {
    const { ownerTabs, opened, connected } = ownerTabsOver([]);

    await gone(ownerTabs.view(false));
    expect(opened).toEqual([]);
    expect(connected).toEqual([]);
    expect(ownerTabs.list()).toEqual({ tabs: [] });
  });

  it("says the Owner tab is gone when its browser was closed or replaced, and reopens it only when asked to", async () => {
    const { ownerTabs, tabs, opened, forgotten } = ownerTabsOver([
      fakeTransport(),
      fakeTransport(),
    ]);

    await ownerTabs.view(true);

    // The browser was closed or replaced: the stored records no longer give the scope a tab.
    tabs.clear();

    await gone(ownerTabs.view(false));
    expect(opened).toHaveLength(1);
    expect(forgotten).toEqual([]);

    // The owner asks to open: the Owner tab is reopened (the same one, in the new browser), said to replace the one that
    // is gone, and nothing is forgotten.
    const fresh = await ownerTabs.view(true);

    expect(fresh.ownerTabId).toBe("id-1");
    expect(fresh.tab.targetId).toBe("owner-2");
    expect([fresh.opened, fresh.replaced, fresh.reopened]).toEqual([true, true, 1]);
    expect(opened).toEqual([ownerTabScope("id-1"), ownerTabScope("id-1")]);
    expect(forgotten).toEqual([]);
    expect(ownerTabs.list()).toEqual({ tabs: [{ id: "id-1" }], shown: "id-1" });
  });

  it("shows another Owner tab still there in place of the one that is gone, opening none, and says it replaced it", async () => {
    const store = records();
    const tabs = new Map<string, Tab>();

    tabs.set(ownerTabScope("b"), { browserSessionId: "browser-1", targetId: "owner-b" });
    store.put("owner-tabs", { tabs: [{ id: "a" }, { id: "b" }], shown: "a" });

    const { ownerTabs, opened, forgotten } = ownerTabsOver([fakeTransport()], store, tabs);
    const shown = await ownerTabs.view(true);

    expect(shown.ownerTabId).toBe("b");
    expect([shown.opened, shown.replaced, shown.reopened]).toEqual([false, true, undefined]);
    expect(opened).toEqual([]);
    expect(forgotten).toEqual([ownerTabScope("a")]);
    expect(ownerTabs.list()).toEqual({ tabs: [{ id: "b" }], shown: "b" });
  });

  it("leaves out a window that closes between the listing and its link, still minting the others", async () => {
    const cdp = fakeTransport({
      "Target.getTargets": {
        targetInfos: [
          page("owner-1"),
          page("popup-1", { openerId: "owner-1", canAccessOpener: true, title: "Sign in" }),
          page("popup-2", { openerId: "owner-1", canAccessOpener: true, title: "Help" }),
        ],
      },
      "Cloudflare.getLiveView": (params) => {
        const asked = params?.["targetId"];
        const targetId = Predicate.isString(asked) ? asked : "";

        // The sign-in pop-up closed once the windows were listed.
        if (targetId === "popup-1") throw new Error("No target with given id found");

        return { webSocketDebuggerUrl: linkTo(targetId) };
      },
    });

    const { ownerTabs } = ownerTabsOver([cdp]);
    const links = await ownerTabs.view(true);

    expect(links.tab).toEqual({ targetId: "owner-1", link: linkTo("owner-1") });
    expect(links.windows).toEqual([
      { targetId: "popup-2", openerId: "owner-1", title: "Help", link: linkTo("popup-2") },
    ]);
  });

  it("says the Owner tab is gone when Browser Run no longer has its browser or its page", async () => {
    const store = records();
    const tabs = new Map<string, Tab>();

    await ownerTabsOver([fakeTransport()], store, tabs).ownerTabs.view(true);

    const noBrowser = ownerTabsOver([], store, tabs, new BrowserGoneError("no such session"));

    await gone(noBrowser.ownerTabs.view(false));

    const noPage = fakeTransport({});

    noPage.transport.send = () => Promise.reject(new Error("No target with given id found"));

    await gone(ownerTabsOver([noPage], store, tabs).ownerTabs.view(false));
    expect(noPage.state.closed).toBe(true);

    // Any other failure is not an answer: it is passed on, for the Pane to try again.
    const failing = ownerTabsOver([], store, tabs, new Error("Browser Run is not answering"));

    await expect(failing.ownerTabs.view(false)).rejects.toThrow(/not answering/);
  });

  it("keeps no link: the records hold the Owner tabs alone", async () => {
    const { ownerTabs, store } = ownerTabsOver([withWindows()]);

    await ownerTabs.view(true);

    expect(JSON.stringify([...store.list({ prefix: "" })])).not.toContain(TOKEN);
    expect(JSON.stringify([...store.list({ prefix: "" })])).not.toContain("live.browser.run");
  });
});

describe("the Browser Pane's several Owner tabs", () => {
  /**
   * Owner tabs `a`, `b` and `c` (targets `owner-a`...) unless `ids` says, shown `shown`, over a browser whose pages are
   * `targets`: each connection the host opens is the next of `reads`, all listing the same pages.
   */
  const withTabs = (targets: ReturnType<typeof page>[], shown = "a", ids = ["a", "b", "c"]) => {
    const store = records();
    const tabs = new Map<string, Tab>();

    for (const id of ids) {
      tabs.set(ownerTabScope(id), { browserSessionId: "browser-1", targetId: `owner-${id}` });
    }

    store.put("owner-tabs", { tabs: ids.map((id) => ({ id })), shown });

    const reads = Array.from({ length: 8 }, () =>
      fakeTransport({ "Target.getTargets": { targetInfos: targets } }),
    );

    return { ...ownerTabsOver([...reads], store, tabs), reads };
  };

  const owners = ["a", "b", "c"].map((id) =>
    page(`owner-${id}`, { title: `Tab ${id.toUpperCase()}` }),
  );

  const closed = (cdp: ReturnType<typeof fakeTransport>) =>
    cdp.sent
      .filter((command) => command.method === "Target.closeTarget")
      .map((command) => command.params);

  it("lists the Owner tabs in the order they were opened, by title and URL, with the one shown, and not a conversation's tab", async () => {
    const { ownerTabs } = withTabs([...owners, page("conversation-tab", { title: "Agent's" })]);

    expect(await ownerTabs.tabs()).toEqual({
      tabs: [
        { id: "a", title: "Tab A", url: "https://example.com/owner-a" },
        { id: "b", title: "Tab B", url: "https://example.com/owner-b" },
        { id: "c", title: "Tab C", url: "https://example.com/owner-c" },
      ],
      shown: "a",
    });
  });

  it("lists none, connecting to nothing, when the owner has none or the browser is gone", async () => {
    const { ownerTabs, connected } = ownerTabsOver([]);

    expect(await ownerTabs.tabs()).toEqual({ tabs: [] });
    expect(connected).toEqual([]);

    const lost = withTabs(owners);

    lost.tabs.clear();
    // Said to be on record (`lost`), for the Pane to reopen them; an owner who had none, or closed the last, leaves nothing.
    expect(await lost.ownerTabs.tabs()).toEqual({ tabs: [], lost: 3 });
    // The list is kept, for the Pane to say the Owner tab was replaced.
    expect(lost.ownerTabs.list().tabs).toHaveLength(3);
    expect(lost.connected).toEqual([]);
  });

  it("opens a blank Owner tab and shows it, after the others", async () => {
    const { ownerTabs, opened } = withTabs([...owners, page("owner-1", { title: "" })]);

    // The fake browser opens `owner-<n>`.
    const listing = await ownerTabs.open();

    expect(opened).toEqual([ownerTabScope("id-1")]);
    expect(listing.shown).toBe("id-1");
    expect(listing.tabs.map(({ id }) => id)).toEqual(["a", "b", "c", "id-1"]);
    expect(ownerTabs.list().shown).toBe("id-1");
  });

  it("shows another Owner tab, as the host's shown one", async () => {
    const { ownerTabs } = withTabs(owners);

    expect((await ownerTabs.show("c")).shown).toBe("c");
    expect(ownerTabs.list().shown).toBe("c");
  });

  it("does not show a tab that is not there", async () => {
    const { ownerTabs, tabs } = withTabs(owners);

    await gone(ownerTabs.show("nope"));

    tabs.delete(ownerTabScope("b"));
    await gone(ownerTabs.show("b"));
    expect(ownerTabs.list().shown).toBe("a");
  });

  it("closes an Owner tab with the windows it opened, and the one shown gives way to its neighbour", async () => {
    const { ownerTabs, reads, forgotten, tabs } = withTabs(
      [
        ...owners,
        page("popup-b", { openerId: "owner-b", canAccessOpener: true }),
        page("popup-of-popup-b", { openerId: "popup-b", canAccessOpener: true }),
        // A tab a link of `b` opened is an Owner tab of its own: it stays.
        page("link-page", { openerId: "owner-b", canAccessOpener: false }),
        page("conversation-tab"),
      ],
      "b",
    );

    const listing = await ownerTabs.close("b");

    // Its pop-ups close, the innermost first, then the tab; no other page is touched.
    expect(reads.flatMap(closed)).toEqual([
      { targetId: "popup-of-popup-b" },
      { targetId: "popup-b" },
      { targetId: "owner-b" },
    ]);
    expect(listing.tabs.map(({ id }) => id)).toEqual(["a", "c", "id-1"]);
    // The tab its link opened was shown, and stays so.
    expect(listing.shown).toBe("id-1");
    expect(forgotten).toEqual([ownerTabScope("b")]);
    expect(tabs.has(ownerTabScope("b"))).toBe(false);
  });

  it("lists a tab a link opened before closing anything, so a close that fails leaves no scope in no list", async () => {
    const targets = [
      ...owners,
      page("popup-b", { openerId: "owner-b", canAccessOpener: true }),
      page("link-page", { openerId: "owner-b", canAccessOpener: false }),
    ];

    const store = records();
    const tabs = new Map<string, Tab>();

    for (const id of ["a", "b", "c"]) {
      tabs.set(ownerTabScope(id), { browserSessionId: "browser-1", targetId: `owner-${id}` });
    }

    store.put("owner-tabs", { tabs: [{ id: "a" }, { id: "b" }, { id: "c" }], shown: "a" });

    const failing = fakeTransport({
      "Target.getTargets": { targetInfos: targets },
      "Target.closeTarget": () => {
        throw new Error("Browser Run is not answering");
      },
    });

    const first = ownerTabsOver([failing], store, tabs);

    await expect(first.ownerTabs.close("b")).rejects.toThrow(/not answering/);
    expect(first.adopted).toEqual([[ownerTabScope("id-1"), "link-page"]]);
    expect(first.ownerTabs.list().tabs.map(({ id }) => id)).toEqual(["a", "b", "c", "id-1"]);

    // The next look finds the page already listed: it is not recorded again under a new ID.
    const second = ownerTabsOver(
      [fakeTransport({ "Target.getTargets": { targetInfos: targets } })],
      store,
      tabs,
    );

    await second.ownerTabs.tabs();
    expect(second.adopted).toEqual([]);
  });

  it("shows the neighbour on the right of the Owner tab shown when it closes, else on the left", async () => {
    const { ownerTabs } = withTabs(owners, "b");

    expect((await ownerTabs.close("b")).shown).toBe("c");
    expect((await ownerTabs.close("c")).shown).toBe("a");
  });

  it("closing the last Owner tab leaves none, and an Owner tab not in the list is closed all the same", async () => {
    const { ownerTabs, tabs, store } = withTabs([page("owner-a")], "a", ["a"]);

    expect(await ownerTabs.close("a")).toEqual({ tabs: [] });
    expect(store.get("owner-tabs")).toEqual({ tabs: [] });
    expect(tabs.size).toBe(0);

    expect(await ownerTabs.close("a")).toEqual({ tabs: [] });
  });

  it("never closes a conversation's tab", async () => {
    const { ownerTabs, reads } = withTabs([...owners, page("conversation-tab")]);

    expect((await ownerTabs.close("conversation-tab")).shown).toBe("a");
    expect(reads.flatMap(closed)).toEqual([]);
  });

  it("makes a page an Owner tab opened with a link an Owner tab of its own, and keeps a pop-up a window", async () => {
    const { ownerTabs, adopted, tabs } = withTabs([
      ...owners,
      page("link-page", { openerId: "owner-b", canAccessOpener: false, title: "Docs" }),
      page("popup", { openerId: "owner-b", canAccessOpener: true, title: "Sign in" }),
      page("conversation-tab"),
      // Opened by a conversation's tab, not by an Owner tab.
      page("agent-link-page", { openerId: "conversation-tab", canAccessOpener: false }),
    ]);

    const listing = await ownerTabs.tabs();

    expect(listing.tabs).toEqual([
      { id: "a", title: "Tab A", url: "https://example.com/owner-a" },
      { id: "b", title: "Tab B", url: "https://example.com/owner-b" },
      { id: "c", title: "Tab C", url: "https://example.com/owner-c" },
      { id: "id-1", title: "Docs", url: "https://example.com/link-page" },
    ]);
    expect(adopted).toEqual([[ownerTabScope("id-1"), "link-page"]]);
    expect(tabs.get(ownerTabScope("id-1"))?.targetId).toBe("link-page");
    // Opened from `b`, which is not the tab shown: it joins the list, and `a` stays shown.
    expect(listing.shown).toBe("a");

    // Read again, nothing more joins.
    expect((await ownerTabs.tabs()).tabs).toHaveLength(4);
    expect(adopted).toHaveLength(1);
  });

  it("shows a tab a link opened from the tab shown, also through its pop-up, and lists it once when read at once", async () => {
    const { ownerTabs, adopted } = withTabs([
      ...owners,
      page("link-page", { openerId: "owner-a", canAccessOpener: false, title: "Docs" }),
      page("popup", { openerId: "owner-a", canAccessOpener: true }),
      page("deep-link-page", { openerId: "popup", canAccessOpener: false, title: "Deep" }),
    ]);

    const [first] = await Promise.all([ownerTabs.tabs(), ownerTabs.tabs()]);

    expect(first.tabs.map(({ id }) => id)).toEqual(["a", "b", "c", "id-1", "id-2"]);
    expect(first.shown).toBe("id-2");
    expect(adopted).toEqual([
      [ownerTabScope("id-1"), "link-page"],
      [ownerTabScope("id-2"), "deep-link-page"],
    ]);
  });

  it("leaves a page that would be the twenty-first Owner tab alone", async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `t${index}`);

    const { ownerTabs, adopted } = withTabs(
      [
        ...ids.map((id) => page(`owner-${id}`)),
        page("link-page", { openerId: "owner-t0", canAccessOpener: false }),
      ],
      "t0",
      ids,
    );

    expect((await ownerTabs.tabs()).tabs).toHaveLength(20);
    expect(adopted).toEqual([]);
    await expect(ownerTabs.open()).rejects.toThrow(/20 Owner tabs/);
  });

  it("mints links to the pop-ups of the tab shown, not to a tab a link opened", async () => {
    const { ownerTabs } = withTabs([
      ...owners,
      page("link-page", { openerId: "owner-a", canAccessOpener: false }),
      page("popup", { openerId: "owner-a", canAccessOpener: true, title: "Sign in" }),
      page("link-page-popup", { openerId: "link-page", canAccessOpener: true }),
    ]);

    const links = await ownerTabs.view(false);

    expect(links.windows.map(({ targetId }) => targetId)).toEqual(["popup"]);
  });

  it("moves to a neighbour when the shown Owner tab closes itself, and mints links to it", async () => {
    const { ownerTabs, tabs } = withTabs(owners, "b");

    tabs.delete(ownerTabScope("b"));

    const links = await ownerTabs.view(false);

    expect(links.ownerTabId).toBe("c");
    expect(ownerTabs.list()).toEqual({
      tabs: [
        { id: "a", url: "https://example.com/owner-a" },
        { id: "c", url: "https://example.com/owner-c" },
      ],
      shown: "c",
    });
  });

  it("leaves a page alone, starting no browser, when the browser closed before it could be recorded, and records it next time", async () => {
    const targets = [
      ...owners,
      page("link-page", { openerId: "owner-b", canAccessOpener: false, title: "Docs" }),
    ];

    const store = records();
    const tabs = new Map<string, Tab>();

    for (const id of ["a", "b", "c"]) {
      tabs.set(ownerTabScope(id), { browserSessionId: "browser-1", targetId: `owner-${id}` });
    }

    store.put("owner-tabs", { tabs: [{ id: "a" }, { id: "b" }, { id: "c" }], shown: "a" });

    const reads = () =>
      Array.from({ length: 4 }, () =>
        fakeTransport({ "Target.getTargets": { targetInfos: targets } }),
      );

    const closed = ownerTabsOver(reads(), store, tabs, undefined, { adoptFails: true });

    expect((await closed.ownerTabs.tabs()).tabs.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(closed.opened).toEqual([]);
    expect(closed.adopted).toEqual([]);

    const later = ownerTabsOver(reads(), store, tabs);

    expect((await later.ownerTabs.tabs()).tabs.map(({ title }) => title)).toEqual([
      "Tab A",
      "Tab B",
      "Tab C",
      "Docs",
    ]);
  });

  it("counts the Owner tabs that are there against the twenty, not stored ones that are gone", async () => {
    const stale = Array.from({ length: 25 }, (_, index) => `old${index}`);
    const { ownerTabs, store, opened } = withTabs(owners);

    store.put("owner-tabs", {
      tabs: [...stale.map((id) => ({ id })), { id: "a" }, { id: "b" }, { id: "c" }],
      shown: "a",
    });

    const listing = await ownerTabs.open();

    expect(opened).toEqual([ownerTabScope("id-1")]);
    expect(listing.tabs.map(({ id }) => id)).toEqual(["a", "b", "c", "id-1"]);
  });

  it("answers listings asked while one waits with a single listing", async () => {
    const { ownerTabs, connected } = withTabs(owners);

    await Promise.all(Array.from({ length: 6 }, () => ownerTabs.tabs()));

    // The first runs at once and the five asked meanwhile share the next.
    expect(connected.length).toBeLessThanOrEqual(2);
  });

  it("closes an Owner tab on one connection", async () => {
    const { ownerTabs, connected } = withTabs([
      ...owners,
      page("popup", { openerId: "owner-b", canAccessOpener: true }),
    ]);

    await ownerTabs.close("b");
    expect(connected).toHaveLength(1);
  });
});

describe("the Owner tabs' addresses and titles, kept and reopened", () => {
  /** Owner tabs `a` and `b` (targets `owner-a`, `owner-b`) whose pages are at the addresses `at` says. */
  const twoTabs = (at: { a: string; b: string }) => {
    const store = records();
    const tabs = new Map<string, Tab>();

    tabs.set(ownerTabScope("a"), { browserSessionId: "browser-1", targetId: "owner-a" });
    tabs.set(ownerTabScope("b"), { browserSessionId: "browser-1", targetId: "owner-b" });
    store.put("owner-tabs", { tabs: [{ id: "a" }, { id: "b" }], shown: "b" });

    const cdp = () =>
      fakeTransport({
        "Target.getTargets": {
          targetInfos: [
            page("owner-a", { url: at.a, title: "A" }),
            page("owner-b", { url: at.b, title: "B" }),
            page("conversation-tab", { url: "https://agent.example/" }),
          ],
        },
      });

    return { store, tabs, cdp };
  };

  it("records each Owner tab's address and title when the list is read, and again as the owner browses", async () => {
    const at = { a: "https://a.example/", b: "https://b.example/start" };
    const { store, tabs, cdp } = twoTabs(at);
    const first = ownerTabsOver([cdp()], store, tabs).ownerTabs;

    // The agent's own tab is not an Owner tab: it is not recorded.
    await first.tabs();
    expect(first.list()).toEqual({
      tabs: [
        { id: "a", url: "https://a.example/" },
        { id: "b", url: "https://b.example/start" },
      ],
      shown: "b",
    });

    // The owner browses on: the next read notes where the tab is now.
    at.b = "https://b.example/next";

    const next = ownerTabsOver([cdp()], store, tabs).ownerTabs;

    await next.tabs();
    expect(next.list().tabs.map((tab) => tab.url)).toEqual([
      "https://a.example/",
      "https://b.example/next",
    ]);
  });

  it("records the address through show and close too, and keeps no fragment or title", async () => {
    const at = { a: "https://a.example/cb?code=x#access_token=secret", b: "https://b.example/" };
    const { store, tabs, cdp } = twoTabs(at);
    const reads = [cdp()];
    const { ownerTabs } = ownerTabsOver(reads, store, tabs);

    await ownerTabs.show("a");
    expect(ownerTabs.list().tabs).toEqual([
      { id: "a", url: "https://a.example/cb?code=x" },
      { id: "b", url: "https://b.example/" },
    ]);

    at.b = "https://b.example/next#frag";
    reads.push(cdp());
    await ownerTabs.close("a");
    expect(ownerTabs.list()).toEqual({
      tabs: [{ id: "b", url: "https://b.example/next" }],
      shown: "b",
    });
  });

  it("records them as the Pane asks for links, a new tab, and the tab it opened", async () => {
    const { ownerTabs } = ownerTabsOver([withWindows(), withWindows()]);

    await ownerTabs.view(true);
    expect(ownerTabs.list().tabs).toEqual([{ id: "id-1" }]);

    // A read of the list finds where it is.
    await ownerTabs.tabs();
    expect(ownerTabs.list().tabs).toEqual([{ id: "id-1", url: "https://example.com/owner-1" }]);
  });

  it("keeps the last address a tab had when its page failed to load, and records only addresses that can be reopened", async () => {
    const at = { a: "https://a.example/", b: "https://b.example/" };
    const { store, tabs, cdp } = twoTabs(at);

    await ownerTabsOver([cdp()], store, tabs).ownerTabs.tabs();

    at.a = "chrome-error://chromewebdata/";
    at.b = "file:///etc/passwd";

    const after = ownerTabsOver([cdp()], store, tabs).ownerTabs;

    await after.tabs();
    expect(after.list().tabs.map((tab) => tab.url)).toEqual([
      "https://a.example/",
      "https://b.example/",
    ]);
  });

  it("reopens every Owner tab at its address, in order, in a browser that replaced the old one, and shows the tab that was shown", async () => {
    const store = records();

    store.put("owner-tabs", {
      tabs: [
        { id: "a", url: "https://a.example/" },
        { id: "b", url: "https://b.example/deep?x=1" },
        { id: "c" },
      ],
      shown: "b",
    });

    // The browser they were in is gone: no scope has a tab.
    const { ownerTabs, opened, urls, forgotten } = ownerTabsOver([fakeTransport()], store);
    const links = await ownerTabs.view(true);

    expect(opened).toEqual([ownerTabScope("a"), ownerTabScope("b"), ownerTabScope("c")]);
    expect(urls).toEqual(["https://a.example/", "https://b.example/deep?x=1", "about:blank"]);
    expect(forgotten).toEqual([]);

    // The one that was shown is shown again (the second to open: `owner-2`), and the answer says what happened.
    expect(links.ownerTabId).toBe("b");
    expect(links.tab.targetId).toBe("owner-2");
    expect([links.opened, links.replaced, links.reopened]).toEqual([true, true, 3]);

    // Their order, addresses and titles are kept, and so is the one shown.
    expect(ownerTabs.list()).toEqual({
      tabs: [
        { id: "a", url: "https://a.example/" },
        { id: "b", url: "https://b.example/deep?x=1" },
        { id: "c" },
      ],
      shown: "b",
    });
  });

  it("reopens only http(s) pages and blank ones: anything else a record holds opens blank", async () => {
    const store = records();

    store.put("owner-tabs", {
      tabs: [
        { id: "a", url: "file:///etc/passwd" },
        { id: "b", url: "chrome://settings" },
        { id: "c", url: "javascript:alert(1)" },
        { id: "d", url: "http://d.example/" },
      ],
      shown: "a",
    });

    const { ownerTabs, urls } = ownerTabsOver([fakeTransport()], store);

    await ownerTabs.view(true);
    expect(urls).toEqual(["about:blank", "about:blank", "about:blank", "http://d.example/"]);
  });

  it("opens a tab blank when the browser refuses its address, rather than losing it", async () => {
    const store = records();

    store.put("owner-tabs", {
      tabs: [{ id: "a", url: "https://a.example/" }],
      shown: "a",
    });

    const { ownerTabs, urls } = ownerTabsOver([fakeTransport()], store, undefined, undefined, {
      refuse: "https://a.example/",
    });

    const links = await ownerTabs.view(true);

    expect(links.reopened).toBe(1);
    expect(urls).toEqual(["https://a.example/", "about:blank"]);
  });

  it("does not reopen an Owner tab closed in the browser that runs: it leaves the list", async () => {
    const store = records();
    const tabs = new Map<string, Tab>();

    tabs.set(ownerTabScope("a"), { browserSessionId: "browser-1", targetId: "owner-a" });
    store.put("owner-tabs", {
      tabs: [
        { id: "a", url: "https://a.example/" },
        { id: "b", url: "https://b.example/" },
      ],
      shown: "b",
    });

    const { ownerTabs, opened, forgotten } = ownerTabsOver([fakeTransport()], store, tabs);
    const links = await ownerTabs.view(true);

    expect(links.ownerTabId).toBe("a");
    expect([links.opened, links.replaced, links.reopened]).toEqual([false, true, undefined]);
    expect(opened).toEqual([]);
    expect(forgotten).toEqual([ownerTabScope("b")]);
    expect(ownerTabs.list()).toEqual({
      tabs: [{ id: "a", url: "https://a.example/" }],
      shown: "a",
    });
  });

  it("shows the first Owner tab when none was shown, reopening the others too", async () => {
    const store = records();

    store.put("owner-tabs", { tabs: [{ id: "a", url: "https://a.example/" }, { id: "b" }] });

    const { ownerTabs, opened } = ownerTabsOver([fakeTransport()], store);
    const links = await ownerTabs.view(true);

    expect(opened).toEqual([ownerTabScope("a"), ownerTabScope("b")]);
    expect(links.ownerTabId).toBe("a");
    expect(links.replaced).toBe(false);
  });

  it("reports nothing lost when every Owner tab was closed in a browser that still runs", async () => {
    const store = records();

    store.put("owner-tabs", { tabs: [{ id: "a", url: "https://a.example/" }], shown: "a" });

    const { ownerTabs } = ownerTabsOver([], store, undefined, undefined, {
      closed: new Set([ownerTabScope("a")]),
    });

    expect(await ownerTabs.tabs()).toEqual({ tabs: [] });
  });

  it("reopens the rest on the next ask when a reopening failed part way, rather than forgetting them", async () => {
    const store = records();

    store.put("owner-tabs", {
      tabs: [
        { id: "a", url: "https://a.example/" },
        { id: "b", url: "https://b.example/" },
        { id: "c", url: "about:blank" },
      ],
      shown: "a",
    });

    const tabs = new Map<string, Tab>();
    const replaced = new Set([ownerTabScope("b"), ownerTabScope("c")]);

    const host = ownerTabsOver([fakeTransport(), fakeTransport()], store, tabs, undefined, {
      replaced,
      failOnce: ownerTabScope("b"),
    });

    // `a` reopened, `b` failed: the list is as it was.
    await expect(host.ownerTabs.view(true)).rejects.toThrow();
    expect(host.opened).toEqual([ownerTabScope("a"), ownerTabScope("b"), ownerTabScope("b")]);
    expect(host.ownerTabs.list().tabs.map((tab) => tab.id)).toEqual(["a", "b", "c"]);

    // The next ask finds `a` open and `b` and `c` still taken with the old browser: it reopens them.
    const links = await host.ownerTabs.view(true);

    expect(links.reopened).toBe(2);
    expect(host.ownerTabs.list().tabs.map((tab) => tab.id)).toEqual(["a", "b", "c"]);
  });

  it("reopens nothing when only asked for links", async () => {
    const store = records();

    store.put("owner-tabs", { tabs: [{ id: "a", url: "https://a.example/" }], shown: "a" });

    const { ownerTabs, opened, connected } = ownerTabsOver([], store);

    await gone(ownerTabs.view(false));
    expect(opened).toEqual([]);
    expect(connected).toEqual([]);
    expect(ownerTabs.list().tabs).toEqual([{ id: "a", url: "https://a.example/" }]);
  });

  it("does not reopen the only Owner tab when it was closed in the browser that runs: a new one opens in its place", async () => {
    const store = records();

    store.put("owner-tabs", { tabs: [{ id: "a", url: "https://a.example/" }], shown: "a" });

    const { ownerTabs, opened, urls, forgotten } = ownerTabsOver(
      [fakeTransport()],
      store,
      undefined,
      undefined,
      { closed: new Set([ownerTabScope("a")]) },
    );

    const links = await ownerTabs.view(true);

    expect([links.opened, links.replaced, links.reopened]).toEqual([true, true, undefined]);
    expect(urls).toEqual(["about:blank"]);
    expect(opened).toHaveLength(1);
    expect(forgotten).toEqual([ownerTabScope("a")]);
    expect(ownerTabs.list().tabs.map((tab) => tab.id)).toEqual(["id-1"]);
  });
});

/** Two Owner tabs the owner has open (`one` shown) in `browser-1`, and a third that was closed. */
const withTwoTabs = (transports: ReturnType<typeof fakeTransport>[]) => {
  const store = records();

  const tabs = new Map<string, Tab>([
    [ownerTabScope("one"), { browserSessionId: "browser-1", targetId: "page-one" }],
    [ownerTabScope("two"), { browserSessionId: "browser-1", targetId: "page-two" }],
  ]);

  store.put("owner-tabs", { tabs: [{ id: "one" }, { id: "two" }, { id: "closed" }], shown: "one" });

  return { ...ownerTabsOver(transports, store, tabs), store };
};

const twoPages = () =>
  fakeTransport({
    "Target.getTargets": {
      targetInfos: [
        page("page-one", { title: "First", url: "https://example.com/one" }),
        page("page-two", { title: "Second", url: "https://example.com/two" }),
        page("conversation-tab", { title: "The agent's" }),
      ],
    },
    "Runtime.evaluate": (_params, sessionId) => ({
      result: { type: "string", value: sessionId === "cdp-page-one" ? "A paragraph." : "" },
    }),
  });

describe("reading the Owner tabs a message attaches", () => {
  it("reads the URL and title of the tabs asked for and the selected text of the one shown, not starting or opening anything", async () => {
    const cdp = twoPages();
    const { ownerTabs, opened } = withTwoTabs([cdp]);

    expect(await ownerTabs.read(["one", "two"])).toEqual([
      {
        ownerTabId: "one",
        url: "https://example.com/one",
        title: "First",
        selection: "A paragraph.",
      },
      { ownerTabId: "two", url: "https://example.com/two", title: "Second" },
    ]);

    expect(opened).toEqual([]);

    // Only the page shown is attached to for its selection, and let go.
    expect(cdp.sent.filter((command) => command.method === "Target.attachToTarget")).toEqual([
      { method: "Target.attachToTarget", params: { targetId: "page-one", flatten: true } },
    ]);
    expect(cdp.sent.filter((command) => command.method === "Target.detachFromTarget")).toHaveLength(
      1,
    );
    expect(cdp.state.closed).toBe(true);
  });

  it("reads no selection of a tab that is not shown, whatever it holds", async () => {
    const cdp = twoPages();
    const { ownerTabs } = withTwoTabs([cdp]);

    const [, two] = await ownerTabs.read(["one", "two"]);

    expect(two).toEqual({ ownerTabId: "two", url: "https://example.com/two", title: "Second" });
    expect(
      cdp.sent
        .filter((command) => command.method === "Runtime.evaluate")
        .map(({ params }) => params),
    ).toHaveLength(1);
  });

  it("still gives a tab's URL and title when its selection cannot be read", async () => {
    const stuck = fakeTransport({
      "Target.getTargets": { targetInfos: [page("page-one", { title: "First" })] },
      "Runtime.evaluate": () => {
        throw new Error("Execution context was destroyed");
      },
    });

    const [read] = await withTwoTabs([stuck]).ownerTabs.read(["one"]);

    expect(read).toEqual({
      ownerTabId: "one",
      url: "https://example.com/page-one",
      title: "First",
    });
  });

  it("says the Owner tab is gone when one asked for is not there, reading none", async () => {
    const { ownerTabs, connected, tabs } = withTwoTabs([twoPages()]);

    await gone(ownerTabs.read(["one", "closed"]));
    expect(connected).toEqual([]);

    await gone(ownerTabs.read(["nope"]));

    // A scope that is no Owner tab of the owner's (not in the list) is not read, though the browser has a tab for it.
    tabs.set(ownerTabScope("stray"), { browserSessionId: "browser-1", targetId: "page-stray" });
    await gone(ownerTabs.read(["stray"]));
    expect(connected).toEqual([]);
  });
});

describe("the script that reads a page's selected text", () => {
  /** The part of a DOM element the script looks at. */
  type Element = {
    readonly value?: string;
    readonly selectionStart?: number;
    readonly selectionEnd?: number;
    readonly type?: string;
    readonly autocomplete?: string;
    readonly tagName?: string;
    readonly nodeType?: number;
  };

  /** `SELECTION` run in a page whose active element is `active`, whose document selection is `selected` (inside `anchor`). */
  const inPage = (
    active: Element | null,
    selected = "",
    anchor: Element | null = null,
    security = "none",
  ): string => {
    const window = {
      getSelection: () => ({
        anchorNode: anchor,
        toString: () => selected,
      }),
      getComputedStyle: () => ({ getPropertyValue: () => security }),
    };

    // oxlint-disable-next-line no-implied-eval -- the script is a constant of this file, run against a stub page.
    const run = new Function("document", "window", `return ${SELECTION};`);

    return String(run({ activeElement: active }, window));
  };

  const field = (value: string, extra: Element = {}) =>
    ({ value, selectionStart: 2, selectionEnd: 6, type: "text", ...extra }) satisfies Element;

  it("reads what is selected in the field being typed in, else the document's selection", () => {
    expect(inPage(field("0123456789"))).toBe("2345");
    expect(inPage({ tagName: "BODY" }, "A paragraph.")).toBe("A paragraph.");
    expect(inPage(field("0123", { selectionEnd: 2 }), "Text outside")).toBe("Text outside");
  });

  it("reads nothing from a password field, or one that is masked in another way", () => {
    expect(inPage(field("hunter2hunter2", { type: "password" }), "hunter2")).toBe("");
    expect(inPage(field("123456", { autocomplete: "one-time-code" }))).toBe("");
    expect(inPage(field("4111111111111111", { autocomplete: "cc-number" }))).toBe("");
    expect(inPage(field("secretsecret", { autocomplete: "new-password" }))).toBe("");
    // Text shown as dots by the page's style.
    expect(inPage(field("secretsecret"), "", null, "disc")).toBe("");
    expect(inPage({ tagName: "BODY" }, "secret", { nodeType: 1 }, "disc")).toBe("");
  });

  it("reads at most the bound, without splitting a surrogate pair", () => {
    const long = "x".repeat(MAX_PAGE_SELECTION_READ - 1);

    expect(inPage({ tagName: "BODY" }, `${long}😀😀`)).toBe(long);
    expect(String(inPage({ tagName: "BODY" }, "y".repeat(50_000))).length).toBe(
      MAX_PAGE_SELECTION_READ,
    );
  });
});
