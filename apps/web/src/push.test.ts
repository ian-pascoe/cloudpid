// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off -- browser code in a React app with no Effect runtime: native arrays and promises are the platform here.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserSubscription,
  decodeKey,
  disablePush,
  enablePush,
  loadPushStatus,
  pageBrowser,
  type PushBrowser,
  syncPush,
} from "./push.ts";
import type { Answer } from "./registry.ts";

const ENDPOINT = "https://push.example.net/wpush/v2/abc";

/** A browser subscription that records whether it was unsubscribed. */
const subscription = (endpoint = ENDPOINT, key = "PUBLIC") => {
  const state = { unsubscribed: false };

  const value: BrowserSubscription = {
    applicationServerKey: () => decodeKey(key),
    toJSON: () => ({ endpoint, keys: { p256dh: "P256", auth: "AUTH" } }),
    unsubscribe: () => {
      state.unsubscribed = true;

      return Promise.resolve(true);
    },
  };

  return { value, state };
};

type BrowserOptions = {
  readonly supported?: boolean;
  readonly permission?: NotificationPermission;
  /** What asking for permission answers. */
  readonly grants?: NotificationPermission;
  readonly existing?: BrowserSubscription | null;
};

/** A browser with the given state, recording the keys it was asked to subscribe with. */
const fakeBrowser = (options: BrowserOptions = {}) => {
  let permission = options.permission ?? "default";
  let current = options.existing ?? null;
  const subscribed: string[] = [];
  const made = { value: subscription().value, state: { unsubscribed: false } };

  const browser: PushBrowser = {
    supported: options.supported ?? true,
    permission: () => permission,
    requestPermission: () => {
      permission = options.grants ?? "granted";

      return Promise.resolve(permission);
    },
    getSubscription: () => Promise.resolve(current),
    subscribe: (publicKey) => {
      const fresh = subscription(ENDPOINT, publicKey);

      subscribed.push(publicKey);
      made.value = fresh.value;
      made.state = fresh.state;
      current = fresh.value;

      return Promise.resolve(fresh.value);
    },
  };

  return { browser, subscribed, made };
};

const ok = <A>(value: A): Answer<A> => ({ ok: true, value });
const refused = (message: string): Answer<never> => ({ ok: false, message });

/** A Registry keeping subscriptions by endpoint; `failing` names the calls it refuses. */
const fakeRegistry = (initial: readonly string[] = [], failing: readonly string[] = []) => {
  const kept = new Set(initial);

  return {
    kept,
    registry: {
      getPush: (endpoint?: string) =>
        Promise.resolve(
          failing.includes("getPush")
            ? refused("Registry is down")
            : ok({ publicKey: "PUBLIC", subscribed: endpoint !== undefined && kept.has(endpoint) }),
        ),
      subscribePush: (subscribed: { endpoint: string }) => {
        if (failing.includes("subscribePush")) return Promise.resolve(refused("Registry is down"));

        kept.add(subscribed.endpoint);

        return Promise.resolve(ok(undefined));
      },
      unsubscribePush: (endpoint: string) => {
        if (failing.includes("unsubscribePush"))
          return Promise.resolve(refused("Registry is down"));

        kept.delete(endpoint);

        return Promise.resolve(ok(undefined));
      },
    },
  };
};

describe("loadPushStatus", () => {
  it("says a browser without Web Push is unsupported", async () => {
    expect(
      await loadPushStatus(fakeBrowser({ supported: false }).browser, fakeRegistry().registry),
    ).toEqual({ kind: "unsupported" });
  });

  it("says a device with no subscription is off, or blocked when the browser blocks notifications", async () => {
    expect(await loadPushStatus(fakeBrowser().browser, fakeRegistry().registry)).toEqual({
      kind: "off",
    });
    expect(
      await loadPushStatus(fakeBrowser({ permission: "denied" }).browser, fakeRegistry().registry),
    ).toEqual({ kind: "denied" });
  });

  it("says a device the Registry holds is on", async () => {
    const { browser } = fakeBrowser({ permission: "granted", existing: subscription().value });

    expect(await loadPushStatus(browser, fakeRegistry([ENDPOINT]).registry)).toEqual({
      kind: "on",
    });
  });

  it("gives the Registry back a subscription it lost, so the device is on", async () => {
    const { browser } = fakeBrowser({ permission: "granted", existing: subscription().value });
    const { registry, kept } = fakeRegistry();

    expect(await loadPushStatus(browser, registry)).toEqual({ kind: "on" });
    expect(kept.has(ENDPOINT)).toBe(true);
  });

  it("reports a Registry that cannot be reached", async () => {
    const { browser } = fakeBrowser({ permission: "granted", existing: subscription().value });

    expect(await loadPushStatus(browser, fakeRegistry([], ["getPush"]).registry)).toEqual({
      kind: "error",
      message: "Registry is down",
    });
  });
});

