// What the `environment` extension's tools return to programs (`docs/architecture/agent-capabilities.md` → Values for
// programs): the shapes of `environment_list` and `environment_get`, and the value of a Container setting change, built
// from the same data the model-facing text is made of (`./environment.ts`). The shapes the Environment tools share
// (a Build, a Repo, a kept Secret, a Skill) live here, and so does the value of a change made at an Environment or at
// Global (`changeOutput`, `unchangedOutput`, `declinedOutput`), which the other Environment tools may build with. Texts
// that can grow (scripts, a failed Build's reason) and lists that can grow are cut to what one nested call's result
// holds, each with a `<field>_truncated` flag (`./outputs.ts`).
// @effect-diagnostics missingPipeableSignature:off
import { type ContainerSettings, InstanceType } from "@cloudpid/config";
import type { BuildView, EnvironmentRepo, EnvironmentSkill } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type {
  AppliedChange,
  ChangedEnvironment,
  EnvironmentDetails,
  EnvironmentListing,
  GlobalDetails,
  KeptSecretListing,
} from "./environment.ts";
import {
  changesOutput,
  ApprovalOutcome,
  boundItems,
  boundText,
  EnvironmentChangeOutput,
  ScopeRef,
} from "./outputs.ts";
import { secretEnvName } from "./secrets/references.ts";

/** The last characters of a failed Build's reason that a result shows. */
export const FAILED_REASON_TAIL = 1_000;

/** The most a script, the Toolchains or a note weighs stored in a value of `environment_get`. */
export const MAX_TEXT_BYTES = 64 * 1024;

/** The most one list of `environment_get` weighs stored: variables, Secrets, Skills, paths. */
export const MAX_ENTRIES_BYTES = 128 * 1024;

/** `environment` as a Scope reference: its id and name. */
export const scopeOf = ({ id, name }: ChangedEnvironment): typeof ScopeRef.Type => ({ id, name });

// ─── Repos and Builds ────────────────────────────────────────────────────────

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
      id: Schema.String,
      name: Schema.String,
      current: Schema.Boolean.annotate({ description: "This Session's own Environment" }),
      repos: Schema.Array(RepoOutput),
      build: BuildOutput,
    }),
  ),
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

const OverriddenIn = Schema.Array(ScopeRef).annotate({
  description:
    "For Global's settings, the Environments that override it, so a change there does not reach them",
});

/** Where each setting's value comes from, whatever the value. */
const placement = { source: Source, overridden_in: OverriddenIn };

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

export const VariableOutput = Schema.Struct({
  name: Schema.String,
  value: Schema.String.annotate({ description: "The value, plain" }),
  ...placement,
});

/** A Secret kept, by name only: never its value. */
export const SecretOutput = Schema.Struct({
  name: Schema.String,
  scope: Schema.Literals(["environment", "every"]).annotate({
    description: "environment: kept for this Environment; every: kept Global",
  }),
  build: Schema.Boolean.annotate({ description: "It reaches the Setup Scripts and the Build" }),
  env_var: Schema.String.annotate({ description: "The variable commands get it as" }),
});

const SkillSourceOutput = Schema.Struct({
  repo: Schema.String,
  path: Schema.String,
  ref: Schema.NullOr(Schema.String),
  commit: Schema.String,
});

