// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the browser and the Registry over native arrays and sets.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Reactivity from "effect/reactivity/Reactivity";
import { ImageEncoderLive } from "./chat/image-encode.ts";
import { UploadsLive } from "./chat/uploads.ts";
import {
  disablePushAtom,
  enablePushAtom,
  pushStatusAtom,
  pushStatusValueAtom,
} from "./push-state.ts";
import { type BrowserSubscription, PushManager, type PushBrowser } from "./push.ts";
import { fakeRegistryLayer, settled } from "./registry.testing.ts";
import { appRuntime, BrowserLayer } from "./runtime.ts";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";

/** A device with an optional subscription, whose notifications are `permission`, and a Registry holding `kept`. */
const device = (options: {
  readonly permission: NotificationPermission;
  readonly subscribed: boolean;
  readonly kept?: readonly string[];
}) => {
  let current: BrowserSubscription | null = options.subscribed ? subscription("PUBLIC") : null;
  const kept = new Set(options.kept ?? []);

  function subscription(key: string): BrowserSubscription {
    return {
      applicationServerKey: () => new TextEncoder().encode(key),
      toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "P256", auth: "AUTH" } }),
      unsubscribe: Effect.sync(() => {
        current = null;

        return true;
      }),
    };
  }

  const browser: PushBrowser = {
    supported: Effect.succeed(true),
    permission: Effect.succeed(options.permission),
    requestPermission: Effect.succeed("granted"),
    getSubscription: Effect.sync(() => current),
    subscribe: (publicKey) =>
      Effect.sync(() => {
        current = subscription(publicKey);

        return current;
      }),
  };

  const registry = fakeRegistryLayer({
    // The key the fake subscription is made with is its public key's bytes, so `PUBLIC` matches what is held below.
    getPush: ({ endpoint }) =>
      Effect.succeed({
        publicKey: btoa("PUBLIC").replaceAll("=", ""),
        subscribed: endpoint !== undefined && kept.has(endpoint),
      }),
    subscribePush: ({ subscription: given }) =>
      Effect.sync(() => {
        kept.add(given.endpoint);
      }),
    unsubscribePush: ({ endpoint }) =>
      Effect.sync(() => {
        kept.delete(endpoint);
      }),
  });

  const registryWithDevice = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(
        appRuntime.layer,
        Layer.mergeAll(
          BrowserLayer,
          Layer.succeed(PushManager, browser),
          UploadsLive,
          ImageEncoderLive,
          registry,
          Reactivity.layer,
          KeyValueStore.layerMemory,
        ),
      ),
    ],
  });

  return { registry: registryWithDevice, kept, subscribed: () => current !== null };
};

describe("this device's notifications", () => {
  it.effect("turns on when enabled, and off when disabled, as the status says", () =>
    Effect.gen(function* () {
      const { registry, kept, subscribed } = device({ permission: "default", subscribed: false });

      registry.mount(pushStatusAtom);
      yield* settled(registry, pushStatusAtom);

      registry.set(enablePushAtom, undefined);
      yield* settled(registry, enablePushAtom);
      expect(registry.get(pushStatusValueAtom)).toEqual({ kind: "on" });
      expect([...kept]).toEqual([ENDPOINT]);

      registry.set(disablePushAtom, undefined);
      yield* settled(registry, disablePushAtom);
      expect(registry.get(pushStatusValueAtom)).toEqual({ kind: "off" });
      expect(kept.size).toBe(0);
      expect(subscribed()).toBe(false);
    }),
  );
});
