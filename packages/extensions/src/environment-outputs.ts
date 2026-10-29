// What the `environment` extension's tools return to programs (`docs/architecture/agent-capabilities.md` → Values for
// programs; the other Environment tools' outputs are in `environment-lifecycle-outputs.ts` and the Settings tools' in
// `settings-outputs.ts`): the shapes of `environment_list` and `environment_get`, and the value of a change made at an
// Environment or at Global (`environmentChangeOutput`, `changeOutput`, `unchangedOutput`, `declinedOutput`, which the
// other tools that change an Environment build with), and of an Environment or a kept Secret deleted. Every value is
// built from the same data the model-facing text is made of (`./environment.ts`). Texts and lists that can grow are cut,
// each with a `<field>_truncated` flag (`./outputs.ts`); the bounds below keep `environment_get`'s whole value, in its
// worst case, under 1 MiB stored, far under what one nested call's result holds (`MAX_NESTED_STRUCTURED_OUTPUT_BYTES`,
// 1.5 MiB, see `docs/architecture/workspace.md` → The rest of one tool result).
// @effect-diagnostics missingPipeableSignature:off
import { type ContainerSettings, InstanceType } from "@cloudpid/config";
import {
  type AgentChange,
  type BuildView,
  type EnvironmentRepo,
  type EnvironmentSkill,
  variableField,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type {
  AppliedChange,
  ChangedEnvironment,
  EnvironmentDetails,
  EnvironmentListing,
  GlobalChanged,
  GlobalDetails,
  KeptSecretListing,
} from "./environment.ts";
import {
  ApprovalOutcome,
  boundItems,
  boundText,
  changesOutput,
  EnvironmentChangeOutput,
  overriddenInOutput,
  scopeRef,
  ScopeRef,
} from "./outputs.ts";
import { secretEnvName } from "./secrets/references.ts";

/** The last characters of a failed Build's reason that a result shows. */
export const FAILED_REASON_TAIL = 1_000;

/**
 * What each part of `environment_get`'s value weighs at most, stored. The worst case, with every part full, is 800 KiB:
 * the scripts 2 x 96, the Toolchains and the paths 2 x 32, the Repos 32, the variables and the Skills 2 x 160, the
 * Secrets 64, each of Global's eight settings' overriding Environments 8 x 8, the names of Global's variables and Skills
 * that an Environment hides 2 x 16, the problem 16, and the Build's reason (1,000 characters, 6 KiB at most) with the
 * small rest.
 */
export const MAX_SCRIPT_BYTES = 96 * 1024;
export const MAX_SMALL_TEXT_BYTES = 32 * 1024;
export const MAX_REPOS_BYTES = 32 * 1024;
export const MAX_VARIABLES_BYTES = 160 * 1024;
export const MAX_SKILLS_BYTES = 160 * 1024;
export const MAX_SECRETS_BYTES = 64 * 1024;
export const MAX_OVERRIDING_BYTES = 8 * 1024;
export const MAX_NAMES_BYTES = 16 * 1024;
export const MAX_PROBLEM_BYTES = 16 * 1024;

// ─── Repos and Builds ────────────────────────────────────────────────────────

/** A Repo of an Environment. */
export const RepoOutput = Schema.Struct({
  name: Schema.String.annotate({ description: "The directory below /workspace it is cloned into" }),
  url: Schema.String.annotate({ description: "The https URL its Workspaces clone" }),
});

/** An Environment's Build, with the end of a failed one's reason. Times are epoch milliseconds. */
export const BuildOutput = Schema.Struct({
  status: Schema.Literals(["none", "building", "ready", "failed"]).annotate({
    description:
      "none: no Build made yet, or nothing to build; building: one is being made; ready: the last Build is good; failed: the last attempt failed",
  }),
  at: Schema.NullOr(Schema.Finite).annotate({
    description: "When the last Build finished (ready) or failed (failed); null otherwise",
  }),
  since: Schema.NullOr(Schema.Finite).annotate({
    description: "When the Build being made began (building); null otherwise",
  }),
  last_good_at: Schema.NullOr(Schema.Finite).annotate({
    description:
      "When the last good Build finished, which new Workspaces start from meanwhile (building, failed); null for none",
  }),
  reason: Schema.NullOr(Schema.String).annotate({
    description: "The end of a failed Build's reason; null for another status",
  }),
  reason_truncated: Schema.Boolean.annotate({
    description: "The reason is cut to its last characters",
  }),
});

/** `build` as a value gives it: a failed Build's reason is cut to its last `FAILED_REASON_TAIL` characters. */
export const buildOutput = (build: BuildView): typeof BuildOutput.Type => {
  switch (build.status) {
    case "none":
      return {
        status: "none",
        at: null,
        since: null,
        last_good_at: null,
        reason: null,
        reason_truncated: false,
      };
    case "building":
      return {
        status: "building",
        at: null,
        since: build.since,
        last_good_at: build.lastGoodAt,
        reason: null,
        reason_truncated: false,
      };
    case "ready":
      return {
        status: "ready",
        at: build.at,
        since: null,
        last_good_at: null,
        reason: null,
        reason_truncated: false,
      };
    case "failed": {
      const cut = build.reason.length > FAILED_REASON_TAIL;

      return {
        status: "failed",
        at: build.at,
        since: null,
        last_good_at: build.lastGoodAt,
        reason: cut ? build.reason.slice(-FAILED_REASON_TAIL) : build.reason,
        reason_truncated: cut,
      };
    }
  }
};

const repoOutput = ({ name, url }: EnvironmentRepo): typeof RepoOutput.Type => ({ name, url });

// ─── environment_list ────────────────────────────────────────────────────────

/** `environment_list`: the Environments, and how many variables are kept Global. */
export const EnvironmentListOutput = Schema.Struct({
  environments: Schema.Array(
    Schema.Struct({
      id: Schema.String.annotate({ description: "The Environment's id" }),
      name: Schema.String.annotate({ description: "The Environment's name" }),
      current: Schema.Boolean.annotate({ description: "This Session's own Environment" }),
      repos: Schema.Array(RepoOutput).annotate({ description: "Its Repos" }),
      build: BuildOutput.annotate({ description: "How its Build stands" }),
    }),
  ).annotate({ description: "The Environments, the first that fit" }),
  environments_truncated: Schema.Boolean.annotate({
    description: "More Environments exist than fit; the first ones are listed",
  }),
  global_variables: Schema.Int.annotate({ description: "How many variables are kept Global" }),
});

/** What `environment_list` gives programs: `listed` (the first that fit), the Session's own and Global's variable count. */
export const environmentListOutput = (
  listed: ReadonlyArray<EnvironmentListing>,
  current: string | null,
  globalVariables: number,
): typeof EnvironmentListOutput.Type => {
  const bounded = boundItems(
    Arr.map(listed, (environment) => ({
      id: environment.id,
      name: environment.name,
      current: environment.id === current,
      repos: Arr.map(environment.repos, repoOutput),
      build: buildOutput(environment.build),
    })),
  );

  return {
    environments: bounded.items,
    environments_truncated: bounded.truncated,
    global_variables: globalVariables,
  };
};

// ─── environment_get ─────────────────────────────────────────────────────────

const Source = Schema.Literals(["own", "inherited", "global"]).annotate({
  description:
    "own: the Environment's own value (overridden here); inherited: Global's, which the Environment does not override; global: kept at Global (for id *)",
});

/** Where each setting's (or variable's) value comes from, whatever the value. */
const placement = {
  source: Source,
  overridden_in: Schema.Array(ScopeRef).annotate({
    description:
      "For Global's settings, the Environments that override it, so a change there does not reach them; empty for an Environment's",
  }),
  overridden_in_truncated: Schema.Boolean.annotate({
    description: "More Environments override it than fit",
  }),
};

/** A Container setting in force, and where it comes from. */
export const SettingsOutput = Schema.Struct({
  instance: Schema.Struct({
    value: InstanceType.annotate({ description: "The size of the next Containers" }),
    ...placement,
  }),
  max_instance: Schema.Struct({
    value: InstanceType.annotate({ description: "The size limit: the largest size allowed" }),
    ...placement,
  }),
  idle_minutes: Schema.Struct({
    value: Schema.Finite.annotate({
      description: "Minutes a Container may sit idle before it stops",
    }),
    ...placement,
  }),
  ignore: Schema.Struct({
    value: Schema.Array(Schema.String).annotate({
      description: "Extra Container-only path patterns",
    }),
    value_truncated: Schema.Boolean.annotate({ description: "The list is cut to what fits" }),
    ...placement,
  }),
  setup_script: Schema.Struct({
    value: Schema.String.annotate({ description: "The Setup Script (bash); empty for none" }),
    value_truncated: Schema.Boolean.annotate({ description: "The script is cut to what fits" }),
    ...placement,
  }),
  start_script: Schema.Struct({
    value: Schema.String.annotate({ description: "The Start Script (bash); empty for none" }),
    value_truncated: Schema.Boolean.annotate({ description: "The script is cut to what fits" }),
    ...placement,
  }),
  toolchains: Schema.Struct({
    value: Schema.String.annotate({
      description: "The mise.toml text; empty for the image's base Toolchains",
    }),
    value_truncated: Schema.Boolean.annotate({ description: "The text is cut to what fits" }),
    ...placement,
  }),
  spare_workspace: Schema.Struct({
    value: Schema.Boolean.annotate({ description: "A Workspace is kept made ahead" }),
    ...placement,
  }),
});

/** A variable that applies, and where it comes from. */
export const VariableOutput = Schema.Struct({
  name: Schema.String.annotate({ description: "The variable's name" }),
  value: Schema.String.annotate({ description: "The value, plain" }),
  ...placement,
});

/** A Secret kept, by name only: never its value. */
export const SecretOutput = Schema.Struct({
  name: Schema.String.annotate({ description: "The Secret's name" }),
  scope: Schema.Literals(["environment", "every"]).annotate({
    description: "environment: kept for this Environment; every: kept Global",
  }),
  build: Schema.Boolean.annotate({ description: "It reaches the Setup Scripts and the Build" }),
  env_var: Schema.String.annotate({ description: "The variable commands get it as" }),
});

/** Where a Skill was installed from. */
export const SkillSourceOutput = Schema.Struct({
  repo: Schema.String.annotate({ description: "The repo it was installed from, owner/name" }),
  path: Schema.String.annotate({
    description: "Its folder in the repo; empty for the repo's root",
  }),
  ref: Schema.NullOr(Schema.String).annotate({
    description: "The ref named at install; null for the repo's default branch",
  }),
  commit: Schema.String.annotate({ description: "The commit it resolved to, in full" }),
});

/** A Skill's source as a value gives it. */
export const skillSourceOutput = ({
  repo,
  path,
  ref,
  commit,
}: {
  readonly repo: string;
  readonly path: string;
  readonly ref: string | null;
  readonly commit: string;
}): typeof SkillSourceOutput.Type => ({ repo, path, ref, commit });

/** A Skill kept, by its name and description. Times are epoch milliseconds. */
export const SkillOutput = Schema.Struct({
  name: Schema.String.annotate({ description: "The Skill's name" }),
  description: Schema.String.annotate({ description: "What the Skill is for, from its SKILL.md" }),
  saved_at: Schema.Finite.annotate({ description: "When it was last saved" }),
  installed_from: Schema.NullOr(SkillSourceOutput).annotate({
    description: "Where it was installed from; null for one never installed",
  }),
  modified: Schema.Boolean.annotate({ description: "Edited since it was installed" }),
  update_available: Schema.Boolean.annotate({
    description: "Its source's folder changed at the ref's head",
  }),
  origin: Schema.Literals(["own", "inherited", "global"]).annotate({
    description:
      "own: the Environment's own; inherited: kept Global and not hidden by the Environment's own; global: kept Global (for id *)",
  }),
});

/** `skill` as a value gives it, kept in `origin`. */
export const skillOutput = (
  skill: EnvironmentSkill,
  origin: typeof SkillOutput.Type.origin,
): typeof SkillOutput.Type => ({
  name: skill.name,
  description: skill.description,
  saved_at: skill.savedAt,
  installed_from: skill.source === undefined ? null : skillSourceOutput(skill.source),
  modified: skill.modified === true,
  update_available: skill.updateAvailable === true,
  origin,
});

const secretOutput = (secret: KeptSecretListing): typeof SecretOutput.Type => ({
  name: secret.name,
  scope: secret.scope,
  build: secret.build,
  env_var: secretEnvName(secret.name),
});

/**
 * `environment_get`: an Environment's settings in force, each marked own or inherited, the variables that apply, the
 * Secrets' names, the Skills and the Build; for id `*`, Global's settings with the Environments that override each, its
 * Secrets and its Skills (no Repos, no Build).
 */
export const EnvironmentGetOutput = Schema.Struct({
  scope: ScopeRef.annotate({ description: 'The Environment, or Global (id "*")' }),
  current: Schema.Boolean.annotate({
    description: "This Session's own Environment; false for Global",
  }),
  repos: Schema.Array(RepoOutput).annotate({ description: "Its Repos; none for Global" }),
  repos_truncated: Schema.Boolean.annotate({ description: "The Repos are cut to what fits" }),
  build: Schema.NullOr(BuildOutput).annotate({
    description: "How its Build stands; null for Global",
  }),
  settings: SettingsOutput.annotate({
    description: "The Container settings in force, each with where its value comes from",
  }),
  variables: Schema.Array(VariableOutput).annotate({
    description:
      "The variables that apply: the Environment's own, then Global's that its own do not override; for Global, its variables",
  }),
  variables_truncated: Schema.Boolean.annotate({
    description: "The variables, or the names in overridden_global_variables, are cut to what fits",
  }),
  overridden_global_variables: Schema.Array(Schema.String).annotate({
    description:
      "The names of Global's variables the Environment's own override; cut to what fits, which sets variables_truncated",
  }),
  secrets: Schema.Array(SecretOutput).annotate({
    description: "The Secrets kept for the Environment and Global, by name only",
  }),
  secrets_truncated: Schema.Boolean.annotate({ description: "The Secrets are cut to what fits" }),
  skills: Schema.Array(SkillOutput).annotate({
    description:
      "The Environment's own Skills, then those kept Global that its own do not hide; for Global, its Skills",
  }),
  skills_truncated: Schema.Boolean.annotate({
    description: "The Skills, or the names in overridden_global_skills, are cut to what fits",
  }),
  overridden_global_skills: Schema.Array(Schema.String).annotate({
    description:
      "The names of Global's Skills the Environment's own hide; cut to what fits, which sets skills_truncated",
  }),
  problem: Schema.NullOr(Schema.String).annotate({
    description:
      "Why only some of the saved settings apply, when a later release no longer accepts one; else null",
  }),
  problem_truncated: Schema.Boolean.annotate({ description: "The problem is cut to what fits" }),
});

/** A Container setting an Environment may override: all but the variables, which are placed one by one. */
type SettingName = Exclude<keyof ContainerSettings, "variables">;

type SettingsValue = typeof SettingsOutput.Type;

type Placement = {
  readonly source: typeof Source.Type;
  readonly overriding: ReadonlyArray<typeof ScopeRef.Type>;
};

/** `place` as a value gives it: the Environments that override are cut to `MAX_OVERRIDING_BYTES`. */
const placed = ({ source, overriding }: Placement) => ({
  source,
  ...overriddenInOutput(overriding, MAX_OVERRIDING_BYTES),
});

/** `settings` as a value gives them, each placed by `place`. */
const settingsOutput = (
  settings: ContainerSettings,
  place: (field: SettingName) => Placement,
): SettingsValue => {
  const ignore = boundItems(settings.ignore, MAX_SMALL_TEXT_BYTES);
  const setup = boundText(settings.setupScript, MAX_SCRIPT_BYTES);
  const start = boundText(settings.startScript, MAX_SCRIPT_BYTES);
  const toolchains = boundText(settings.toolchains, MAX_SMALL_TEXT_BYTES);

  return {
    instance: { value: settings.instance, ...placed(place("instance")) },
    max_instance: { value: settings.maxInstance, ...placed(place("maxInstance")) },
    idle_minutes: { value: settings.idleMinutes, ...placed(place("idleMinutes")) },
    ignore: { value: ignore.items, value_truncated: ignore.truncated, ...placed(place("ignore")) },
    setup_script: {
      value: setup.text,
      value_truncated: setup.truncated,
      ...placed(place("setupScript")),
    },
    start_script: {
      value: start.text,
      value_truncated: start.truncated,
      ...placed(place("startScript")),
    },
    toolchains: {
      value: toolchains.text,
      value_truncated: toolchains.truncated,
      ...placed(place("toolchains")),
    },
    spare_workspace: { value: settings.spareWorkspace, ...placed(place("spareWorkspace")) },
  };
};

/** Variable `name` as a value gives it, placed by `place`. */
const variableOutput = (
  name: string,
  value: string,
  place: Placement,
): typeof VariableOutput.Type => ({ name, value, ...placed(place) });

/**
 * What `environment_get` gives programs for Environment `details`: the settings in force with where each comes from, its
 * own variables and Global's that they do not override, the Secrets, its own Skills and Global's they do not hide, and
 * its Build. `current`: whether it is this Session's own Environment.
 */
export const environmentGetOutput = (
  details: EnvironmentDetails,
  current: boolean,
): typeof EnvironmentGetOutput.Type => {
  const { settings, overrides, global } = details;
  const own = overrides.variables ?? {};
  const inherited = Record.filter(global.variables, (_, name) => !Record.has(own, name));
  const overridden = Arr.filter(Record.keys(global.variables), (name) => Record.has(own, name));

  const variables = boundItems(
    [
      ...Arr.map(Record.toEntries(own), ([name, value]) =>
        variableOutput(name, value, { source: "own", overriding: [] }),
      ),
      ...Arr.map(Record.toEntries(inherited), ([name, value]) =>
        variableOutput(name, value, { source: "inherited", overriding: [] }),
      ),
    ],
    MAX_VARIABLES_BYTES,
  );

  const ownSkills = new Set(Arr.map(details.skills, (skill) => skill.name));
  const hidden = Arr.filter(details.globalSkills, (skill) => ownSkills.has(skill.name));

  const skills = boundItems(
    [
      ...Arr.map(details.skills, (skill) => skillOutput(skill, "own")),
      ...Arr.map(
        Arr.filter(details.globalSkills, (skill) => !ownSkills.has(skill.name)),
        (skill) => skillOutput(skill, "inherited"),
      ),
    ],
    MAX_SKILLS_BYTES,
  );

  const repos = boundItems(Arr.map(details.repos, repoOutput), MAX_REPOS_BYTES);
  const secrets = boundItems(Arr.map(details.secrets, secretOutput), MAX_SECRETS_BYTES);
  const hiddenVariables = boundItems(overridden, MAX_NAMES_BYTES);

  const hiddenSkills = boundItems(
    Arr.map(hidden, (skill) => skill.name),
    MAX_NAMES_BYTES,
  );

  const problem = boundText(details.problem ?? "", MAX_PROBLEM_BYTES);

  const place = (field: SettingName): Placement => ({
    source: overrides[field] === undefined ? "inherited" : "own",
    overriding: [],
  });

  return {
    scope: scopeRef(details),
    current,
    repos: repos.items,
    repos_truncated: repos.truncated,
    build: buildOutput(details.build),
    settings: settingsOutput(settings, place),
    variables: variables.items,
    variables_truncated: variables.truncated || hiddenVariables.truncated,
    overridden_global_variables: hiddenVariables.items,
    secrets: secrets.items,
    secrets_truncated: secrets.truncated,
    skills: skills.items,
    skills_truncated: skills.truncated || hiddenSkills.truncated,
    overridden_global_skills: hiddenSkills.items,
    problem: details.problem === undefined ? null : problem.text,
    problem_truncated: problem.truncated,
  };
};

/**
 * What `environment_get` gives programs for what is kept Global (id `*`): its settings and variables, each with the
 * Environments that override it, its Secrets and its Skills.
 */
export const globalGetOutput = (
  details: GlobalDetails,
  scope: typeof ScopeRef.Type,
): typeof EnvironmentGetOutput.Type => {
  const { settings, overriddenIn } = details;

  const overriding = (path: string) => Arr.map(overriddenIn[path] ?? [], scopeRef);

  const variables = boundItems(
    Arr.map(Record.toEntries(settings.variables), ([name, value]) =>
      variableOutput(name, value, {
        source: "global",
        overriding: overriding(variableField(name)),
      }),
    ),
    MAX_VARIABLES_BYTES,
  );

  const secrets = boundItems(Arr.map(details.secrets, secretOutput), MAX_SECRETS_BYTES);

  const skills = boundItems(
    Arr.map(details.skills, (skill) => skillOutput(skill, "global")),
    MAX_SKILLS_BYTES,
  );

  return {
    scope,
    current: false,
    repos: [],
    repos_truncated: false,
    build: null,
    settings: settingsOutput(settings, (field) => ({
      source: "global",
      overriding: overriding(field),
    })),
    variables: variables.items,
    variables_truncated: variables.truncated,
    overridden_global_variables: [],
    secrets: secrets.items,
    secrets_truncated: secrets.truncated,
    skills: skills.items,
    skills_truncated: skills.truncated,
    overridden_global_skills: [],
    problem: null,
    problem_truncated: false,
  };
};

// ─── Changes ─────────────────────────────────────────────────────────────────

type Approval = typeof ApprovalOutcome.Type;

type EnvironmentChange = typeof EnvironmentChangeOutput.Type;

/**
 * A Container setting change at an Environment or at Global, as a value gives it: `change` (none for a setting that had
 * its value already, or a change the owner declined), the fields that `unchanged` left alone, the owner's `approval`
 * where the change waited for it, whether it reached this Session's Workspace (`own`), whether a new Build was asked for
 * (`newBuild`), and for a change at Global whom it reached (`global`).
 */
export const environmentChangeOutput = ({
  environment,
  change,
  unchanged = [],
  approval = null,
  own = false,
  newBuild = false,
  global = null,
}: {
  readonly environment: ChangedEnvironment;
  readonly change?: AgentChange | undefined;
  readonly unchanged?: ReadonlyArray<string>;
  readonly approval?: Approval;
  readonly own?: boolean;
  readonly newBuild?: boolean;
  readonly global?: GlobalChanged | null;
}): EnvironmentChange => ({
  scope: scopeRef(environment),
  ...changesOutput(change === undefined ? [] : [change]),
  unchanged,
  approval,
  own,
  new_build: newBuild,
  global: global === null ? null : globalReach(global),
});

/** The most each list of the Environments a change at Global reached weighs stored. */
const MAX_REACHED_BYTES = 64 * 1024;

/** Whom a change at Global reached, each list cut to `MAX_REACHED_BYTES`. */
const globalReach = (global: GlobalChanged) => {
  const overridden = boundItems(Arr.map(global.overriddenIn, scopeRef), MAX_REACHED_BYTES);
  const builds = boundItems(Arr.map(global.newBuilds, scopeRef), MAX_REACHED_BYTES);

  return {
    overridden_in: overridden.items,
    overridden_in_truncated: overridden.truncated,
    new_builds: builds.items,
    new_builds_truncated: builds.truncated,
  };
};

/**
 * An Agent change that was made, as a value gives it: whether it reaches this Session's own Workspace (`own`: the
 * Session's Environment is the one changed; a change at Global says so itself), whether a new Build was asked for, and
 * for a change at Global, whom it did not reach and where Builds were asked for. `approval`: the owner's answer, for a
 * change that waited for it.
 */
export const changeOutput = (
  applied: Extract<AppliedChange, { readonly status: "changed" }>,
  own: boolean,
  approval: Approval = null,
): EnvironmentChange =>
  environmentChangeOutput({
    environment: applied.environment,
    change: applied.change,
    approval,
    own: applied.global?.own ?? own,
    newBuild: applied.newBuild,
    global: applied.global ?? null,
  });

/** A setting that already had the value: nothing changed, so it reached no one and asked for no Build. */
export const unchangedOutput = (
  environment: ChangedEnvironment,
  field: string,
  approval: Approval = null,
): EnvironmentChange => environmentChangeOutput({ environment, unchanged: [field], approval });

/** A change the owner declined (`approval`, as `declinedWith` gives it): nothing changed. */
export const declinedOutput = (
  environment: ChangedEnvironment,
  approval: Approval,
): EnvironmentChange => environmentChangeOutput({ environment, approval });

// ─── Deletes ─────────────────────────────────────────────────────────────────

/** What deleting an Environment took, as the owner was asked about it. */
export const FootprintOutput = Schema.Struct({
  workspaces: Schema.Finite.annotate({ description: "Its Workspaces, but its spare" }),
  sessions: Schema.Finite.annotate({ description: "The Sessions in them, archived ones too" }),
  secrets: Schema.Finite.annotate({ description: "The Secrets kept for it alone" }),
});

/** `environment_delete`: whether the Environment was deleted, and what that took. */
export const EnvironmentDeleteOutput = Schema.Struct({
  environment: ScopeRef.annotate({ description: "The Environment asked to be deleted" }),
  deleted: Schema.Boolean.annotate({
    description:
      "The Environment no longer exists: deleted by this call, or already gone when the owner approved; false only when the owner declined",
  }),
  footprint: Schema.NullOr(FootprintOutput).annotate({
    description: "What the delete took, as the owner approved it; null when nothing was deleted",
  }),
  approval: ApprovalOutcome,
});

/** `environment_secret_delete`: whether the kept Secret was deleted. */
export const EnvironmentSecretDeleteOutput = Schema.Struct({
  scope: ScopeRef.annotate({
    description: 'The Environment the Secret is kept for, or Global (id "*")',
  }),
  name: Schema.String.annotate({ description: "The Secret's name" }),
  deleted: Schema.Boolean.annotate({
    description:
      "The Secret no longer exists: deleted by this call, or already gone when the owner approved; false only when the owner declined",
  }),
  approval: ApprovalOutcome,
});
