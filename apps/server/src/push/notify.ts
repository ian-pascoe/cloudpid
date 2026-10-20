// @effect-diagnostics preferSchemaOverJson:off -- the payload is JSON text for the service worker, not a parsed value.
// Sending a Session's notification to every subscribed browser (`docs/spec.md` → Client and protocol → Notifications).
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RegistryStore } from "../registry/store.ts";
import { describeEvent, type PushEvent } from "./notification.ts";
import { type PushResult, sendPush, type Vapid } from "./webpush.ts";

/** A push could not be made at all: the request failed or timed out. */
class PushError extends Schema.TaggedError<PushError, { readonly brand: unique symbol }>()(
  "PushError",
  { message: Schema.String },
) {}

/** Pushes to different browsers go out together, up to this many at once. */
const CONCURRENCY = 8;

export type NotifierOptions = {
  /** The Registry's tables: the Session's title, and the subscriptions to notify and to prune. */
  readonly store: Pick<
    RegistryStore,
    "getSession" | "listPushSubscriptions" | "deletePushSubscription"
  >;
  readonly vapid: Vapid;
  /** For a test; the global `fetch` otherwise. */
  readonly fetch?: typeof fetch;
};

/**
 * Tell every subscribed browser that Session `sessionId` has `event`. A Session the Registry does not know is ignored.
 * A subscription the push service reports gone (404, 410) is deleted; any other refusal or failure is logged and the
 * subscription kept, so one bad push service never stops the rest. This never fails.
 */
export const pushNotifier =
  ({ store, vapid, fetch }: NotifierOptions) =>
  (sessionId: string, event: PushEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      const session = store.getSession(sessionId);
      const subscriptions = store.listPushSubscriptions();

      if (session === null || subscriptions.length === 0) return;

      const payload = JSON.stringify(describeEvent(event, session));
      const now = yield* Clock.currentTimeMillis;

      yield* Effect.forEach(
        subscriptions,
        (subscription) =>
          Effect.tryPromise({
            try: () => sendPush(subscription, payload, vapid, { now, fetch }),
            catch: (cause) => PushError.make({ message: String(cause) }),
          }).pipe(
            Effect.flatMap((result: PushResult) => {
              if (result.kind === "sent") return Effect.void;

              if (result.kind === "gone") {
                return Effect.sync(() => store.deletePushSubscription(subscription.endpoint));
              }

              return Effect.logWarning(`Push service answered ${result.status}`, {
                host: new URL(subscription.endpoint).host,
              });
            }),
            Effect.catchCause((cause) =>
              Effect.logWarning("Push failed", {
                host: new URL(subscription.endpoint).host,
                cause,
              }),
            ),
          ),
        { concurrency: CONCURRENCY, discard: true },
      );
    }).pipe(Effect.asVoid);
