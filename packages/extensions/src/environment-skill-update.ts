// `environment_skill_update` (ADR-0026, `docs/spec.md` → Agent changes, and → Installing from GitHub → Updates): move
// installed Skills to the latest commit of their recorded ref. The Registry fetches it as the GitHub App, never the
// Session or a Container, and keeps the files as an Agent change for each Skill, with the files and the Skill source
// before and after, so the user's revert brings back the earlier commit and any edits an overwrite replaced. A Skill the
// agent edited since it was installed (**modified**) is refused unless `overwrite` is set, and the result names it.
// With `id: "*"` the update waits for the owner's Approval (`./environment-skills-every.ts`), which shows the files each
// Skill would take and is made at exactly the commits they were shown.
//
// `environment.ts` imports this module through `./environment-skills.ts`, so what it takes from `environment.ts` is used
// inside functions only: its exports are not there yet when this module loads.
// @effect-diagnostics missingPipeableSignature:off
import { defineEffectTool } from "@cloudpid/effect-durable";
import { SKILLS_ROOT, shortSha, skillSourceText } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { askedBefore, approvedAlready, declined, withApproval } from "./approvals.ts";
import type { ApprovalCall } from "./approvals.ts";
import { type ChangedEnvironment, EnvironmentsError, idOrEvery, Reason } from "./environment.ts";
import { EVERY_ENVIRONMENT_ID } from "./environment-secret-marks.ts";
import {
  asJsonValue,
  named,
  PROMPT_NOTE,
  reach,
  type SkillToolDeps,
  type SkillUpdatePin,
  type SkillUpdateReady,
  type SkillUpdateResult,
  type SkillUpdatesPreview,
  type SkillsUpdated,
} from "./environment-skill-results.ts";
import { cardOfSkills, MAX_CARD_CHARS, SKILL_APPROVAL } from "./environment-skills-every.ts";

const TOOL = "environment_skill_update";

/** What an Approval of an update was asked against: the updates shown, and whether the edits they replace were. */
const UpdateAsked = Schema.Struct({
  overwrite: Schema.Boolean,
  pins: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      savedAt: Schema.Finite,
      commit: Schema.String,
      folderHash: Schema.String,
    }),
  ),
});

type UpdateDeps = Pick<SkillToolDeps, "environments" | "approvals" | "log" | "notFound">;

/** The Skills' names as a sentence part. */
const namesOf = (results: ReadonlyArray<{ readonly name: string }>): string =>
  Arr.join(
    Arr.map(results, ({ name }) => name),
    ", ",
  );

/** The lines that tell what became of each Skill that was not moved. */
const problemLines = (results: ReadonlyArray<SkillUpdateResult>): ReadonlyArray<string> =>
  Arr.flatMap(results, (result) =>
    result.outcome === "updated" || result.outcome === "unchanged"
      ? []
      : [`- ${result.name} (${result.outcome}): ${result.message}`],
  );

/**
 * The result of an update, whatever it came to: the tool's own result, or its refusal when no Skill was moved or found
 * up to date. `scope` is the Environment the call named, or every Environment.
 */
