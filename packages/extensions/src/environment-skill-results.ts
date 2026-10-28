// What `environment_skill_save` and `environment_skill_remove` are built over and say (ADR-0026, `docs/architecture/agent-changes.md`):
// the Session's `EnvironmentSkills` service they call, what each call can come to (`SkillSaved`,
// `SkillRemoved`), and the results they give for each, shared by a change to an Environment's own Skills and one to those
// kept Global (which waits for the owner's Approval first: `./environment-skills-global.ts`).
//
// `environment.ts` imports `./environment-skills.ts`, which imports this file, so what it takes from `environment.ts` is
// used inside functions only: its exports are not there yet when this module loads.
// @effect-diagnostics missingPipeableSignature:off
import {
  type AgentChange,
  type SkillExpectation,
  type SkillInstallation,
  type SkillInstallPin,
  type SkillInstallPreview,
  type SkillUpdatePin,
  type SkillUpdatePreview,
  type SkillUpdateRun,
  shortSha,
  SKILLS_ROOT,
  skillField,
  skillSourceText,
} from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { ApprovalsService } from "./approvals.ts";
import { approvedAlready } from "./approvals.ts";
import {
  type ChangeAuthor,
  type ChangedEnvironment,
  EnvironmentsError,
  type EnvironmentsService,
  type RunChange,
} from "./environment.ts";
import { GLOBAL_ID, GLOBAL_NAME } from "./environment-secret-marks.ts";

/** How the save of a Skill went. */
export type SkillSaved =
  | {
      readonly status: "saved";
      /** The Environment, or Global (`GLOBAL_ID`). */
      readonly environment: ChangedEnvironment;
      /** The change as the Registry recorded it, with the files before and after by hash. */
      readonly change: AgentChange;
      readonly name: string;
      /** Whether it is an Environment's own Skill that hides the one of the name kept Global. */
      readonly inherited: boolean;
      /**
       * For a Skill kept Global: the Environments whose own Skill of the name hides it, so it does not
       * reach them.
       */
      readonly overriddenIn: ReadonlyArray<ChangedEnvironment>;
      /**
       * Whether this Session's own Workspace serves it now: it took the new Skill set (it is the Environment's, or the
       * Skill is kept Global and its Environment does not keep one of the name).
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

/**
 * How an install of Skills from GitHub went: as the Registry answers (`SkillInstallation`), and for one that kept Skills,
 * whether this Session's own Workspace serves them now (it took the new Skill set: it is the Environment's, or the Skills
 * are kept Global and its Environment does not hide all of them).
 */
export type SkillsInstalled =
  | Exclude<SkillInstallation, { readonly status: "installed" }>
  | (Extract<SkillInstallation, { readonly status: "installed" }> & { readonly handed: boolean });

/**
 * How an update of Skills went: as the Registry answers (`SkillUpdateRun`), and for one that was made, whether this
 * Session's own Workspace serves the new Skill set now.
 */
export type SkillsUpdated =
  | Exclude<SkillUpdateRun, { readonly status: "done" }>
  | (Extract<SkillUpdateRun, { readonly status: "done" }> & { readonly handed: boolean });

/** How the removal of a Skill went. */
export type SkillRemoved =
  | {
      readonly status: "removed";
      readonly environment: ChangedEnvironment;
      readonly change: AgentChange;
      /** Whether the Skill of the name kept Global is served in its place, for an Environment's own. */
      readonly inherited: boolean;
      /** For a Skill kept Global: the Environments whose own Skill of the name stays served there. */
      readonly overriddenIn: ReadonlyArray<ChangedEnvironment>;
      /**
       * Whether this Session's own Workspace no longer serves it: it took the new Skill set (it is the Environment's, or
       * the Skill was kept Global and its Environment keeps none of the name).
       */
      readonly handed: boolean;
    }
  /** The scope keeps no Skill of the name. */
  | { readonly status: "absent"; readonly environment: ChangedEnvironment }
  /** The Skill of the name was saved again since the owner was asked (`expected`): nothing was removed. */
  | { readonly status: "changed-since"; readonly environment: ChangedEnvironment }
  /** Removing it would serve a Skill of the layer below that does not fit a Skill set: nothing was removed. */
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "missing" };

