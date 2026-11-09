// @effect-diagnostics globalJsonInEffect:off -- the payload is JSON text for the service worker, not a parsed value.
// Sending a notification to every subscribed browser (`docs/architecture/client-and-protocol.md` → Notifications →
// Sending): a Session's (`pushNotifier`), or the owner's with no Session (`pushOwner`), such as a Trigger's failed Fire,
// which opens its Environment's Triggers section (`describeTriggerFailure`), or the changes an agent made over the MCP
// endpoint (`docs/architecture/mcp-endpoint.md` → After a change, and Notifications). `pushNotifier` sends through `pushOwner`.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RegistryStore } from "../registry/store.ts";
import { describeEvent, type PushEvent, type PushPayload } from "./notification.ts";
import { type PushResult, sendPush, type Vapid } from "./webpush.ts";

/** A push could not be made at all: the request failed or timed out. */
class PushError extends Schema.TaggedError<PushError, { readonly brand: unique symbol }>()(
  "PushError",
  { message: Schema.String },
) {}

/**
 * Pushes to different browsers go out together, up to this many at once, each given up on after `PUSH_TIMEOUT_MS`: the
 * whole notification takes at most `ceil(browsers / CONCURRENCY) * PUSH_TIMEOUT_MS`, which stays under the Session's
 * `NOTIFY_TIMEOUT` (20 s) for up to 64 browsers. A Session that gave up earlier would send it again.
 */
const CONCURRENCY = 16;

const PUSH_TIMEOUT_MS = 5_000;

export type OwnerPushOptions = {
  /** The Registry's subscriptions to notify and to prune. */
  readonly store: Pick<RegistryStore, "listPushSubscriptions" | "deletePushSubscription">;
  readonly vapid: Vapid;
  /** For a test; the global `fetch` otherwise. */
  readonly fetch?: typeof fetch;
};

export type NotifierOptions = OwnerPushOptions & {
  /** The Registry's tables: the Session's title, besides the subscriptions. */
  readonly store: Pick<RegistryStore, "getSession">;
};

/**
 * Tell every subscribed browser `payload`, a notification of the owner's that belongs to no Session (the Session's
 * own go through `pushNotifier`, which builds its payload and sends it here): its `url` is where a tap goes (any
 * same-origin page: the service worker opens it), and a later one with the same `tag` replaces it on screen. A
 * subscription the push service reports gone (404, 410) is deleted; any other refusal or failure is logged and the
 * subscription kept, so one bad push service never stops the rest. This never fails.
 */
export const pushOwner =
  ({ store, vapid, fetch }: OwnerPushOptions) =>
  (payload: PushPayload): Effect.Effect<void> =>
    Effect.gen(function* () {
      const subscriptions = store.listPushSubscriptions();

      if (subscriptions.length === 0) return;

      const text = JSON.stringify(payload);
      const now = yield* Clock.currentTimeMillis;

      yield* Effect.forEach(
        subscriptions,
        (subscription) =>
          Effect.tryPromise({
            try: () =>
              sendPush(subscription, text, vapid, { now, fetch, timeoutMs: PUSH_TIMEOUT_MS }),
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

/** Tell every subscribed browser that Session `sessionId` has `event` (`pushOwner`). A Session the Registry does not know is ignored. */
export const pushNotifier =
  (options: NotifierOptions) =>
  (sessionId: string, event: PushEvent): Effect.Effect<void> =>
    Effect.suspend(() => {
      const session = options.store.getSession(sessionId);

      return session === null ? Effect.void : pushOwner(options)(describeEvent(event, session));
    });
