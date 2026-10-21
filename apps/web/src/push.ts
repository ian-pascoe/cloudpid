// Web Push in the browser (`docs/spec.md` → Client and protocol → Notifications): this device's subscription, kept in the
// Registry so Sessions can notify it, and turned on and off from the settings page. The browser is the `PushManager`
// service and the Registry is the app's client, so the logic runs without either.
import type { PushSubscription } from "@cloudpid/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { messageOf, RegistryClient } from "./registry.ts";

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

/** A browser call that failed, with the browser's own message. */
export class PushError extends Schema.TaggedError<PushError, { readonly brand: unique symbol }>()(
  "PushError",
  { message: Schema.String },
) {}

/** The part of a browser's `PushSubscription` this uses. */
export interface BrowserSubscription {
  readonly toJSON: () => {
    endpoint?: string | undefined;
    keys?: Record<string, string> | undefined;
  };
  readonly unsubscribe: Effect.Effect<boolean, PushError>;
  /** The VAPID public key the subscription was made with (its `options.applicationServerKey`), when the browser says. */
  readonly applicationServerKey: () => Uint8Array | null;
}

/** The browser's side of Web Push, as the page sees it. */
export interface PushBrowser {
  readonly supported: Effect.Effect<boolean>;
  readonly permission: Effect.Effect<NotificationPermission>;
  readonly requestPermission: Effect.Effect<NotificationPermission, PushError>;
  /** This device's subscription, if it has one. */
  readonly getSubscription: Effect.Effect<BrowserSubscription | null, PushError>;
  /** Subscribe this device to the push service with the deployment's VAPID `publicKey` (base64url). */
  readonly subscribe: (publicKey: string) => Effect.Effect<BrowserSubscription, PushError>;
}

/** The page's browser, as Web Push sees it. */
export class PushManager extends Context.Service<PushManager, PushBrowser>()(
  "@cloudpid/web/push/PushManager",
) {}

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

const unsupported: PushStatus = { kind: "unsupported" };
const denied: PushStatus = { kind: "denied" };
const off: PushStatus = { kind: "off" };
const on: PushStatus = { kind: "on" };

/** Whether two keys are the same octets. */
const sameKey = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((octet, index) => octet === right[index]);

/** What a push operation needs: the browser and the Registry. */
type Needs = PushManager | RegistryClient;

/**
 * Run an operation that answers a status: whatever fails in it (the browser, the Registry, a defect) is the status
 * `error`, with its message.
 */
const settle = <E, R>(
  operation: Effect.Effect<PushStatus, E, R>,
): Effect.Effect<PushStatus, never, R> =>
  operation.pipe(
    Effect.catchCause((cause) =>
      Effect.succeed<PushStatus>({ kind: "error", message: messageOf(cause) }),
    ),
  );

/** Subscribe this device with `publicKey` and have the Registry keep it; the browser's is dropped if the Registry refuses. */
const subscribeAndKeep = (publicKey: string) =>
  Effect.gen(function* () {
    const browser = yield* PushManager;
    const subscription = yield* browser.subscribe(publicKey);
    const keep = toSubscription(subscription);

    if (keep === undefined) {
      yield* subscription.unsubscribe;

      return yield* PushError.make({ message: "The browser gave an incomplete subscription" });
    }

    // Not kept by the Registry, so no Session would use it: do not leave the browser subscribed either.
    yield* RegistryClient.use((registry) => registry("subscribePush", { subscription: keep })).pipe(
      Effect.onError(() => Effect.ignore(subscription.unsubscribe)),
    );

    return on;
  });

/**
 * Bring a subscription the browser holds in line with the Registry. One the Registry lost (the push service dropped
 * it, or the Registry was reset) is given back to it. One made with another VAPID key (the pair was rotated) would be
 * refused by its push service whatever is sent, so it is replaced by a fresh one, or dropped if the browser no longer
 * allows notifications.
 */
const reconcile = (subscription: BrowserSubscription, keep: PushSubscription) =>
  Effect.gen(function* () {
    const browser = yield* PushManager;

    const state = yield* RegistryClient.use((registry) =>
      registry("getPush", { endpoint: keep.endpoint }),
    );

    const made = subscription.applicationServerKey();

    if (made !== null && !sameKey(made, decodeKey(state.publicKey))) {
      yield* RegistryClient.use((registry) =>
        registry("unsubscribePush", { endpoint: keep.endpoint }),
      );
      yield* subscription.unsubscribe;

      if ((yield* browser.permission) !== "granted") return off;

      return yield* subscribeAndKeep(state.publicKey);
    }

    if (state.subscribed) return on;

    yield* RegistryClient.use((registry) => registry("subscribePush", { subscription: keep }));

    return on;
  });

/** Whether this device is notified, after `reconcile`. */
export const loadPushStatus: Effect.Effect<PushStatus, never, Needs> = Effect.gen(function* () {
  const browser = yield* PushManager;

  if (!(yield* browser.supported)) return unsupported;

  return yield* settle(
    Effect.gen(function* () {
      const subscription = yield* browser.getSubscription;

      if (subscription === null || (yield* browser.permission) !== "granted") {
        return (yield* browser.permission) === "denied" ? denied : off;
      }

      const keep = toSubscription(subscription);

      return keep === undefined ? off : yield* reconcile(subscription, keep);
    }),
  );
});

