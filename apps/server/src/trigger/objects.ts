// The Trigger objects as their callers reach them (`docs/architecture/triggers.md` → Cascades, → Agent tools and
// Approval): a Trigger that went with its Environment has its object wiped, and one the agent changed, or the owner's
// revert of an Agent change put back, has its object woken to read its definition again. `wake`, for a caller that must
// see a Trigger with no alarm scheduled (one made, brought back or resumed), tries again and then fails; `sync` and
// `remove` log a failure and leave it to the object, which reads its definition again at its next alarm.
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { FireRecord, TriggerRotation } from "@cloudpid/protocol";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { TRIGGER_CLASS, triggerObjectName } from "./name.ts";
import {
  type Delivery,
  type DeliveryAnswer,
  type DeliveryStats,
  type FireAgainAnswer,
  type FireNowAnswer,
  type HookAnswer,
  type TriggerState,
  TriggerUnreachable,
} from "./object.ts";
import type { Trigger } from "./Trigger.ts";

/** The `Trigger` namespace, as far as its callers use it. */
export type TriggerNamespace = Pick<Cloudflare.DurableObject<Trigger>, "getByName">;

export type TriggerObjects = {
  /**
   * Wake Trigger `id`'s object to read its definition again: arm, re-arm, disarm or wipe it. Tried `WAKE_RETRIES` more
   * times, then fails.
   */
  readonly wake: (id: string) => Effect.Effect<void, TriggerUnreachable>;
  /** Wake Trigger `id`'s object once, a failure logged and left to its next alarm. Never fails. */
  readonly sync: (id: string) => Effect.Effect<void>;
  /** Wipe Trigger `id`'s object: its alarm and its storage. Never fails. */
  readonly remove: (id: string) => Effect.Effect<void>;
  /**
   * Wipe Trigger `id`'s object as `remove` does, for a caller that must know it is wiped (a reverted removal, whose
   * Trigger must not keep the old URL and Signing secret): tried `WAKE_RETRIES` more times, then fails.
   */
  readonly wipe: (id: string) => Effect.Effect<void, TriggerUnreachable>;
  /** The owner's Fire now of Trigger `id`, one Fire per `key`: a Fire recorded `manual`, or why there is none. */
  readonly fireNow: (id: string, key: string) => Effect.Effect<FireNowAnswer, TriggerUnreachable>;
  /** The owner's Fire again of Trigger `id`, one Fire per `key`: a Fire recorded `manual` with the last delivery. */
  readonly fireAgain: (
    id: string,
    key: string,
  ) => Effect.Effect<FireAgainAnswer, TriggerUnreachable>;
  /** A delivery to Trigger `id`'s URL: what its object answers (the main Worker builds the response). */
  readonly deliver: (
    id: string,
    delivery: Delivery,
  ) => Effect.Effect<DeliveryAnswer, TriggerUnreachable>;
  /** The deliveries Trigger `id`'s object took: the counts of 30 days, its last delivery and its ping. */
  readonly deliveries: (id: string) => Effect.Effect<DeliveryStats, TriggerUnreachable>;
  /** Trigger `id`'s token and Signing secret, or why there are none to show. */
  readonly reveal: (id: string) => Effect.Effect<HookAnswer, TriggerUnreachable>;
  /** Replace Trigger `id`'s token (`url`) or Signing secret (`secret`) at once, and answer both. */
  readonly rotate: (
    id: string,
    what: TriggerRotation,
  ) => Effect.Effect<HookAnswer, TriggerUnreachable>;
  /** Trigger `id`'s fire log, newest first: at most `limit` Fires. */
  readonly fireLog: (
    id: string,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<FireRecord>, TriggerUnreachable>;
  /** What Trigger `id`'s object says of itself. */
  readonly state: (id: string) => Effect.Effect<TriggerState, TriggerUnreachable>;
};

/** How many more times `wake` tries an object that doesn't answer. */
export const WAKE_RETRIES = 3;

/**
 * The Trigger objects over the `Trigger` namespace, `wake` waiting `wakeSchedule` between its tries: by default 0.2, 0.4
 * and 0.8 seconds.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a constructor, not a transform of `triggers`.
export const triggerObjects = (
  triggers: TriggerNamespace,
  wakeSchedule: Schedule.Schedule<unknown, unknown> = Schedule.exponential("200 millis"),
): TriggerObjects => {
  /** Call Trigger `id`'s object, any failure its `TriggerUnreachable`. */
  const reach = <A, E>(id: string, call: (stub: TriggerStub) => Effect.Effect<A, E>) =>
    Effect.suspend(() => call(triggers.getByName(triggerObjectName(id)))).pipe(
      Effect.catchCause((cause) =>
        Effect.fail(
          TriggerUnreachable.make({
            message: `Trigger ${id}'s object did not answer: ${Cause.pretty(cause)}`,
          }),
        ),
      ),
    );

  const once = (id: string) => reach(id, (stub) => stub.sync()).pipe(Effect.asVoid);

  return {
    wake: (id) => once(id).pipe(Effect.retry({ schedule: wakeSchedule, times: WAKE_RETRIES })),
    sync: (id) =>
      once(id).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("A Trigger's object could not be woken", cause),
        ),
      ),
    remove: (id) =>
      Effect.suspend(() => triggers.getByName(triggerObjectName(id)).remove()).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("A Trigger's object could not be wiped", cause),
        ),
      ),
    wipe: (id) =>
      reach(id, (stub) => stub.remove()).pipe(
        Effect.retry({ schedule: wakeSchedule, times: WAKE_RETRIES }),
      ),
    fireNow: (id, key) => reach(id, (stub) => stub.fireNow({ key })),
    fireAgain: (id, key) => reach(id, (stub) => stub.fireAgain({ key })),
    deliver: (id, delivery) => reach(id, (stub) => stub.deliver(delivery)),
    deliveries: (id) => reach(id, (stub) => stub.deliveries()),
    reveal: (id) => reach(id, (stub) => stub.reveal()),
    rotate: (id, what) => reach(id, (stub) => stub.rotate(what)),
    fireLog: (id, limit) => reach(id, (stub) => stub.fireLog(limit === undefined ? {} : { limit })),
    state: (id) => reach(id, (stub) => stub.state()),
  };
};

type TriggerStub = ReturnType<TriggerNamespace["getByName"]>;

/**
 * The `Trigger` namespace from the Server Worker's raw environment (`Cloudflare.WorkerEnvironment`), its stubs made as
 * `yield* Trigger` makes them, for the Session DO: `TriggerLive` needs `SessionLive`, so `SessionLive` cannot need it
 * back.
 */
export const triggersOfEnvironment = (
  worker: typeof Cloudflare.WorkerEnvironment.Service,
): TriggerNamespace => {
  // SAFETY: `TriggerLive` binds the `Trigger` class's namespace in this Worker under its class name.
  const namespace = worker[TRIGGER_CLASS] as DurableObjectNamespace;

  return {
    getByName: (name, options) =>
      Cloudflare.makeRpcStub<TriggerStub>(namespace.getByName(name, options), {
        errors: [TriggerUnreachable],
        // The class is bridged by this bundle, whose bridge strips the trace context again.
        traceContext: true,
      }),
  };
};
