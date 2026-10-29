// What the tools for an Environment's record and Skills give programs (`docs/architecture/agent-capabilities.md` → Values
// for programs): `environment_create`, `environment_rename`, `environment_repo_add`, `environment_repo_remove` and
// `environment_rebuild` (`./environment-lifecycle.ts`), and `environment_skill_save`, `environment_skill_remove`,
// `environment_skill_install` and `environment_skill_update` (`./environment-skills.ts`). Each gives the outcome a script
// branches on, in the shape of a change at a Scope (`ChangeOutputFields`: the Scope, the Agent changes made, the fields
// that already had their value, the owner's Approval) with whether anything changed and what the tool adds. A Skill
// change kept Global waits for the owner's Approval, so its value says which way it went, with the reason of a decline.
// The lists that can grow (a repo's Skills, the Environments an own Skill hides one from) are cut as `boundItems` cuts
// them, with a `<field>_truncated` flag. This module imports no tool, so both tool files and their result builders can
// share it.
// @effect-diagnostics missingPipeableSignature:off
import {
  type AgentChange,
  type EnvironmentRepo,
  type InstalledSkill,
  type ListedSkill,
  type SkillSource,
  type SkillUpdateEntry,
  skillField,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import {
  changesOutput,
  type ApprovalOutcome,
  asOutput,
  boundItems,
  ChangeOutputFields,
  type ScopeRef,
  ScopeRef as ScopeRefSchema,
} from "./outputs.ts";

/** An Environment, or Global, as the tool's result names it. */
type Scope = { readonly id: string; readonly name: string };

const scopeRef = ({ id, name }: Scope): typeof ScopeRef.Type => ({ id, name });

const changed = Schema.Boolean.annotate({
  description: "Whether anything changed: false when the call found everything as asked already",
});

/**
 * The owner's answer as a value gives it: approved, or declined with their reason (null when they gave none); null for a
 * change that waits for no Approval.
 */
export const approvalOutput = (
  answer:
    | { readonly approved: true }
    | { readonly approved: false; readonly reason?: string | undefined }
    | null,
): typeof ApprovalOutcome.Type =>
  answer === null
    ? null
    : answer.approved
      ? { approved: true, reason: null }
      : { approved: false, reason: answer.reason ?? null };

const OverriddenIn = {
  overridden_in: Schema.Array(ScopeRefSchema).annotate({
    description:
      "The Environments whose own Skill of the name hides the one kept Global, so the change does not reach them; empty for a change to an Environment's own Skills",
  }),
  overridden_in_truncated: Schema.Boolean.annotate({
    description: "More Environments than fit this value: the first are listed",
  }),
};

const overriddenInOutput = (environments: ReadonlyArray<Scope>) => {
  const kept = boundItems(Arr.map(environments, scopeRef));

  return { overridden_in: kept.items, overridden_in_truncated: kept.truncated };
};

// ── An Environment's record ─────────────────────────────────────────────────────────────────────────────────────

const RecordFields = {
  ...ChangeOutputFields,
  changed,
  new_build: Schema.Boolean.annotate({
    description:
      "A new Build was asked for: the Registry's upkeep makes one when the Repos changed and the Environment has anything to build, and environment_rebuild asks for one",
  }),
};

/** `environment_rename`, `environment_repo_add` and `environment_repo_remove`: a change to the Environment's record. */
export const RecordChangeOutput = Schema.Struct(RecordFields);

/** `environment_create`: the Environment made, with its Repos. */
export const EnvironmentCreateOutput = Schema.Struct({
  ...RecordFields,
  repos: Schema.Array(
    Schema.Struct({
      name: Schema.String.annotate({
        description: "The directory below /workspace it is cloned into",
      }),
      url: Schema.String.annotate({ description: "The https URL it is cloned from" }),
    }),
  ).annotate({ description: "The Repos the new Environment holds" }),
  repos_truncated: Schema.Boolean.annotate({
    description: "More Repos than fit this value: the first are listed",
  }),
});

/** `environment_rebuild`: a Build asked for, or a Test Build of proposed changes. */
export const RebuildOutput = Schema.Struct({
  ...RecordFields,
  rerun: Schema.Boolean.annotate({
    description:
      "The call was cut off after it began asking for the Build and ran again: it asked for nothing, since the first run may have",
  }),
  test_build: Schema.NullOr(
    Schema.Struct({
      proposed: Schema.Array(Schema.String).annotate({
        description:
          "The fields the Test Build replaced (repos, variables, setup_script, toolchains, ignore); empty for the saved settings",
      }),
      took_ms: Schema.Finite.annotate({
        description: "How long the Test Build took, in milliseconds",
      }),
    }),
  ).annotate({
    description:
      "A Test Build of proposed changes that succeeded (a failed one is an error); null for a Build of the saved settings. It saves and records nothing, so nothing changed",
  }),
});

/**
 * An Agent change to an Environment's record as a value gives it: `change` is the one recorded, or null when the
 * record was as asked already (`unchanged` names the field).
 */
export const recordOutput = ({
  environment,
  change,
  unchanged,
  newBuild,
}: {
  readonly environment: Scope;
  readonly change: AgentChange | null;
  readonly unchanged: ReadonlyArray<string>;
  readonly newBuild: boolean;
}): typeof RecordChangeOutput.Type => ({
  scope: scopeRef(environment),
  ...changesOutput(change === null ? [] : [change]),
  unchanged: change === null ? [...unchanged] : [],
  approval: null,
  changed: change !== null,
  new_build: change !== null && newBuild,
});

/** The value of `environment_create`. */
export const createdOutput = ({
  environment,
  repos,
  change,
  newBuild,
}: {
  readonly environment: Scope;
  readonly repos: ReadonlyArray<EnvironmentRepo>;
  readonly change: AgentChange;
  readonly newBuild: boolean;
}) => {
  const kept = boundItems(Arr.map(repos, ({ name, url }) => ({ name, url })));

  return asOutput(EnvironmentCreateOutput, {
    ...recordOutput({ environment, change, unchanged: [], newBuild }),
    repos: kept.items,
    repos_truncated: kept.truncated,
  });
};

/** The value of `environment_rebuild`, for a Build asked for or found under way (`change` null), or one that was not. */
export const rebuildOutput = ({
  environment,
  change,
  unchanged,
  rerun = false,
  testBuild = null,
}: {
  readonly environment: Scope;
  readonly change: AgentChange | null;
  readonly unchanged: ReadonlyArray<string>;
  readonly rerun?: boolean;
  readonly testBuild?: { readonly proposed: ReadonlyArray<string>; readonly tookMs: number } | null;
}) =>
  asOutput(RebuildOutput, {
    ...recordOutput({ environment, change, unchanged, newBuild: true }),
    rerun,
    test_build:
      testBuild === null ? null : { proposed: [...testBuild.proposed], took_ms: testBuild.tookMs },
  });

// ── Skills ──────────────────────────────────────────────────────────────────────────────────────────────────────

const SkillChangeFields = {
  ...ChangeOutputFields,
  changed,
  skill: Schema.String.annotate({ description: "The Skill's name" }),
  handed: Schema.Boolean.annotate({
    description:
      "This Session's Workspace serves the change now (false when nothing changed); the other Workspaces get it at their next readying",
  }),
  ...OverriddenIn,
};

/** `environment_skill_save`. */
export const SkillSaveOutput = Schema.Struct({
  ...SkillChangeFields,
  served_at: Schema.NullOr(Schema.String).annotate({
    description:
      "Where each Workspace serves the Skill (read-only); null when a Skill at Global was declined",
  }),
  hides_global: Schema.Boolean.annotate({
    description:
      "For an Environment's own Skill: it hides the Skill of the name kept Global, in this Environment",
  }),
});

/** `environment_skill_remove`. */
export const SkillRemoveOutput = Schema.Struct({
  ...SkillChangeFields,
  global_served: Schema.Boolean.annotate({
    description:
      "For an Environment's own Skill: the Skill of the name kept Global is served in its place",
  }),
});

/** A Skill's source, as the install and update tools keep it. */
const SkillSourceOutput = Schema.Struct({
  repo: Schema.String.annotate({ description: "owner/name of the GitHub repo" }),
  path: Schema.String.annotate({
    description: "The Skill's folder in the repo; empty for the root",
  }),
  ref: Schema.NullOr(Schema.String).annotate({
    description: "The ref named; null when the repo's default branch was used",
  }),
  commit: Schema.String.annotate({ description: "The commit it resolved to, in full" }),
});

const skillSourceOutput = ({ repo, path, ref, commit }: SkillSource) => ({
  repo,
  path,
  ref,
  commit,
});

/** `environment_skill_install`. */
export const SkillInstallOutput = Schema.Struct({
  ...ChangeOutputFields,
  changed,
  source: Schema.NullOr(
    Schema.Struct({
      repo: Schema.String,
      ref: Schema.NullOr(Schema.String),
      commit: Schema.String.annotate({
        description: "The commit the Skills were read at, in full",
      }),
    }),
  ).annotate({
    description: "What was read: the repo, the ref and the commit; null when nothing was read",
  }),
  installed: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String.annotate({ description: "The Skill's folder in the repo" }),
    }),
  ).annotate({
    description:
      "The Skills installed now; empty when none was (the unchanged ones are in unchanged)",
  }),
  installed_truncated: Schema.Boolean.annotate({
    description: "More Skills than fit this value: the first are listed",
  }),
  refused: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String,
      message: Schema.String.annotate({ description: "Why it was refused, each problem a line" }),
    }),
  ).annotate({ description: "The Skills the checks refused; the others were still installed" }),
  refused_truncated: Schema.Boolean.annotate({
    description: "More Skills than fit this value: the first are listed",
  }),
  listed: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      path: Schema.String.annotate({ description: "The Skill's folder in the repo" }),
    }),
  ).annotate({
    description:
      "When the repo holds several Skills and none was named: nothing is installed and they are listed; else empty",
  }),
  listed_truncated: Schema.Boolean.annotate({
    description: "More Skills than fit this value: the first are listed",
  }),
  handed: Schema.Boolean.annotate({
    description:
      "This Session's Workspace serves the Skills installed now (false when none was); the other Workspaces get them at their next readying",
  }),
  ...OverriddenIn,
});

