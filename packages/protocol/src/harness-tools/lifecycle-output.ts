// What the tools for an Environment's record, its Skills and its resets give programs, on both surfaces
// (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Shared definitions and the core/wrapper split;
// `docs/architecture/agent-capabilities.md` → Values for programs): `environment_create`, `environment_rename`,
// `environment_repo_add`, `environment_repo_remove`, `environment_rebuild`, and `environment_skill_save`, `_remove`,
// `_install` and `_update`. The in-session shapes are the ones the tools have always declared
// (`packages/extensions/src/harness-session.test.ts` pins them): the shape of a change at a Scope
// (`ChangeOutputFields`) with whether anything changed and what the tool adds. The endpoint's are flat objects with
// optional keys (`next`, which `McpServer` fills, and `replayed`), no Approval and nothing that is a Session's own (the
// Workspace a change was handed to, a call that ran again). A Skill tool's change at Global asks the owner (S3b-3), so its
// endpoint output gains the request's optional keys (`status`, `approval_id`, `url`, `expires_at`): a `pending` answer
// carries a change's keys with no change made yet.
// @effect-diagnostics missingPipeableSignature:off
import * as Schema from "effect/Schema";
import { ApprovalRequestFields } from "./approvals.ts";
import { ChangeEndpointOutput, ChangeOutputFields } from "./change-output.ts";
import { RepoOutput, SkillSourceOutput } from "./environment-output.ts";
import { ScopeRef } from "./scope.ts";

const changed = Schema.Boolean.annotate({
  description: "Whether anything changed: false when the call found everything as asked already",
});

const OverriddenIn = {
  overridden_in: Schema.Array(ScopeRef).annotate({
    description:
      "The Environments whose own Skill of the name hides the one kept Global, so the change does not reach them; empty for a change to an Environment's own Skills",
  }),
  overridden_in_truncated: Schema.Boolean.annotate({
    description: "More Environments than fit this value: the first are listed",
  }),
};

const UnchangedTruncated = Schema.Boolean.annotate({
  description: "More fields than fit this value (unchanged lists the first)",
});

// ── An Environment's record ─────────────────────────────────────────────────────────────────────────────────────

const RecordFields = {
  ...ChangeOutputFields,
  changed,
};

/** `environment_rename`, `environment_repo_add` and `environment_repo_remove`: a change to the Environment's record. */
export const RecordChangeOutput = Schema.Struct(RecordFields);

const CreatedFields = {
  repos: Schema.Array(RepoOutput).annotate({ description: "The Repos the new Environment holds" }),
  repos_truncated: Schema.Boolean.annotate({
    description: "More Repos than fit this value: the first are listed",
  }),
};

/** `environment_create`: the Environment made, with its Repos. */
export const EnvironmentCreateOutput = Schema.Struct({
  ...RecordFields,
  ...CreatedFields,
});

const NewBuild = Schema.Boolean.annotate({
  description:
    "A new Build was asked for now; false when one was under way already for the same Repos and settings, and for a Test Build",
});

