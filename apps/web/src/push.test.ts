// @effect-diagnostics preferEffectArray:off newSchemaClass:off strictEffectProvide:off newPromise:off -- in-memory fakes of the browser and the Registry over native arrays and sets; each test provides its fakes, and one needs a promise that never settles.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vitest";
import {
  type BrowserSubscription,
  decodeKey,
  disablePush,
  enablePush,
  loadPushStatus,
  pageBrowser,
  type PushBrowser,
  PushManager,
  type PushStatus,
  syncPush,
} from "./push.ts";
import { fakeRegistryLayer } from "./registry.testing.ts";
import type { RegistryClient } from "./registry.ts";

// At a known push service: the fake Registry validates what it is sent, as the real one does.
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";

/** A browser subscription that records whether it was unsubscribed. */
const subscription = (endpoint = ENDPOINT, key = "PUBLIC") => {
  const state = { unsubscribed: false };

  const value: BrowserSubscription = {
    applicationServerKey: () => decodeKey(key),
    toJSON: () => ({ endpoint, keys: { p256dh: "P256", auth: "AUTH" } }),
    unsubscribe: Effect.sync(() => {
      state.unsubscribed = true;

      return true;
    }),
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
    supported: Effect.succeed(options.supported ?? true),
    permission: Effect.sync(() => permission),
    requestPermission: Effect.sync(() => {
      permission = options.grants ?? "granted";

      return permission;
    }),
    getSubscription: Effect.sync(() => current),
    subscribe: (publicKey) =>
      Effect.sync(() => {
        const fresh = subscription(ENDPOINT, publicKey);

        subscribed.push(publicKey);
        made.value = fresh.value;
        made.state = fresh.state;
        current = fresh.value;

        return fresh.value;
      }),
  };

  return { browser, subscribed, made };
};

/** A Registry keeping subscriptions by endpoint; `failing` names the calls it refuses. */
const fakeRegistry = (initial: readonly string[] = [], failing: readonly string[] = []) => {
  const kept = new Set(initial);
  const refuse = (call: string) => failing.includes(call);

  const layer = fakeRegistryLayer({
    getPush: ({ endpoint }) =>
      refuse("getPush")
        ? Effect.die(new Error("Registry is down"))
        : Effect.succeed({
            publicKey: "PUBLIC",
            subscribed: endpoint !== undefined && kept.has(endpoint),
          }),
    subscribePush: ({ subscription: subscribed }) =>
      refuse("subscribePush")
        ? Effect.die(new Error("Registry is down"))
        : Effect.sync(() => {
            kept.add(subscribed.endpoint);
          }),
    unsubscribePush: ({ endpoint }) =>
      refuse("unsubscribePush")
        ? Effect.die(new Error("Registry is down"))
        : Effect.sync(() => {
            kept.delete(endpoint);
          }),
  });

  return { kept, layer };
};

/** Run a push operation against `browser` and the Registry `layer`. */
const running = <A>(
  operation: Effect.Effect<A, never, PushManager | RegistryClient>,
  browser: PushBrowser,
  registry: Layer.Layer<RegistryClient>,
) => operation.pipe(Effect.provide(Layer.mergeAll(Layer.succeed(PushManager, browser), registry)));