/** A Skill kept, by its name and description. Times are epoch milliseconds. */
export const SkillOutput = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
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
  installed_from:
    skill.source === undefined
      ? null
      : {
          repo: skill.source.repo,
          path: skill.source.path,
          ref: skill.source.ref,
          commit: skill.source.commit,
        },
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
  scope: ScopeRef,
  current: Schema.Boolean.annotate({
    description: "This Session's own Environment; false for Global",
  }),
  repos: Schema.Array(RepoOutput).annotate({ description: "Its Repos; none for Global" }),
  build: Schema.NullOr(BuildOutput).annotate({
    description: "How its Build stands; null for Global",
  }),
  settings: SettingsOutput,
  variables: Schema.Array(VariableOutput).annotate({
    description:
      "The variables that apply: the Environment's own, then Global's that its own do not override; for Global, its variables",
  }),
  variables_truncated: Schema.Boolean.annotate({
    description: "The variables are cut to what fits",
  }),
  overridden_global_variables: Schema.Array(Schema.String).annotate({
    description: "The names of Global's variables the Environment's own override",
  }),
  secrets: Schema.Array(SecretOutput).annotate({
    description: "The Secrets kept for the Environment and Global, by name only",
  }),
  secrets_truncated: Schema.Boolean.annotate({ description: "The Secrets are cut to what fits" }),
  skills: Schema.Array(SkillOutput).annotate({
    description:
      "The Environment's own Skills, then those kept Global that its own do not hide; for Global, its Skills",
  }),
  skills_truncated: Schema.Boolean.annotate({ description: "The Skills are cut to what fits" }),
  overridden_global_skills: Schema.Array(Schema.String).annotate({
    description: "The names of Global's Skills the Environment's own hide",
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
  readonly overridden_in: (typeof ScopeRef.Type)[];
};

/** `settings` as a value gives them, each placed by `place`. */
const settingsOutput = (
  settings: ContainerSettings,
  place: (field: SettingName) => Placement,
): SettingsValue => {
  const ignore = boundItems(settings.ignore, MAX_ENTRIES_BYTES);
  const setup = boundText(settings.setupScript, MAX_TEXT_BYTES);
  const start = boundText(settings.startScript, MAX_TEXT_BYTES);
  const toolchains = boundText(settings.toolchains, MAX_TEXT_BYTES);

  return {
    instance: { value: settings.instance, ...place("instance") },
    max_instance: { value: settings.maxInstance, ...place("maxInstance") },
    idle_minutes: { value: settings.idleMinutes, ...place("idleMinutes") },
    ignore: { value: ignore.items, value_truncated: ignore.truncated, ...place("ignore") },
    setup_script: { value: setup.text, value_truncated: setup.truncated, ...place("setupScript") },
    start_script: { value: start.text, value_truncated: start.truncated, ...place("startScript") },
    toolchains: {
      value: toolchains.text,
      value_truncated: toolchains.truncated,
      ...place("toolchains"),
    },
    spare_workspace: { value: settings.spareWorkspace, ...place("spareWorkspace") },
  };
};

/** What the lists of a value hold when the Environment is Global's, which has no Build, Repos or overridden fields. */
const bounded = <A extends Schema.Json>(items: ReadonlyArray<A>) =>
  boundItems(items, MAX_ENTRIES_BYTES);

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

  const variables = bounded([
    ...Arr.map(Record.toEntries(own), ([name, value]) => ({
      name,
      value,
      source: "own" as const,
      overridden_in: [],
    })),
    ...Arr.map(Record.toEntries(inherited), ([name, value]) => ({
      name,
      value,
      source: "inherited" as const,
      overridden_in: [],
    })),
  ]);

  const ownSkills = new Set(Arr.map(details.skills, (skill) => skill.name));
  const hidden = Arr.filter(details.globalSkills, (skill) => ownSkills.has(skill.name));

  const skills = bounded([
    ...Arr.map(details.skills, (skill) => skillOutput(skill, "own")),
    ...Arr.map(
      Arr.filter(details.globalSkills, (skill) => !ownSkills.has(skill.name)),
      (skill) => skillOutput(skill, "inherited"),
    ),
  ]);

  const secrets = bounded(Arr.map(details.secrets, secretOutput));
  const hiddenVariables = bounded(overridden);
  const hiddenSkills = bounded(Arr.map(hidden, (skill) => skill.name));
  const problem = boundText(details.problem ?? "", MAX_TEXT_BYTES);

  const place = (field: SettingName): Placement => ({
    source: overrides[field] === undefined ? "inherited" : "own",
    overridden_in: [],
  });

  return {
    scope: scopeOf(details),
    current,
    repos: Arr.map(details.repos, repoOutput),
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

  const overriding = (path: string) => Arr.map(overriddenIn[path] ?? [], scopeOf);

  const variables = bounded(
    Arr.map(Record.toEntries(settings.variables), ([name, value]) => ({
      name,
      value,
      source: "global" as const,
      overridden_in: overriding(`variables.${name}`),
    })),
  );

  const secrets = bounded(Arr.map(details.secrets, secretOutput));
  const skills = bounded(Arr.map(details.skills, (skill) => skillOutput(skill, "global")));

  return {
    scope,
    current: false,
    repos: [],
    build: null,
    settings: settingsOutput(settings, (field) => ({
      source: "global",
      overridden_in: overriding(field),
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

// ─── The setters ─────────────────────────────────────────────────────────────

type Approval = typeof ApprovalOutcome.Type;

type EnvironmentChange = typeof EnvironmentChangeOutput.Type;

/**
 * An Agent change that was made, as a value gives it: the Agent change, whether it reaches this Session's own Workspace
 * (`own`: the Session's Environment is the one changed; a change at Global says so itself), whether a new Build was
 * asked for, and for a change at Global, whom it did not reach and where Builds were asked for. `approval`: the owner's
 * answer, for a change that waited for it.
 */
export const changeOutput = (
  applied: Extract<AppliedChange, { readonly status: "changed" }>,
  own: boolean,
  approval: Approval = null,
): EnvironmentChange => ({
  scope: scopeOf(applied.environment),
  ...changesOutput([applied.change]),
  unchanged: [],
  approval,
  own: applied.global?.own ?? own,
  new_build: applied.newBuild,
  global:
    applied.global === undefined
      ? null
      : {
          overridden_in: Arr.map(applied.global.overriddenIn, scopeOf),
          new_builds: Arr.map(applied.global.newBuilds, scopeOf),
        },
});

/** A setting that already had the value: nothing changed, so it reached no one and asked for no Build. */
export const unchangedOutput = (
  environment: ChangedEnvironment,
  field: string,
  approval: Approval = null,
): EnvironmentChange => ({
  scope: scopeOf(environment),
  changes: [],
  changes_truncated: false,
  unchanged: [field],
  approval,
  own: false,
  new_build: false,
  global: null,
});

/** A change the owner declined: nothing changed, and `reason` is theirs, null when they gave none. */
export const declinedOutput = (
  environment: ChangedEnvironment,
  reason: string | null,
): EnvironmentChange => ({
  scope: scopeOf(environment),
  changes: [],
  changes_truncated: false,
  unchanged: [],
  approval: { approved: false, reason },
  own: false,
  new_build: false,
  global: null,
});