/** `environment_skill_update`. */
export const SkillUpdateOutput = Schema.Struct({
  ...ChangeOutputFields,
  changed,
  updated: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      from: SkillSourceOutput.annotate({ description: "Where it came from before" }),
      to: SkillSourceOutput.annotate({ description: "Where it comes from now" }),
      overwrote: Schema.Boolean.annotate({ description: "The edits made to it were replaced" }),
    }),
  ).annotate({ description: "The Skills moved to the ref's latest commit" }),
  updated_truncated: Schema.Boolean.annotate({
    description: "More Skills than fit this value: the first are listed",
  }),
  refused: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      outcome: Schema.Literals(["modified", "rejected", "changed-since"]).annotate({
        description:
          "modified: edited since installed, and overwrite was not set; rejected: not updated (no source, no answer, or a failed check); changed-since: saved again since the owner was asked",
      }),
      message: Schema.String,
    }),
  ).annotate({ description: "The Skills not updated; the others were" }),
  refused_truncated: Schema.Boolean.annotate({
    description: "More Skills than fit this value: the first are listed",
  }),
  nothing_marked: Schema.Boolean.annotate({
    description: "No Skill was named and none is marked update available, so nothing was read",
  }),
  handed: Schema.Boolean.annotate({
    description:
      "This Session's Workspace serves the Skills updated now (false when none was); the other Workspaces get them at their next readying",
  }),
});

