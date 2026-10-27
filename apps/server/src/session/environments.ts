// The Session's `Environments` (`@cloudpid/extensions/environment`, `docs/spec.md` → Agent changes): the Registry's
// Environments, read and changed for the agent. A change is applied and recorded by the Registry (`changeEnvironment`,
// and `changeEveryEnvironment` for a variable kept for every Environment), as the owner's save is applied; then, as
// after that save, the Builds' upkeep runs for the Environment (each one, for a variable kept for every Environment),
// and a change that reaches the Session's own Environment is handed to its Workspace at once
// (`updateContainerSettings`), with the variables kept for every Environment merged in, which applies it at its next
// Container start. Other Environments' Workspaces get it at their next readying, as they get the owner's. A Skill saved
// or removed (ADR-0026) is the Registry's too (`agentSaveSkill`, `agentRemoveSkill`, `agentInstallSkills`); the Session's own Workspace is
// handed its Environment's new Skill set at once (`updateSkills`), and no Build's upkeep runs: Skills are not part of
// a Build.
import type {
  AppliedChange,
  EnvironmentDetails,
  EnvironmentListing,
  EnvironmentsService,
  KeptSecretListing,
} from "@cloudpid/extensions/environment";
import {
  EnvironmentsError,
  EVERY_ENVIRONMENT_ID,
  EVERY_ENVIRONMENT_NAME,
} from "@cloudpid/extensions/environment";
import type { BuildView } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { RegistryMethods } from "../registry/Registry.ts";
import type { EnvironmentRecord } from "../registry/store.ts";
import type { EnvironmentLifecycle } from "@cloudpid/extensions/environment-lifecycle";
import type { Builds } from "../registry/builds.ts";
import type { Placement } from "./workspace.ts";
import type { SkillSet } from "../workspace/bundled-skill-set.ts";

/** What the Session's Environments read and change in the Registry. */
export type EnvironmentsRegistry = Pick<
  RegistryMethods,
  | "listEnvironments"
  | "listBuilds"
  | "getEnvironment"
  | "getEnvironmentSettings"
  | "listEnvironmentSecrets"
  | "changeEnvironment"
  | "changeEveryEnvironment"
  | "getEveryEnvironmentSettings"
  | "workspaceOverrides"
  | "agentMarkSecretBuild"
  | "agentSaveSkill"
  | "agentRemoveSkill"
  | "agentInstallSkills"
  | "listSkills"
  | "workspaceSkillSet"
  | "getWorkspace"
>;

