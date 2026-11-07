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
import type { ContainerSettings } from "@cloudpid/config";
import {
  type AgentChange,
  type BuildView,
  type EnvironmentRepo,
  type EnvironmentSkill,
  variableField,
} from "@cloudpid/protocol";
import {
  BuildOutput,
  ENDPOINT_VARIABLE_VALUE_BYTES,
  EnvironmentGetEndpointOutput,
  EnvironmentListEndpointOutput,
  EnvironmentGetOutput,
  EnvironmentListOutput,
  RepoOutput,
  SecretOutput,
  SettingsOutput,
  SkillOutput,
  SkillSourceOutput,
  VariableOutput,
} from "@cloudpid/protocol/harness-tools";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type {
  ChangedSetting,
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
import { cutStored } from "./stored-bytes.ts";

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

/** What each part of `environment_get`'s value weighs at most, stored. */
export type GetBounds = {
  readonly script: number;
  readonly small: number;
  readonly repos: number;
  readonly variables: number;
  readonly skills: number;
  readonly secrets: number;
  readonly overriding: number;
  readonly names: number;
  readonly problem: number;
};

/** The in-session bounds: the worst case is 800 KiB. */
export const SESSION_GET_BOUNDS: GetBounds = {
  script: MAX_SCRIPT_BYTES,
  small: MAX_SMALL_TEXT_BYTES,
  repos: MAX_REPOS_BYTES,
  variables: MAX_VARIABLES_BYTES,
  skills: MAX_SKILLS_BYTES,
  secrets: MAX_SECRETS_BYTES,
  overriding: MAX_OVERRIDING_BYTES,
  names: MAX_NAMES_BYTES,
  problem: MAX_PROBLEM_BYTES,
};

/**
 * The endpoint's bounds, which keep the value near 50 KiB in its worst case, far under the 800 KiB of a Session's: the
 * scripts 2 x 3, the Toolchains and the paths 2 x 2, the Repos 2, the variables 20 (50 of them, each value cut near
 * 160 bytes), the Skills 5, the Secrets 3, each of Global's eight settings' overriding Environments 8 x 0.5, the names
 * Global's variables and Skills that an Environment hides 2 x 1, the problem 1, and the Build's reason (1,000
 * characters, 6 KiB at most) with the small rest. A text cut here is read whole with `field`.
 */
export const ENDPOINT_GET_BOUNDS: GetBounds = {
  script: 3 * 1024,
  small: 2 * 1024,
  repos: 2 * 1024,
  variables: 20 * 1024,
  skills: 5 * 1024,
  secrets: 3 * 1024,
  overriding: 512,
  names: 1024,
  problem: 1024,
};

// ─── Repos and Builds ────────────────────────────────────────────────────────

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

/** A Container setting an Environment may override: all but the variables, which are placed one by one. */
type SettingName = Exclude<keyof ContainerSettings, "variables">;

type SettingsValue = typeof SettingsOutput.Type;

type Placement = {
  readonly source: (typeof VariableOutput.Type)["source"];
  readonly overriding: ReadonlyArray<typeof ScopeRef.Type>;
};

/** `place` as a value gives it: the Environments that override are cut to `bounds.overriding`. */
const placed = ({ source, overriding }: Placement, maxBytes: number) => ({
  source,
  ...overriddenInOutput(overriding, maxBytes),
});

/** `settings` as a value gives them, each placed by `place`. */
const settingsOutput = (
  settings: ContainerSettings,
  place: (field: SettingName) => Placement,
  bounds: GetBounds,
): SettingsValue => {
  const ignore = boundItems(settings.ignore, bounds.small);
  const setup = boundText(settings.setupScript, bounds.script);
  const start = boundText(settings.startScript, bounds.script);
  const toolchains = boundText(settings.toolchains, bounds.small);

  return {
    instance: { value: settings.instance, ...placed(place("instance"), bounds.overriding) },
    max_instance: {
      value: settings.maxInstance,
      ...placed(place("maxInstance"), bounds.overriding),
    },
    idle_minutes: {
      value: settings.idleMinutes,
      ...placed(place("idleMinutes"), bounds.overriding),
    },
    ignore: {
      value: ignore.items,
      value_truncated: ignore.truncated,
      ...placed(place("ignore"), bounds.overriding),
    },
    setup_script: {
      value: setup.text,
      value_truncated: setup.truncated,
      ...placed(place("setupScript"), bounds.overriding),
    },
    start_script: {
      value: start.text,
      value_truncated: start.truncated,
      ...placed(place("startScript"), bounds.overriding),
    },
    toolchains: {
      value: toolchains.text,
      value_truncated: toolchains.truncated,
      ...placed(place("toolchains"), bounds.overriding),
    },
    spare_workspace: {
      value: settings.spareWorkspace,
      ...placed(place("spareWorkspace"), bounds.overriding),
    },
  };
};

/** Variable `name` as a value gives it, placed by `place`. */
const variableOutput = (
  name: string,
  value: string,
  place: Placement,
  bounds: GetBounds,
): typeof VariableOutput.Type => ({ name, value, ...placed(place, bounds.overriding) });

/**
 * What `environment_get` gives programs for Environment `details`: the settings in force with where each comes from, its
 * own variables and Global's that they do not override, the Secrets, its own Skills and Global's they do not hide, and
 * its Build. `current`: whether it is this Session's own Environment.
 */
export const environmentGetOutput = (
  details: EnvironmentDetails,
  current: boolean,
  bounds: GetBounds = SESSION_GET_BOUNDS,
): typeof EnvironmentGetOutput.Type => {
  const { settings, overrides, global } = details;
  const own = overrides.variables ?? {};
  const inherited = Record.filter(global.variables, (_, name) => !Record.has(own, name));
  const overridden = Arr.filter(Record.keys(global.variables), (name) => Record.has(own, name));

  const variables = boundItems(
    [
      ...Arr.map(Record.toEntries(own), ([name, value]) =>
        variableOutput(name, value, { source: "own", overriding: [] }, bounds),
      ),
      ...Arr.map(Record.toEntries(inherited), ([name, value]) =>
        variableOutput(name, value, { source: "inherited", overriding: [] }, bounds),
      ),
    ],
    bounds.variables,
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
    bounds.skills,
  );

  const repos = boundItems(Arr.map(details.repos, repoOutput), bounds.repos);
  const secrets = boundItems(Arr.map(details.secrets, secretOutput), bounds.secrets);
  const hiddenVariables = boundItems(overridden, bounds.names);

  const hiddenSkills = boundItems(
    Arr.map(hidden, (skill) => skill.name),
    bounds.names,
  );

  const problem = boundText(details.problem ?? "", bounds.problem);

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
    settings: settingsOutput(settings, place, bounds),
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
  bounds: GetBounds = SESSION_GET_BOUNDS,
): typeof EnvironmentGetOutput.Type => {
  const { settings, overriddenIn } = details;

  const overriding = (path: string) => Arr.map(overriddenIn[path] ?? [], scopeRef);

  const variables = boundItems(
    Arr.map(Record.toEntries(settings.variables), ([name, value]) =>
      variableOutput(
        name,
        value,
        {
          source: "global",
          overriding: overriding(variableField(name)),
        },
        bounds,
      ),
    ),
    bounds.variables,
  );

  const secrets = boundItems(Arr.map(details.secrets, secretOutput), bounds.secrets);

  const skills = boundItems(
    Arr.map(details.skills, (skill) => skillOutput(skill, "global")),
    bounds.skills,
  );

  return {
    scope,
    current: false,
    repos: [],
    repos_truncated: false,
    build: null,
    settings: settingsOutput(
      settings,
      (field) => ({
        source: "global",
        overriding: overriding(field),
      }),
      bounds,
    ),
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

// ─── On the endpoint ─────────────────────────────────────────────────────────

/** The most the Environments of `environment_list` weigh stored on the endpoint. */
const MAX_ENDPOINT_LIST_BYTES = 32 * 1024;

/**
 * What `environment_list` gives the endpoint: `listed` (the first that fit) and Global's variable count, with no
 * Environment marked a Session's own.
 */
export const environmentListEndpointOutput = (
  listed: ReadonlyArray<EnvironmentListing>,
  globalVariables: number,
): typeof EnvironmentListEndpointOutput.Type => {
  const bounded = boundItems(
    Arr.map(listed, (environment) => ({
      id: environment.id,
      name: environment.name,
      repos: Arr.map(environment.repos, repoOutput),
      build: buildOutput(environment.build),
    })),
    MAX_ENDPOINT_LIST_BYTES,
  );

  return {
    environments: bounded.items,
    environments_truncated: bounded.truncated,
    global_variables: globalVariables,
  };
};

/** `variables` with each value cut to `ENDPOINT_VARIABLE_VALUE_BYTES` stored, and the names of those that were cut. */
const cutVariables = (variables: Readonly<Record<string, string>>) => {
  const cut = new Set<string>();

  const values = Record.map(variables, (value, name) => {
    const head = cutStored(value, ENDPOINT_VARIABLE_VALUE_BYTES, "");

    if (head !== value) cut.add(name);

    return head;
  });

  return { values, cut };
};

/** The endpoint's `environment_get` value of a whole Environment (or Global): every key of it present, none of a page's. */
export type EnvironmentGetEndpointWhole = Required<
  Omit<
    typeof EnvironmentGetEndpointOutput.Type,
    "id" | "field" | "text" | "offset" | "total_chars" | "next_offset" | "next"
  >
>;

/** `base`, an Environment's or Global's value in the Session's shape, as the endpoint gives it. */
const endpointGetOutput = (
  base: typeof EnvironmentGetOutput.Type,
  cut: { readonly own: ReadonlySet<string>; readonly inherited: ReadonlySet<string> },
): EnvironmentGetEndpointWhole => {
  const { settings } = base;

  return {
    ...Struct.omit(base, ["current"]),
    variables: Arr.map(base.variables, (variable) => ({
      ...variable,
      // Only the value shown counts: an Environment's short override of a name Global holds long is not cut.
      value_truncated: (variable.source === "own" ? cut.own : cut.inherited).has(variable.name),
    })),
    settings_truncated:
      settings.setup_script.value_truncated ||
      settings.start_script.value_truncated ||
      settings.toolchains.value_truncated ||
      settings.ignore.value_truncated,
  };
};

/**
 * What `environment_get` gives the endpoint for Environment `details`: the Session's value, cut to `ENDPOINT_GET_BOUNDS`,
 * with no mark of a Session's own and each variable's value cut near `ENDPOINT_VARIABLE_VALUE_BYTES` (`value_truncated`).
 */
export const environmentGetEndpointOutput = (
  details: EnvironmentDetails,
): EnvironmentGetEndpointWhole => {
  const own = cutVariables(details.overrides.variables ?? {});
  const inherited = cutVariables(details.global.variables);

  const base = environmentGetOutput(
    {
      ...details,
      overrides: { ...details.overrides, variables: own.values },
      global: { ...details.global, variables: inherited.values },
    },
    false,
    ENDPOINT_GET_BOUNDS,
  );

  return endpointGetOutput(base, { own: own.cut, inherited: inherited.cut });
};

/** What `environment_get` gives the endpoint for what is kept Global (id `*`), cut as `environmentGetEndpointOutput` is. */
export const globalGetEndpointOutput = (
  details: GlobalDetails,
  scope: typeof ScopeRef.Type,
): EnvironmentGetEndpointWhole => {
  const variables = cutVariables(details.settings.variables);

  const base = globalGetOutput(
    { ...details, settings: { ...details.settings, variables: variables.values } },
    scope,
    ENDPOINT_GET_BOUNDS,
  );

  // Every variable at Global has source "global", so neither set is picked by it: both are the same cuts.
  return endpointGetOutput(base, { own: variables.cut, inherited: variables.cut });
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
  applied: ChangedSetting,
  own: boolean,
  approval: Approval = null,
): EnvironmentChange =>
  environmentChangeOutput({
    environment: applied.environment,
    change: applied.change,
    approval,
    own: applied.global?.own ?? own,
    newBuild: applied.newBuild ?? false,
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
  triggers: Schema.Finite.annotate({ description: "Its Triggers" }),
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
