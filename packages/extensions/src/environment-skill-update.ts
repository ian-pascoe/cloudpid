// `environment_skill_update` (ADR-0026, `docs/architecture/agent-changes.md`, and → Installing from GitHub → Updates): move
// installed Skills to the latest commit of their recorded ref. The Registry fetches it as the GitHub App, never the
// Session or a Container, and keeps the files as an Agent change for each Skill, with the files and the Skill source
// before and after, so the user's revert brings back the earlier commit and any edits an overwrite replaced. A Skill the
// agent edited since it was installed (**modified**) is refused unless `overwrite` is set, and the result names it.
// With `id: "*"` the update waits for the owner's Approval (`./environment-skills-global.ts`), which shows the files each
// Skill would take and is made at exactly the commits they were shown. Each result also gives a program its value
// (`docs/architecture/agent-capabilities.md` → Values for programs; `./environment-lifecycle-outputs.ts`).
//
// `environment.ts` imports this module through `./environment-skills.ts`, so what it takes from `environment.ts` is used
// inside functions only: its exports are not there yet when this module loads.
// @effect-diagnostics missingPipeableSignature:off
import { defineEffectTool } from "@cloudpid/effect-durable";
import {
  SKILLS_ROOT,
  shortSha,
  skillSourceText,
  SkillUpdatePin,
  type SkillUpdateEntry,
  type SkillUpdatePreview,
  type SkillUpdateReady,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type ApprovalAnswer,
  type ApprovalCall,
  approvedAlready,
  askedBefore,
  declinedWith,
  withApproval,
} from "./approvals.ts";
import { type ChangedEnvironment, EnvironmentsError, idOrGlobal, Reason } from "./environment.ts";
import { SkillUpdateOutput, skillUpdatedOutput } from "./environment-lifecycle-outputs.ts";
import { GLOBAL_ID } from "./environment-secret-marks.ts";
import {
  asJsonValue,
  named,
  PROMPT_NOTE,
  reach,
  type SkillToolDeps,
  type SkillsUpdated,
} from "./environment-skill-results.ts";
import { cardOf, MAX_CARD_CHARS, SKILL_APPROVAL } from "./environment-skills-global.ts";
import { APPROVED, outputSchema } from "./outputs.ts";
import { SKILL_SIZES } from "./skill-checks.ts";

const TOOL = "environment_skill_update";

/** A Skill the update left out, which a rerun that reads nothing reports too. */
const leftOutSkill = <Outcome extends "unchanged" | "modified" | "rejected" | "changed-since">(
  outcome: Outcome,
) =>
  Schema.Struct({ name: Schema.String, outcome: Schema.Literal(outcome), message: Schema.String });

/**
 * What an Approval of an update was asked against: the updates shown (`SkillUpdatePin`), whether the edits they replace
 * were, how much the cards cut, and the Skills left out of the update, which the result reports with the others.
 */
