// The Session's `TriggerAccess` (`@cloudpid/extensions/triggers`, `docs/architecture/triggers.md` → Agent tools and
// Approval): the Registry's Triggers, read and changed for the agent. Each change is the Registry's Agent change of
// `triggers.<id>` by this Session (`agentCreateTrigger`, `agentUpdateTrigger`, `agentSetTriggerPaused`,
// `agentRemoveTrigger`), and then the Trigger's object is woken to read its definition again (`Trigger.sync`), which
// arms, re-arms, disarms or wipes it: the Registry never calls out. It is woken after a change that found the Trigger
// as asked too, since the call that made the change may have been cut off before it woke the object. A Trigger made or
// resumed has no alarm yet to heal from, so its object is tried again (`TriggerObjects.wake`), then the call fails
// saying how to schedule it; after any other change one that doesn't answer is left to its next alarm.
import { EnvironmentsError } from "@cloudpid/extensions/environment";
import type { TriggerAccessService } from "@cloudpid/extensions/triggers";
import { heldBySession, type TriggerChanged } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { newTriggerId } from "../registry/ids.ts";
import type { RegistryMethods } from "../registry/Registry.ts";
import type { TriggerObjects } from "../trigger/objects.ts";

/** What the Session's Triggers read and change in the Registry. */
export type TriggersRegistry = Pick<
  RegistryMethods,
  | "getSession"
  | "getWorkspace"
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
  readonly objects: Pick<TriggerObjects, "wake" | "sync">;
};

const unlisted = EnvironmentsError.make({
  message: "This Session is not one the Registry lists, so it changes no Trigger.",
});

export const sessionTriggers = ({
  registry,
  session,
  objects,
}: SessionTriggersOptions): TriggerAccessService => {
  /**
   * Wake Trigger `id`'s object: for one that must be scheduled now (`arming`), failing the call when it never answers,
   * saying how to schedule it; else left to its next alarm when it doesn't answer.
   */
  const wake = (id: string, arming: boolean) =>
    arming
      ? objects.wake(id).pipe(
          Effect.mapError(() =>
            EnvironmentsError.make({
              message: `Trigger ${id} is saved, but its object didn't answer, so it isn't scheduled yet. Call trigger_resume with id ${id} to schedule it: it asks nothing for a Trigger that is active.`,
            }),
          ),
        )
      : objects.sync(id);

  /** Make a change as this Session's, then wake Trigger `id`'s object unless the change was refused. */
  const changing = (
    id: string,
    arming: boolean,
    change: (session: string) => Effect.Effect<TriggerChanged>,
  ) =>
    session === undefined
      ? unlisted
      : Effect.tap(change(session), (changed) =>
          changed.status === "changed" || changed.status === "unchanged"
            ? wake(id, arming)
            : Effect.void,
        );

  // Another Session's Session trigger is neither listed nor found (`heldBySession`).
  return {
    list: (environment) =>
      registry
        .listTriggers({ environment })
        .pipe(Effect.map(Arr.filter((definition) => heldBySession(definition, session)))),
    get: (id) =>
      registry
        .triggerDefinition({ id })
        .pipe(
          Effect.map((found) => (found !== null && heldBySession(found, session) ? found : null)),
        ),
    newId: newTriggerId,
    // This Session's own Workspace: the agent can't name another until a tool lists them.
    workspace: Effect.gen(function* () {
      const known = session === undefined ? null : yield* registry.getSession({ id: session });

      if (known === null) return yield* unlisted;

      const kept = yield* registry.getWorkspace({ id: known.workspace });

      if (kept === null) {
        return yield* EnvironmentsError.make({
          message: "This Session's Workspace is not listed.",
        });
      }

      return { id: kept.id, branch: kept.branch, environment: kept.environment };
    }),
    create: ({ id, trigger, author }) =>
      changing(id, true, (by) =>
        registry.agentCreateTrigger({
          id,
          // A Session trigger is made for this Session.
          trigger: trigger.kind === "session" ? { ...trigger, session: by } : trigger,
          author: { session: by, ...author },
        }),
      ),
    update: ({ id, patch, expected, author }) =>
      changing(id, false, (by) =>
        registry.agentUpdateTrigger({ id, patch, expected, author: { session: by, ...author } }),
      ),
    setPaused: ({ id, paused, expected, author }) =>
      changing(id, !paused, (by) =>
        registry.agentSetTriggerPaused({
          id,
          paused,
          expected,
          author: { session: by, ...author },
        }),
      ),
    remove: ({ id, author }) =>
      changing(id, false, (by) =>
        registry.agentRemoveTrigger({ id, author: { session: by, ...author } }),
      ),
  };
};
