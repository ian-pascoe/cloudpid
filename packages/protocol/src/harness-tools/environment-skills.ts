// The tools that install, update and remove an Environment's Skills, for both surfaces (`docs/architecture/mcp-endpoint.md`
// → Environment and Settings tools → Names and surfaces, The tools): `environment_skill_install`, `_update` and
// `_remove`. The in-session descriptions, parameters and output schemas stay as they were (the snapshot in
// `packages/extensions/src/harness-session.test.ts` pins them). On the endpoint a change to an Environment's own Skills is
// made at once, and one to the Skills kept Global (`*`) asks the owner (S3b-3, `→ Built so far: S3b-3`): the call answers
// `pending`, and the output gains the request's optional keys. Its sentences name the owner and no Session, no Workspace
// "handed" a change, and no tool the endpoint does not serve; its answers say what became of each Skill, since an install
// whose Skills were all refused is not a failure of the call. `environment_skill_save` is a later stage's (S4b).
// @effect-diagnostics missingPipeableSignature:off
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import {
  SkillInstallEndpointOutput,
  SkillInstallOutput,
  SkillRemoveEndpointOutput,
  SkillRemoveOutput,
  SkillUpdateEndpointOutput,
  SkillUpdateOutput,
} from "./lifecycle-output.ts";
import { MAX_CHANGE_REASON, RequestIdField } from "./reason.ts";
import { GLOBAL_ID, idOrGlobal } from "./scope.ts";
import { DESTRUCTIVE, WRITE_OPEN } from "./surface.ts";
import {
  GLOBAL_SKILL_ASK,
  INSTALL_APPROVAL,
  MAX_APPROVED_SKILLS,
  MAX_CARD_CHARS,
  SKILL_APPROVAL,
  SKILL_SIZE_WORDS,
  SKILLS_ROOT,
} from "./skill-words.ts";

/** A Skill tool's `reason`, as a Session's tools say it. */
const SkillReason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CHANGE_REASON),
).annotate({
  description:
    "Why you save, install or remove the Skill, for the user to read in the Environment's Agent changes, such as 'the release steps are the same every time'",
});

const SkillReasonEndpoint = SkillReason.annotate({
  description:
    "Why you install or remove the Skill, for the owner to read in the Environment's Agent changes, such as 'the release steps are the same every time'",
});

const UpdateReason = SkillReason.annotate({
  description:
    "Why you update the Skills, for the user to read in the Environment's Agent changes, such as 'the user asked for the latest grill-me'",
});

const UpdateReasonEndpoint = SkillReason.annotate({
  description:
    "Why you update the Skills, for the owner to read in the Environment's Agent changes, such as 'the owner asked for the latest grill-me'",
});

const Source = Schema.String.check(Schema.isMinLength(1)).annotate({
  description:
    "Where to install from: owner/repo, owner/repo@skill, or a GitHub URL (https://github.com/owner/repo/tree/<ref>/<path>)",
});

const Skills = Schema.optionalKey(
  Schema.Array(Schema.String.check(Schema.isMinLength(1))).annotate({
    description:
      'The names of the Skills to install from the source; ["*"] for all of them. Left out: the repo\'s only Skill, or a list of its Skills when it holds several',
  }),
);

const Names = Schema.optionalKey(
  Schema.Array(Schema.String.check(Schema.isMinLength(1))).annotate({
    description: "The Skills to update, by name. Left out: every Skill marked update available",
  }),
);

const Overwrite = Schema.optionalKey(
  Schema.Boolean.annotate({
    description:
      "Replace the edits made to a modified Skill (default false: a modified Skill is refused and named)",
  }),
);

const SkillName = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "The Skill's name, as environment_get lists it",
});

const paragraphs = (lines: ReadonlyArray<string>): string => Arr.join(lines, "\n\n");

/** What the endpoint's `id` of a Skill tool says of `*`. */
const GLOBAL_SKILLS_ID = "the Skills kept Global, which the owner must approve a change to";

/** What an Environment's own Skills' checks are, as both surfaces say them. */
const CHECKS = `the Agent Skills name rules, text only, ${SKILL_SIZE_WORDS.file} a file, ${SKILL_SIZE_WORDS.skill} a Skill, nothing that looks like a credential or a local path; a set holds at most 100 Skills and ${SKILL_SIZE_WORDS.set}`;