export type SessionEnvironmentsOptions = {
  readonly registry: EnvironmentsRegistry;
  /** The Session's id in the Registry; undefined when unknown, for a Session that then belongs to no Environment. */
  readonly session: string | undefined;
  /** Where the Session works: its Workspace, whose Environment is the Session's. */
  readonly placement: () => Promise<Placement>;
  /** Hand an Environment's new Container settings overrides to the Workspace DO `object`. */
  readonly handOver: (
    object: string,
    overrides: Schema.Json,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  /** Hand the Workspace DO `object` its Environment's new Skill set (`Workspace.updateSkills`). */
  readonly handSkills: (
    object: string,
    set: SkillSet,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  /** The Builds' upkeep, run for an Environment after each change, as after the owner's save. */
  readonly builds: Pick<Builds, "of">;
  /** What the agent does to an Environment's own record: make, rename, Repos, Build (`sessionLifecycle`). */
  readonly lifecycle: EnvironmentLifecycle;
};

const NO_BUILD: BuildView = { status: "none" };

/** The Secrets `environment` uses, by name: its own, then those kept for every Environment that it does not override. */
const keptFor = (
  environment: string,
  records: Effect.Success<ReturnType<RegistryMethods["listEnvironmentSecrets"]>>,
): ReadonlyArray<KeptSecretListing> => {
  const own = Arr.filter(records, (record) => record.environment === environment);
  const names = new Set(Arr.map(own, (record) => record.name));

  return [
    ...Arr.map(own, ({ name, build }) => ({ name, scope: "environment" as const, build })),
    ...Arr.map(
      Arr.filter(records, (record) => record.environment === null && !names.has(record.name)),
      ({ name, build }) => ({ name, scope: "every" as const, build }),
    ),
  ];
};

/** An Environment as a change names it: its id and name. */
const changedEnvironment = ({ id, name }: EnvironmentRecord) => ({ id, name });

/** Every Environment as a change names it. */
const EVERY_ENVIRONMENT = { id: EVERY_ENVIRONMENT_ID, name: EVERY_ENVIRONMENT_NAME };

/**
 * The Builds' upkeep after a kept Secret changed (its Build mark, or one more kept) or a variable kept for every
 * Environment did, as the main Worker runs it after the owner's: the Builds it may reach are looked at again, each
 * Environment's for one kept for every Environment (`*`).
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const buildsAfterScope = (
  registry: Pick<RegistryMethods, "listEnvironments">,
  builds: Pick<Builds, "of">,
  environment: string,
): Effect.Effect<void> =>
  environment === EVERY_ENVIRONMENT_ID
    ? registry
        .listEnvironments()
        .pipe(
          Effect.flatMap((all) =>
            Effect.forEach(all, (item) => builds.of(item.id), { discard: true }),
          ),
        )
    : builds.of(environment);

/** The error of a failed call to the Registry or the Workspace, as the model sees it. */
const failedCall = (what: string) => (cause: unknown) =>
  EnvironmentsError.make({ message: `${what} failed: ${String(cause)}. Try again.` });

export const sessionEnvironments = ({
  registry,
  session,
  placement,
  handOver,
  handSkills,
  builds,
  lifecycle,
}: SessionEnvironmentsOptions): EnvironmentsService => {
  /** The Session's Workspace and its Environment, once found: neither changes for the Session's life. */
  let found: { readonly object: string; readonly environment: string } | undefined;

  const where = Effect.gen(function* () {
    if (found !== undefined) return found;

    const { workspace, object } = yield* Effect.tryPromise({
      try: placement,
      catch: failedCall("Finding the Session's Workspace"),
    });

    const record =
      session === undefined || workspace === null
        ? null
        : yield* registry.getWorkspace({ id: workspace });

    if (record === null) return null;

    found = { object, environment: record.environment };

    return found;
  });

  /**
   * Hand the overrides `read` gives to the Session's own Workspace `object` (none: nothing); a Workspace that cannot be
   * reached, or overrides that cannot be read, leave the change to the Workspace's next readying.
   */
  const handToWorkspace = (object: string, read: Effect.Effect<Schema.Json | null>) =>
    read.pipe(
      Effect.flatMap((overrides) =>
        overrides === null
          ? Effect.void
          : Effect.tryPromise(() => handOver(object, overrides)).pipe(
              Effect.flatMap((written) =>
                written.ok
                  ? Effect.void
                  : Effect.logWarning(
                      `The Session's Workspace refused an Agent change: ${written.message}`,
                    ),
              ),
            ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Handing an Agent change to the Session's Workspace failed; it takes it at its next readying",
          cause,
        ),
      ),
    );

  /**
   * Hand the Session's own Workspace its Environment's Skill set after a change to it, if `environment` is the Session's:
   * whether the Workspace took it. One that cannot be reached, or refuses it, gets it at its next readying.
   */
  const handSkillsIfOwn = (environment: string) =>
    Effect.gen(function* () {
      const own = yield* where;

      if (own?.environment !== environment) return false;

      const set = yield* registry.workspaceSkillSet({ environment });

      if (set === null) return false;

      const written = yield* Effect.tryPromise(() => handSkills(own.object, set));

      if (written.ok) return true;

      yield* Effect.logWarning(
        `The Session's Workspace refused its Environment's Skill set: ${written.message}`,
      );

      return false;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Handing the Skill set to the Session's Workspace failed; it takes it at its next readying",
          cause,
        ).pipe(Effect.as(false)),
      ),
    );

  /** The refusal of a change by a Session the Registry does not list. */
  const unlisted = Effect.suspend(() =>
    EnvironmentsError.make({
      message: "This Session is not one the Registry lists, so it changes no Environment.",
    }),
  );

  const buildsById = Effect.map(
    registry.listBuilds(),
    (builds) => new Map(Arr.map(builds, ({ environment, build }) => [environment, build] as const)),
  );

  return {
    ...lifecycle,
    current: Effect.map(where, (known) => known?.environment ?? null),
    list: Effect.gen(function* () {
      const environments = yield* registry.listEnvironments();
      const byId = yield* buildsById;

      return Arr.map(environments, ({ id, name, repos }): EnvironmentListing => ({
        id,
        name,
        repos,
        build: byId.get(id) ?? NO_BUILD,
      }));
    }),
    get: (id) =>
      Effect.gen(function* () {
        const environment = yield* registry.getEnvironment({ id });
        const state = yield* registry.getEnvironmentSettings({ environment: id });

        if (environment === null || state === null) return null;

        const byId = yield* buildsById;
        const secrets = yield* registry.listEnvironmentSecrets();
        const every = yield* registry.getEveryEnvironmentSettings();
        const skills = yield* registry.listSkills({ environment: id });

        return {
          id,
          name: environment.name,
          repos: environment.repos,
          build: byId.get(id) ?? NO_BUILD,
          settings: state.settings,
          problem: state.problem,
          secrets: keptFor(id, secrets),
          everyVariables: every.settings.variables,
          skills: skills ?? [],
        } satisfies EnvironmentDetails;
      }),
    every: Effect.gen(function* () {
      const { settings } = yield* registry.getEveryEnvironmentSettings();
      const secrets = yield* registry.listEnvironmentSecrets();

      return {
        variables: settings.variables,
        secrets: Arr.map(
          Arr.filter(secrets, (record) => record.environment === null),
          ({ name, build }): KeptSecretListing => ({ name, scope: "every", build }),
        ),
      };
    }),
    saveSkill: ({ environment, folder, files, author }) =>
      Effect.gen(function* () {
        if (session === undefined) return yield* unlisted;

        const saved = yield* registry.agentSaveSkill({
          environment,
          folder,
          files,
          author: { session, ...author },
        });

        switch (saved.status) {
          case "rejected":
          case "missing":
            return saved;
          case "unchanged":
            // Nothing changed, but the Session's Workspace may not have taken the set when it was saved.
            yield* handSkillsIfOwn(environment);

            return {
              status: "unchanged",
              environment: changedEnvironment(saved.environment),
              name: folder,
            };
          case "saved":
            // Skills are not part of a Build: no upkeep runs. The Session's own Workspace serves it now.
            return {
              status: "saved",
              environment: changedEnvironment(saved.environment),
              change: saved.change,
              name: saved.skill.name,
              shadows: saved.shadows,
              handed: yield* handSkillsIfOwn(environment),
            };
        }
      }),
    removeSkill: ({ environment, name, author }) =>
      Effect.gen(function* () {
        if (session === undefined) return yield* unlisted;

        const removed = yield* registry.agentRemoveSkill({
          environment,
          name,
          author: { session, ...author },
        });

        switch (removed.status) {
          case "missing":
            return removed;
          case "absent":
            return { status: "absent", environment: changedEnvironment(removed.environment) };
          case "removed":
            return {
              status: "removed",
              environment: changedEnvironment(removed.environment),
              change: removed.change,
              bundled: removed.bundled,
              handed: yield* handSkillsIfOwn(environment),
            };
        }
      }),
    installSkills: ({ environment, source, skills, author }) =>
      Effect.gen(function* () {
        if (session === undefined) return yield* unlisted;

        // The Registry fetches as the GitHub App: no token comes here.
        const installed = yield* registry.agentInstallSkills({
          environment,
          source,
          skills,
          author: { session, ...author },
        });

        switch (installed.status) {
          case "missing":
          case "refused":
            return installed;
          case "listed":
            return { ...installed, environment: changedEnvironment(installed.environment) };
          case "installed": {
            const { results, repo, ref, commit } = installed;

            return {
              status: "installed",
              environment: changedEnvironment(installed.environment),
              repo,
              ref,
              commit,
              results,
              // Skills are not part of a Build: no upkeep runs. The Session's own Workspace serves them now.
              handed: yield* handSkillsIfOwn(environment),
            };
          }
        }
      }),
    markSecret: ({ environment, name, build, author }) =>
      Effect.gen(function* () {
        if (session === undefined) return yield* unlisted;

        const marked = yield* registry.agentMarkSecretBuild({
          environment,
          name,
          build,
          author: { session, ...author },
        });

        // As after the owner's switch: the Secrets marked for the Build are part of what a Build is made with.
        if (marked.status === "changed") {
          yield* buildsAfterScope(registry, builds, environment);
        }

        return marked;
      }),
    change: ({ environment, change, expected, author }) =>
      Effect.gen(function* () {
        if (session === undefined) return yield* unlisted;

        const own = yield* where;

        if (environment === EVERY_ENVIRONMENT_ID) {
          const everywhere = yield* registry.changeEveryEnvironment({
            change,
            author: { session, ...author },
            environment: own?.environment,
          });

          switch (everywhere.status) {
            case "rejected":
              return everywhere;
            case "unchanged":
              return {
                status: "unchanged",
                environment: EVERY_ENVIRONMENT,
                value: everywhere.value,
              };
            case "changed":
              break;
          }

          // The Session's own Workspace takes it now unless its Environment has a variable of its own by that name.
          if (own !== null && everywhere.own === true) {
            yield* handToWorkspace(
              own.object,
              registry.workspaceOverrides({ environment: own.environment }),
            );
          }

          // As after the owner's save: every Environment's Build is made with the variables.
          yield* buildsAfterScope(registry, builds, EVERY_ENVIRONMENT_ID);

          return {
            status: "changed",
            environment: EVERY_ENVIRONMENT,
            change: everywhere.change,
            newBuild: everywhere.newBuilds.length > 0,
            every: {
              overriddenIn: everywhere.overriddenIn,
              newBuilds: everywhere.newBuilds,
              own: everywhere.own === true,
            },
          } satisfies AppliedChange;
        }

        const answer = yield* registry.changeEnvironment({
          environment,
          change,
          expected,
          author: { session, ...author },
        });

        switch (answer.status) {
          case "rejected":
          case "missing":
          case "changed-since":
            return answer;
          case "unchanged":
            return {
              status: "unchanged",
              environment: changedEnvironment(answer.environment),
              value: answer.value,
            };
          case "changed":
            break;
        }

        // The Session's own Workspace takes it now, not at its next readying; one that cannot be reached gets it then.
        // What it is handed has the variables kept for every Environment merged in, which the change may not have
        // touched.
        if (own?.environment === environment) {
          yield* handToWorkspace(
            own.object,
            Effect.map(
              registry.workspaceOverrides({ environment }),
              (handed) => handed ?? answer.state.overrides,
            ),
          );
        }

        // As after the owner's save: the variables are among what a Build is made with.
        yield* builds.of(environment);

        return {
          status: "changed",
          environment: changedEnvironment(answer.environment),
          change: answer.change,
          newBuild: answer.newBuild,
        } satisfies AppliedChange;
      }),
  };
};
