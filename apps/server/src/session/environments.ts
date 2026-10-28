// The Session's `Environments` (`@cloudpid/extensions/environment`, `docs/architecture/agent-changes.md`): the Registry's
// Environments, read and changed for the agent. A change is applied and recorded by the Registry (`changeEnvironment`,
// and `changeGlobal` for a variable kept Global), as the owner's save is applied; then, as
// after that save, the Builds' upkeep runs for the Environment (each one, for a variable kept Global),
// and the spares' upkeep after a change of its Spare Workspace setting; a change that reaches the Session's own
// Environment is handed to its Workspace at once (`updateContainerSettings`), with the variables kept
// Global merged in, which applies it at its next Container start. Other Environments' Workspaces get it at their next readying, as they get the owner's. A Skill saved,
// installed or removed (ADR-0026) is the Registry's too (`agentSaveSkill`, `agentInstallSkills`, `agentRemoveSkill`,
// `agentPreviewSkill`), for an Environment or, saved or removed, at Global (`*`); the Session's own Workspace
// is handed its Environment's new Skill set at once (`updateSkills`), unless the change is to those kept
// Global and its Environment keeps its own Skill of the name, and no Build's upkeep runs: Skills are not part of a
// Build.
import type {
  AppliedChange,
  EnvironmentDetails,
  EnvironmentListing,
  EnvironmentsService,
  KeptSecretListing,
} from "@cloudpid/extensions/environment";
import { EnvironmentsError, GLOBAL_ID, GLOBAL_NAME } from "@cloudpid/extensions/environment";
import { containerOverridesFrom, SPARE_WORKSPACE_FIELD } from "@cloudpid/config";
import type { BuildView } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { RegistryMethods } from "../registry/Registry.ts";
import type { EnvironmentLifecycle } from "@cloudpid/extensions/environment-lifecycle";
import type { Builds } from "../registry/builds.ts";
import type { Spares } from "../registry/rpc.ts";
import type { Placement } from "./workspace.ts";
import type { SkillSet } from "../workspace/skill-set-schema.ts";

/** What the Session's Environments read and change in the Registry. */
export type EnvironmentsRegistry = Pick<
  RegistryMethods,
  | "listEnvironments"
  | "listBuilds"
  | "getEnvironment"
  | "getEnvironmentSettings"
  | "listEnvironmentSecrets"
  | "changeEnvironment"
  | "changeGlobal"
  | "getGlobalContainerSettings"
  | "workspaceOverrides"
  | "agentMarkSecretBuild"
  | "agentSaveSkill"
  | "agentPreviewSkill"
  | "agentRemoveSkill"
  | "agentInstallSkills"
  | "agentUpdateSkills"
  | "previewSkillUpdates"
  | "agentPreviewSkillInstall"
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
  /** The spares' upkeep, run for an Environment after a change of its Spare Workspace setting. */
  readonly spares: Pick<Spares, "of">;
  /** What the agent does to an Environment's own record: make, rename, Repos, Build (`sessionLifecycle`). */
  readonly lifecycle: EnvironmentLifecycle;
};

const NO_BUILD: BuildView = { status: "none" };

/** The Secrets `environment` uses, by name: its own, then those kept Global that it does not override. */
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
const changedEnvironment = ({ id, name }: { readonly id: string; readonly name: string }) => ({
  id,
  name,
});

/**
 * The Environments whose own Skill hides every one of the Skills `results` kept Global: a change reaches
 * them in no Skill. None for Skills kept for one Environment.
 */
const hiddenInAll = (
  results: ReadonlyArray<{
    readonly outcome: string;
    readonly overriddenIn?: ReadonlyArray<{ readonly id: string }> | undefined;
  }>,
): ReadonlyArray<{ readonly id: string }> => {
  const [first, ...rest] = Arr.map(
    Arr.filter(results, (result) => result.outcome === "installed"),
    (result) => result.overriddenIn ?? [],
  );

  return Arr.filter(first ?? [], ({ id }) =>
    Arr.every(rest, (hidden) => Arr.some(hidden, (one) => one.id === id)),
  );
};

/** Global as a change names it. */
const GLOBAL = { id: GLOBAL_ID, name: GLOBAL_NAME };

