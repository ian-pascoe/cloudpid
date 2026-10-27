// The `environment` extension's tools for an Environment's own Skills (ADR-0026, `docs/spec.md` → Agent changes, and
// → The Environment's own Skills): `environment_skill_save` reads a Skill's folder from the Workspace (one the agent wrote, or one
// `npx skills add --copy` made) and saves it for the Environment, in place of one of its name, and
// `environment_skill_remove` removes one. The Registry checks a save (the Agent Skills name rules, text only, 128 KB a
// file, 1 MB a Skill, nothing that looks like a credential or a local path, at most 100 Skills in the set) and records
// each as an Agent change with the files before and after, so the owner sees the diffs and can revert it. The Session
// hands its own Workspace the new Skill set at once; the Environment's other Workspaces and its spare get it at their
// next readying. The skills list in the prompt changes at the next Context Window.
// @effect-diagnostics missingPipeableSignature:off
import { defineEffectTool } from "@cloudpid/effect-durable";
import { type AgentChange, SKILLS_ROOT, skillField } from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { ExecutionEnv, FileError, Result } from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import {
  type ChangeAuthor,
  type ChangedEnvironment,
  EnvironmentsError,
  MAX_CHANGE_REASON,
  type EnvironmentsService,
  type RunChange,
} from "./environment.ts";
import { MAX_FILE_BYTES, MAX_SKILL_BYTES, problemsIn } from "./skill-checks.ts";

/** How the save of a Skill went. */
export type SkillSaved =
  | {
      readonly status: "saved";
      readonly environment: ChangedEnvironment;
      /** The change as the Registry recorded it, with the files before and after by hash. */
      readonly change: AgentChange;
      readonly name: string;
      /** Whether it hides the bundle's Skill of the name. */
      readonly shadows: boolean;
      /** Whether this Session's own Workspace serves it now: it is the Environment's, and took the new Skill set. */
      readonly handed: boolean;
    }
  /** The Environment keeps the Skill with these files already: nothing was saved or recorded. */
  | {
      readonly status: "unchanged";
      readonly environment: ChangedEnvironment;
      readonly name: string;
    }
  /** The Skill is not one a save keeps, each problem a line: nothing was saved. */
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "missing" };

/** How the removal of a Skill went. */
export type SkillRemoved =
  | {
      readonly status: "removed";
      readonly environment: ChangedEnvironment;
      readonly change: AgentChange;
      /** Whether the bundle's Skill of the name is served in its place. */
      readonly bundled: boolean;
      /** Whether this Session's own Workspace no longer serves it: it is the Environment's, and took the new Skill set. */
      readonly handed: boolean;
    }
  /** The Environment keeps no Skill of the name. */
  | { readonly status: "absent"; readonly environment: ChangedEnvironment }
  | { readonly status: "missing" };

/**
 * What the Session does for an Environment's own Skills, over the Registry: saves or removes one as an Agent change, and
 * hands its own Workspace the Environment's new Skill set at once when it is that Environment's.
 */
