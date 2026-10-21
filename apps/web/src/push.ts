// @effect-diagnostics asyncFunction:off missingPipeableSignature:off globalTimers:off newPromise:off -- browser code in a React app with no Effect runtime: promises and timers are the platform here.
// Web Push in the browser (`docs/spec.md` → Client and protocol → Notifications): this device's subscription, kept in the
// Registry so Sessions can notify it, and turned on and off from the settings page. The browser and the Registry are
// passed in, so the logic runs without either.
import type { PushSubscription } from "@cloudpid/protocol";
import type { RegistryApi } from "./legacy-registry.ts";

/** What the settings page shows of this device's notifications. */
export type PushStatus =
  /** This browser cannot do Web Push: no service worker, push manager or notifications. */
  | { readonly kind: "unsupported" }
  /** The user blocked notifications for this site in the browser, which only the browser's own settings undo. */
  | { readonly kind: "denied" }
  | { readonly kind: "off" }
  | { readonly kind: "on" }
  /** Something failed; the device is as `then` says it was, as far as is known. */
  | { readonly kind: "error"; readonly message: string };

/** The part of a browser's `PushSubscription` this uses. */
export interface BrowserSubscription {
  readonly toJSON: () => {
    endpoint?: string | undefined;
    keys?: Record<string, string> | undefined;
  };
  readonly unsubscribe: () => Promise<boolean>;
  /** The VAPID public key the subscription was made with (its `options.applicationServerKey`), when the browser says. */
  readonly applicationServerKey: () => Uint8Array | null;
}

/** The browser's side of Web Push, as the page sees it. */
export interface PushBrowser {
  readonly supported: boolean;
  readonly permission: () => NotificationPermission;
  readonly requestPermission: () => Promise<NotificationPermission>;
  /** This device's subscription, if it has one. */
  readonly getSubscription: () => Promise<BrowserSubscription | null>;
  /** Subscribe this device to the push service with the deployment's VAPID `publicKey` (base64url). */
  readonly subscribe: (publicKey: string) => Promise<BrowserSubscription>;
}

type Registry = Pick<RegistryApi, "getPush" | "subscribePush" | "unsubscribePush">;

/** The `applicationServerKey` of a base64url VAPID public key. */
export const decodeKey = (key: string): Uint8Array<ArrayBuffer> => {
  const padded = key.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));

  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

/** The subscription as the Registry keeps it, or undefined when the browser's is incomplete. */
const toSubscription = (subscription: BrowserSubscription): PushSubscription | undefined => {
  const { endpoint, keys } = subscription.toJSON();
  const p256dh = keys?.["p256dh"];
  const auth = keys?.["auth"];

  return endpoint === undefined || p256dh === undefined || auth === undefined
    ? undefined
    : { endpoint, keys: { p256dh, auth } };
};

const failed = (message: string): PushStatus => ({ kind: "error", message });

/** Whether two keys are the same octets. */
const sameKey = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((octet, index) => octet === right[index]);

/** Subscribe this device with `publicKey` and have the Registry keep it; the browser's is dropped if the Registry refuses. */
const subscribeAndKeep = async (
  browser: PushBrowser,
  registry: Registry,
  publicKey: string,
): Promise<PushStatus> => {
  const subscription = await browser.subscribe(publicKey);
  const keep = toSubscription(subscription);

  if (keep === undefined) {
    await subscription.unsubscribe();

    return { kind: "error", message: "The browser gave an incomplete subscription" };
  }

  const saved = await registry.subscribePush(keep);

  if (!saved.ok) {
    // Not kept by the Registry, so no Session would use it: do not leave the browser subscribed either.
    await subscription.unsubscribe();

    return { kind: "error", message: saved.message };
  }

  return { kind: "on" };
};

/**
 * Bring a subscription the browser holds in line with the Registry. One the Registry lost (the push service dropped
 * it, or the Registry was reset) is given back to it. One made with another VAPID key (the pair was rotated) would be
 * refused by its push service whatever is sent, so it is replaced by a fresh one, or dropped if the browser no longer
 * allows notifications.
 */
const reconcile = async (
  browser: PushBrowser,
  registry: Registry,
  subscription: BrowserSubscription,
  keep: PushSubscription,
): Promise<PushStatus> => {
  const state = await registry.getPush(keep.endpoint);

  if (!state.ok) return { kind: "error", message: state.message };

  const made = subscription.applicationServerKey();

  if (made !== null && !sameKey(made, decodeKey(state.value.publicKey))) {
    const forgotten = await registry.unsubscribePush(keep.endpoint);

    if (!forgotten.ok) return { kind: "error", message: forgotten.message };

    await subscription.unsubscribe();

    return browser.permission() === "granted"
      ? subscribeAndKeep(browser, registry, state.value.publicKey)
      : { kind: "off" };
  }

  if (state.value.subscribed) return { kind: "on" };

  const restored = await registry.subscribePush(keep);

  return restored.ok ? { kind: "on" } : { kind: "error", message: restored.message };
};

