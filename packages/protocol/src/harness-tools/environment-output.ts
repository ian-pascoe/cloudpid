// What `environment_list` and `environment_get` give programs, as schemas (`docs/architecture/mcp-endpoint.md` →
// Environment and Settings tools → Shared definitions; `docs/architecture/agent-capabilities.md` → Values for programs):
// the in-session tools' output schemas, which `packages/extensions` builds each value for, kept here so one declaration
// serves both surfaces. Keys are snake_case and "none" is null.
// @effect-diagnostics missingPipeableSignature:off
import { InstanceType } from "@cloudpid/config";
import * as Schema from "effect/Schema";
import { ScopeRef } from "./scope.ts";

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

export const Source = Schema.Literals(["own", "inherited", "global"]).annotate({
  description:
    "own: the Environment's own value (overridden here); inherited: Global's, which the Environment does not override; global: kept at Global (for id *)",
});

/** Where each setting's (or variable's) value comes from, whatever the value. */
export const placement = {
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