export const environmentSkillInstall = {
  name: "environment_skill_install",
  annotations: WRITE_OPEN,
  session: {
    description: paragraphs([
      `Install Skills from GitHub for an Environment (the one id names): fetched by cloudpid, not by you (no Container, no \`npx skills\`), pinned to the commit the source's ref resolves to, and kept with their Skill source (repo, path, ref, commit). Every Workspace of the Environment then serves each at ${SKILLS_ROOT}/<name>, read-only; a Skill of the same name the Environment keeps is replaced.`,
      "source is owner/repo, owner/repo@skill, or a GitHub URL such as https://github.com/owner/repo/tree/<ref>/<path> (the first segment after tree/ is the ref, so write a branch name with a slash as feature%2Ffoo; without one, the default branch is used). Public repos work, and so do private ones in an account the GitHub App is installed on. Other sources (GitLab, other hosts, well-known indexes) are not fetched here: run `npx skills add <source> --copy` in a Container and save the folder with environment_skill_save.",
      `With id "${GLOBAL_ID}" the Skills are kept Global: each Environment's Workspaces serve them at their next readying (this Session's at once, unless its Environment keeps its own Skill of the name). They steer every future Session, so the user must approve the install, reading each Skill on the card: it shows the first ${MAX_CARD_CHARS} characters of each Skill's files and warns the user of what it cuts, so install Skills small enough to review in full, or expect them to be declined. One request shows at most ${MAX_APPROVED_SKILLS} Skills: name fewer with skills, then call again for the rest. The call reads the repo, asks about the Skills it would keep (those kept with the same files and Skill source already are left out), and on Approve installs exactly the commit the user was shown, each Skill only while the Skill of its name is still the one that was shown. ${INSTALL_APPROVAL}`,
      'skills names the Skills to install (by name): ["*"] installs every Skill the repo holds. When the repo holds several and you name none, nothing is installed and its Skills are listed; ask the user which they want, or call again with skills. skill_search finds a source on skills.sh.',
      `Each Skill passes the checks of environment_skill_save (the Agent Skills name rules, text only, ${SKILL_SIZE_WORDS.file} a file, ${SKILL_SIZE_WORDS.skill} a Skill, nothing that looks like a credential or a local path; a set holds at most 100 Skills and ${SKILL_SIZE_WORDS.set}). One that fails is reported and the others are still installed. Each is recorded with your reason and the files before and after, and the user can revert it on the Skills page.`,
    ]),
    input: Schema.Struct({
      id: idOrGlobal("Skills kept Global"),
      source: Source,
      skills: Skills,
      reason: SkillReason,
    }),
    output: SkillInstallOutput,
  },
  endpoint: {
    description: paragraphs([
      `Install Skills from GitHub for an Environment (the one id names): fetched by cloudpid, pinned to the commit the source's ref resolves to, and kept with their Skill source (repo, path, ref, commit). Every Workspace of the Environment then serves each at ${SKILLS_ROOT}/<name>, read-only, from its next readying; a Skill of the same name the Environment keeps is replaced.`,
      "source is owner/repo, owner/repo@skill, or a GitHub URL such as https://github.com/owner/repo/tree/<ref>/<path> (the first segment after tree/ is the ref, so write a branch name with a slash as feature%2Ffoo; without one, the default branch is used). Public repos work, and so do private ones in an account the GitHub App is installed on. Other sources (GitLab, other hosts, well-known indexes) are not fetched.",
      `With id "${GLOBAL_ID}" the Skills are kept Global. The call reads the repo and asks about the Skills it would keep (those kept with the same files and Skill source already are left out, and answered "unchanged" when that is all of them), showing the owner each Skill's files on the card: the first ${MAX_CARD_CHARS} characters of each, with a warning for what is cut, so install Skills small enough to review in full, or expect them to be declined. One request shows at most ${MAX_APPROVED_SKILLS} Skills, and at most ${SKILL_SIZE_WORDS.set} of files together: name fewer with skills, then call again for the rest; more is refused, and nothing is asked. On Approve exactly the commit the owner was shown is installed, each Skill only while it is the folder and files shown and the Skill of its name was not saved again meanwhile: the result names each Skill it skipped (in refused). ${GLOBAL_SKILL_ASK}`,
      'skills names the Skills to install (by name): ["*"] installs every Skill the repo holds. When the repo holds several and you name none, nothing is installed and its Skills are listed (listed; at Global the call is refused, listing them): choose, then call again with skills.',
      `Each Skill passes the checks (${CHECKS}). One that fails is reported in refused and the others are still installed: the answer's changed and installed say what was kept, and a call whose Skills were all refused still answers, so read refused, not the call's success. Each is recorded with your reason and the files before and after, and the owner can revert it on the Skills page.`,
    ]),
    input: Schema.Struct({
      id: idOrGlobal(GLOBAL_SKILLS_ID, "endpoint"),
      source: Source,
      skills: Skills,
      reason: SkillReasonEndpoint,
      ...RequestIdField,
    }),
    output: SkillInstallEndpointOutput,
  },
} as const;