describe("a VAPID key that was rotated", () => {
  it("replaces a subscription made with the old key, so the device keeps getting pushes", async () => {
    const old = subscription(ENDPOINT, "OLDKEY1");

    const { browser, subscribed, made } = fakeBrowser({
      permission: "granted",
      existing: old.value,
    });

    const { registry, kept } = fakeRegistry([ENDPOINT]);

    expect(await loadPushStatus(browser, registry)).toEqual({ kind: "on" });
    expect(old.state.unsubscribed).toBe(true);
    expect(subscribed).toEqual(["PUBLIC"]);
    expect(made.value.applicationServerKey()).toEqual(decodeKey("PUBLIC"));
    expect([...kept]).toEqual([ENDPOINT]);
  });

  it("drops the old subscription and shows the device off when notifications are no longer allowed", async () => {
    const old = subscription(ENDPOINT, "OLDKEY1");
    const { browser, subscribed } = fakeBrowser({ permission: "granted", existing: old.value });
    const { registry, kept } = fakeRegistry([ENDPOINT]);

    // The browser reports permission lost between reading the subscription and replacing it.
    let reads = 0;

    const revoked: PushBrowser = {
      ...browser,
      permission: () => (reads++ < 1 ? "granted" : "denied"),
    };

    expect(await loadPushStatus(revoked, registry)).toEqual({ kind: "off" });
    expect(old.state.unsubscribed).toBe(true);
    expect(subscribed).toEqual([]);
    expect(kept.size).toBe(0);
  });

  it("is replaced at startup too", async () => {
    const old = subscription(ENDPOINT, "OLDKEY1");
    const { browser, subscribed } = fakeBrowser({ permission: "granted", existing: old.value });

    await syncPush(browser, fakeRegistry([ENDPOINT]).registry);
    expect(subscribed).toEqual(["PUBLIC"]);
  });
});

describe("enablePush", () => {
  it("asks permission, subscribes with the deployment's key, and has the Registry keep it", async () => {
    const { browser, subscribed } = fakeBrowser();
    const { registry, kept } = fakeRegistry();

    expect(await enablePush(browser, registry)).toEqual({ kind: "on" });
    expect(subscribed).toEqual(["PUBLIC"]);
    expect([...kept]).toEqual([ENDPOINT]);
  });

  it("does not subscribe when the user refuses permission", async () => {
    const { browser, subscribed } = fakeBrowser({ grants: "denied" });
    const { registry, kept } = fakeRegistry();

    expect(await enablePush(browser, registry)).toEqual({ kind: "denied" });
    expect(subscribed).toEqual([]);
    expect(kept.size).toBe(0);
  });

  it("stays off when the permission prompt is dismissed", async () => {
    const { browser } = fakeBrowser({ grants: "default" });

    expect(await enablePush(browser, fakeRegistry().registry)).toEqual({ kind: "off" });
  });

  it("unsubscribes the browser when the Registry will not keep the subscription", async () => {
    const { browser, made } = fakeBrowser();

    expect(await enablePush(browser, fakeRegistry([], ["subscribePush"]).registry)).toEqual({
      kind: "error",
      message: "Registry is down",
    });
    expect(made.state.unsubscribed).toBe(true);
  });
});

describe("disablePush", () => {
  it("has the Registry forget the device and unsubscribes the browser", async () => {
    const existing = subscription();
    const { browser } = fakeBrowser({ permission: "granted", existing: existing.value });
    const { registry, kept } = fakeRegistry([ENDPOINT]);

    expect(await disablePush(browser, registry)).toEqual({ kind: "off" });
    expect(kept.size).toBe(0);
    expect(existing.state.unsubscribed).toBe(true);
  });

  it("keeps the browser subscribed when the Registry could not forget it, so the page tells the truth", async () => {
    const existing = subscription();
    const { browser } = fakeBrowser({ permission: "granted", existing: existing.value });

    expect(
      await disablePush(browser, fakeRegistry([ENDPOINT], ["unsubscribePush"]).registry),
    ).toEqual({ kind: "error", message: "Registry is down" });
    expect(existing.state.unsubscribed).toBe(false);
  });
});

describe("syncPush", () => {
  it("re-tells the Registry about an existing subscription", async () => {
    const { browser } = fakeBrowser({ permission: "granted", existing: subscription().value });
    const { registry, kept } = fakeRegistry();

    await syncPush(browser, registry);
    expect(kept.has(ENDPOINT)).toBe(true);
  });

  it("never subscribes a device that is not, or one that has not allowed notifications", async () => {
    const granted = fakeBrowser({ permission: "granted" });
    const asked = fakeBrowser({ existing: subscription().value });
    const { registry, kept } = fakeRegistry();

    await syncPush(granted.browser, registry);
    await syncPush(asked.browser, registry);
    expect(kept.size).toBe(0);
    expect(granted.subscribed).toEqual([]);
  });
});

describe("decodeKey", () => {
  it("reads a base64url key into its bytes, with or without padding", () => {
    expect([...decodeKey("-_8")]).toEqual([251, 255]);
    expect([...decodeKey("-_8=")]).toEqual([251, 255]);
  });
});

describe("the page's browser", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("says why when the service worker never becomes active, instead of waiting forever", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { serviceWorker: { ready: new Promise(() => undefined) } });
    vi.stubGlobal("window", { PushManager: {}, Notification: {} });
    vi.stubGlobal("Notification", { permission: "granted" });

    const status = loadPushStatus(pageBrowser(), fakeRegistry().registry);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await status).toMatchObject({
      kind: "error",
      message: expect.stringContaining("service worker is not running"),
    });
  });
});