/**
 * The Builds' upkeep after a kept Secret changed (its Build mark, or one more kept) or a variable kept
 * Global did, as the main Worker runs it after the owner's: the Builds it may reach are looked at again, each
 * Environment's for one kept Global (`*`).
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const buildsAfterScope = (
  registry: Pick<RegistryMethods, "listEnvironments">,
  builds: Pick<Builds, "of">,
  environment: string,
): Effect.Effect<void> =>
  environment === GLOBAL_ID
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
  spares,
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

  /**
   * Hand the Session's own Workspace its Environment's Skill set after a change to the Skills kept for `environment`
   * (an Environment's id, or `*`): whether the Workspace took it. A change to those kept Global reaches
   * the Session's Environment unless it is one of those `hidden` by an own Skill of the name.
   */
  const handSkillsAfter = (environment: string, hidden: ReadonlyArray<{ readonly id: string }>) =>
    Effect.gen(function* () {
      if (environment !== GLOBAL_ID) return yield* handSkillsIfOwn(environment);

      const own = yield* where.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "The Session's Workspace could not be found to hand it the Skill set; it takes it at its next readying",
            cause,
          ).pipe(Effect.as(null)),
        ),
      );

      return own === null || Arr.some(hidden, ({ id }) => id === own.environment)
        ? false
        : yield* handSkillsIfOwn(own.environment);
    });

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
        const skills = yield* registry.listSkills({ environment: id });
        const globalSkills = yield* registry.listSkills({ environment: GLOBAL_ID });

        return {
          id,
          name: environment.name,
          repos: environment.repos,
          build: byId.get(id) ?? NO_BUILD,
          settings: state.settings,
          overrides: state.overrides,
          global: state.global,
          problem: state.problem,
          secrets: keptFor(id, secrets),
          skills: skills ?? [],
          globalSkills: globalSkills ?? [],
        } satisfies EnvironmentDetails;
      }),
    global: Effect.gen(function* () {
      const { settings, overriddenIn } = yield* registry.getGlobalContainerSettings();
      const secrets = yield* registry.listEnvironmentSecrets();
      const skills = yield* registry.listSkills({ environment: GLOBAL_ID });

      return {
        settings,
        overriddenIn,
        skills: skills ?? [],
        secrets: Arr.map(
          Arr.filter(secrets, (record) => record.environment === null),
          ({ name, build }): KeptSecretListing => ({ name, scope: "every", build }),
        ),
      };
    }),
    saveSkill: ({ environment, folder, files, expected, author }) =>
      Effect.gen(function* () {
        if (session === undefined) return yield* unlisted;

        const saved = yield* registry.agentSaveSkill({
          environment,
          folder,
          files,
          expected,
          author: { session, ...author },
        });

        switch (saved.status) {
          case "rejected":
          case "missing":
          case "changed-since":
            return saved;
          case "unchanged":
            // Nothing changed, but the Session's Workspace may not have taken the set when it was saved.
            yield* handSkillsAfter(environment, []);

            return { status: "unchanged", environment: saved.environment, name: folder };
          case "saved":
            // Skills are not part of a Build: no upkeep runs. The Session's own Workspace serves it now.
            return {
              status: "saved",
              environment: saved.environment,
              change: saved.change,
              name: saved.skill.name,
              inherited: saved.inherited,
              overriddenIn: saved.overriddenIn,
              handed: yield* handSkillsAfter(environment, saved.overriddenIn),
            };
        }
      }),
    previewSkill: ({ environment, folder, files }) =>
      registry.agentPreviewSkill({ environment, folder, files }),
    removeSkill: ({ environment, name, expected, author }) =>
      Effect.gen(function* () {
        if (session === undefined) return yield* unlisted;

        const removed = yield* registry.agentRemoveSkill({
          environment,
          name,
          expected,
          author: { session, ...author },
        });

        switch (removed.status) {
          case "missing":
          case "absent":
          case "changed-since":
          case "rejected":
            return removed;
          case "removed":
            return {
              status: "removed",
              environment: removed.environment,
              change: removed.change,
              inherited: removed.inherited,
              overriddenIn: removed.overriddenIn,
              handed: yield* handSkillsAfter(environment, removed.overriddenIn),
            };
        }
      }),
    previewInstall: ({ environment, source, skills }) =>
      Effect.gen(function* () {
        const previewed = yield* registry.agentPreviewSkillInstall({ environment, source, skills });

        switch (previewed.status) {
          case "missing":
          case "refused":
            return previewed;
          case "listed":
          case "previewed":
            return { ...previewed, environment: changedEnvironment(previewed.environment) };
        }
      }),
    installSkills: ({ environment, source, skills, author, pin }) =>
      Effect.gen(function* () {
        if (session === undefined) return yield* unlisted;

        // The Registry fetches as the GitHub App: no token comes here.
        const installed = yield* registry.agentInstallSkills({
          environment,
          source,
          skills,
          author: { session, ...author },
          pin,
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
              // Skills are not part of a Build: no upkeep runs. The Session's own Workspace serves them now, unless its
              // Environment keeps its own Skill of every name installed at Global.
              handed: yield* handSkillsAfter(environment, hiddenInAll(results)),
            };
          }
        }
      }),
    updateSkills: ({ environment, names, overwrite, pins, author }) =>
      Effect.gen(function* () {
        if (session === undefined) return yield* unlisted;

        // The Registry fetches as the GitHub App: no token comes here.
        const updated = yield* registry.agentUpdateSkills({
          environment,
          names,
          overwrite,
          pins,
          author: { session, ...author },
        });

        switch (updated.status) {
          case "missing":
          case "refused":
            return updated;
          case "nothing":
            return { status: "nothing" as const, environment: updated.environment };
          case "done": {
            const moved = Arr.some(updated.results, ({ outcome }) => outcome === "updated");

            return {
              status: "done" as const,
              environment: updated.environment,
              results: updated.results,
              // Skills are not part of a Build: no upkeep runs. The Session's own Workspace serves them now.
              handed: moved ? yield* handSkillsAfter(environment, []) : false,
            };
          }
        }
      }),
    previewUpdates: ({ environment, names, overwrite }) =>
      registry.previewSkillUpdates({ environment, names, overwrite }),
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

        if (environment === GLOBAL_ID) {
          const atGlobal = yield* registry.changeGlobal({
            change,
            expected,
            author: { session, ...author },
            environment: own?.environment,
          });

          switch (atGlobal.status) {
            case "rejected":
            case "changed-since":
              return atGlobal;
            case "unchanged":
              return {
                status: "unchanged",
                environment: GLOBAL,
                value: atGlobal.value,
              };
            case "changed":
              break;
          }

          // The Session's own Workspace takes it now unless its Environment overrides the field.
          if (own !== null && atGlobal.own === true) {
            yield* handToWorkspace(
              own.object,
              registry.workspaceOverrides({ environment: own.environment }),
            );
          }

          // The Spare Workspace setting keeps or removes the spare of each Environment that inherits it.
          if (change.field === SPARE_WORKSPACE_FIELD) {
            const all = yield* registry.listEnvironments();

            yield* Effect.forEach(all, (item) => spares.of(item.id), { discard: true });
          }

          // As after the owner's save: each Environment's Build is made with the settings it inherits.
          yield* buildsAfterScope(registry, builds, GLOBAL_ID);

          return {
            status: "changed",
            environment: GLOBAL,
            change: atGlobal.change,
            newBuild: atGlobal.newBuilds.length > 0,
            global: {
              overriddenIn: atGlobal.overriddenIn,
              newBuilds: atGlobal.newBuilds,
              own: atGlobal.own === true,
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
        // It is handed every setting in force, Global's among them, which the change may not have touched.
        if (own?.environment === environment) {
          yield* handToWorkspace(
            own.object,
            Effect.map(
              registry.workspaceOverrides({ environment }),
              (handed) => handed ?? containerOverridesFrom(answer.state.settings),
            ),
          );
        }

        // The Spare Workspace setting keeps or removes the spare (the owner's save runs this upkeep after any change,
        // not knowing which field changed). As after that save, the variables are among what a Build is made with.
        if (change.field === SPARE_WORKSPACE_FIELD) yield* spares.of(environment);

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
