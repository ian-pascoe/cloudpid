// The `environment` extension's tools for an Environment's own Skills, and those kept Global (ADR-0026,
// `docs/architecture/agent-changes.md`, and → The Environment's own Skills): `environment_skill_save` reads a Skill's folder
// from the Workspace (one the agent wrote, or one `npx skills add --copy` made) and saves it for the Environment, in
// place of one of its name, `environment_skill_install` installs Skills from GitHub (fetched by the Registry, never by
// the Session or a Container; for `*` too, with the owner's Approval), and `environment_skill_remove` removes one. The
// Registry checks a save (the Agent Skills name rules, text only, `SKILL_SIZES`, nothing that looks like a credential or
// a local path, at most 100 Skills in the merged set) and records each as an Agent change with the files before and after, so the owner
// sees the diffs and can revert it. The Session hands its own Workspace the new Skill set at once; the Environment's
// other Workspaces and its spare get it at their next readying. The skills list in the prompt changes at the next
// Context Window. With `id: "*"` the Skill is kept Global, and the change waits for the owner's Approval
// (`./environment-skills-global.ts`), as a change to a Limit does: it steers every future Session. An Environment's own
// Skill of the same name wins in that Environment, with no Approval.
// @effect-diagnostics missingPipeableSignature:off
import { defineEffectTool } from "@cloudpid/effect-durable";
import { SKILLS_ROOT } from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv, FileError, Result } from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { EnvironmentsError, idOrGlobal, Reason } from "./environment.ts";
import { GLOBAL_ID } from "./environment-secret-marks.ts";
import {
  installedOutcome,
  refused,
  removedOutcome,
  savedOutcome,
  type SkillToolDeps,
} from "./environment-skill-results.ts";
import { updateTool } from "./environment-skill-update.ts";
import {
  INSTALL_APPROVAL,
  installAtGlobal,
  MAX_CARD_CHARS,
  removeAtGlobal,
  saveAtGlobal,
  SKILL_APPROVAL,
} from "./environment-skills-global.ts";
import {
  MAX_APPROVED_SKILLS,
  MAX_FILE_BYTES,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  problemsIn,
  SKILL_SIZES,
} from "./skill-checks.ts";

export type {
  EnvironmentSkills,
  SkillPreview,
  SkillRemoved,
  SkillSaved,
  SkillsInstalled,
  SkillsUpdated,
  SkillToolDeps,
} from "./environment-skill-results.ts";

/** The Workspace's files: a folder elsewhere is the Container's only, and is not read. */
const WORKSPACE_ROOT = "/workspace";

/** The most files and folders a listing of a Skill's folder takes. */
const MAX_ENTRIES = MAX_SKILL_FILES * 4;

/** What the save reads of the call's environment: the Workspace's files, never a command. */
type FolderEnv = Pick<ExecutionEnv, "absolutePath" | "fileInfo" | "listFiles" | "readBinaryFile">;