/** Ask permission, subscribe this device, and tell the Registry. */
export const enablePush: Effect.Effect<PushStatus, never, Needs> = Effect.gen(function* () {
  const browser = yield* PushManager;

  if (!(yield* browser.supported)) return unsupported;

  return yield* settle(
    Effect.gen(function* () {
      if ((yield* browser.permission) !== "granted") {
        const permission = yield* browser.requestPermission;

        if (permission === "denied") return denied;

        if (permission !== "granted") return off;
      }

      const state = yield* RegistryClient.use((registry) => registry("getPush", {}));

      return yield* subscribeAndKeep(state.publicKey);
    }),
  );
});

/** Stop notifying this device: the Registry forgets it and the browser unsubscribes. */
export const disablePush: Effect.Effect<PushStatus, never, Needs> = Effect.gen(function* () {
  const browser = yield* PushManager;

  if (!(yield* browser.supported)) return unsupported;

  return yield* settle(
    Effect.gen(function* () {
      const subscription = yield* browser.getSubscription;

      if (subscription === null) return off;

      const keep = toSubscription(subscription);

      // Still subscribed in the Registry if it cannot forget: keep the browser's, so the page shows the truth and the
      // user can try again.
      if (keep !== undefined) {
        yield* RegistryClient.use((registry) =>
          registry("unsubscribePush", { endpoint: keep.endpoint }),
        );
      }

      yield* subscription.unsubscribe;

      return off;
    }),
  );
});

/**
 * At startup, bring this device's subscription in line with the Registry (`reconcile`), so one the browser renewed or
 * a VAPID rotation does not leave it silently without pushes. It does nothing for a device that is not subscribed, and
 * never subscribes one that is not.
 */
export const syncPush: Effect.Effect<void, never, Needs> = Effect.gen(function* () {
  const browser = yield* PushManager;

  if (!(yield* browser.supported) || (yield* browser.permission) !== "granted") return;

  const subscription = yield* browser.getSubscription;
  const keep = subscription === null ? undefined : toSubscription(subscription);

  if (subscription !== null && keep !== undefined) yield* reconcile(subscription, keep);
}).pipe(
  // Best effort: the settings page shows the state when the user looks.
  Effect.ignoreCause,
  Effect.asVoid,
);

/** How long to wait for the service worker to become active before saying it will not. */
const WORKER_TIMEOUT = "5 seconds";

/** A browser promise as an Effect, failing with the browser's own message. */
const browserCall = <A>(call: () => PromiseLike<A>): Effect.Effect<A, PushError> =>
  Effect.tryPromise({
    try: call,
    catch: (error) =>
      PushError.make({ message: Predicate.isError(error) ? error.message : String(error) }),
  });

type PushSubscriptionHandle = globalThis.PushSubscription;

/** The browser's subscription as `BrowserSubscription` reads it. */
const adapt = (subscription: PushSubscriptionHandle): BrowserSubscription => ({
  toJSON: () => subscription.toJSON(),
  unsubscribe: browserCall(() => subscription.unsubscribe()),
  applicationServerKey: () => {
    const key = subscription.options.applicationServerKey;

    return key === null ? null : new Uint8Array(key);
  },
});

/** The active service worker's registration, or a failure that says why there is none (it failed to register). */
const activeRegistration: Effect.Effect<ServiceWorkerRegistration, PushError> = browserCall(
  () => navigator.serviceWorker.ready,
).pipe(
  Effect.timeoutOrElse({
    duration: WORKER_TIMEOUT,
    orElse: () =>
      Effect.fail(
        PushError.make({
          message:
            "The service worker is not running, so this browser cannot receive notifications here. Reload the page; private windows do not allow it.",
        }),
      ),
  }),
);

/**
 * The page's browser, through the service worker `registerServiceWorker` registered. It touches `navigator`, `window` and
 * `Notification` only when an operation runs, so building it is safe where there is no page.
 */
export const pageBrowser = (): PushBrowser => ({
  supported: Effect.sync(
    () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
  ),
  permission: Effect.sync(() => Notification.permission),
  requestPermission: browserCall(() => Notification.requestPermission()),
  getSubscription: Effect.gen(function* () {
    const { pushManager } = yield* activeRegistration;
    const subscription = yield* browserCall(() => pushManager.getSubscription());

    return subscription === null ? null : adapt(subscription);
  }),
  subscribe: (publicKey) =>
    Effect.gen(function* () {
      const { pushManager } = yield* activeRegistration;
      const existing = yield* browserCall(() => pushManager.getSubscription());

      // A subscription made with another application server key (a rotated VAPID key) cannot be reused.
      if (existing !== null) yield* browserCall(() => existing.unsubscribe());

      return adapt(
        yield* browserCall(() =>
          pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: decodeKey(publicKey),
          }),
        ),
      );
    }),
});

/** The page's browser as the `PushManager`. */
export const PushManagerLive = Layer.sync(PushManager, pageBrowser);

/** Register the service worker that shows notifications. A browser without service workers is left alone. */
export const registerServiceWorker: Effect.Effect<void> = Effect.suspend(() =>
  "serviceWorker" in navigator
    ? // Notifications are unavailable if it fails; the app itself needs no service worker.
      browserCall(() => navigator.serviceWorker.register("/sw.js")).pipe(Effect.ignore)
    : Effect.void,
);