/** A Skill change that made or found nothing, or that was declined: the shared part of a save's and a removal's value. */
const skillChange = ({
  scope,
  skill,
  change,
  unchanged,
  approval,
  handed,
  overriddenIn,
}: {
  readonly scope: Scope;
  readonly skill: string;
  /** The Agent change recorded; null when nothing was. */
  readonly change: AgentChange | null;
  /** Whether the scope kept the Skill as asked already, which names its field. */
  readonly unchanged: boolean;
  readonly approval: typeof ApprovalOutcome.Type;
  readonly handed: boolean;
  readonly overriddenIn: ReadonlyArray<Scope>;
}) => ({
  scope: scopeRef(scope),
  ...changesOutput(change === null ? [] : [change]),
  unchanged: unchanged ? [skillField(skill)] : [],
  approval,
  changed: change !== null,
  skill,
  handed: change !== null && handed,
  ...overriddenInOutput(change === null ? [] : overriddenIn),
});

/** The value of `environment_skill_save`; `change` null for a Skill kept already, or one that was declined. */
export const skillSavedOutput = (
  input: Parameters<typeof skillChange>[0] & {
    readonly servedAt: string | null;
    readonly hidesGlobal: boolean;
  },
) =>
  asOutput(SkillSaveOutput, {
    ...skillChange(input),
    served_at: input.servedAt,
    hides_global: input.hidesGlobal,
  });