const updatedOutcome = (
  updated: SkillsUpdated,
  {
    environments,
    log,
    notFound,
    scope,
    own,
    approved,
  }: UpdateDeps & {
    readonly scope: string;
    /** Whether the call named the Session's own Environment (for an Environment's own Skills). */
    readonly own: boolean;
    readonly approved: boolean;
  },
) =>
  Effect.gen(function* () {
    const everywhere = scope === EVERY_ENVIRONMENT_ID;

    switch (updated.status) {
      case "missing":
        return yield* notFound(scope);
      case "refused":
        return yield* EnvironmentsError.make({
          message: `${approved ? "The user approved, but nothing" : "Nothing"} was updated: ${updated.message}`,
        });
      case "nothing":
        return {
          output: [
            {
              type: "text" as const,
              text: `No Skill kept for ${named(updated.environment)} is marked update available. The daily check marks a Skill when its folder changed on its ref upstream (environment_get shows the marks); name Skills in names to update them anyway.`,
            },
          ],
          details: { updated: [] },
        };
      case "done": {
        const { results, environment } = updated;
        const moved = Arr.filter(results, (result) => result.outcome === "updated");
        const same = Arr.filter(results, (result) => result.outcome === "unchanged");
        const refusedModified = Arr.filter(results, (result) => result.outcome === "modified");
        const problems = problemLines(results);

        if (moved.length === 0 && same.length === 0) {
          return yield* EnvironmentsError.make({
            message: Arr.join(
              [
                `${approved ? "The user approved, but nothing" : "Nothing"} was updated:`,
                ...problems,
                ...(refusedModified.length === 0
                  ? []
                  : [
                      `${namesOf(refusedModified)} ${refusedModified.length === 1 ? "was" : "were"} edited since installed: call again with overwrite set to replace the edits (the user can revert the update on the Environments page, which brings them back).`,
                    ]),
              ],
              "\n",
            ),
          });
        }

        const changes = Arr.flatMap(moved, (result) =>
          result.change === undefined ? [] : [result.change],
        );

        for (const change of changes) {
          yield* log.record({
            tool: TOOL,
            environmentName: environment.name,
            field: change.field,
          });
        }

        const current = everywhere ? yield* environments.current : null;
        const overwrote = Arr.filter(moved, (result) => result.overwrote);
        const first = moved[0]?.name ?? same[0]?.name ?? "<name>";

        const text = Arr.join(
          [
            ...(moved.length === 0
              ? []
              : [
                  `${approved ? "The user approved: updated" : "Updated"} ${Arr.join(
                    Arr.map(
                      moved,
                      (result) =>
                        `${result.name} (${skillSourceText(result.from)} → ${shortSha(result.to.commit)})`,
                    ),
                    ", ",
                  )} for ${named(environment)}.`,
                ]),
            ...(overwrote.length === 0
              ? []
              : [
                  `The edits made to ${namesOf(overwrote)} were replaced; reverting the update brings them back.`,
                ]),
            ...(same.length === 0
              ? []
              : [
                  `${namesOf(same)} ${same.length === 1 ? "was" : "were"} the same at the ref's latest commit: nothing changed, and nothing was recorded for ${same.length === 1 ? "it" : "them"}.`,
                ]),
            ...(problems.length === 0
              ? []
              : [
                  "Not updated (the others were):",
                  ...problems,
                  ...(refusedModified.length === 0
                    ? []
                    : [
                        `${namesOf(refusedModified)} ${refusedModified.length === 1 ? "was" : "were"} refused because the Skill was edited since it was installed: call again with overwrite set to replace the edits.`,
                      ]),
                ]),
            ...(moved.length === 0
              ? []
              : [
                  updated.handed
                    ? `They are served now at ${SKILLS_ROOT}/<name> (read-only): read ${SKILLS_ROOT}/${first}/SKILL.md to use one.`
                    : `They are served at ${SKILLS_ROOT}/<name> (read-only) in each Workspace${everywhere ? "" : " of the Environment"}.`,
                  everywhere
                    ? `Every Environment's Workspaces and spares get it at their next readying${updated.handed ? "; this Session's Workspace has it now" : ""}${current === null || updated.handed ? "" : " (or its Environment keeps its own Skill of the name, which hides it there)"}.`
                    : reach(environment, updated.handed, own),
                  PROMPT_NOTE,
                  `Each change is recorded${approved ? " as approved" : ""} with your reason and the files and Skill source before and after, and the user can revert it on the Environments page.`,
                ]),
          ],
          " ",
        );

        const details = {
          agentChanges: Arr.map(changes, (change) => ({
            id: change.id,
            environment,
            field: change.field,
            before: asJsonValue(change.before),
            after: asJsonValue(change.after),
          })),
          own: everywhere ? updated.handed : own,
        };

        return {
          output: [{ type: "text" as const, text }],
          details: approved ? { approval: { approved: true }, ...details } : details,
        };
      }
    }
  });

/** The sentence an Approval request of an update opens its _After_ with: what is not part of it. */
const leftOut = (results: ReadonlyArray<SkillUpdateResult | SkillUpdateReady>): string => {
  const lines = Arr.flatMap(results, (result) =>
    result.outcome === "ready" || result.outcome === "updated"
      ? []
      : [`- ${result.name} (${result.outcome}): ${"message" in result ? result.message : ""}`],
  );

  return lines.length === 0 ? "" : `Not part of this update:\n${Arr.join(lines, "\n")}\n\n`;
};

