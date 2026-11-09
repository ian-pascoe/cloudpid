// The Session's `TriggerAccess` (`@cloudpid/extensions/triggers`, `docs/architecture/triggers.md` → Agent tools and
// Approval): the Registry's Triggers, read and changed for the agent. Each change is the Registry's Agent change of
// `triggers.<id>` by this Session (`agentCreateTrigger`, `agentUpdateTrigger`, `agentSetTriggerPaused`,
// `agentRemoveTrigger`), and then the Trigger's object is woken to read its definition again (`Trigger.sync`), which
// arms, re-arms, disarms or wipes it: the Registry never calls out. It is woken after a change that found the Trigger
// as asked too, since the call that made the change may have been cut off before it woke the object. A Trigger made or
// resumed has no alarm yet to heal from, so its object is tried again (`TriggerObjects.wake`), then the call fails
// saying how to schedule it; after any other change one that doesn't answer is left to its next alarm. A Trigger with a
// GitHub-managed hook is made only once the Registry lists `githubHooks` (`triggerFeatures`), and its create answers where
// the hook is, as its woken object says after its first try.
import { EnvironmentsError } from "@cloudpid/extensions/environment";
import type { TriggerAccessService } from "@cloudpid/extensions/triggers";
import { githubHookOf, heldBySession, type TriggerChanged } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { newTriggerId } from "../registry/ids.ts";
import { triggerGitHubHooksUnavailable } from "../registry/messages.ts";
import type { RegistryMethods } from "../registry/Registry.ts";
import type { TriggerObjects } from "../trigger/objects.ts";
import { sessionAuthor } from "./change-author.ts";

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
  | "triggerFeatures"
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
  /** Wake Trigger `id`'s object, which must be scheduled now: failing the call when it never answers, saying how to. */
  const arm = (id: string) =>
    objects.wake(id).pipe(
      Effect.mapError(() =>
        EnvironmentsError.make({
          message: `Trigger ${id} is saved, but its object didn't answer, so it isn't scheduled yet. Call trigger_resume with id ${id} to schedule it: it asks nothing for a Trigger that is active.`,
        }),
      ),
    );

  /**
   * Wake Trigger `id`'s object: for one that must be scheduled now (`arming`), as `arm` does; else left to its next alarm
   * when it doesn't answer.
   */
  const wake = (id: string, arming: boolean) => (arming ? arm(id) : objects.sync(id));

  /** Fails while the Registry can't keep a GitHub-managed hook: one older than this Session's server has no such method. */
  const hooksListed = registry.triggerFeatures().pipe(
    Effect.map(({ githubHooks }) => githubHooks),
    Effect.catchCause(() => Effect.succeed(false)),
    Effect.filterOrFail(Predicate.isTruthy, () =>
      EnvironmentsError.make({ message: `${triggerGitHubHooksUnavailable}. Nothing was saved.` }),
    ),
  );

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
      Effect.gen(function* () {
        if (session === undefined) return yield* unlisted;

        const hook = githubHookOf(trigger);

        if (hook !== undefined) yield* hooksListed;

        const applied = yield* registry.agentCreateTrigger({
          id,
          // A Session trigger is made for this Session.
          trigger: trigger.kind === "session" ? { ...trigger, session } : trigger,
          author: sessionAuthor(session, author),
        });

        if (applied.status !== "changed" && applied.status !== "unchanged") return { applied };

        const state = yield* arm(id);

        if (hook === undefined) return { applied };

        // An object older than this server keeps no hook, and says nothing of one.
        if (state.github === undefined) {
          return yield* EnvironmentsError.make({
            message: `Trigger ${id} is saved, but its object can't make its hook on ${hook.repo} yet: the server is being updated. Call trigger_resume with id ${id} in a few minutes to make it: it asks nothing for a Trigger that is active.`,
          });
        }

        return state.github === null ? { applied } : { applied, github: state.github };
      }),
    update: ({ id, patch, expected, author }) =>
      changing(id, false, (by) =>
        registry.agentUpdateTrigger({ id, patch, expected, author: sessionAuthor(by, author) }),
      ),
    setPaused: ({ id, paused, expected, author }) =>
      changing(id, !paused, (by) =>
        registry.agentSetTriggerPaused({
          id,
          paused,
          expected,
          author: sessionAuthor(by, author),
        }),
      ),
    remove: ({ id, author }) =>
      changing(id, false, (by) =>
        registry.agentRemoveTrigger({ id, author: sessionAuthor(by, author) }),
      ),
  };
};