describe("loadPushStatus", () => {
  it.effect("says a browser without Web Push is unsupported", () =>
    Effect.gen(function* () {
      expect(
        yield* running(
          loadPushStatus,
          fakeBrowser({ supported: false }).browser,
          fakeRegistry().layer,
        ),
      ).toEqual({ kind: "unsupported" });
    }),
  );

  it.effect(
    "says a device with no subscription is off, or blocked when the browser blocks notifications",
    () =>
      Effect.gen(function* () {
        expect(yield* running(loadPushStatus, fakeBrowser().browser, fakeRegistry().layer)).toEqual(
          { kind: "off" },
        );
        expect(
          yield* running(
            loadPushStatus,
            fakeBrowser({ permission: "denied" }).browser,
            fakeRegistry().layer,
          ),
        ).toEqual({ kind: "denied" });
      }),
  );

  it.effect("says a device the Registry holds is on", () =>
    Effect.gen(function* () {
      const { browser } = fakeBrowser({ permission: "granted", existing: subscription().value });

      expect(yield* running(loadPushStatus, browser, fakeRegistry([ENDPOINT]).layer)).toEqual({
        kind: "on",
      });
    }),
  );

  it.effect("gives the Registry back a subscription it lost, so the device is on", () =>
    Effect.gen(function* () {
      const { browser } = fakeBrowser({ permission: "granted", existing: subscription().value });
      const { layer, kept } = fakeRegistry();

      expect(yield* running(loadPushStatus, browser, layer)).toEqual({ kind: "on" });
      expect(kept.has(ENDPOINT)).toBe(true);
    }),
  );

  it.effect("reports a Registry that cannot be reached", () =>
    Effect.gen(function* () {
      const { browser } = fakeBrowser({ permission: "granted", existing: subscription().value });

      expect(yield* running(loadPushStatus, browser, fakeRegistry([], ["getPush"]).layer)).toEqual({
        kind: "error",
        message: "Registry is down",
      });
    }),
  );
});

describe("a VAPID key that was rotated", () => {
  it.effect(
    "replaces a subscription made with the old key, so the device keeps getting pushes",
    () =>
      Effect.gen(function* () {
        const old = subscription(ENDPOINT, "OLDKEY1");

        const { browser, subscribed, made } = fakeBrowser({
          permission: "granted",
          existing: old.value,
        });

        const { layer, kept } = fakeRegistry([ENDPOINT]);

        expect(yield* running(loadPushStatus, browser, layer)).toEqual({ kind: "on" });
        expect(old.state.unsubscribed).toBe(true);
        expect(subscribed).toEqual(["PUBLIC"]);
        expect(made.value.applicationServerKey()).toEqual(decodeKey("PUBLIC"));
        expect([...kept]).toEqual([ENDPOINT]);
      }),
  );

  it.effect(
    "drops the old subscription and shows the device off when notifications are no longer allowed",
    () =>
      Effect.gen(function* () {
        const old = subscription(ENDPOINT, "OLDKEY1");
        const { browser, subscribed } = fakeBrowser({ permission: "granted", existing: old.value });
        const { layer, kept } = fakeRegistry([ENDPOINT]);

        // The browser reports permission lost between reading the subscription and replacing it.
        let reads = 0;

        const revoked: PushBrowser = {
          ...browser,
          permission: Effect.sync(() => (reads++ < 1 ? "granted" : "denied")),
        };

        expect(yield* running(loadPushStatus, revoked, layer)).toEqual({ kind: "off" });
        expect(old.state.unsubscribed).toBe(true);
        expect(subscribed).toEqual([]);
        expect(kept.size).toBe(0);
      }),
  );

  it.effect("is replaced at startup too", () =>
    Effect.gen(function* () {
      const old = subscription(ENDPOINT, "OLDKEY1");
      const { browser, subscribed } = fakeBrowser({ permission: "granted", existing: old.value });

      yield* running(syncPush, browser, fakeRegistry([ENDPOINT]).layer);
      expect(subscribed).toEqual(["PUBLIC"]);
    }),
  );
});