/** What a save of a Skill would do, checked as the Registry checks it, with nothing saved or recorded. */
export type SkillPreview =
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
 * What the Session does for the Skills of an Environment and of Global (`GLOBAL_ID`), over the
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
    /** What the Skill of the name must still be: the one the owner's Approval was asked against. */
    readonly expected?: SkillExpectation | undefined;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<SkillSaved, EnvironmentsError>;
  /** What `saveSkill` would do with the same folder and files, nothing saved or recorded. */
  readonly previewSkill: (input: {
    readonly environment: string;
    readonly folder: string;
    readonly files: Readonly<Record<string, string>>;
  }) => Effect.Effect<SkillPreview, EnvironmentsError>;
  readonly removeSkill: (input: {
    readonly environment: string;
    readonly name: string;
    /** What the Skill must still be: the one the owner's Approval was asked against. */
    readonly expected?: SkillExpectation | undefined;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<SkillRemoved, EnvironmentsError>;
  /**
   * Install from the GitHub `source` the Skills `skills` names (`["*"]` for all; absent: the only one, else the list),
   * fetched by the Registry as the GitHub App, never by the Session.
   */
  readonly installSkills: (input: {
    readonly environment: string;
    readonly source: string;
    readonly skills?: ReadonlyArray<string> | undefined;
    readonly author: ChangeAuthor;
    /** What the owner's Approval was asked against: read at its commit, and a Skill kept only while it still holds. */
    readonly pin?: SkillInstallPin | undefined;
  }) => Effect.Effect<SkillsInstalled, EnvironmentsError>;
  /**
   * Update the Skills `names` (absent: every one marked update available) the scope keeps to the latest commit of their
   * recorded ref, fetched by the Registry as the GitHub App; a modified Skill is refused unless `overwrite`. With `pins`,
   * the commits and folders the owner was shown, and only while each Skill was last saved then.
   */
  readonly updateSkills: (input: {
    readonly environment: string;
    readonly names?: ReadonlyArray<string> | undefined;
    readonly overwrite: boolean;
    readonly pins?: ReadonlyArray<SkillUpdatePin> | undefined;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<SkillsUpdated, EnvironmentsError>;
  /** What `updateSkills` would do with the same names, nothing saved or recorded. */
  readonly previewUpdates: (input: {
    readonly environment: string;
    readonly names?: ReadonlyArray<string> | undefined;
    readonly overwrite: boolean;
  }) => Effect.Effect<SkillUpdatePreview, EnvironmentsError>;
  /** What `installSkills` would do with the same source, nothing kept or recorded. */
  readonly previewInstall: (input: {
    readonly environment: string;
    readonly source: string;
    readonly skills?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<SkillInstallPreview, EnvironmentsError>;
};

/** What the tools need of `EnvironmentTools`: what they build over, and its refusals. */
export type SkillToolDeps = {
  readonly environments: EnvironmentsService;
  /** The Session's Approval requests, which a change to the Skills kept Global waits on. */
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

/** Global, as a change to the Skills kept for it names it. */
export const GLOBAL_TARGET = { id: GLOBAL_ID, name: GLOBAL_NAME };

/** A Schema `Json` value as the details' `JsonValue`, which differs only in that its arrays are mutable. */
// SAFETY: the two types describe the same values; the details are never mutated.
export const asJsonValue = (value: AgentChange["before"]): JsonValue | null =>
  value as JsonValue | null;

/** The refusal of a save: nothing was saved. */
export const refused = (message: string) =>
  EnvironmentsError.make({ message: `Nothing was saved: ${message}` });

/** Where a Skill is served in each Workspace of its Environment. */
export const servedAt = (name: string): string => `${SKILLS_ROOT}/${name}`;

/** An Environment as a result names it, or Global. */
export const named = ({ id, name }: ChangedEnvironment): string =>
  id === GLOBAL_ID ? GLOBAL_NAME : `Environment ${JSON.stringify(name)} (${id})`;

/** What a result says of where a change to an Environment's own Skills reaches. */
export const reach = (environment: ChangedEnvironment, handed: boolean, own: boolean): string =>
  handed
    ? `This Session's Workspace has the change now; the other Workspaces of ${named(environment)} and its spare get it at their next readying, and those of other Environments never do.`
    : own
      ? `This Session's Workspace gets it at its next readying (it could not take it now), as do the other Workspaces of ${named(environment)} and its spare.`
      : `The Workspaces of ${named(environment)} and its spare get it at their next readying; this Session's Workspace, of another Environment, does not.`;

/**
 * What a result says of where a change to the Skills kept Global reaches: each Environment's Workspaces
 * and spares at their next readying, this Session's Workspace at once unless its Environment keeps its own Skill of the
 * name, and not the Environments that do.
 */
const reachGlobal = (
  handed: boolean,
  overriddenIn: ReadonlyArray<ChangedEnvironment>,
  current: string | null,
): string => {
  const hereHidden = Arr.some(overriddenIn, ({ id }) => id === current);
  const others = Arr.filter(overriddenIn, ({ id }) => id !== current);

  return Arr.join(
    [
      "Each Environment's Workspaces and spares get it at their next readying.",
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

/**
 * What the result of an install of several Skills kept Global says of where it reaches: as
 * `reachGlobal`, but for each Skill, since an Environment's own Skill hides only the one of its name.
 */
const reachInstalledGlobal = (
  handed: boolean,
  saved: ReadonlyArray<{
    readonly name: string;
    readonly overriddenIn?: ReadonlyArray<ChangedEnvironment> | undefined;
  }>,
  current: string | null,
): string => {
  const hidden = Arr.filter(saved, (skill) => (skill.overriddenIn ?? []).length > 0);

  const hereHidden =
    saved.length > 0 &&
    Arr.every(saved, (skill) => Arr.some(skill.overriddenIn ?? [], ({ id }) => id === current));

  return Arr.join(
    [
      "Each Environment's Workspaces and spares get them at their next readying.",
      handed
        ? "This Session's Workspace has the change now."
        : hereHidden
          ? "This Session's Environment keeps its own Skill of each name, which hides them there."
          : "This Session's Workspace gets them at their next readying (it could not take them now).",
      ...Arr.map(
        hidden,
        (skill) =>
          `${skill.name} does not reach ${Arr.join(Arr.map(skill.overriddenIn ?? [], named), ", ")}, whose own Skill of that name hides it.`,
      ),
    ],
    " ",
  );
};

export const PROMPT_NOTE =
  "The skills list in your system prompt changes at the next Context Window (after a Handoff, or in a new Session).";

/** The agent change a result carries as its details, with the files before and after by hash. */
const changeDetails = (environment: ChangedEnvironment, change: AgentChange) => ({
  id: change.id,
  environment,
  field: change.field,
  before: asJsonValue(change.before),
  after: asJsonValue(change.after),
});

/** `details` marked as made with the owner's Approval, when it was. */
const withApprovalMark = <D extends object>(details: D, approved: boolean) =>
  approved ? { approval: { approved: true }, ...details } : details;

/** What a call knows of how it was made, which its result says. */
export type SkillCall = {
  readonly environments: Pick<EnvironmentsService, "current">;
  readonly log: SkillToolDeps["log"];
  readonly notFound: SkillToolDeps["notFound"];
  /** The Environment the call named, or Global (`GLOBAL_ID`). */
  readonly scope: string;
  /** Whether the call named the Session's own Environment (for an Environment's own Skills). */
  readonly own: boolean;
  /** Whether the owner approved the change first: the result says so. */
  readonly approved: boolean;
};

/** The result of the save of Skill `folder`, whatever it came to: the tool's own result, or its refusal. */
export const savedOutcome = (
  saved: SkillSaved,
  {
    environments,
    log,
    notFound,
    scope,
    own,
    approved,
    folder,
    count,
    note,
  }: SkillCall & {
    readonly folder: string;
    readonly count: number;
    /** A sentence the agent is told after a save that was approved, such as what the owner could not review. */
    readonly note?: string | undefined;
  },
) =>
  Effect.gen(function* () {
    const tool = "environment_skill_save";
    const atGlobal = scope === GLOBAL_ID;

    switch (saved.status) {
      case "missing":
        return yield* notFound(scope);
      case "rejected":
        return yield* approved
          ? EnvironmentsError.make({
              message: `The user approved, but nothing was saved:\n${saved.message}`,
            })
          : refused(`\n${saved.message}`);
      case "changed-since":
        return yield* EnvironmentsError.make({
          message: `${approved ? "The user approved, but the" : "The"} Skill ${folder} kept for ${named(saved.environment)} was saved again since the user was asked: nothing was saved. Ask again if the Skill is still needed.`,
        });
      case "unchanged":
        return approved
          ? {
              output: [
                {
                  type: "text" as const,
                  text: approvedAlready(
                    `${named(saved.environment)} keeps the Skill ${saved.name} with these files`,
                  ),
                },
              ],
              details: { approval: { approved: true } },
            }
          : {
              output: [
                {
                  type: "text" as const,
                  text: `${named(saved.environment)} keeps the Skill ${saved.name} with these files already: nothing was changed or recorded now (if an earlier run of this call saved it before the Session restarted, it is done). It is at ${servedAt(saved.name)}.`,
                },
              ],
              details: {
                unchanged: { environment: saved.environment, field: skillField(saved.name) },
              },
            };
      case "saved": {
        const { change } = saved;
        const current = atGlobal ? yield* environments.current : null;

        yield* log.record({
          tool,
          environmentName: saved.environment.name,
          field: change.field,
        });

        const details = {
          agentChange: changeDetails(saved.environment, change),
          path: servedAt(saved.name),
          own: atGlobal ? saved.handed : own,
        };

        return {
          output: [
            {
              type: "text" as const,
              text: Arr.join(
                [
                  `${approved ? "The user approved: " : ""}${change.before === null ? "Saved the new Skill" : "Saved the Skill"} ${saved.name} for ${named(saved.environment)} (${count} file${count === 1 ? "" : "s"}).`,
                  saved.handed
                    ? `It is served now at ${servedAt(saved.name)} (read-only): read ${servedAt(saved.name)}/SKILL.md to use it.`
                    : `It is served at ${servedAt(saved.name)} (read-only) in each Workspace${atGlobal ? "" : " of the Environment"}.`,
                  ...(saved.inherited
                    ? ["It hides the Skill of that name kept Global, in this Environment."]
                    : []),
                  atGlobal
                    ? reachGlobal(saved.handed, saved.overriddenIn, current)
                    : reach(saved.environment, saved.handed, own),
                  PROMPT_NOTE,
                  `The change is recorded${approved ? " as approved" : ""} with your reason and the files before and after, and the user can revert it on the Skills page.`,
                  ...(approved && note !== undefined ? [note] : []),
                ],
                " ",
              ),
            },
          ],
          details: withApprovalMark(details, approved),
        };
      }
    }
  });

/**
 * The result of an install, whatever it came to: the tool's own result, or its refusal. `approved`: the owner approved the
 * install first (one at Global), which the result and its record say.
 */
export const installedOutcome = (
  installed: SkillsInstalled,
  {
    environments,
    log,
    notFound,
    scope,
    own,
    approved,
    note,
  }: SkillCall & {
    /** A sentence the agent is told after an install that was approved, such as what the owner could not review. */
    readonly note?: string | undefined;
  },
) =>
  Effect.gen(function* () {
    const tool = "environment_skill_install";
    const atGlobal = scope === GLOBAL_ID;

    switch (installed.status) {
      case "missing":
        return yield* notFound(scope);
      case "refused":
        return yield* EnvironmentsError.make({
          message: `${approved ? "The user approved, but nothing" : "Nothing"} was installed: ${installed.message}`,
        });
      case "listed": {
        const { available, repo, commit } = installed;

        return {
          output: [
            {
              type: "text" as const,
              text: Arr.join(
                [
                  `Installed nothing: ${repo} (at ${shortSha(commit)}) holds ${available.length} Skills and none was named:`,
                  ...Arr.map(
                    available,
                    (skill) =>
                      `- ${skill.name}${skill.path === "" ? "" : ` (${skill.path})`}: ${skill.description}`,
                  ),
                  'Ask the user which they want, then call environment_skill_install again with the same source and skills set to their names (["*"] for all of them).',
                ],
                "\n",
              ),
            },
          ],
          details: {
            listed: { repo, commit, skills: Arr.map(available, (skill) => skill.name) },
          },
        };
      }

      case "installed": {
        const { results, repo, ref, commit } = installed;
        const saved = Arr.filter(results, (result) => result.outcome === "installed");
        const unchanged = Arr.filter(results, (result) => result.outcome === "unchanged");
        const rejected = Arr.filter(results, (result) => result.outcome === "rejected");

        const problems = Arr.map(
          rejected,
          (result) =>
            `- ${result.name}${result.path === "" ? "" : ` (${result.path})`}: ${result.message ?? "refused"}`,
        );

        if (saved.length === 0 && unchanged.length === 0) {
          return yield* EnvironmentsError.make({
            message: Arr.join(
              [
                `${approved ? "The user approved, but nothing" : "Nothing"} was installed from ${repo}; each Skill was refused:`,
                ...problems,
              ],
              "\n",
            ),
          });
        }

        const changes = Arr.flatMap(saved, (result) =>
          result.change === undefined ? [] : [result.change],
        );

        for (const change of changes) {
          yield* log.record({
            tool,
            environmentName: installed.environment.name,
            field: change.field,
          });
        }

        const pinned = skillSourceText({ repo, path: "", ref, commit });

        const listOf = (list: typeof results) =>
          Arr.join(
            Arr.map(list, (result) => result.name),
            ", ",
          );

        const first = (saved[0] ?? unchanged[0])?.name ?? "<name>";
        const current = atGlobal ? yield* environments.current : null;

        const details = {
          agentChanges: Arr.map(changes, (change) => changeDetails(installed.environment, change)),
          own: atGlobal ? installed.handed : own,
        };

        return {
          output: [
            {
              type: "text" as const,
              text: Arr.join(
                [
                  ...(saved.length === 0
                    ? []
                    : [
                        `${approved ? "The user approved: installed" : "Installed"} ${Arr.join(
                          Arr.map(saved, (result) => result.name),
                          ", ",
                        )} for ${named(installed.environment)} from ${pinned}.`,
                      ]),
                  ...(unchanged.length === 0
                    ? []
                    : [
                        `${listOf(unchanged)} ${unchanged.length === 1 ? "was" : "were"} installed from ${pinned} already: nothing changed, and nothing was recorded for ${unchanged.length === 1 ? "it" : "them"}.`,
                      ]),
                  ...(problems.length === 0
                    ? []
                    : ["Refused (the others were installed):", ...problems]),
                  installed.handed
                    ? `They are served now at ${SKILLS_ROOT}/<name> (read-only): read ${SKILLS_ROOT}/${first}/SKILL.md to use one.`
                    : `They are served at ${SKILLS_ROOT}/<name> (read-only) in each Workspace${atGlobal ? "" : " of the Environment"}.`,
                  atGlobal
                    ? reachInstalledGlobal(installed.handed, saved, current)
                    : reach(installed.environment, installed.handed, own),
                  PROMPT_NOTE,
                  ...(saved.length === 0
                    ? []
                    : [
                        `Each change is recorded${approved ? " as approved" : ""} with your reason and the files before and after, and the user can revert it on the Skills page.`,
                      ]),
                  ...(approved && note !== undefined ? [note] : []),
                ],
                " ",
              ),
            },
          ],
          details: withApprovalMark(details, approved),
        };
      }
    }
  });

/** The result of the removal of Skill `name`, whatever it came to: the tool's own result, or its refusal. */
export const removedOutcome = (
  removed: SkillRemoved,
  {
    environments,
    log,
    notFound,
    scope,
    own,
    approved,
    name,
  }: SkillCall & { readonly name: string },
) =>
  Effect.gen(function* () {
    const tool = "environment_skill_remove";
    const atGlobal = scope === GLOBAL_ID;

    switch (removed.status) {
      case "missing":
        return yield* notFound(scope);
      case "rejected":
        return yield* EnvironmentsError.make({
          message: `${approved ? "The user approved, but nothing" : "Nothing"} was removed:\n${removed.message}`,
        });
      case "changed-since":
        return yield* EnvironmentsError.make({
          message: `${approved ? "The user approved, but the" : "The"} Skill ${name} kept for ${named(removed.environment)} was saved again since the user was asked: nothing was removed. Ask again if it should still be removed.`,
        });
      case "absent":
        return approved
          ? {
              output: [
                {
                  type: "text" as const,
                  text: approvedAlready(
                    `${named(removed.environment)} keeps no Skill named "${name}"`,
                  ),
                },
              ],
              details: { approval: { approved: true } },
            }
          : yield* EnvironmentsError.make({
              message: `Nothing was removed: ${named(removed.environment)} keeps no Skill named "${name}" (if an earlier run of this call removed it before the Session restarted, it is done). environment_get lists the Skills it keeps; those kept Global are not the Environment's.`,
            });
      case "removed": {
        const { change } = removed;
        const current = atGlobal ? yield* environments.current : null;

        yield* log.record({
          tool,
          environmentName: removed.environment.name,
          field: change.field,
        });

        const details = {
          agentChange: changeDetails(removed.environment, change),
          own: atGlobal ? removed.handed : own,
        };

        return {
          output: [
            {
              type: "text" as const,
              text: Arr.join(
                [
                  `${approved ? "The user approved: removed" : "Removed"} the Skill ${name} from ${named(removed.environment)}.`,
                  atGlobal
                    ? `Nothing is served at ${servedAt(name)} any more, where an Environment keeps none of its own.`
                    : removed.inherited
                      ? `The Skill of that name kept Global is served at ${servedAt(name)} instead.`
                      : `Nothing is served at ${servedAt(name)} any more.`,
                  atGlobal
                    ? reachGlobal(removed.handed, removed.overriddenIn, current)
                    : reach(removed.environment, removed.handed, own),
                  PROMPT_NOTE,
                  `The change is recorded${approved ? " as approved" : ""} with your reason and the files the Skill had, and the user can revert it on the Skills page.`,
                ],
                " ",
              ),
            },
          ],
          details: withApprovalMark(details, approved),
        };
      }
    }
  });