const UpdateAsked = Schema.Struct({
  overwrite: Schema.Boolean,
  pins: Schema.Array(SkillUpdatePin),
  unseen: Schema.Struct({ files: Schema.Finite, characters: Schema.Finite }),
  notKept: Schema.Array(
    Schema.Union([
      leftOutSkill("unchanged"),
      leftOutSkill("modified"),
      leftOutSkill("rejected"),
      leftOutSkill("changed-since"),
    ]),
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
const problemLines = (
  results: ReadonlyArray<
    SkillUpdateEntry | { readonly name: string; readonly outcome: string; readonly message: string }
  >,
): ReadonlyArray<string> =>
  Arr.flatMap(results, (result) =>
    result.outcome === "updated" || result.outcome === "unchanged"
      ? []
      : [`- ${result.name} (${result.outcome}): ${"message" in result ? result.message : ""}`],
  );

/**
 * The result of an update, whatever it came to: the tool's own result, or its refusal when no Skill was moved or found
 * up to date. `scope` is the Environment the call named, or Global.
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
    const atGlobal = scope === GLOBAL_ID;

    switch (updated.status) {
      case "missing":
        return yield* notFound(scope);
      case "refused":
        return yield* EnvironmentsError.make({
          message: `${approved ? "The user approved, but nothing" : "Nothing"} was updated: ${updated.message}`,
        });
      case "nothing":
        return {
          structuredOutput: skillUpdatedOutput({
            scope: updated.environment,
            results: [],
            approval: approved ? APPROVED : null,
            handed: false,
            nothingMarked: true,
          }),
          output: [
            {
              type: "text" as const,
              text: `No Skill kept for ${named(updated.environment)} is marked update available. The daily check marks a Skill when its folder changed at its Skill source on the ref it was installed from (environment_get shows the marks); name Skills in names to update them anyway.`,
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
                      `${namesOf(refusedModified)} ${refusedModified.length === 1 ? "was" : "were"} edited since installed: call again with overwrite set to replace the edits (the user can revert the update on the Skills page, which brings them back).`,
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

        const current = atGlobal ? yield* environments.current : null;
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
                    : `They are served at ${SKILLS_ROOT}/<name> (read-only) in each Workspace${atGlobal ? "" : " of the Environment"}.`,
                  atGlobal
                    ? `Each Environment's Workspaces and spares get it at their next readying${updated.handed ? "; this Session's Workspace has it now" : ""}${current === null || updated.handed ? "" : " (or its Environment keeps its own Skill of the name, which hides it there)"}.`
                    : reach(environment, updated.handed, own),
                  PROMPT_NOTE,
                  `Each change is recorded${approved ? " as approved" : ""} with your reason and the files and Skill source before and after, and the user can revert it on the Skills page.`,
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
          own: atGlobal ? updated.handed : own,
        };

        return {
          output: [{ type: "text" as const, text }],
          structuredOutput: skillUpdatedOutput({
            scope: environment,
            results,
            approval: approved ? APPROVED : null,
            handed: updated.handed,
          }),
          details: approved ? { approval: { approved: true }, ...details } : details,
        };
      }
    }
  });

/** The sentence an Approval request of an update opens its _After_ with: what is not part of it. */
const leftOut = (
  results: ReadonlyArray<{
    readonly name: string;
    readonly outcome: string;
    readonly message: string;
  }>,
): string => {
  const lines = problemLines(results);

  return lines.length === 0 ? "" : `Not part of this update:\n${Arr.join(lines, "\n")}\n\n`;
};

/** Update the Skills kept Global once the owner approves exactly what they are shown. */
const updateAtGlobal = (
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
    const GLOBAL_TARGET: ChangedEnvironment = { id: GLOBAL_ID, name: "Global" };

    /** What the owner's answer comes to: on Approve, the pinned updates made at the commits they were shown. */
    const answered = (answer: ApprovalAnswer) =>
      Effect.gen(function* () {
        if (!answer.approved) {
          return declinedWith(answer, "updating the Skills kept Global", (approval) =>
            skillUpdatedOutput({ scope: GLOBAL_TARGET, results: [], approval, handed: false }),
          );
        }

        const asked = Schema.decodeUnknownOption(UpdateAsked)(answer.expected);

        if (Option.isNone(asked)) {
          return yield* EnvironmentsError.make({
            message:
              "The user approved, but the request holds no record of the update they were shown: nothing was updated. Ask again.",
          });
        }

        const shown = asked.value;

        const updated = yield* environments.updateSkills({
          environment: GLOBAL_ID,
          names: Arr.map(shown.pins, (pin) => pin.name),
          overwrite: shown.overwrite,
          pins: shown.pins,
          author: { conversation: api.conversationId, tool: TOOL, reason, approved: true },
        });

        if (updated.status !== "done") {
          return yield* updatedOutcome(updated, {
            ...deps,
            scope: GLOBAL_ID,
            own: false,
            approved: true,
          });
        }

        // A Skill is listed once: the Registry's result for a Skill shown wins over what the preview left out under it.
        const results: ReadonlyArray<SkillUpdateEntry> = [
          ...updated.results,
          ...Arr.filter(
            shown.notKept,
            ({ name }) => !Arr.some(updated.results, (result) => result.name === name),
          ),
        ];

        // An earlier run of this call made the update before the Session restarted: the Skills are at what was approved.
        if (
          updated.results.length > 0 &&
          Arr.every(updated.results, (result) => result.outcome === "unchanged")
        ) {
          const problems = problemLines(shown.notKept);

          return {
            output: [
              {
                type: "text" as const,
                text: `${approvedAlready(`the Skills ${namesOf(updated.results)} were updated`)}${problems.length === 0 ? "" : ` Not part of it:\n${Arr.join(problems, "\n")}`}`,
              },
            ],
            structuredOutput: skillUpdatedOutput({
              scope: GLOBAL_TARGET,
              results,
              approval: APPROVED,
              handed: false,
            }),
            details: { approval: { approved: true } },
          };
        }

        const result = yield* updatedOutcome(
          { ...updated, results },
          { ...deps, scope: GLOBAL_ID, own: false, approved: true },
        );

        return shown.unseen.files === 0
          ? result
          : {
              ...result,
              output: [
                ...result.output,
                {
                  type: "text" as const,
                  text: `The card showed the user only the first ${MAX_CARD_CHARS} characters of each Skill's files: ${shown.unseen.characters} characters in ${shown.unseen.files} file${shown.unseen.files === 1 ? "" : "s"} were cut or left out, so that part was not reviewed. Keep a Skill at Global small enough to review in full.`,
                },
              ],
            };
      });

    // A rerun after an eviction asked already: what the owner was shown is in its request, and what they answered is
    // applied at exactly that, so GitHub's answer now (a rate limit, a commit that is the head already) must not withdraw
    // the request or hide that the update was made. Nothing is read.
    if (yield* askedBefore(approvals, api)) {
      return yield* withApproval(
        approvals,
        api,
        // Never shown: the request the owner sees is the one the first call made.
        {
          tool: TOOL,
          target: "Global",
          change: "Update the Skills kept Global",
          before: "",
          after: "",
          reason,
          expected: null,
        },
        answered,
      );
    }

    const previewed: SkillUpdatePreview | undefined = yield* environments.previewUpdates({
      environment: GLOBAL_ID,
      names,
      overwrite,
    });

    // A call that asks nothing.
    const nothing = (settled: SkillsUpdated) =>
      updatedOutcome(settled, {
        ...deps,
        scope: GLOBAL_ID,
        own: false,
        approved: false,
      });

    if (previewed.status === "missing") return yield* notFound(GLOBAL_ID);

    if (previewed.status === "refused") {
      return yield* EnvironmentsError.make({
        message: `Nothing was updated: ${previewed.message}.`,
      });
    }

    if (previewed.status === "nothing") return yield* nothing(previewed);

    const results = previewed.results;

    const ready = Arr.filter(
      results,
      (result): result is SkillUpdateReady => result.outcome === "ready",
    );

    const notKept = Arr.flatMap(results, (result) =>
      result.outcome === "ready" || result.outcome === "updated"
        ? []
        : [{ name: result.name, outcome: result.outcome, message: result.message }],
    );

    if (ready.length === 0) {
      return yield* nothing({
        status: "done",
        environment: GLOBAL_TARGET,
        results: Arr.filter(
          results,
          (result): result is SkillUpdateEntry => result.outcome !== "ready",
        ),
        handed: false,
      });
    }

    const cards = Arr.map(ready, (skill) => ({
      skill,
      card: cardOf(
        `${skill.description}${skill.overwrites ? "\n⚠ EDITED since it was installed: this update replaces the edits." : ""}`,
        skill.files,
      ),
    }));

    const unseen = Arr.reduce(cards, { files: 0, characters: 0 }, (total, { card }) => ({
      files: total.files + (card.unseen?.files ?? 0),
      characters: total.characters + (card.unseen?.characters ?? 0),
    }));

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
        target: "Global",
        change: `Update ${ready.length === 1 ? "the Skill" : "the Skills"} ${Arr.join(
          Arr.map(ready, ({ name }) => JSON.stringify(name)),
          ", ",
        )} to their refs' latest commits`,
        before: Arr.join(
          Arr.map(
            ready,
            (skill) =>
              `${skill.name}: kept Global: ${skillSourceText(skill.from)}${skill.overwrites ? " (edited since installed)" : ""} (files: ${Arr.join(skill.current.files, ", ")})`,
          ),
          "\n",
        ),
        after: `${leftOut(notKept)}${Arr.join(
          Arr.map(
            cards,
            ({ skill, card }) =>
              `━━ ${skill.name} (${skill.to.path === "" ? "the repo's root" : skill.to.path}) at ${skillSourceText(skill.to)} ━━\n${card.after}`,
          ),
          "\n\n",
        )}`,
        reason,
        // What the owner is shown: applied only at these commits, while each Skill was last saved as it is now.
        expected: { overwrite, pins, unseen, notKept },
      },
      answered,
    );
  });