describe("enablePush", () => {
  it.effect(
    "asks permission, subscribes with the deployment's key, and has the Registry keep it",
    () =>
      Effect.gen(function* () {
        const { browser, subscribed } = fakeBrowser();
        const { layer, kept } = fakeRegistry();

        expect(yield* running(enablePush, browser, layer)).toEqual({ kind: "on" });
        expect(subscribed).toEqual(["PUBLIC"]);
        expect([...kept]).toEqual([ENDPOINT]);
      }),
  );

  it.effect("does not subscribe when the user refuses permission", () =>
    Effect.gen(function* () {
      const { browser, subscribed } = fakeBrowser({ grants: "denied" });
      const { layer, kept } = fakeRegistry();

      expect(yield* running(enablePush, browser, layer)).toEqual({ kind: "denied" });
      expect(subscribed).toEqual([]);
      expect(kept.size).toBe(0);
    }),
  );

  it.effect("stays off when the permission prompt is dismissed", () =>
    Effect.gen(function* () {
      const { browser } = fakeBrowser({ grants: "default" });

      expect(yield* running(enablePush, browser, fakeRegistry().layer)).toEqual({ kind: "off" });
    }),
  );

  it.effect("unsubscribes the browser when the Registry will not keep the subscription", () =>
    Effect.gen(function* () {
      const { browser, made } = fakeBrowser();

      expect(
        yield* running(enablePush, browser, fakeRegistry([], ["subscribePush"]).layer),
      ).toEqual({
        kind: "error",
        message: "Registry is down",
      });
      expect(made.state.unsubscribed).toBe(true);
    }),
  );
});

describe("disablePush", () => {
  it.effect("has the Registry forget the device and unsubscribes the browser", () =>
    Effect.gen(function* () {
      const existing = subscription();
      const { browser } = fakeBrowser({ permission: "granted", existing: existing.value });
      const { layer, kept } = fakeRegistry([ENDPOINT]);

      expect(yield* running(disablePush, browser, layer)).toEqual({ kind: "off" });
      expect(kept.size).toBe(0);
      expect(existing.state.unsubscribed).toBe(true);
    }),
  );

  it.effect(
    "keeps the browser subscribed when the Registry could not forget it, so the page tells the truth",
    () =>
      Effect.gen(function* () {
        const existing = subscription();
        const { browser } = fakeBrowser({ permission: "granted", existing: existing.value });

        expect(
          yield* running(disablePush, browser, fakeRegistry([ENDPOINT], ["unsubscribePush"]).layer),
        ).toEqual({ kind: "error", message: "Registry is down" });
        expect(existing.state.unsubscribed).toBe(false);
      }),
  );
});

describe("syncPush", () => {
  it.effect("re-tells the Registry about an existing subscription", () =>
    Effect.gen(function* () {
      const { browser } = fakeBrowser({ permission: "granted", existing: subscription().value });
      const { layer, kept } = fakeRegistry();

      yield* running(syncPush, browser, layer);
      expect(kept.has(ENDPOINT)).toBe(true);
    }),
  );

  it.effect(
    "never subscribes a device that is not, or one that has not allowed notifications",
    () =>
      Effect.gen(function* () {
        const granted = fakeBrowser({ permission: "granted" });
        const asked = fakeBrowser({ existing: subscription().value });
        const { layer, kept } = fakeRegistry();

        yield* running(syncPush, granted.browser, layer);
        yield* running(syncPush, asked.browser, layer);
        expect(kept.size).toBe(0);
        expect(granted.subscribed).toEqual([]);
      }),
  );
});

describe("decodeKey", () => {
  it("reads a base64url key into its bytes, with or without padding", () => {
    expect([...decodeKey("-_8")]).toEqual([251, 255]);
    expect([...decodeKey("-_8=")]).toEqual([251, 255]);
  });
});

describe("the page's browser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect(
    "says why when the service worker never becomes active, instead of waiting forever",
    () =>
      Effect.gen(function* () {
        vi.stubGlobal("navigator", { serviceWorker: { ready: new Promise(() => undefined) } });
        vi.stubGlobal("window", { PushManager: {}, Notification: {} });
        vi.stubGlobal("Notification", { permission: "granted" });

        const status = yield* running(loadPushStatus, pageBrowser(), fakeRegistry().layer).pipe(
          Effect.forkChild,
        );

        yield* TestClock.adjust(5_000);

        const loaded: PushStatus = yield* Fiber.join(status);

        expect(loaded).toMatchObject({
          kind: "error",
          message: expect.stringContaining("service worker is not running"),
        });
      }),
  );
});
