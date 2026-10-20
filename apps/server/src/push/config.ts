import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { type Vapid, vapidProblem } from "./webpush.ts";

/** A VAPID secret is malformed: the Worker does not start, as when one is missing. */
class VapidConfigError extends Schema.TaggedError<
  VapidConfigError,
  { readonly brand: unique symbol }
>()("VapidConfigError", { message: Schema.String }) {}

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
    Effect.flatMap(({ publicKey, privateKey, subject }) => {
      const vapid: Vapid = {
        publicKey: Redacted.value(publicKey),
        privateKey: Redacted.value(privateKey),
        subject: Redacted.value(subject),
      };

      // Checked when the layer is built, so a bad secret fails a deploy or `alchemy dev` at once.
      return Effect.tryPromise({
        try: () => vapidProblem(vapid),
        catch: (cause) => VapidConfigError.make({ message: String(cause) }),
      }).pipe(
        Effect.flatMap((problem) =>
          problem === undefined
            ? Effect.succeed({ vapid })
            : Effect.fail(VapidConfigError.make({ message: problem })),
        ),
      );
    }),
    Effect.orDie,
  ),
);