/** Whether this device is notified, after `reconcile`. */
export const loadPushStatus = async (
  browser: PushBrowser,
  registry: Registry,
): Promise<PushStatus> => {
  if (!browser.supported) return { kind: "unsupported" };

  try {
    const subscription = await browser.getSubscription();

    if (subscription === null || browser.permission() !== "granted") {
      return browser.permission() === "denied" ? { kind: "denied" } : { kind: "off" };
    }

    const keep = toSubscription(subscription);

    return keep === undefined
      ? { kind: "off" }
      : await reconcile(browser, registry, subscription, keep);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
};

/** Ask permission, subscribe this device, and tell the Registry. */
export const enablePush = async (browser: PushBrowser, registry: Registry): Promise<PushStatus> => {
  if (!browser.supported) return { kind: "unsupported" };

  try {
    if (browser.permission() !== "granted") {
      const permission = await browser.requestPermission();

      if (permission === "denied") return { kind: "denied" };

      if (permission !== "granted") return { kind: "off" };
    }

    const state = await registry.getPush();

    if (!state.ok) return { kind: "error", message: state.message };

    return await subscribeAndKeep(browser, registry, state.value.publicKey);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
};

/** Stop notifying this device: the Registry forgets it and the browser unsubscribes. */
export const disablePush = async (
  browser: PushBrowser,
  registry: Registry,
): Promise<PushStatus> => {
  if (!browser.supported) return { kind: "unsupported" };

  try {
    const subscription = await browser.getSubscription();

    if (subscription === null) return { kind: "off" };

    const keep = toSubscription(subscription);

    if (keep !== undefined) {
      const forgotten = await registry.unsubscribePush(keep.endpoint);

      // Still subscribed in the Registry: keep the browser's, so the page shows the truth and the user can try again.
      if (!forgotten.ok) return { kind: "error", message: forgotten.message };
    }

    await subscription.unsubscribe();

    return { kind: "off" };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
};

/**
 * At startup, bring this device's subscription in line with the Registry (`reconcile`), so one the browser renewed or
 * a VAPID rotation does not leave it silently without pushes. It does nothing for a device that is not subscribed, and
 * never subscribes one that is not.
 */
export const syncPush = async (browser: PushBrowser, registry: Registry): Promise<void> => {
  if (!browser.supported || browser.permission() !== "granted") return;

  try {
    const subscription = await browser.getSubscription();
    const keep = subscription === null ? undefined : toSubscription(subscription);

    if (subscription !== null && keep !== undefined) {
      await reconcile(browser, registry, subscription, keep);
    }
  } catch {
    // Best effort: the settings page shows the state when the user looks.
  }
};

/** How long to wait for the service worker to become active before saying it will not. */
const WORKER_TIMEOUT_MS = 5_000;

/** The browser's subscription as `BrowserSubscription` reads it. */
const adapt = (subscription: PushSubscriptionHandle): BrowserSubscription => ({
  toJSON: () => subscription.toJSON(),
  unsubscribe: () => subscription.unsubscribe(),
  applicationServerKey: () => {
    const key = subscription.options.applicationServerKey;

    return key === null ? null : new Uint8Array(key);
  },
});

type PushSubscriptionHandle = globalThis.PushSubscription;

/** The active service worker's registration, or a failure that says why there is none (it failed to register). */
const activeRegistration = (): Promise<ServiceWorkerRegistration> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          "The service worker is not running, so this browser cannot receive notifications here. Reload the page; private windows do not allow it.",
        ),
      );
    }, WORKER_TIMEOUT_MS);

    void navigator.serviceWorker.ready.then(
      (registration) => {
        clearTimeout(timer);
        resolve(registration);
      },
      (error: Error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/** The page's browser, through the service worker `main.tsx` registered. */
export const pageBrowser = (): PushBrowser => {
  const supported =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  return {
    supported,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    getSubscription: async () => {
      const subscription = await (await activeRegistration()).pushManager.getSubscription();

      return subscription === null ? null : adapt(subscription);
    },
    subscribe: async (publicKey) => {
      const { pushManager } = await activeRegistration();
      const existing = await pushManager.getSubscription();

      // A subscription made with another application server key (a rotated VAPID key) cannot be reused.
      await existing?.unsubscribe();

      return adapt(
        await pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeKey(publicKey),
        }),
      );
    },
  };
};

/** Register the service worker that shows notifications. A browser without service workers is left alone. */
export const registerServiceWorker = async (): Promise<void> => {
  if (!("serviceWorker" in navigator)) return;

  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch {
    // Notifications are unavailable; the app itself needs no service worker.
  }
};
