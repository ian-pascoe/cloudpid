// What `environment_skill_save` and `environment_skill_remove` are built over and say (ADR-0026, `docs/spec.md` → Agent
// changes): the Session's `EnvironmentSkills` service they call, what each call can come to (`SkillSaved`,
// `SkillRemoved`), and the results they give for each, shared by a change to an Environment's own Skills and one to those
// kept for every Environment (which waits for the owner's Approval first: `./environment-skills-every.ts`).
//
// `environment.ts` imports `./environment-skills.ts`, which imports this file, so what it takes from `environment.ts` is
// used inside functions only: its exports are not there yet when this module loads.
// @effect-diagnostics missingPipeableSignature:off
import {
  type AgentChange,
  type ListedSkill,
  type SkillExpectation,
  SKILLS_ROOT,
  skillField,
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
import { EVERY_ENVIRONMENT_ID, EVERY_ENVIRONMENT_NAME } from "./environment-secret-marks.ts";

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
      readonly bundled: boolean;
      /** Whether it is an Environment's own Skill that hides the one of the name kept for every Environment. */
      readonly inherited: boolean;
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

/** How an install of Skills from GitHub went. */
export type SkillsInstalled =
  | {
      readonly status: "installed";
      readonly environment: ChangedEnvironment;
      readonly repo: string;
      readonly ref: string | null;
      readonly commit: string;
      /** Each Skill the source gave, in the order the Registry answered. */
      readonly results: ReadonlyArray<{
        readonly name: string;
        /** Its folder in the repo. */
        readonly path: string;
        readonly outcome: "installed" | "unchanged" | "rejected";
        /** Why it was refused: each problem a line. */
        readonly message?: string | undefined;
        readonly change?: AgentChange | undefined;
        /** Whether it hides the bundle's Skill of the name. */
        readonly shadows?: boolean | undefined;
      }>;
      /** Whether this Session's own Workspace serves them now: it is the Environment's, and took the new Skill set. */
      readonly handed: boolean;
    }
  /** The source holds several Skills and none was named: nothing was installed. */
  | {
      readonly status: "listed";
      readonly environment: ChangedEnvironment;
      readonly repo: string;
      readonly ref: string | null;
      readonly commit: string;
      readonly available: ReadonlyArray<ListedSkill>;
    }
  /** Nothing was installed: the source is not one, GitHub gave no answer, or the repo holds no such Skill. */
  | { readonly status: "refused"; readonly message: string }
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
  }) => Effect.Effect<SkillsInstalled, EnvironmentsError>;
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

/** Every Environment, as a change to the Skills kept for it names it. */
export const EVERY = { id: EVERY_ENVIRONMENT_ID, name: EVERY_ENVIRONMENT_NAME };

/** A Schema `Json` value as the details' `JsonValue`, which differs only in that its arrays are mutable. */
// SAFETY: the two types describe the same values; the details are never mutated.
export const asJsonValue = (value: AgentChange["before"]): JsonValue | null =>
  value as JsonValue | null;

/** The refusal of a save: nothing was saved. */
export const refused = (message: string) =>
  EnvironmentsError.make({ message: `Nothing was saved: ${message}` });

/** Where a Skill is served in each Workspace of its Environment. */
export const servedAt = (name: string): string => `${SKILLS_ROOT}/${name}`;

/** An Environment as a result names it, or every Environment. */
export const named = ({ id, name }: ChangedEnvironment): string =>
  id === EVERY_ENVIRONMENT_ID
    ? EVERY_ENVIRONMENT_NAME
    : `Environment ${JSON.stringify(name)} (${id})`;

/** What a result says of where a change to an Environment's own Skills reaches. */
export const reach = (environment: ChangedEnvironment, handed: boolean, own: boolean): string =>
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
  /** The Environment the call named, or every Environment (`EVERY_ENVIRONMENT_ID`). */
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
    const everywhere = scope === EVERY_ENVIRONMENT_ID;

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
        const current = everywhere ? yield* environments.current : null;

        yield* log.record({
          tool,
          environmentName: saved.environment.name,
          field: change.field,
        });

        const details = {
          agentChange: changeDetails(saved.environment, change),
          path: servedAt(saved.name),
          own: everywhere ? saved.handed : own,
        };

        return {
          output: [
            {
              type: "text" as const,
              text: Arr.join(
                [
                  `${approved ? "The user approved: " : ""}${change.before === null ? "Saved the new Skill" : "Saved the Skill"} ${saved.name} for ${named(saved.environment)} (${count} file${count === 1 ? "" : "s"})${saved.bundled ? ", over the bundle's Skill of that name" : ""}.`,
                  saved.handed
                    ? `It is served now at ${servedAt(saved.name)} (read-only): read ${servedAt(saved.name)}/SKILL.md to use it.`
                    : `It is served at ${servedAt(saved.name)} (read-only) in each Workspace${everywhere ? "" : " of the Environment"}.`,
                  ...(saved.inherited
                    ? [
                        "It hides the Skill of that name kept for every Environment, in this Environment.",
                      ]
                    : []),
                  everywhere
                    ? reachEvery(saved.handed, saved.overriddenIn, current)
                    : reach(saved.environment, saved.handed, own),
                  PROMPT_NOTE,
                  `The change is recorded${approved ? " as approved" : ""} with your reason and the files before and after, and the user can revert it on the Environments page.`,
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
    const everywhere = scope === EVERY_ENVIRONMENT_ID;

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
              message: `Nothing was removed: ${named(removed.environment)} keeps no Skill named "${name}" (if an earlier run of this call removed it before the Session restarted, it is done). environment_get lists the Skills it keeps; those kept for every Environment and the bundle's are not the Environment's.`,
            });
      case "removed": {
        const { change } = removed;
        const current = everywhere ? yield* environments.current : null;

        yield* log.record({
          tool,
          environmentName: removed.environment.name,
          field: change.field,
        });

        const details = {
          agentChange: changeDetails(removed.environment, change),
          own: everywhere ? removed.handed : own,
        };

        return {
          output: [
            {
              type: "text" as const,
              text: Arr.join(
                [
                  `${approved ? "The user approved: removed" : "Removed"} the Skill ${name} from ${named(removed.environment)}.`,
                  everywhere
                    ? removed.bundled
                      ? `The bundle's Skill of that name is served at ${servedAt(name)} again, where an Environment keeps none of its own.`
                      : `Nothing is served at ${servedAt(name)} any more, where an Environment keeps none of its own.`
                    : removed.inherited
                      ? `The Skill of that name kept for every Environment is served at ${servedAt(name)} instead.`
                      : removed.bundled
                        ? `The bundle's Skill of that name is served at ${servedAt(name)} again.`
                        : `Nothing is served at ${servedAt(name)} any more.`,
                  everywhere
                    ? reachEvery(removed.handed, removed.overriddenIn, current)
                    : reach(removed.environment, removed.handed, own),
                  PROMPT_NOTE,
                  `The change is recorded${approved ? " as approved" : ""} with your reason and the files the Skill had, and the user can revert it on the Environments page.`,
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