export type EnvironmentSkills = {
  readonly saveSkill: (input: {
    readonly environment: string;
    /** The folder's own name, which the Skill's must be. */
    readonly folder: string;
    /** Each file's text, by its path in the folder. */
    readonly files: Readonly<Record<string, string>>;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<SkillSaved, EnvironmentsError>;
  readonly removeSkill: (input: {
    readonly environment: string;
    readonly name: string;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<SkillRemoved, EnvironmentsError>;
};

/** What the tools need of `EnvironmentTools`: what they build over, and its refusals. */
export type SkillToolDeps = {
  readonly environments: EnvironmentsService;
  /** Where the Run's Agent changes are kept for the Notification of its end. */
  readonly log: { readonly record: (change: RunChange) => Effect.Effect<void> };
  /** Fails when any of `texts` holds the value of a Secret the Session holds or of a deploy-time credential. */
  readonly refuseSecrets: (
    texts: ReadonlyArray<{ readonly what: string; readonly text: string }>,
  ) => Effect.Effect<void, EnvironmentsError>;
  /** The Environment `id` names, the Session's own by default. */
  readonly target: (
    id: string | undefined,
  ) => Effect.Effect<{ readonly environment: string; readonly own: boolean }, EnvironmentsError>;
  readonly notFound: (id: string) => EnvironmentsError;
};

/** A Schema `Json` value as the details' `JsonValue`, which differs only in that its arrays are mutable. */
// SAFETY: the two types describe the same values; the details are never mutated.
const asJsonValue = (value: AgentChange["before"]): JsonValue | null => value as JsonValue | null;

/** The Workspace's files: a folder elsewhere is the Container's only, and is not read. */
const WORKSPACE_ROOT = "/workspace";

/** The most files a Skill's folder may hold, far above any real one. */
const MAX_FILES = 500;

/** The most files and folders a listing of a Skill's folder takes. */
const MAX_ENTRIES = MAX_FILES * 4;

/** What the save reads of the call's environment: the Workspace's files, never a command. */
type FolderEnv = Pick<ExecutionEnv, "absolutePath" | "fileInfo" | "listFiles" | "readBinaryFile">;

const refused = (message: string) =>
  EnvironmentsError.make({ message: `Nothing was saved: ${message}` });

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
 * and read what the Workspace does not hold. Nothing is refused when `env` cannot say.
 */
const refuseContainerOnly = (
  env: FolderEnv,
  paths: readonly string[],
): Effect.Effect<void, EnvironmentsError> =>
  Effect.gen(function* () {
    if (!knowsContainerOnly(env) || paths.length === 0) return;

    const answer = yield* attempt("Cannot tell where the folder is", () =>
      env.containerOnly(paths, BACKGROUND_CONTEXT),
    );

    const found = answer.ok ? Arr.filter(paths, (_, at) => answer.value[at] === true) : [];

    if (found.length === 0) return;

    return yield* refused(
      `${Arr.join(found, ", ")} ${found.length === 1 ? "is a Container-only path" : "are Container-only paths"}: only the Container has the files, not the Workspace. Copy the Skill's folder to a Workspace path such as ${WORKSPACE_ROOT}/.cloudpid/tmp/<name> and save it from there`,
    );
  });

/**
 * The Skill folder at `path` in the Workspace: its own name and each file's text by its path in it (`.git` and
 * `node_modules` left out). Refused when it is not a folder of the Workspace's files, holds a symbolic link or more than
 * `MAX_FILES` files, or a file that is not text or is too large, each problem a line.
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

    if (listing.value.truncated || entries.length > MAX_FILES) {
      return yield* refused(
        `the folder holds more than ${MAX_FILES} files, or ${MAX_ENTRIES} files and folders`,
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

/** Where a Skill is served in each Workspace of its Environment. */
const servedAt = (name: string): string => `${SKILLS_ROOT}/${name}`;

/** An Environment as a result names it. */
const named = ({ id, name }: ChangedEnvironment): string =>
  `Environment ${JSON.stringify(name)} (${id})`;

/** What a result says of where a change reaches. */
const reach = (environment: ChangedEnvironment, handed: boolean, own: boolean): string =>
  handed
    ? `This Session's Workspace has the change now; the other Workspaces of ${named(environment)} and its spare get it at their next readying, and those of other Environments never do.`
    : own
      ? `This Session's Workspace gets it at its next readying (it could not take it now), as do the other Workspaces of ${named(environment)} and its spare.`
      : `The Workspaces of ${named(environment)} and its spare get it at their next readying; this Session's Workspace, of another Environment, does not.`;

const PROMPT_NOTE =
  "The skills list in your system prompt changes at the next Context Window (after a Handoff, or in a new Session).";

/**
 * `environment_skill_save` and `environment_skill_remove`: each runs alone and is not replayed after an eviction, which
 * would record the change again. Built here, not at the module's top: `environment.ts` imports this file, so its
 * exports are not there yet then.
 */
export const skillTools = ({
  environments,
  log,
  refuseSecrets,
  target,
  notFound,
}: SkillToolDeps) => {
  const Reason = Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_CHANGE_REASON),
  ).annotate({
    description:
      "Why you save or remove the Skill, for the user to read in the Environment's Agent changes, such as 'the release steps are the same every time'",
  });

  const Id = Schema.String.annotate({
    description:
      "The Environment's id, as environment_list shows it (default: this Session's Environment)",
  });

  const save = defineEffectTool({
    name: "environment_skill_save",
    description: Arr.join(
      [
        `Save a Skill for an Environment (this Session's unless id names another), from its folder in the Workspace: a folder you wrote (such as ${WORKSPACE_ROOT}/.cloudpid/tmp/<name>), or one \`npx skills add <source> --copy\` made. Every Workspace of the Environment then serves it read-only at ${SKILLS_ROOT}/<name>, over the bundle's Skill of the same name if there is one, and lists it among the skills; Workspaces of other Environments do not. A Skill of the same name the Environment keeps is replaced.`,
        "The folder holds a SKILL.md whose YAML frontmatter sets name (1 to 64 lowercase letters, digits and hyphens, not starting or ending with a hyphen, no two in a row, and the folder's own name) and description (at most 1024 characters, saying what the Skill does and when to use it), and any files it refers to. The files must be text, at most 128 KB each and 1 MB together, with nothing that looks like a credential or a path on somebody's machine (/home/<user>/…), nor the value of a Secret this Session holds. A Skill set holds at most 100 Skills and 8 MB, the bundle's counted.",
        "To change a Skill, copy its folder from the skills directory to a scratch folder, edit it there, and save it again. The change is recorded with your reason and the files before and after, and the user can see the difference and revert it on the Environments page.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: Schema.optionalKey(Id),
      path: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: `The Skill's folder in the Workspace, absolute or relative to the working directory, such as ${WORKSPACE_ROOT}/.cloudpid/tmp/release-notes`,
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, path, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([{ what: "the reason", text: reason }]);

        if (api.env === undefined) return yield* refused("no execution environment is configured");

        const { environment, own } = yield* target(id);
        const { folder, files } = yield* readSkillFolder(api.env, path);

        // Saved as written, served to every Workspace of the Environment, and read by the agent.
        yield* refuseSecrets(
          Arr.map(Record.toEntries(files), ([file, text]) => ({ what: `the file ${file}`, text })),
        );

        const saved = yield* environments.saveSkill({
          environment,
          folder,
          files,
          author: { conversation: api.conversationId, tool: "environment_skill_save", reason },
        });

        switch (saved.status) {
          case "missing":
            return yield* notFound(environment);
          case "rejected":
            return yield* refused(`\n${saved.message}`);
          case "unchanged":
            return {
              output: [
                {
                  type: "text" as const,
                  text: `${named(saved.environment)} keeps the Skill ${saved.name} with these files already: nothing changed, and nothing was recorded. It is at ${servedAt(saved.name)}.`,
                },
              ],
              details: {
                unchanged: { environment: saved.environment, field: skillField(saved.name) },
              },
            };
          case "saved": {
            const { change } = saved;
            const count = Record.size(files);

            yield* log.record({
              tool: "environment_skill_save",
              environmentName: saved.environment.name,
              field: change.field,
            });

            return {
              output: [
                {
                  type: "text" as const,
                  text: Arr.join(
                    [
                      `${change.before === null ? "Saved the new Skill" : "Saved the Skill"} ${saved.name} for ${named(saved.environment)} (${count} file${count === 1 ? "" : "s"})${saved.shadows ? ", over the bundle's Skill of that name" : ""}.`,
                      saved.handed
                        ? `It is served now at ${servedAt(saved.name)} (read-only): read ${servedAt(saved.name)}/SKILL.md to use it.`
                        : `It is served at ${servedAt(saved.name)} (read-only) in each Workspace of the Environment.`,
                      reach(saved.environment, saved.handed, own),
                      PROMPT_NOTE,
                      "The change is recorded with your reason and the files before and after, and the user can revert it on the Environments page.",
                    ],
                    " ",
                  ),
                },
              ],
              details: {
                agentChange: {
                  id: change.id,
                  environment: saved.environment,
                  field: change.field,
                  before: asJsonValue(change.before),
                  after: asJsonValue(change.after),
                },
                path: servedAt(saved.name),
                own,
              },
            };
          }
        }
      }),
  });

  const remove = defineEffectTool({
    name: "environment_skill_remove",
    description: `Remove a Skill the Environment keeps (this Session's Environment unless id names another): its Workspaces stop serving it at ${SKILLS_ROOT}/<name>, and serve the bundle's Skill of that name again if there is one. environment_get lists the Environment's own Skills; the bundle's are not the Environment's and cannot be removed. The change is recorded with your reason and the files the Skill had, and the user can revert it on the Environments page.`,
    parameters: Schema.Struct({
      id: Schema.optionalKey(Id),
      name: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: "The Skill's name, as environment_get lists it",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, name, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([{ what: "the reason", text: reason }]);

        const { environment, own } = yield* target(id);

        const removed = yield* environments.removeSkill({
          environment,
          name,
          author: { conversation: api.conversationId, tool: "environment_skill_remove", reason },
        });

        switch (removed.status) {
          case "missing":
            return yield* notFound(environment);
          case "absent":
            return yield* EnvironmentsError.make({
              message: `Nothing was removed: ${named(removed.environment)} keeps no Skill named "${name}". environment_get lists the Skills it keeps; the bundle's are not the Environment's.`,
            });
          case "removed": {
            const { change } = removed;

            yield* log.record({
              tool: "environment_skill_remove",
              environmentName: removed.environment.name,
              field: change.field,
            });

            return {
              output: [
                {
                  type: "text" as const,
                  text: Arr.join(
                    [
                      `Removed the Skill ${name} from ${named(removed.environment)}.`,
                      removed.bundled
                        ? `The bundle's Skill of that name is served at ${servedAt(name)} again.`
                        : `Nothing is served at ${servedAt(name)} any more.`,
                      reach(removed.environment, removed.handed, own),
                      PROMPT_NOTE,
                      "The change is recorded with your reason and the files the Skill had, and the user can revert it on the Environments page.",
                    ],
                    " ",
                  ),
                },
              ],
              details: {
                agentChange: {
                  id: change.id,
                  environment: removed.environment,
                  field: change.field,
                  before: asJsonValue(change.before),
                  after: asJsonValue(change.after),
                },
                own,
              },
            };
          }
        }
      }),
  });

  return Effect.all([save, remove]);
};
