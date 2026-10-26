// The Browser Pane's Owner tabs in the browser host (`./owner-tabs.ts`), over the scripted CDP connection the handoff
// tests use: opening the Pane opens an Owner tab only when the owner has none, the host keeps the Owner tabs as a list
// with the one shown, each ask mints 60-second links named by their target for the tab and its windows, and a tab whose
// browser is gone is said to be gone rather than replaced unasked.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off
import { OWNER_TAB_GONE } from "@cloudpid/extensions/browser/contract";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import { BrowserGoneError } from "./cdp.ts";
import { fakeTransport, linkTo, page, records, TOKEN } from "./cdp.testing.ts";
import { OwnerTabs, ownerTabScope } from "./owner-tabs.ts";

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
) => {
  const opened: string[] = [];
  const connected: string[] = [];
  const forgotten: string[] = [];
  let ids = 0;

  const ownerTabs = new OwnerTabs({
    records: store,
    newId: () => `id-${++ids}`,
    browser: {
      tabOf: (scope) => Promise.resolve(tabs.get(scope)),
      openTab: async (scope) => {
        opened.push(scope);
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

  return { ownerTabs, store, tabs, opened, connected, forgotten };
};

/** The targets of a browser with Owner tab `owner-1` and a pop-up it opened, which opened one of its own. */
const withWindows = () =>
  fakeTransport({
    "Target.getTargets": {
      targetInfos: [
        page("owner-1"),
        page("conversation-tab"),
        page("popup-1", { openerId: "owner-1", title: "Sign in" }),
        page("popup-2", { openerId: "popup-1", title: "Consent" }),
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

  it("says the Owner tab is gone when its browser was closed or replaced, and opens a new one only when asked to", async () => {
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

    // The owner opens a new Owner tab: it is shown, said to replace the one that is gone, and the gone one leaves the
    // list, its scope record deleted.
    const fresh = await ownerTabs.view(true);

    expect(fresh.ownerTabId).toBe("id-2");
    expect(fresh.tab.targetId).toBe("owner-2");
    expect([fresh.opened, fresh.replaced]).toEqual([true, true]);
    expect(opened).toEqual([ownerTabScope("id-1"), ownerTabScope("id-2")]);
    expect(forgotten).toEqual([ownerTabScope("id-1")]);
    expect(ownerTabs.list()).toEqual({ tabs: [{ id: "id-2" }], shown: "id-2" });
  });

  it("shows another Owner tab still there in place of the one that is gone, opening none, and says it replaced it", async () => {
    const store = records();
    const tabs = new Map<string, Tab>();

    tabs.set(ownerTabScope("b"), { browserSessionId: "browser-1", targetId: "owner-b" });
    store.put("owner-tabs", { tabs: [{ id: "a" }, { id: "b" }], shown: "a" });

    const { ownerTabs, opened, forgotten } = ownerTabsOver([fakeTransport()], store, tabs);
    const shown = await ownerTabs.view(true);

    expect(shown.ownerTabId).toBe("b");
    expect([shown.opened, shown.replaced]).toEqual([false, true]);
    expect(opened).toEqual([]);
    expect(forgotten).toEqual([ownerTabScope("a")]);
    expect(ownerTabs.list()).toEqual({ tabs: [{ id: "b" }], shown: "b" });
  });

  it("leaves out a window that closes between the listing and its link, still minting the others", async () => {
    const cdp = fakeTransport({
      "Target.getTargets": {
        targetInfos: [
          page("owner-1"),
          page("popup-1", { openerId: "owner-1", title: "Sign in" }),
          page("popup-2", { openerId: "owner-1", title: "Help" }),
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
