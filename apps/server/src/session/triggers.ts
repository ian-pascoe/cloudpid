// The Session's `TriggerAccess` (`@cloudpid/extensions/triggers`, `docs/architecture/triggers.md` → Agent tools and
// Approval): the Registry's Triggers, read and changed for the agent. Each change is the Registry's Agent change of
// `triggers.<id>` by this Session (`agentCreateTrigger`, `agentUpdateTrigger`, `agentSetTriggerPaused`,
// `agentRemoveTrigger`), and once it changed something the Trigger's object is woken to read its definition again
// (`Trigger.sync`), which arms, re-arms, disarms or wipes it: the Registry never calls out.
import { EnvironmentsError } from "@cloudpid/extensions/environment";
import type { TriggerAccessService } from "@cloudpid/extensions/triggers";
import * as Effect from "effect/Effect";
import { newTriggerId } from "../registry/ids.ts";
import type { RegistryMethods } from "../registry/Registry.ts";
import type { TriggerChanged } from "../registry/trigger-changes.ts";
import type { TriggerObjects } from "../trigger/objects.ts";

/** What the Session's Triggers read and change in the Registry. */
export type TriggersRegistry = Pick<
  RegistryMethods,
  | "listTriggers"
  | "triggerDefinition"
  | "agentCreateTrigger"
  | "agentUpdateTrigger"
  | "agentSetTriggerPaused"
  | "agentRemoveTrigger"
>;

export type SessionTriggersOptions = {
  readonly registry: TriggersRegistry;
  /** The Session's id in the Registry; undefined when unknown, for a Session that then changes no Trigger. */
  readonly session: string | undefined;
  /** The Trigger objects, woken after each change. */
  readonly objects: Pick<TriggerObjects, "sync">;
};

const unlisted = EnvironmentsError.make({
  message: "This Session is not one the Registry lists, so it changes no Trigger.",
});

export const sessionTriggers = ({
  registry,
  session,
  objects,
}: SessionTriggersOptions): TriggerAccessService => {
  /** Make a change as this Session's, then wake Trigger `id`'s object if it changed anything. */
  const changing = (id: string, change: (session: string) => Effect.Effect<TriggerChanged>) =>
    session === undefined
      ? unlisted
      : Effect.tap(change(session), (changed) =>
          changed.status === "changed" ? objects.sync(id) : Effect.void,
        );

  return {
    list: (environment) => registry.listTriggers({ environment }),
    get: (id) => registry.triggerDefinition({ id }),
    newId: newTriggerId,
    create: ({ id, trigger, author }) =>
      changing(id, (by) =>
        registry.agentCreateTrigger({ id, trigger, author: { session: by, ...author } }),
      ),
    update: ({ id, patch, expected, author }) =>
      changing(id, (by) =>
        registry.agentUpdateTrigger({ id, patch, expected, author: { session: by, ...author } }),
      ),
    setPaused: ({ id, paused, expected, author }) =>
      changing(id, (by) =>
        registry.agentSetTriggerPaused({
          id,
          paused,
          expected,
          author: { session: by, ...author },
        }),
      ),
    remove: ({ id, author }) =>
      changing(id, (by) => registry.agentRemoveTrigger({ id, author: { session: by, ...author } })),
  };
};