/** `environment_skill_update`. Runs alone; `replay: "safe"` so an update at Global waits for the same request. */
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
        `Update installed Skills of an Environment (the one id names) to the latest commit of the ref each was installed from: cloudpid fetches them, not you (no Container, no \`npx skills\`). Each Skill moved is kept in place of itself with its new Skill source and recorded as an Agent change with the files before and after, so the user can revert it on the Skills page. Skills stay pinned until someone updates them; environment_get marks a Skill "update available" when the daily check found its folder changed at its Skill source, and "modified" when it was edited since it was installed.`,
        `names are the Skills to update (as environment_get lists them); without names, every Skill marked update available is updated. A Skill whose folder is the same at the new commit records nothing. A modified Skill is refused, and named in the result, unless overwrite is true: that replaces the edits made to it (the user's revert brings them back); only set it when the user wants their edits replaced. A Skill that was not installed from GitHub has no source to update from, and one the checks refuse (the Agent Skills name rules, text only, ${SKILL_SIZES.file} a file, ${SKILL_SIZES.skill} a Skill, 100 Skills and ${SKILL_SIZES.set} in a set) is reported while the others are updated. After an update, this Session's Workspace serves the new files at ${SKILLS_ROOT}/<name> at once; the skills list in your system prompt changes at the next Context Window.`,
        `With id "${GLOBAL_ID}" the Skills kept Global are updated, which the user must approve because they steer every future Session: they read the files each Skill would take on the card (the first ${MAX_CARD_CHARS} characters of each Skill's files, with a warning for what is cut), and the update is made at exactly those commits. ${SKILL_APPROVAL}`,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: idOrGlobal("the Skills kept Global"),
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
    structuredOutputSchema: outputSchema(SkillUpdateOutput),
    executionMode: "sequential",
    // A rerun after an eviction waits for the request an update at Global made, or takes its answer; one for
    // an Environment's own Skills finds the Skills already at the new commit (unchanged) and records nothing again.
    replay: "safe",
    execute: ({ id, names, overwrite, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([
          { what: "the reason", text: reason },
          ...Arr.map(names ?? [], (name) => ({ what: "a Skill name", text: name })),
        ]);

        if (id === GLOBAL_ID) {
          return yield* updateAtGlobal(deps, { names, overwrite: overwrite === true, reason }, api);
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