/** `environment_rebuild`: a Build asked for, or a Test Build of proposed changes. */
export const RebuildOutput = Schema.Struct({
  ...RecordFields,
  new_build: NewBuild,
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

/** A change to an Environment's record, on the endpoint: the Scope, the changes made, and the fields left alone. */
export const RecordChangeEndpointOutput = Schema.Struct({
  ...ChangeEndpointOutput.fields,
  changed,
});

/** `environment_create` on the endpoint: the Environment made (its id is the Scope's), with its Repos. */
export const EnvironmentCreateEndpointOutput = Schema.Struct({
  ...RecordChangeEndpointOutput.fields,
  ...CreatedFields,
});

/** `environment_rebuild` on the endpoint: a Build asked for, or found under way for the same Repos and settings. */
export const RebuildEndpointOutput = Schema.Struct({
  ...RecordChangeEndpointOutput.fields,
  new_build: NewBuild,
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

/** `environment_skill_install`. */
export const SkillInstallOutput = Schema.Struct({
  ...ChangeOutputFields,
  unchanged_truncated: UnchangedTruncated,
  changed,
  source: Schema.NullOr(
    Schema.Struct({
      repo: Schema.String.annotate({ description: "owner/name of the GitHub repo" }),
      ref: Schema.NullOr(Schema.String).annotate({
        description: "The ref named; null when the repo's default branch was used",
      }),
      commit: Schema.String.annotate({
        description: "The commit the Skills were read at, in full",
      }),
    }),
  ).annotate({
    description: "What was read: the repo, the ref and the commit; null when nothing was read",
  }),
  installed: Schema.Array(
    Schema.Struct({
      name: Schema.String.annotate({ description: "The Skill's name" }),
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
      name: Schema.String.annotate({ description: "The Skill's name" }),
      path: Schema.String.annotate({ description: "The Skill's folder in the repo" }),
      message: Schema.String.annotate({ description: "Why it was refused, each problem a line" }),
    }),
  ).annotate({ description: "The Skills the checks refused; the others were still installed" }),
  refused_truncated: Schema.Boolean.annotate({
    description: "More Skills than fit this value: the first are listed",
  }),
  listed: Schema.Array(
    Schema.Struct({
      name: Schema.String.annotate({ description: "The Skill's name" }),
      description: Schema.String.annotate({
        description: "What the Skill does and when to use it",
      }),
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
  unchanged_truncated: UnchangedTruncated,
  changed,
  updated: Schema.Array(
    Schema.Struct({
      name: Schema.String.annotate({ description: "The Skill's name" }),
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
      name: Schema.String.annotate({ description: "The Skill's name" }),
      outcome: Schema.Literals(["modified", "rejected", "changed-since"]).annotate({
        description:
          "modified: edited since installed, and overwrite was not set; rejected: not updated (no source, no answer, or a failed check); changed-since: saved again since the owner was asked",
      }),
      message: Schema.String.annotate({ description: "Why it was not updated" }),
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

/**
 * The keys of a Skill tool's endpoint answer to a change at Global, which asks the owner: `status` and the request's (all
 * absent from a change made at once, at an Environment).
 */
const SkillAskFields = {
  status: Schema.optionalKey(
    Schema.String.annotate({
      description:
        '"pending": a change to the Skills kept Global, so the owner was asked (approval_wait follows the request) and nothing is changed yet; "unchanged": Global keeps it so already, so nothing was asked; absent for a change made at once, at an Environment',
    }),
  ),
  ...ApprovalRequestFields,
};

/** The fields of a Skill tool's endpoint answer that every one has: the Scope, the changes and what was left alone. */
const SkillEndpointFields = {
  ...ChangeEndpointOutput.fields,
  unchanged_truncated: UnchangedTruncated,
  changed,
  ...SkillAskFields,
};

/** `environment_skill_install` on the endpoint: for an Environment's own Skills, what was installed, refused or listed. */
export const SkillInstallEndpointOutput = Schema.Struct({
  ...SkillEndpointFields,
  source: SkillInstallOutput.fields.source,
  installed: SkillInstallOutput.fields.installed,
  installed_truncated: SkillInstallOutput.fields.installed_truncated,
  refused: SkillInstallOutput.fields.refused,
  refused_truncated: SkillInstallOutput.fields.refused_truncated,
  listed: SkillInstallOutput.fields.listed,
  listed_truncated: SkillInstallOutput.fields.listed_truncated,
});

/** `environment_skill_update` on the endpoint: for an Environment's own Skills, what moved and what was refused. */
export const SkillUpdateEndpointOutput = Schema.Struct({
  ...SkillEndpointFields,
  updated: SkillUpdateOutput.fields.updated,
  updated_truncated: SkillUpdateOutput.fields.updated_truncated,
  refused: SkillUpdateOutput.fields.refused,
  refused_truncated: SkillUpdateOutput.fields.refused_truncated,
  nothing_marked: SkillUpdateOutput.fields.nothing_marked,
});

/** `environment_skill_remove` on the endpoint. */
export const SkillRemoveEndpointOutput = Schema.Struct({
  ...ChangeEndpointOutput.fields,
  changed,
  ...SkillAskFields,
  skill: SkillChangeFields.skill,
  global_served: SkillRemoveOutput.fields.global_served,
});