/** Update the Skills kept for every Environment once the owner approves exactly what they are shown. */
const updateEverywhere = (
  deps: UpdateDeps,
  {
    names,
    overwrite,
    reason,
  }: {
    readonly names: ReadonlyArray<string> | undefined;
    readonly overwrite: boolean;
    readonly reason: string;
  },
  api: ApprovalCall,
) =>
  Effect.gen(function* () {
    const { environments, approvals, notFound } = deps;
    const rerun = yield* askedBefore(approvals, api);
    const EVERY: ChangedEnvironment = { id: EVERY_ENVIRONMENT_ID, name: "every Environment" };

    // A rerun after an eviction asked already: what the owner was shown is in its request, and what they answered is
    // applied at exactly that, so GitHub's answer now (a rate limit, a commit that is the head already) must not withdraw
    // the request or hide that the update was made.
    const previewing = environments.previewUpdates({
      environment: EVERY_ENVIRONMENT_ID,
      names,
      overwrite,
    });

    const previewed: SkillUpdatesPreview | undefined = rerun
      ? Option.getOrUndefined(yield* Effect.option(previewing))
      : yield* previewing;

    // A call that asks nothing: its request, if one still waits, is withdrawn.
    const nothing = (settled: SkillsUpdated) =>
      updatedOutcome(settled, {
        ...deps,
        scope: EVERY_ENVIRONMENT_ID,
        own: false,
        approved: false,
      });

    if (!rerun) {
      if (previewed === undefined || previewed.status === "missing") {
        return yield* notFound(EVERY_ENVIRONMENT_ID);
      }

      if (previewed.status === "refused") {
        return yield* EnvironmentsError.make({
          message: `Nothing was updated: ${previewed.message}.`,
        });
      }

      if (previewed.status === "nothing") return yield* nothing(previewed);
    }

    const results = previewed?.status === "done" ? previewed.results : [];

    const ready = Arr.filter(
      results,
      (result): result is SkillUpdateReady => result.outcome === "ready",
    );

    if (!rerun && ready.length === 0) {
      return yield* nothing({
        status: "done",
        environment: EVERY,
        results: Arr.filter(
          results,
          (result): result is SkillUpdateResult => result.outcome !== "ready",
        ),
        handed: false,
      });
    }

    const card = cardOfSkills(
      Arr.map(ready, (skill) => ({
        heading: `══ ${skill.name}: ${skillSourceText(skill.from)} → ${skillSourceText(skill.to)}\n${skill.description}${skill.overwrites ? "\n⚠ EDITED since it was installed: this update replaces the edits." : ""}`,
        files: skill.files,
      })),
    );

    const pins: ReadonlyArray<SkillUpdatePin> = Arr.map(ready, (skill) => ({
      name: skill.name,
      savedAt: skill.savedAt,
      commit: skill.to.commit,
      folderHash: skill.folderHash,
    }));

    return yield* withApproval(
      approvals,
      api,
      {
        tool: TOOL,
        target: "every Environment",
        change: `Update the Skills ${Arr.join(
          Arr.map(ready, (skill) => JSON.stringify(skill.name)),
          ", ",
        )} to their refs' latest commits`,
        before: Arr.join(
          Arr.map(
            ready,
            (skill) =>
              `${skill.name}: ${skillSourceText(skill.from)}${skill.overwrites ? " (edited since installed)" : ""}`,
          ),
          "\n",
        ),
        after: `${leftOut(results)}${card.after}`,
        reason,
        // What the owner is shown: applied only at these commits, while each Skill was last saved as it is now.
        expected: { overwrite, pins },
      },
      (answer) =>
        Effect.gen(function* () {
          if (!answer.approved) {
            return declined(answer, "updating the Skills kept for every Environment");
          }

          const asked = Schema.decodeUnknownOption(UpdateAsked)(answer.expected);

          if (Option.isNone(asked)) {
            return yield* EnvironmentsError.make({
              message:
                "The user approved, but the request holds no record of the update they were shown: nothing was updated. Ask again.",
            });
          }

          const updated = yield* environments.updateSkills({
            environment: EVERY_ENVIRONMENT_ID,
            names: Arr.map(asked.value.pins, (pin) => pin.name),
            overwrite: asked.value.overwrite,
            pins: asked.value.pins,
            author: { conversation: api.conversationId, tool: TOOL, reason, approved: true },
          });

          const result = yield* updatedOutcome(updated, {
            ...deps,
            scope: EVERY_ENVIRONMENT_ID,
            own: false,
            approved: true,
          });

          // A Skill the owner approved that is the same already (a rerun after the update was made).
          if (
            updated.status === "done" &&
            Arr.every(updated.results, (r) => r.outcome === "unchanged")
          ) {
            return {
              output: [
                {
                  type: "text" as const,
                  text: approvedAlready(`the Skills ${namesOf(updated.results)} were updated`),
                },
              ],
              details: { approval: { approved: true } },
            };
          }

          return card.unseen === null
            ? result
            : {
                ...result,
                output: [
                  ...result.output,
                  {
                    type: "text" as const,
                    text: `The card showed the user only the first ${MAX_CARD_CHARS} characters of the Skills' files: ${card.unseen.characters} characters in ${card.unseen.files} file${card.unseen.files === 1 ? "" : "s"} were cut or left out, so that part was not reviewed. Keep a Skill for every Environment small enough to review in full.`,
                  },
                ],
              };
        }),
    );
  });