/** The value of `environment_skill_remove`; `change` null for a Skill that was gone already, or one that was declined. */
export const skillRemovedOutput = (
  input: Parameters<typeof skillChange>[0] & { readonly globalServed: boolean },
) => asOutput(SkillRemoveOutput, { ...skillChange(input), global_served: input.globalServed });

/** The value of `environment_skill_install`: what the Registry answered for each Skill, or the Skills it listed. */
export const skillInstalledOutput = ({
  scope,
  source,
  results,
  listed,
  approval,
  handed,
}: {
  readonly scope: Scope;
  readonly source: {
    readonly repo: string;
    readonly ref: string | null;
    readonly commit: string;
  } | null;
  readonly results: ReadonlyArray<InstalledSkill>;
  readonly listed: ReadonlyArray<ListedSkill>;
  readonly approval: typeof ApprovalOutcome.Type;
  readonly handed: boolean;
}) => {
  const saved = Arr.filter(results, (result) => result.outcome === "installed");

  const changes = Arr.flatMap(saved, (result) =>
    result.change === undefined ? [] : [result.change],
  );

  const installed = boundItems(Arr.map(saved, ({ name, path }) => ({ name, path })));

  const refused = boundItems(
    Arr.flatMap(results, ({ name, path, outcome, message }) =>
      outcome === "rejected" ? [{ name, path, message: message ?? "refused" }] : [],
    ),
  );

  const shown = boundItems(
    Arr.map(listed, ({ name, description, path }) => ({ name, description, path })),
  );

  // Each Environment once, whichever Skill its own hides.
  const hiding: Scope[] = [];

  for (const environment of Arr.flatMap(saved, (result) => result.overriddenIn ?? [])) {
    if (!Arr.some(hiding, ({ id }) => id === environment.id)) hiding.push(environment);
  }

  return asOutput(SkillInstallOutput, {
    scope: scopeRef(scope),
    ...changesOutput(changes),
    unchanged: Arr.map(
      Arr.filter(results, (result) => result.outcome === "unchanged"),
      ({ name }) => skillField(name),
    ),
    approval,
    changed: saved.length > 0,
    source: source === null ? null : { repo: source.repo, ref: source.ref, commit: source.commit },
    installed: installed.items,
    installed_truncated: installed.truncated,
    refused: refused.items,
    refused_truncated: refused.truncated,
    listed: shown.items,
    listed_truncated: shown.truncated,
    handed: saved.length > 0 && handed,
    ...overriddenInOutput(hiding),
  });
};

/** The value of `environment_skill_update`. */
export const skillUpdatedOutput = ({
  scope,
  results,
  approval,
  handed,
  nothingMarked = false,
}: {
  readonly scope: Scope;
  readonly results: ReadonlyArray<SkillUpdateEntry>;
  readonly approval: typeof ApprovalOutcome.Type;
  readonly handed: boolean;
  /** No Skill was named and none is marked update available: nothing was read. */
  readonly nothingMarked?: boolean;
}) => {
  const moved = Arr.flatMap(results, (result) => (result.outcome === "updated" ? [result] : []));

  const changes = Arr.flatMap(moved, (result) =>
    result.change === undefined ? [] : [result.change],
  );

  const updated = boundItems(
    Arr.map(moved, ({ name, from, to, overwrote }) => ({
      name,
      from: skillSourceOutput(from),
      to: skillSourceOutput(to),
      overwrote,
    })),
  );

  const refused = boundItems(
    Arr.flatMap(results, (result) =>
      result.outcome === "modified" ||
      result.outcome === "rejected" ||
      result.outcome === "changed-since"
        ? [{ name: result.name, outcome: result.outcome, message: result.message }]
        : [],
    ),
  );

  return asOutput(SkillUpdateOutput, {
    scope: scopeRef(scope),
    ...changesOutput(changes),
    unchanged: Arr.flatMap(results, (result) =>
      result.outcome === "unchanged" ? [skillField(result.name)] : [],
    ),
    approval,
    changed: moved.length > 0,
    updated: updated.items,
    updated_truncated: updated.truncated,
    refused: refused.items,
    refused_truncated: refused.truncated,
    nothing_marked: nothingMarked,
    handed: moved.length > 0 && handed,
  });
};
