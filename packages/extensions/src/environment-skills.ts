// The `environment` extension's tools for an Environment's own Skills, and those kept for every Environment (ADR-0026,
// `docs/spec.md` → Agent changes, and → The Environment's own Skills): `environment_skill_save` reads a Skill's folder
// from the Workspace (one the agent wrote, or one `npx skills add --copy` made) and saves it for the Environment, in
// place of one of its name, and `environment_skill_remove` removes one. The Registry checks a save (the Agent Skills name
// rules, text only, 128 KB a file, 1 MB a Skill, nothing that looks like a credential or a local path, at most 100
// Skills and 8 MB in the merged set) and records each as an Agent change with the files before and after, so the owner
// sees the diffs and can revert it. The Session hands its own Workspace the new Skill set at once; the Environment's
// other Workspaces and its spare get it at their next readying. The skills list in the prompt changes at the next
// Context Window. With `id: "*"` the Skill is kept for every Environment, and the change waits for the owner's Approval
// (`./approvals.ts`), as a change to a Limit does: it steers every future Session. An Environment's own Skill of the same
// name wins in that Environment, with no Approval.
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off preferSchemaOverJson:off
import { defineEffectTool } from "@cloudpid/effect-durable";
import { type AgentChange, SKILLS_ROOT, skillField } from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { ExecutionEnv, FileError, Result } from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import {
  APPROVAL,
  type ApprovalCall,
  type ApprovalsService,
  approvedAlready,
  askedBefore,
  declined,
  withApproval,
} from "./approvals.ts";
import {
  type ChangeAuthor,
  type ChangedEnvironment,
  EnvironmentsError,
  type EnvironmentsService,
  idOrEvery,
  Reason,
  type RunChange,
} from "./environment.ts";
import { EVERY_ENVIRONMENT_ID, EVERY_ENVIRONMENT_NAME } from "./environment-secret-marks.ts";
import { MAX_FILE_BYTES, MAX_SKILL_BYTES, problemsIn } from "./skill-checks.ts";

/** How the save of a Skill went. */
export type SkillSaved =
  | {
      readonly status: "saved";
      /** The Environment, or every Environment (`EVERY_ENVIRONMENT_ID`). */
      readonly environment: ChangedEnvironment;
      /** The change as the Registry recorded it, with the files before and after by hash. */
      readonly change: AgentChange;
      readonly name: string;
      /** Whether it hides the bundle's Skill of the name. */
      readonly shadows: boolean;
      /** Whether it is an Environment's own Skill that hides the one of the name kept for every Environment. */
      readonly overrides: boolean;
      /**
       * For a Skill kept for every Environment: the Environments whose own Skill of the name hides it, so it does not
       * reach them.
       */
      readonly overriddenIn: ReadonlyArray<ChangedEnvironment>;
      /**
       * Whether this Session's own Workspace serves it now: it took the new Skill set (it is the Environment's, or the
       * Skill is kept for every Environment and its Environment does not keep one of the name).
       */
      readonly handed: boolean;
    }
  /** The scope keeps the Skill with these files already: nothing was saved or recorded. */
  | {
      readonly status: "unchanged";
      readonly environment: ChangedEnvironment;
      readonly name: string;
    }
  /** The Skill of the name was saved again since the owner was asked (`expected`): nothing was saved. */
  | { readonly status: "changed-since"; readonly environment: ChangedEnvironment }
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
      /** Whether the Skill of the name kept for every Environment is served in its place, for an Environment's own. */
      readonly inherited: boolean;
      /** For a Skill kept for every Environment: the Environments whose own Skill of the name stays served there. */
      readonly overriddenIn: ReadonlyArray<ChangedEnvironment>;
      /**
       * Whether this Session's own Workspace no longer serves it: it took the new Skill set (it is the Environment's, or
       * the Skill was kept for every Environment and its Environment keeps none of the name).
       */
      readonly handed: boolean;
    }
  /** The scope keeps no Skill of the name. */
  | { readonly status: "absent"; readonly environment: ChangedEnvironment }
  /** The Skill of the name was saved again since the owner was asked (`expected`): nothing was removed. */
  | { readonly status: "changed-since"; readonly environment: ChangedEnvironment }
  | { readonly status: "missing" };

