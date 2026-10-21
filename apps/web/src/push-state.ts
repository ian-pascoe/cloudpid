// This device's notifications: whether it is notified, turning that on and off, and the startup sync.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import {
  disablePush,
  enablePush,
  loadPushStatus,
  type PushStatus,
  registerServiceWorker,
  syncPush,
} from "./push.ts";
import { appRuntime } from "./runtime.ts";

/** What the browser and the Registry say this device is, asked again when `push` is invalidated. */
const loadedPushAtom = appRuntime.atom(loadPushStatus).pipe(Atom.withReactivity(["push"]));

/**
 * Whether this device is notified, as of the last answer: what loading it found, or what turning it on or off ended
 * as (which says why that failed, as a load would not). An `error` status is an answer, not a failure of the atom.
 */
export const pushStatusAtom = Atom.writable(
  (get) => get(loadedPushAtom),
  (ctx, status: PushStatus) => {
    ctx.setSelf(AsyncResult.success(status));
  },
);

/** The status as of the last answer; null until the first. */
export const pushStatusValueAtom = Atom.map(pushStatusAtom, (result) =>
  result.pipe(AsyncResult.value, Option.getOrNull),
);

/** Ask permission and subscribe this device; the status becomes what that ended as. */
export const enablePushAtom = appRuntime.fn(
  (_: void, get) =>
    enablePush.pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          get.set(pushStatusAtom, status);
        }),
      ),
    ),
  { concurrent: true },
);

/** Unsubscribe this device; the status becomes what that ended as. */
export const disablePushAtom = appRuntime.fn(
  (_: void, get) =>
    disablePush.pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          get.set(pushStatusAtom, status);
        }),
      ),
    ),
  { concurrent: true },
);

/**
 * At startup: register the service worker, then re-tell the Registry about a subscription this device already has, so
 * one the browser renewed is not lost. The app mounts it once and it lives as long as the registry.
 */
export const pushSyncAtom = Atom.keepAlive(
  appRuntime.atom(registerServiceWorker.pipe(Effect.andThen(syncPush))),
);
