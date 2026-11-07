// The Trigger objects as their callers reach them (`docs/architecture/triggers.md` → Cascades): a Trigger that went
// with its Environment has its object wiped. A wipe that fails is logged and left to the object, which wipes itself at
// its next alarm, when its definition no longer reads.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { TRIGGER_CLASS, triggerObjectName } from "./name.ts";
import { TriggerUnreachable } from "./object.ts";
import type { Trigger } from "./Trigger.ts";

/** The `Trigger` namespace, as far as its callers use it. */
export type TriggerNamespace = Pick<Cloudflare.DurableObject<Trigger>, "getByName">;

export type TriggerObjects = {
  /** Wipe Trigger `id`'s object: its alarm and its storage. Never fails. */
  readonly remove: (id: string) => Effect.Effect<void>;
};

/** The Trigger objects over the `Trigger` namespace. */
export const triggerObjects = (triggers: TriggerNamespace): TriggerObjects => ({
  remove: (id) =>
    Effect.suspend(() => triggers.getByName(triggerObjectName(id)).remove()).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A Trigger's object could not be wiped", cause),
      ),
    ),
});

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
