// @effect-diagnostics asyncFunction:off missingPipeableSignature:off -- browser code in a React app with no Effect runtime: promises are the platform here.
// Web Push in the browser (`docs/spec.md` → Client and protocol → Notifications): this device's subscription, kept in the
// Registry so Sessions can notify it, and turned on and off from the settings page. The browser and the Registry are
// passed in, so the logic runs without either.
import type { PushSubscription } from "@cloudpid/protocol";
import type { RegistryApi } from "./registry.ts";

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

/**
 * Whether this device is notified. A subscription the browser holds but the Registry lost (the push service dropped it,
 * or the Registry was reset) is given back to the Registry, so the page does not show a device as off that is on.
 */
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

    if (keep === undefined) return { kind: "off" };

    const state = await registry.getPush(keep.endpoint);

    if (!state.ok) return { kind: "error", message: state.message };

    if (state.value.subscribed) return { kind: "on" };

    const restored = await registry.subscribePush(keep);

    return restored.ok ? { kind: "on" } : { kind: "error", message: restored.message };
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

    const subscription = await browser.subscribe(state.value.publicKey);
    const keep = toSubscription(subscription);

    if (keep === undefined)
      return { kind: "error", message: "The browser gave an incomplete subscription" };

    const saved = await registry.subscribePush(keep);

    if (!saved.ok) {
      // Not kept by the Registry, so no Session would use it: do not leave the browser subscribed either.
      await subscription.unsubscribe();

      return { kind: "error", message: saved.message };
    }

    return { kind: "on" };
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
 * Re-tell the Registry about this device's subscription at startup, so one the browser renewed is not lost. It does
 * nothing for a device that is not subscribed, and never subscribes one.
 */
export const syncPush = async (browser: PushBrowser, registry: Registry): Promise<void> => {
  if (!browser.supported || browser.permission() !== "granted") return;

  try {
    const subscription = await browser.getSubscription();
    const keep = subscription === null ? undefined : toSubscription(subscription);

    if (keep !== undefined) await registry.subscribePush(keep);
  } catch {
    // Best effort: the settings page shows the state when the user looks.
  }
};

/** The page's browser, through the service worker `main.tsx` registered. */
export const pageBrowser = (): PushBrowser => {
  const supported =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  const registration = () => navigator.serviceWorker.ready;

  return {
    supported,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    getSubscription: async () => (await registration()).pushManager.getSubscription(),
    subscribe: async (publicKey) => {
      const { pushManager } = await registration();
      const existing = await pushManager.getSubscription();

      // A subscription made with another application server key (a rotated VAPID key) cannot be reused.
      await existing?.unsubscribe();

      return pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(publicKey),
      });
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
