import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { Vapid } from "./webpush.ts";

/**
 * The deployment's VAPID identity (RFC 8292): deploy-time secrets, bound to the Worker by `Config.Redacted`. The public
 * key reaches the web app, which subscribes with it; the private key never leaves the Worker.
 */
export class PushConfig extends Context.Service<PushConfig, { readonly vapid: Vapid }>()(
  "@cloudpid/server/push/config/PushConfig",
) {}

/** Reads `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`: from the deploying environment, then from the Worker's secrets. */
export const PushConfigLive = Layer.effect(
  PushConfig,
  Config.all({
    publicKey: Config.Redacted("VAPID_PUBLIC_KEY"),
    privateKey: Config.Redacted("VAPID_PRIVATE_KEY"),
    subject: Config.Redacted("VAPID_SUBJECT"),
  }).pipe(
    Effect.map(({ publicKey, privateKey, subject }) => ({
      vapid: {
        publicKey: Redacted.value(publicKey),
        privateKey: Redacted.value(privateKey),
        subject: Redacted.value(subject),
      },
    })),
  ),
);