/** What a save of a Skill would do, checked as the Registry checks it, with nothing saved or recorded. */
export type SkillChecked =
  | {
      /** `ready`: a save would keep it. `unchanged`: the scope keeps the Skill with these files already. */
      readonly status: "ready" | "unchanged";
      readonly environment: ChangedEnvironment;
      readonly name: string;
      readonly description: string;
      /** The Skill of the name the scope keeps now, with its files' paths. Null for a new Skill. */
      readonly current: {
        readonly description: string;
        readonly savedAt: number;
        readonly files: ReadonlyArray<string>;
      } | null;
    }
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "missing" };

/**
 * What the Session does for the Skills of an Environment and of every Environment (`EVERY_ENVIRONMENT_ID`), over the
 * Registry: saves or removes one as an Agent change, and hands its own Workspace its Environment's new Skill set at once
 * when the change reaches it.
 */
export type EnvironmentSkills = {
  readonly saveSkill: (input: {
    readonly environment: string;
    /** The folder's own name, which the Skill's must be. */
    readonly folder: string;
    /** Each file's text, by its path in the folder. */
    readonly files: Readonly<Record<string, string>>;
    /** When the Skill of the name must have been saved last: the one the owner's Approval was asked against. */
    readonly expected?: { readonly savedAt: number | null } | undefined;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<SkillSaved, EnvironmentsError>;
  /** What `saveSkill` would do with the same folder and files, nothing saved or recorded. */
  readonly checkSkill: (input: {
    readonly environment: string;
    readonly folder: string;
    readonly files: Readonly<Record<string, string>>;
  }) => Effect.Effect<SkillChecked, EnvironmentsError>;
  readonly removeSkill: (input: {
    readonly environment: string;
    readonly name: string;
    /** When the Skill must have been saved last: the one the owner's Approval was asked against. */
    readonly expected?: { readonly savedAt: number | null } | undefined;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<SkillRemoved, EnvironmentsError>;
};

/** What the tools need of `EnvironmentTools`: what they build over, and its refusals. */
export type SkillToolDeps = {
  readonly environments: EnvironmentsService;
  /** The Session's Approval requests, which a change to the Skills kept for every Environment waits on. */
  readonly approvals: ApprovalsService;
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

/** An Environment as a result names it, or every Environment. */
const named = ({ id, name }: ChangedEnvironment): string =>
  id === EVERY_ENVIRONMENT_ID
    ? EVERY_ENVIRONMENT_NAME
    : `Environment ${JSON.stringify(name)} (${id})`;

/** What a result says of where a change to an Environment's own Skills reaches. */
const reach = (environment: ChangedEnvironment, handed: boolean, own: boolean): string =>
  handed
    ? `This Session's Workspace has the change now; the other Workspaces of ${named(environment)} and its spare get it at their next readying, and those of other Environments never do.`
    : own
      ? `This Session's Workspace gets it at its next readying (it could not take it now), as do the other Workspaces of ${named(environment)} and its spare.`
      : `The Workspaces of ${named(environment)} and its spare get it at their next readying; this Session's Workspace, of another Environment, does not.`;

/**
 * What a result says of where a change to the Skills kept for every Environment reaches: every Environment's Workspaces
 * and spares at their next readying, this Session's Workspace at once unless its Environment keeps its own Skill of the
 * name, and not the Environments that do.
 */
const reachEvery = (
  handed: boolean,
  overriddenIn: ReadonlyArray<ChangedEnvironment>,
  current: string | null,
): string => {
  const hereHidden = Arr.some(overriddenIn, ({ id }) => id === current);
  const others = Arr.filter(overriddenIn, ({ id }) => id !== current);

  return Arr.join(
    [
      "Every Environment's Workspaces and spares get it at their next readying.",
      handed
        ? "This Session's Workspace has the change now."
        : hereHidden
          ? "This Session's Environment keeps its own Skill of that name, which hides it there."
          : "This Session's Workspace gets it at its next readying (it could not take it now).",
      ...(others.length === 0
        ? []
        : [
            `It does not reach the Environments whose own Skill of that name hides it: ${Arr.join(Arr.map(others, named), ", ")}.`,
          ]),
    ],
    " ",
  );
};

const PROMPT_NOTE =
  "The skills list in your system prompt changes at the next Context Window (after a Handoff, or in a new Session).";

/** The most characters of a Skill's files the Approval card shows: the rest is named, not shown. */
const MAX_CARD_CHARS = 16_000;

/** A Skill's files as the Approval card shows them, `SKILL.md` first, up to `MAX_CARD_CHARS` characters in all. */
const cardFiles = (files: Readonly<Record<string, string>>): string => {
  const ordered = Arr.sort(
    Record.toEntries(files),
    Order.mapInput(Order.String, ([path]: readonly [string, string]) =>
      path === "SKILL.md" ? "" : path,
    ),
  );

  let budget = MAX_CARD_CHARS;

  return Arr.join(
    Arr.map(ordered, ([path, text]) => {
      const head = `── ${path} (${new TextEncoder().encode(text).length} bytes)`;

      if (budget <= 0) return `${head}, not shown ──`;

      const shown = text.length > budget ? `${text.slice(0, budget)}\n…` : text;

      budget -= shown.length;

      return `${head} ──\n${shown}`;
    }),
    "\n\n",
  );
};

const hex = (buffer: ArrayBuffer): string =>
  Arr.join(
    Arr.map([...new Uint8Array(buffer)], (byte) => byte.toString(16).padStart(2, "0")),
    "",
  );

/** A digest of the folder's name and files, which an Approval was asked for: the call saves only what it shows. */
const digestOf = (folder: string, files: Readonly<Record<string, string>>): Effect.Effect<string> =>
  Effect.promise(async () =>
    hex(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([
            folder,
            Arr.sort(
              Record.toEntries(files),
              Order.mapInput(Order.String, ([path]: readonly [string, string]) => path),
            ),
          ]),
        ),
      ),
    ),
  );

/** What an Approval of a save was asked against: when the Skill of the name was last saved, and the files shown. */
const SaveAsked = Schema.Struct({ savedAt: Schema.NullOr(Schema.Finite), digest: Schema.String });

/** What an Approval of a removal was asked against: when the Skill was last saved. */
const RemoveAsked = Schema.Struct({ savedAt: Schema.NullOr(Schema.Finite) });

/**
 * `environment_skill_save` and `environment_skill_remove`: each runs alone. A change to an Environment's own Skills is
 * made at once; one to the Skills kept for every Environment (`id: "*"`) waits for the owner's Approval, like a Limit
 * (`withApproval`), and is replayed after an eviction to wait for the same request. So both are `replay: "safe"`: a
 * rerun of a change to an Environment's own Skills finds it made (the same files record nothing again). Built here, not
 * at the module's top: `environment.ts` imports this file, so its exports are not there yet then.
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
      "Why you save or remove the Skill, for the user to read in the Environment's Agent changes, such as 'the release steps are the same every time'",
  });

  const EVERY = { id: EVERY_ENVIRONMENT_ID, name: EVERY_ENVIRONMENT_NAME };

  /** The Skill saved as a result says it, with what the call knows of where it reaches. */
  const savedResult = (
    saved: Extract<SkillSaved, { readonly status: "saved" }>,
    {
      count,
      own,
      current,
      approved,
    }: {
      readonly count: number;
      readonly own: boolean;
      readonly current: string | null;
      readonly approved: boolean;
    },
  ) => {
    const { change } = saved;
    const everywhere = saved.environment.id === EVERY_ENVIRONMENT_ID;

    const details = {
      agentChange: {
        id: change.id,
        environment: saved.environment,
        field: change.field,
        before: asJsonValue(change.before),
        after: asJsonValue(change.after),
      },
      path: servedAt(saved.name),
      own: everywhere ? saved.handed : own,
    };

    return {
      output: [
        {
          type: "text" as const,
          text: Arr.join(
            [
              `${approved ? "The user approved: " : ""}${change.before === null ? "Saved the new Skill" : "Saved the Skill"} ${saved.name} for ${named(saved.environment)} (${count} file${count === 1 ? "" : "s"})${saved.shadows ? ", over the bundle's Skill of that name" : ""}.`,
              saved.handed
                ? `It is served now at ${servedAt(saved.name)} (read-only): read ${servedAt(saved.name)}/SKILL.md to use it.`
                : `It is served at ${servedAt(saved.name)} (read-only) in each Workspace${everywhere ? "" : " of the Environment"}.`,
              ...(saved.overrides
                ? [
                    "It hides the Skill of that name kept for every Environment, in this Environment.",
                  ]
                : []),
              everywhere
                ? reachEvery(saved.handed, saved.overriddenIn, current)
                : reach(saved.environment, saved.handed, own),
              PROMPT_NOTE,
              `The change is recorded${approved ? " as approved" : ""} with your reason and the files before and after, and the user can revert it on the Environments page.`,
            ],
            " ",
          ),
        },
      ],
      details: approved ? { approval: { approved: true }, ...details } : details,
    };
  };

  /** Save the folder's Skill for every Environment once the owner approves it. */
  const saveEverywhere = (
    {
      folder,
      files,
      path,
      reason,
    }: {
      readonly folder: string;
      readonly files: Readonly<Record<string, string>>;
      readonly path: string;
      readonly reason: string;
    },
    api: ApprovalCall,
  ) =>
    Effect.gen(function* () {
      const tool = "environment_skill_save";

      const checked = yield* environments.checkSkill({
        environment: EVERY_ENVIRONMENT_ID,
        folder,
        files,
      });

      const rerun = yield* askedBefore(approvals, api);

      if (checked.status === "missing" || checked.status === "rejected") {
        // A rerun that no longer passes the checks asks nothing: its request, if still waiting, is withdrawn.
        if (rerun) yield* approvals.settle(String(api.taskId));

        return yield* checked.status === "missing"
          ? notFound(EVERY_ENVIRONMENT_ID)
          : refused(`\n${checked.message}`);
      }

      const { name, description, current } = checked;

      if (checked.status === "unchanged" && !rerun) {
        return {
          output: [
            {
              type: "text" as const,
              text: `${named(EVERY)} keeps the Skill ${name} with these files already: nothing was asked, changed or recorded. It is at ${servedAt(name)}.`,
            },
          ],
          details: { unchanged: { environment: EVERY, field: skillField(name) } },
        };
      }

      const digest = yield* digestOf(folder, files);

      return yield* withApproval(
        approvals,
        api,
        {
          tool,
          target: "every Environment",
          change: `Save the Skill ${JSON.stringify(name)}`,
          before:
            current === null
              ? "Not kept for every Environment"
              : `Kept for every Environment: ${current.description} (files: ${Arr.join(current.files, ", ")})`,
          after: `${description}\n\n${cardFiles(files)}`,
          reason,
          // The Skill as the owner saw it: saved only while the Skill of the name was last saved then, and the folder holds
          // what was shown.
          expected: { savedAt: current?.savedAt ?? null, digest },
        },
        (answer) =>
          Effect.gen(function* () {
            if (!answer.approved) {
              return declined(answer, `saving the Skill ${name} for every Environment`);
            }

            const asked = Schema.decodeUnknownOption(SaveAsked)(answer.expected);

            if (Option.isNone(asked) || asked.value.digest !== digest) {
              return yield* EnvironmentsError.make({
                message: `The user approved, but the folder ${path} no longer holds the Skill they were shown (its files changed since): nothing was saved. Ask again with the folder as it is now if the Skill is still needed.`,
              });
            }

            const saved = yield* environments.saveSkill({
              environment: EVERY_ENVIRONMENT_ID,
              folder,
              files,
              expected: { savedAt: asked.value.savedAt },
              author: { conversation: api.conversationId, tool, reason, approved: true },
            });

            switch (saved.status) {
              case "missing":
                return yield* notFound(EVERY_ENVIRONMENT_ID);
              case "rejected":
                return yield* EnvironmentsError.make({
                  message: `The user approved, but nothing was saved:\n${saved.message}`,
                });
              case "changed-since":
                return yield* EnvironmentsError.make({
                  message: `The user approved, but the Skill ${name} kept for every Environment was saved again since they were asked: nothing was saved. Ask again if the Skill is still needed.`,
                });
              case "unchanged":
                return {
                  output: [
                    {
                      type: "text" as const,
                      text: approvedAlready(
                        `${named(EVERY)} keeps the Skill ${saved.name} with these files`,
                      ),
                    },
                  ],
                  details: { approval: { approved: true } },
                };
              case "saved": {
                yield* log.record({
                  tool,
                  environmentName: saved.environment.name,
                  field: saved.change.field,
                });

                return savedResult(saved, {
                  count: Record.size(files),
                  own: false,
                  current: yield* environments.current,
                  approved: true,
                });
              }
            }
          }),
      );
    });

  /** Remove the Skill kept for every Environment once the owner approves it. */
  const removeEverywhere = (
    { name, reason }: { readonly name: string; readonly reason: string },
    api: ApprovalCall,
  ) =>
    Effect.gen(function* () {
      const tool = "environment_skill_remove";
      const { skills } = yield* environments.every;
      const kept = Arr.findFirst(skills, (skill) => skill.name === name);

      if (Option.isNone(kept) && !(yield* askedBefore(approvals, api))) {
        return yield* EnvironmentsError.make({
          message: `Nothing was asked or removed: no Skill named "${name}" is kept for every Environment. environment_get with id "${EVERY_ENVIRONMENT_ID}" lists them; the bundle's are not kept and cannot be removed.`,
        });
      }

      const before = Option.match(kept, {
        onNone: () => `${name}, no longer kept for every Environment`,
        onSome: (skill) => `${name}: ${skill.description}`,
      });

      return yield* withApproval(
        approvals,
        api,
        {
          tool,
          target: "every Environment",
          change: `Remove the Skill ${JSON.stringify(name)}`,
          before,
          after:
            "Removed for every Environment: each Environment serves its own Skill of the name if it has one, else the bundle's",
          reason,
          expected: {
            savedAt: Option.match(kept, { onNone: () => null, onSome: (skill) => skill.savedAt }),
          },
        },
        (answer) =>
          Effect.gen(function* () {
            if (!answer.approved) {
              return declined(answer, `removing the Skill ${name} from every Environment`);
            }

            const asked = Schema.decodeUnknownOption(RemoveAsked)(answer.expected);

            const removed = yield* environments.removeSkill({
              environment: EVERY_ENVIRONMENT_ID,
              name,
              expected: Option.getOrUndefined(asked),
              author: { conversation: api.conversationId, tool, reason, approved: true },
            });

            switch (removed.status) {
              case "missing":
                return yield* notFound(EVERY_ENVIRONMENT_ID);
              case "absent":
                return {
                  output: [
                    {
                      type: "text" as const,
                      text: approvedAlready(
                        `no Skill named "${name}" is kept for every Environment`,
                      ),
                    },
                  ],
                  details: { approval: { approved: true } },
                };
              case "changed-since":
                return yield* EnvironmentsError.make({
                  message: `The user approved, but the Skill ${name} kept for every Environment was saved again since they were asked: nothing was removed. Ask again if it should still be removed.`,
                });
              case "removed": {
                const { change } = removed;
                const current = yield* environments.current;

                yield* log.record({
                  tool,
                  environmentName: removed.environment.name,
                  field: change.field,
                });

                return {
                  output: [
                    {
                      type: "text" as const,
                      text: Arr.join(
                        [
                          `The user approved: removed the Skill ${name} from every Environment.`,
                          removed.bundled
                            ? `The bundle's Skill of that name is served at ${servedAt(name)} again, where an Environment keeps none of its own.`
                            : `Nothing is served at ${servedAt(name)} any more, where an Environment keeps none of its own.`,
                          reachEvery(removed.handed, removed.overriddenIn, current),
                          PROMPT_NOTE,
                          "The change is recorded as approved with your reason and the files the Skill had, and the user can revert it on the Environments page.",
                        ],
                        " ",
                      ),
                    },
                  ],
                  details: {
                    approval: { approved: true },
                    agentChange: {
                      id: change.id,
                      environment: removed.environment,
                      field: change.field,
                      before: asJsonValue(change.before),
                      after: asJsonValue(change.after),
                    },
                    own: removed.handed,
                  },
                };
              }
            }
          }),
      );
    });

  const save = defineEffectTool({
    name: "environment_skill_save",
    description: Arr.join(
      [
        `Save a Skill for an Environment (this Session's unless id names another), from its folder in the Workspace: a folder you wrote (such as ${WORKSPACE_ROOT}/.cloudpid/tmp/<name>), or one \`npx skills add <source> --copy\` made. Every Workspace of the Environment then serves it read-only at ${SKILLS_ROOT}/<name>, over the Skill of the same name kept for every Environment and the bundle's, and lists it among the skills; Workspaces of other Environments do not. A Skill of the same name the Environment keeps is replaced. Saving a Skill whose name is also kept for every Environment makes the Environment's own copy, which wins in this Environment only.`,
        `With id "${EVERY_ENVIRONMENT_ID}" the Skill is kept for every Environment: every Environment's Workspaces serve it at their next readying (this Session's at once, unless its Environment keeps its own Skill of the name). A Skill there steers every future Session, so the user must approve the change: ${APPROVAL}`,
        "The folder holds a SKILL.md whose YAML frontmatter sets name (1 to 64 lowercase letters, digits and hyphens, not starting or ending with a hyphen, no two in a row, and the folder's own name) and description (at most 1024 characters, saying what the Skill does and when to use it), and any files it refers to. The files must be text, at most 128 KB each and 1 MB together, with nothing that looks like a credential or a path on somebody's machine (/home/<user>/…), nor the value of a Secret this Session holds. A Skill set holds at most 100 Skills and 8 MB, every layer and the bundle counted; a Skill for every Environment is refused when any Environment's set would pass either.",
        "To change a Skill, copy its folder from the skills directory to a scratch folder, edit it there, and save it again. The change is recorded with your reason and the files before and after, and the user can see the difference and revert it on the Environments page.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: Schema.optionalKey(idOrEvery("a Skill kept for every Environment")),
      path: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: `The Skill's folder in the Workspace, absolute or relative to the working directory, such as ${WORKSPACE_ROOT}/.cloudpid/tmp/release-notes`,
      }),
      reason: SkillReason,
    }),
    executionMode: "sequential",
    // A rerun after an eviction waits for the request a change to every Environment made, or takes its answer; one to an
    // Environment's own Skills finds its change made (the same files record nothing again).
    replay: "safe",
    execute: ({ id, path, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([{ what: "the reason", text: reason }]);

        if (api.env === undefined) return yield* refused("no execution environment is configured");

        const everywhere = id === EVERY_ENVIRONMENT_ID;

        const { environment, own } = everywhere
          ? { environment: EVERY_ENVIRONMENT_ID, own: false }
          : yield* target(id);

        const { folder, files } = yield* readSkillFolder(api.env, path);

        // Saved as written, served to every Workspace of the Environment, and read by the agent.
        yield* refuseSecrets(
          Arr.map(Record.toEntries(files), ([file, text]) => ({ what: `the file ${file}`, text })),
        );

        if (everywhere) return yield* saveEverywhere({ folder, files, path, reason }, api);

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
          // Only a save made against an expected Skill, which a change to an Environment's own Skills never gives.
          case "changed-since":
            return yield* refused(`the Skill ${folder} was saved again meanwhile`);
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
            yield* log.record({
              tool: "environment_skill_save",
              environmentName: saved.environment.name,
              field: saved.change.field,
            });

            return savedResult(saved, {
              count: Record.size(files),
              own,
              current: null,
              approved: false,
            });
          }
        }
      }),
  });

  const remove = defineEffectTool({
    name: "environment_skill_remove",
    description: `Remove a Skill the Environment keeps (this Session's Environment unless id names another): its Workspaces stop serving it at ${SKILLS_ROOT}/<name>, and serve the Skill of that name kept for every Environment again if there is one, else the bundle's. environment_get lists the Environment's own Skills; those kept for every Environment and the bundle's are not the Environment's and cannot be removed this way. With id "${EVERY_ENVIRONMENT_ID}" the Skill is removed from those kept for every Environment, which the user must approve: ${APPROVAL} The change is recorded with your reason and the files the Skill had, and the user can revert it on the Environments page.`,
    parameters: Schema.Struct({
      id: Schema.optionalKey(idOrEvery("a Skill kept for every Environment")),
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

        if (id === EVERY_ENVIRONMENT_ID) return yield* removeEverywhere({ name, reason }, api);

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
              message: `Nothing was removed: ${named(removed.environment)} keeps no Skill named "${name}". environment_get lists the Skills it keeps; those kept for every Environment and the bundle's are not the Environment's.`,
            });
          // Only a removal made against an expected Skill, which a change to an Environment's own Skills never gives.
          case "changed-since":
            return yield* EnvironmentsError.make({
              message: `Nothing was removed: the Skill ${name} was saved again meanwhile.`,
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
                      removed.inherited
                        ? `The Skill of that name kept for every Environment is served at ${servedAt(name)} instead.`
                        : removed.bundled
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