/** `environment_skill_update`. Runs alone; `replay: "safe"` so an update for every Environment waits for the same request. */
export const updateTool = ({
  environments,
  approvals,
  log,
  refuseSecrets,
  target,
  notFound,
}: SkillToolDeps) => {
  const deps = { environments, approvals, log, notFound };

  return defineEffectTool({
    name: TOOL,
    description: Arr.join(
      [
        `Update installed Skills of an Environment (this Session's unless id names another) to the latest commit of the ref each was installed from: cloudpid fetches them, not you (no Container, no \`npx skills\`). Each Skill moved is kept in place of itself with its new Skill source and recorded as an Agent change with the files before and after, so the user can revert it on the Environments page. Skills stay pinned until someone updates them; environment_get marks a Skill "update available" when the daily check found its folder changed upstream, and "modified" when it was edited since it was installed.`,
        `names are the Skills to update (as environment_get lists them); without names, every Skill marked update available is updated. A Skill whose folder is the same at the new commit records nothing. A modified Skill is refused, and named in the result, unless overwrite is true: that replaces the edits made to it (the user's revert brings them back); only set it when the user wants their edits replaced. A Skill that was not installed from GitHub has no source to update from, and one the checks refuse (the Agent Skills name rules, text only, 128 KB a file, 1 MB a Skill, 100 Skills and 8 MB in a set) is reported while the others are updated. After an update, this Session's Workspace serves the new files at ${SKILLS_ROOT}/<name> at once; the skills list in your system prompt changes at the next Context Window.`,
        `With id "${EVERY_ENVIRONMENT_ID}" the Skills kept for every Environment are updated, which the user must approve because they steer every future Session: they read the files each Skill would take on the card (the first ${MAX_CARD_CHARS} characters in all, with a warning for what is cut), and the update is made at exactly those commits. ${SKILL_APPROVAL}`,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: Schema.optionalKey(idOrEvery("the Skills kept for every Environment")),
      names: Schema.optionalKey(
        Schema.Array(Schema.String.check(Schema.isMinLength(1))).annotate({
          description:
            "The Skills to update, by name. Left out: every Skill marked update available",
        }),
      ),
      overwrite: Schema.optionalKey(
        Schema.Boolean.annotate({
          description:
            "Replace the edits made to a modified Skill (default false: a modified Skill is refused and named)",
        }),
      ),
      reason: Reason.annotate({
        description:
          "Why you update the Skills, for the user to read in the Environment's Agent changes, such as 'the user asked for the latest grill-me'",
      }),
    }),
    executionMode: "sequential",
    // A rerun after an eviction waits for the request an update for every Environment made, or takes its answer; one for
    // an Environment's own Skills finds the Skills already at the new commit (unchanged) and records nothing again.
    replay: "safe",
    execute: ({ id, names, overwrite, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([
          { what: "the reason", text: reason },
          ...Arr.map(names ?? [], (name) => ({ what: "a Skill name", text: name })),
        ]);

        if (id === EVERY_ENVIRONMENT_ID) {
          return yield* updateEverywhere(
            deps,
            { names, overwrite: overwrite === true, reason },
            api,
          );
        }

        const { environment, own } = yield* target(id);

        const updated = yield* environments.updateSkills({
          environment,
          names,
          overwrite: overwrite === true,
          author: { conversation: api.conversationId, tool: TOOL, reason },
        });

        return yield* updatedOutcome(updated, {
          ...deps,
          scope: environment,
          own,
          approved: false,
        });
      }),
  });
};
