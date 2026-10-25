// The deletes the agent makes once the owner approved them (`@cloudpid/extensions/approval-tools`, `docs/spec.md` →
// Approval): an Environment, deleted as the owner's delete on the Environments page deletes it (`removals`, which the
// main Worker's endpoint runs too), and a Secret kept for an Environment, deleted and recorded by the Registry
// (`agentDeleteSecret`), after which the Builds' upkeep runs as after the owner's delete.
import type {
  EnvironmentFootprint,
  EnvironmentRemovalService,
} from "@cloudpid/extensions/approval-tools";
import { EnvironmentsError, EVERY_ENVIRONMENT_ID } from "@cloudpid/extensions/environment";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { Builds } from "../registry/builds.ts";
import type { RegistryMethods } from "../registry/Registry.ts";
import { type RemovalObjects, type RemovalRegistry, removals } from "../registry/removal.ts";
import { buildsAfterSecret } from "./environments.ts";

/** What the deletes read and change in the Registry. */
export type EnvironmentRemovalRegistry = RemovalRegistry &
  Pick<RegistryMethods, "listEnvironments" | "listEnvironmentSecrets" | "agentDeleteSecret">;

export type SessionEnvironmentRemovalOptions = {
  readonly registry: EnvironmentRemovalRegistry;
  /** The Session's id in the Registry; undefined when unknown, for a Session that then deletes nothing. */
  readonly session: string | undefined;
  /** The Workspaces' and the Sessions' objects, which deleting an Environment wipes. */
  readonly objects: RemovalObjects;
  /** The Builds' upkeep, run after a kept Secret is deleted, as after the owner's delete. */
  readonly builds: Pick<Builds, "of">;
};

const unlisted = EnvironmentsError.make({
  message: "This Session is not one the Registry lists, so it deletes nothing.",
});

export const sessionEnvironmentRemoval = ({
  registry,
  session,
  objects,
  builds,
}: SessionEnvironmentRemovalOptions): EnvironmentRemovalService => {
  const { deleteEnvironment } = removals(registry, objects);

  /** The Secrets kept in `scope` alone: an Environment's id, or every Environment's (`*`). */
  const keptIn = (scope: string) =>
    Effect.map(registry.listEnvironmentSecrets(), (records) =>
      Arr.filter(records, (record) =>
        scope === EVERY_ENVIRONMENT_ID ? record.environment === null : record.environment === scope,
      ),
    );

  return {
    footprint: (environment) =>
      Effect.gen(function* () {
        if ((yield* registry.getEnvironment({ id: environment })) === null) return null;

        const workspaces = Arr.filter(
          yield* registry.listWorkspaces(),
          (workspace) => workspace.environment === environment,
        );

        const ids = new Set(Arr.map(workspaces, (workspace) => workspace.id));

        const sessions = Arr.filter(yield* registry.listSessions(), (record) =>
          ids.has(record.workspace),
        );

        return {
          workspaces: workspaces.length,
          sessions: sessions.length,
          secrets: (yield* keptIn(environment)).length,
        } satisfies EnvironmentFootprint;
      }),
    deleteEnvironment: (environment) =>
      session === undefined
        ? unlisted
        : deleteEnvironment(environment).pipe(
            Effect.mapError((error) => EnvironmentsError.make({ message: error.message })),
          ),
    keptSecrets: (scope) =>
      Effect.gen(function* () {
        if (
          scope !== EVERY_ENVIRONMENT_ID &&
          (yield* registry.getEnvironment({ id: scope })) === null
        ) {
          return null;
        }

        return Arr.map(yield* keptIn(scope), ({ name, build }) => ({ name, build }));
      }),
    deleteSecret: ({ environment, name, author }) =>
      Effect.gen(function* () {
        if (session === undefined) return yield* unlisted;

        const deleted = yield* registry.agentDeleteSecret({
          environment,
          name,
          author: { session, ...author },
        });

        // As after the owner's delete: the Secrets a Build gets are part of what it is made with.
        if (deleted.status === "deleted") {
          yield* buildsAfterSecret(registry, builds, environment);
        }

        return deleted;
      }),
  };
};