const attempt = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      EnvironmentsError.make({
        message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

/** An environment that can say which paths are Container-only (the Workspace DO's, `ComputerExecutionEnv`). */
type ContainerOnlyEnv = {
  readonly containerOnly: (
    paths: readonly string[],
    context: typeof BACKGROUND_CONTEXT,
  ) => Promise<Result<readonly boolean[], FileError>>;
};

const knowsContainerOnly = (env: FolderEnv): env is FolderEnv & ContainerOnlyEnv =>
  "containerOnly" in env;

/**
 * Refuse `paths` when `env` says any is Container-only: only the Container has their files, so a save would start it
 * and read what the Workspace does not hold. An environment that has no such check (a test's) refuses nothing; one
 * whose check fails refuses all, since the folder's place is not known.
 */
const refuseContainerOnly = (
  env: FolderEnv,
  paths: readonly string[],
): Effect.Effect<void, EnvironmentsError> =>
  Effect.gen(function* () {
    if (!knowsContainerOnly(env) || paths.length === 0) return;

    const unchecked = (why: string) =>
      refused(
        `could not check whether the folder is a Workspace path or a Container-only one (${why}); try again, or copy it to ${WORKSPACE_ROOT}/.cloudpid/tmp/<name> and save it from there`,
      );

    const answer = yield* attempt("Cannot tell where the folder is", () =>
      env.containerOnly(paths, BACKGROUND_CONTEXT),
    ).pipe(Effect.catch((error) => unchecked(error.message)));

    // Fail closed: a folder whose place is not known is not read.
    if (!answer.ok) return yield* unchecked(answer.error.message);

    const found = Arr.filter(paths, (_, at) => answer.value[at] === true);

    if (found.length === 0) return;

    return yield* refused(
      `${Arr.join(found, ", ")} ${found.length === 1 ? "is a Container-only path" : "are Container-only paths"}: only the Container has the files, not the Workspace. Copy the Skill's folder to a Workspace path such as ${WORKSPACE_ROOT}/.cloudpid/tmp/<name> and save it from there`,
    );
  });

/**
 * The Skill folder at `path` in the Workspace: its own name and each file's text by its path in it (`.git` and
 * `node_modules` left out). Refused when it is not a folder of the Workspace's files, holds a symbolic link or more than
 * `MAX_SKILL_FILES` files, or a file that is not text or is too large, each problem a line.
 */
export const readSkillFolder = (
  env: FolderEnv,
  path: string,
): Effect.Effect<
  { readonly folder: string; readonly files: Readonly<Record<string, string>> },
  EnvironmentsError
> =>
  Effect.gen(function* () {
    const resolved = yield* attempt("Cannot resolve the path", () =>
      env.absolutePath(path, BACKGROUND_CONTEXT),
    );

    if (!resolved.ok) return yield* refused(resolved.error.message);

    const directory = resolved.value.replace(/\/+$/, "");

    if (!directory.startsWith(`${WORKSPACE_ROOT}/`)) {
      return yield* refused(
        `${directory} is not in the Workspace's files: write the Skill's folder under ${WORKSPACE_ROOT} (a scratch folder such as ${WORKSPACE_ROOT}/.cloudpid/tmp/<name> will do) and save it from there`,
      );
    }

    yield* refuseContainerOnly(env, [directory]);

    const info = yield* attempt("Cannot read the folder", () =>
      env.fileInfo(directory, BACKGROUND_CONTEXT),
    );

    if (!info.ok) {
      return yield* refused(
        info.error.code === "not_found" ? `${directory} does not exist` : info.error.message,
      );
    }

    if (info.value.kind !== "directory") {
      return yield* refused(
        `${directory} is not a folder: give the Skill's folder, which holds its SKILL.md`,
      );
    }

    if (env.listFiles === undefined) return yield* refused("this environment cannot list a folder");

    const listing = yield* attempt("Cannot list the folder", () =>
      env.listFiles!(
        directory,
        {
          hidden: true,
          gitignore: false,
          exclude: [".git", "node_modules"],
          maxEntries: MAX_ENTRIES,
        },
        BACKGROUND_CONTEXT,
      ),
    );

    if (!listing.ok) return yield* refused(listing.error.message);

    const links = Arr.filter(listing.value.entries, (entry) => entry.kind === "symlink");

    if (links.length > 0) {
      return yield* refused(
        `the folder holds symbolic links (${Arr.join(
          Arr.map(links, (entry) => entry.path),
          ", ",
        )}): a Skill holds its files themselves, so copy them in (\`npx skills add --copy\` does)`,
      );
    }

    const entries = Arr.filter(listing.value.entries, (entry) => entry.kind === "file");

    if (listing.value.truncated || entries.length > MAX_SKILL_FILES) {
      return yield* refused(
        `the folder holds more than ${MAX_SKILL_FILES} files, or ${MAX_ENTRIES} files and folders`,
      );
    }

    yield* refuseContainerOnly(
      env,
      Arr.map(entries, (entry) => `${directory}/${entry.path}`),
    );

    const problems: string[] = [];
    const files: Record<string, string> = {};
    let total = 0;

    for (const entry of entries) {
      const file = `${directory}/${entry.path}`;

      const size = yield* attempt(`Cannot read ${entry.path}`, () =>
        env.fileInfo(file, BACKGROUND_CONTEXT),
      );

      // A file whose size is not known is not read: it could be of any size.
      if (!size.ok) {
        problems.push(`${entry.path}: ${size.error.message}`);
        continue;
      }

      if (size.value.size > MAX_FILE_BYTES) {
        problems.push(
          `${entry.path}: ${size.value.size} bytes, more than the ${MAX_FILE_BYTES} a Skill's file may be`,
        );
        continue;
      }

      total += size.value.size;

      if (total > MAX_SKILL_BYTES) {
        problems.push(
          `The files are more than the ${MAX_SKILL_BYTES} bytes a Skill may be together`,
        );
        break;
      }

      const read = yield* attempt(`Cannot read ${entry.path}`, () =>
        env.readBinaryFile(file, BACKGROUND_CONTEXT),
      );

      if (!read.ok) {
        problems.push(`${entry.path}: ${read.error.message}`);
        continue;
      }

      const found = problemsIn(entry.path, read.value);

      if (found.length > 0) {
        problems.push(...found);
        continue;
      }

      files[entry.path] = new TextDecoder().decode(read.value);
    }

    if (problems.length > 0) return yield* refused(`\n${Arr.join(problems, "\n")}`);

    return { folder: directory.slice(directory.lastIndexOf("/") + 1), files };
  });

/**
 * `environment_skill_save` and `environment_skill_remove`: each runs alone. A change to an Environment's own Skills is
 * made at once; one to the Skills kept Global (`id: "*"`) waits for the owner's Approval, like a Limit
 * (`withApproval`), and is replayed after an eviction to wait for the same request. So both are `replay: "safe"`: a
 * rerun of a save to an Environment's own Skills finds it made (the same files record nothing again), and a rerun of its
 * removal that finds the Skill gone says it may be this call's own earlier work. Built here, not at the module's top:
 * `environment.ts` imports this file, so its exports are not there yet then.
 */
export const skillTools = ({
  environments,
  approvals,
  log,
  refuseSecrets,
  target,
  notFound,
}: SkillToolDeps) => {
  const SkillReason = Reason.annotate({
    description:
      "Why you save, install or remove the Skill, for the user to read in the Environment's Agent changes, such as 'the release steps are the same every time'",
  });

  const globalDeps = { environments, approvals, log, notFound };

  const save = defineEffectTool({
    name: "environment_skill_save",
    description: Arr.join(
      [
        `Save a Skill for an Environment (the one id names), from its folder in the Workspace: a folder you wrote (such as ${WORKSPACE_ROOT}/.cloudpid/tmp/<name>), or one \`npx skills add <source> --copy\` made. Every Workspace of the Environment then serves it read-only at ${SKILLS_ROOT}/<name>, over the Skill of the same name kept Global, and lists it among the skills; Workspaces of other Environments do not. A Skill of the same name the Environment keeps is replaced. Saving a Skill whose name is also kept Global makes the Environment's own copy, which wins in this Environment only.`,
        `With id "${GLOBAL_ID}" the Skill is kept Global: each Environment's Workspaces serve it at their next readying (this Session's at once, unless its Environment keeps its own Skill of the name). A Skill there steers every future Session, so the user must approve the change, reading the Skill on the card: it shows the first ${MAX_CARD_CHARS} characters of the files and warns the user of what it cuts, so keep a Skill at Global small enough to review in full, or expect it to be declined. ${SKILL_APPROVAL}`,
        `The folder holds a SKILL.md whose YAML frontmatter sets name (1 to 64 lowercase letters, digits and hyphens, not starting or ending with a hyphen, no two in a row, and the folder's own name) and description (at most 1024 characters, saying what the Skill does and when to use it), and any files it refers to. The files must be text, at most ${SKILL_SIZES.file} each and ${SKILL_SIZES.skill} together, with nothing that looks like a credential or a path on somebody's machine (/home/<user>/…), nor the value of a Secret this Session holds. A Skill set holds at most 100 Skills and ${SKILL_SIZES.set}, every layer counted; a Skill at Global is refused when any Environment's set would pass either.`,
        "To change a Skill, copy its folder from the skills directory to a scratch folder, edit it there, and save it again. The change is recorded with your reason and the files before and after, and the user can see the difference and revert it on the Skills page.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: idOrGlobal("a Skill kept Global"),
      path: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: `The Skill's folder in the Workspace, absolute or relative to the working directory, such as ${WORKSPACE_ROOT}/.cloudpid/tmp/release-notes`,
      }),
      reason: SkillReason,
    }),
    executionMode: "sequential",
    // A rerun after an eviction waits for the request a change to Global made, or takes its answer; one to an
    // Environment's own Skills finds its change made (the same files record nothing again).
    replay: "safe",
    execute: ({ id, path, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([{ what: "the reason", text: reason }]);

        if (api.env === undefined) return yield* refused("no execution environment is configured");

        const atGlobal = id === GLOBAL_ID;

        const { environment, own } = atGlobal
          ? { environment: GLOBAL_ID, own: false }
          : yield* target(id);

        const { folder, files } = yield* readSkillFolder(api.env, path);

        // Saved as written, served to every Workspace of the Environment, and read by the agent.
        yield* refuseSecrets(
          Arr.map(Record.toEntries(files), ([file, text]) => ({ what: `the file ${file}`, text })),
        );

        if (atGlobal) return yield* saveAtGlobal(globalDeps, { folder, files, path, reason }, api);

        const saved = yield* environments.saveSkill({
          environment,
          folder,
          files,
          author: { conversation: api.conversationId, tool: "environment_skill_save", reason },
        });

        return yield* savedOutcome(saved, {
          environments,
          log,
          notFound,
          scope: environment,
          own,
          approved: false,
          folder,
          count: Record.size(files),
        });
      }),
  });

  const remove = defineEffectTool({
    name: "environment_skill_remove",
    description: `Remove a Skill the Environment keeps (the one id names): its Workspaces stop serving it at ${SKILLS_ROOT}/<name>, and serve the Skill of that name kept Global again if there is one (refused if a Skill set would then hold more than 100 Skills or ${SKILL_SIZES.set}). environment_get lists the Environment's own Skills; those kept Global are not the Environment's and cannot be removed this way. With id "${GLOBAL_ID}" the Skill is removed from those kept Global, which the user must approve: ${SKILL_APPROVAL} The change is recorded with your reason and the files the Skill had, and the user can revert it on the Skills page.`,
    parameters: Schema.Struct({
      id: idOrGlobal("a Skill kept Global"),
      name: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: "The Skill's name, as environment_get lists it",
      }),
      reason: SkillReason,
    }),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ id, name, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([{ what: "the reason", text: reason }]);

        if (id === GLOBAL_ID) return yield* removeAtGlobal(globalDeps, { name, reason }, api);

        const { environment, own } = yield* target(id);

        const removed = yield* environments.removeSkill({
          environment,
          name,
          author: { conversation: api.conversationId, tool: "environment_skill_remove", reason },
        });

        return yield* removedOutcome(removed, {
          environments,
          log,
          notFound,
          scope: environment,
          own,
          approved: false,
          name,
        });
      }),
  });

  const install = defineEffectTool({
    name: "environment_skill_install",
    description: Arr.join(
      [
        `Install Skills from GitHub for an Environment (the one id names): fetched by cloudpid, not by you (no Container, no \`npx skills\`), pinned to the commit the source's ref resolves to, and kept with their Skill source (repo, path, ref, commit). Every Workspace of the Environment then serves each at ${SKILLS_ROOT}/<name>, read-only; a Skill of the same name the Environment keeps is replaced.`,
        "source is owner/repo, owner/repo@skill, or a GitHub URL such as https://github.com/owner/repo/tree/<ref>/<path> (the first segment after tree/ is the ref, so write a branch name with a slash as feature%2Ffoo; without one, the default branch is used). Public repos work, and so do private ones in an account the GitHub App is installed on. Other sources (GitLab, other hosts, well-known indexes) are not fetched here: run `npx skills add <source> --copy` in a Container and save the folder with environment_skill_save.",
        `With id "${GLOBAL_ID}" the Skills are kept Global: each Environment's Workspaces serve them at their next readying (this Session's at once, unless its Environment keeps its own Skill of the name). They steer every future Session, so the user must approve the install, reading each Skill on the card: it shows the first ${MAX_CARD_CHARS} characters of each Skill's files and warns the user of what it cuts, so install Skills small enough to review in full, or expect them to be declined. One request shows at most ${MAX_APPROVED_SKILLS} Skills: name fewer with skills, then call again for the rest. The call reads the repo, asks about the Skills it would keep (those kept with the same files and Skill source already are left out), and on Approve installs exactly the commit the user was shown, each Skill only while the Skill of its name is still the one that was shown. ${INSTALL_APPROVAL}`,
        'skills names the Skills to install (by name): ["*"] installs every Skill the repo holds. When the repo holds several and you name none, nothing is installed and its Skills are listed; ask the user which they want, or call again with skills. skill_search finds a source on skills.sh.',
        `Each Skill passes the checks of environment_skill_save (the Agent Skills name rules, text only, ${SKILL_SIZES.file} a file, ${SKILL_SIZES.skill} a Skill, nothing that looks like a credential or a local path; a set holds at most 100 Skills and ${SKILL_SIZES.set}). One that fails is reported and the others are still installed. Each is recorded with your reason and the files before and after, and the user can revert it on the Skills page.`,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: idOrGlobal("Skills kept Global"),
      source: Schema.String.check(Schema.isMinLength(1)).annotate({
        description:
          "Where to install from: owner/repo, owner/repo@skill, or a GitHub URL (https://github.com/owner/repo/tree/<ref>/<path>)",
      }),
      skills: Schema.optionalKey(
        Schema.Array(Schema.String.check(Schema.isMinLength(1))).annotate({
          description:
            'The names of the Skills to install from the source; ["*"] for all of them. Left out: the repo\'s only Skill, or a list of its Skills when it holds several',
        }),
      ),
      reason: SkillReason,
    }),
    executionMode: "sequential",
    // A rerun after an eviction waits for the request an install at Global made, or takes its answer; one for
    // an Environment's own Skills runs again: the Skills kept already come back unchanged, and a ref that moved is
    // installed at its new commit.
    replay: "safe",
    execute: ({ id, source, skills: names, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([
          { what: "the reason", text: reason },
          { what: "the source", text: source },
          ...Arr.map(names ?? [], (name) => ({ what: "a Skill name", text: name })),
        ]);

        if (id === GLOBAL_ID) {
          return yield* installAtGlobal(globalDeps, { source, names, reason }, api);
        }

        const { environment, own } = yield* target(id);

        const installed = yield* environments.installSkills({
          environment,
          source,
          skills: names,
          author: { conversation: api.conversationId, tool: "environment_skill_install", reason },
        });

        // An install into an Environment's own Skills is made at once; one at Global waits for the Approval.
        return yield* installedOutcome(installed, {
          environments,
          log,
          notFound,
          scope: environment,
          own,
          approved: false,
        });
      }),
  });

  const update = updateTool({ environments, approvals, log, refuseSecrets, target, notFound });

  return Effect.all([save, remove, install, update]);
};