export const environmentSkillUpdate = {
  name: "environment_skill_update",
  annotations: WRITE_OPEN,
  session: {
    description: paragraphs([
      `Update installed Skills of an Environment (the one id names) to the latest commit of the ref each was installed from: cloudpid fetches them, not you (no Container, no \`npx skills\`). Each Skill moved is kept in place of itself with its new Skill source and recorded as an Agent change with the files before and after, so the user can revert it on the Skills page. Skills stay pinned until someone updates them; environment_get marks a Skill "update available" when the daily check found its folder changed at its Skill source, and "modified" when it was edited since it was installed.`,
      `names are the Skills to update (as environment_get lists them); without names, every Skill marked update available is updated. A Skill whose folder is the same at the new commit records nothing. A modified Skill is refused, and named in the result, unless overwrite is true: that replaces the edits made to it (the user's revert brings them back); only set it when the user wants their edits replaced. A Skill that was not installed from GitHub has no source to update from, and one the checks refuse (the Agent Skills name rules, text only, ${SKILL_SIZE_WORDS.file} a file, ${SKILL_SIZE_WORDS.skill} a Skill, 100 Skills and ${SKILL_SIZE_WORDS.set} in a set) is reported while the others are updated. After an update, this Session's Workspace serves the new files at ${SKILLS_ROOT}/<name> at once; the skills list in your system prompt changes at the next Context Window.`,
      `With id "${GLOBAL_ID}" the Skills kept Global are updated, which the user must approve because they steer every future Session: they read the files each Skill would take on the card (the first ${MAX_CARD_CHARS} characters of each Skill's files, with a warning for what is cut), and the update is made at exactly those commits. ${SKILL_APPROVAL}`,
    ]),
    input: Schema.Struct({
      id: idOrGlobal("the Skills kept Global"),
      names: Names,
      overwrite: Overwrite,
      reason: UpdateReason,
    }),
    output: SkillUpdateOutput,
  },
  endpoint: {
    description: paragraphs([
      `Update installed Skills of an Environment (the one id names) to the latest commit of the ref each was installed from: cloudpid fetches them. Each Skill moved is kept in place of itself with its new Skill source and recorded as an Agent change with the files before and after, so the owner can revert it on the Skills page. Skills stay pinned until someone updates them; environment_get marks a Skill "update available" when the daily check found its folder changed at its Skill source, and "modified" when it was edited since it was installed.`,
      `names are the Skills to update (as environment_get lists them); without names, every Skill marked update available is updated. A Skill whose folder is the same at the new commit records nothing. A modified Skill is refused, and named in refused, unless overwrite is true: that replaces the edits made to it (the owner's revert brings them back); only set it when the owner wants their edits replaced. A Skill that was not installed from GitHub has no source to update from, and one the checks refuse (${CHECKS}) is reported while the others are updated: read updated and refused, not the call's success. Every Workspace of the Environment serves the new files at ${SKILLS_ROOT}/<name> from its next readying.`,
      `With id "${GLOBAL_ID}" the Skills kept Global are updated. The call reads the commit each would move to and asks about the Skills that would move, showing the owner the files each would take on the card (the first ${MAX_CARD_CHARS} characters of each Skill's files, with a warning for what is cut); the Skills left out (the same at the new commit, modified, refused) are named in the answer. One request shows at most ${MAX_APPROVED_SKILLS} Skills, and at most ${SKILL_SIZE_WORDS.set} of files together: name fewer, then call again for the rest; more is refused, and nothing is asked. On Approve each Skill is moved only to the commit and files the owner was shown, and only while it was not saved again meanwhile: the result names each Skill it skipped (in refused). ${GLOBAL_SKILL_ASK}`,
    ]),
    input: Schema.Struct({
      id: idOrGlobal(GLOBAL_SKILLS_ID, "endpoint"),
      names: Names,
      overwrite: Overwrite,
      reason: UpdateReasonEndpoint,
      ...RequestIdField,
    }),
    output: SkillUpdateEndpointOutput,
  },
} as const;

export const environmentSkillRemove = {
  name: "environment_skill_remove",
  annotations: DESTRUCTIVE,
  session: {
    description: `Remove a Skill the Environment keeps (the one id names): its Workspaces stop serving it at ${SKILLS_ROOT}/<name>, and serve the Skill of that name kept Global again if there is one (refused if a Skill set would then hold more than 100 Skills or ${SKILL_SIZE_WORDS.set}). environment_get lists the Environment's own Skills; those kept Global are not the Environment's and cannot be removed this way. With id "${GLOBAL_ID}" the Skill is removed from those kept Global, which the user must approve: ${SKILL_APPROVAL} The change is recorded with your reason and the files the Skill had, and the user can revert it on the Skills page.`,
    input: Schema.Struct({
      id: idOrGlobal("a Skill kept Global"),
      name: SkillName,
      reason: SkillReason,
    }),
    output: SkillRemoveOutput,
  },
  endpoint: {
    description: `Remove a Skill the Environment keeps (the one id names): its Workspaces stop serving it at ${SKILLS_ROOT}/<name> from their next readying, and serve the Skill of that name kept Global again if there is one (refused if a Skill set would then hold more than 100 Skills or ${SKILL_SIZE_WORDS.set}). environment_get lists the Environment's own Skills; those kept Global are not the Environment's and cannot be removed this way. With id "${GLOBAL_ID}" the Skill is removed from those kept Global (environment_get with id "${GLOBAL_ID}" lists them), only while it was not saved again since the ask. ${GLOBAL_SKILL_ASK} A Skill that is gone already is refused, not removed again, and nothing is asked. The change is recorded with your reason and the files the Skill had, and the owner can revert it on the Skills page.`,
    input: Schema.Struct({
      id: idOrGlobal(GLOBAL_SKILLS_ID, "endpoint"),
      name: SkillName,
      reason: SkillReasonEndpoint,
      ...RequestIdField,
    }),
    output: SkillRemoveEndpointOutput,
  },
} as const;
