// The cores of the Skill tools' changes at Global over the MCP endpoint (`docs/architecture/mcp-endpoint.md` → Environment
// and Settings tools → Built so far: S3b-3, → Approvals with no Session; ADR-0050; #685 L6, L18): `environment_skill_install`,
// `_update` and `_remove` with `id: "*"`. A Skill kept Global steers every Session that starts after, so the owner approves
// the change in cloudpid, from a request the Registry keeps. Each core has the `ApprovalCore` shape:
//
// - `prepare` reads what the change would do (the Registry's preview of an install or an update, fetched as the GitHub App;
//   for a removal, the Skill kept Global and when it was last saved) and refuses, asking nothing, what the change could not
//   apply: more Skills than one request shows (`MAX_APPROVED_SKILLS`) or more files than it holds (the Registry refuses
//   both in its preview), Skills it refuses, a source that is none, a Skill not kept. Its card shows each Skill's files as a
//   Session's card does (`cardOf`); `expected` is the pin only (`SkillInstallPin`, the update's `SkillUpdatePin`s, a
//   removal's `SkillExpectation`), never a file's text (L6).
// - `apply` makes the Registry's write with that pin and the endpoint author (`approved`), so a Skill is kept only while
//   its pin still holds; the Registry refuses a change at Global that carries none.
// - `render` reads each Skill's outcome, never the call's (an install whose Skills were all refused still answers
//   `installed`): what was kept, what was found kept already, and each Skill it skipped, with why. An install and an update
//   are multi-write (one transaction per Skill): a resumed apply is run again under the same attempt (L18), and `how.earlier`
//   holds the Agent changes the request's claim recorded before, so a Skill an earlier run kept, which this run finds
//   unchanged, is told as installed or updated with its change.
//
// There is no Session to hand the new Skill set to: the Workspaces take it at their next readying. These cores answer the
// endpoint's form only; the Session's tools keep their own (`./environment-skills-global.ts`, `./environment-skill-update.ts`)
// and make the same Registry calls.
// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off -- a name quoted in a sentence.
import {
  type AgentChange,
  type InstalledSkill,
  fieldSkill,
  SkillChangeValue,
  skillField,
  SkillInstallPin,
  type SkillSource,
  skillSourceText,
  shortSha,
  SKILLS_ROOT,
  type SkillUpdateEntry,
  SkillUpdatePin,
  type SkillUpdateReady,
} from "@cloudpid/protocol";
import {
  GLOBAL_ID,
  GLOBAL_NAME,
  type HARNESS_TOOLS,
  MAX_APPROVED_SKILLS,
  MAX_CARD_CHARS,
  SkillRemoveEndpointOutput,
} from "@cloudpid/protocol/harness-tools";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ApprovalCore, Prepared } from "./approval-cores.ts";
import { refuseSecretsIn } from "./environment-change-parts.ts";
import { endpointText, fittedChanges, type TextCheck } from "./environment-changes.ts";
import { EnvironmentsError } from "./environment-describe.ts";
import { installValue, namesOf, skillLine, updateValue } from "./environment-skill-changes.ts";
import type { SkillRemoved, SkillsInstalled, SkillsUpdated } from "./environment-skill-results.ts";
import { cardOf } from "./environment-skills-global.ts";
import type { EnvironmentsService } from "./environment.ts";
import type { HarnessAnswer } from "./harness.ts";
import { INVALID_ARGUMENT, NOT_FOUND } from "./harness.ts";
import { asOutput, changesOutput, scopeRef } from "./outputs.ts";

/** What the cores use: the Registry's Skills as the endpoint reaches them (no Workspace), and the check of a text. */
export type GlobalSkillServices = {
  readonly environments: Pick<
    EnvironmentsService,
    | "global"
    | "previewInstall"
    | "previewUpdates"
    | "installSkills"
    | "updateSkills"
    | "removeSkill"
  >;
  readonly holdsSecret: TextCheck;
};

/** The arguments of tool `Name` as a request keeps them: the endpoint input, its `request_id` aside. */
type ArgsOf<Name extends keyof typeof HARNESS_TOOLS> = Omit<
  (typeof HARNESS_TOOLS)[Name]["endpoint"]["input"]["Type"],
  "request_id"
>;

export type GlobalInstallArgs = ArgsOf<"environment_skill_install">;

export type GlobalUpdateArgs = ArgsOf<"environment_skill_update">;

export type GlobalRemoveArgs = ArgsOf<"environment_skill_remove">;

/** Global, where every change of these cores is: what `prepare` knows of the target. */
export type GlobalKnown = { readonly id: typeof GLOBAL_ID; readonly name: string };

const GLOBAL: GlobalKnown = { id: GLOBAL_ID, name: GLOBAL_NAME };

/**
 * What `render` is told besides the write's answer: the Agent changes the request's claim recorded before this run (an
 * earlier run of the same approved request, cut before it finished), each Skill's own. Empty for a first run.
 */
export type GlobalSkillHow = { readonly earlier: ReadonlyArray<AgentChange> };

/**
 * How an approved apply went, for the request it finishes: the write recorded changes under the request's claim
 * (`wrote`, this run's or an earlier run's), found the change made already (`found`), or made none, every Skill skipped
 * (`changed_since`: no Skill is as the owner was shown it) or the write refused (`refused`).
 */
export type GlobalSkillOutcome = "wrote" | "found" | "changed_since" | "refused";

/** A Global Skill tool's core: an `ApprovalCore`, and how its apply went for the request it finishes. */
export type GlobalSkillCore<Args, Result> = ApprovalCore<
  Args,
  GlobalKnown,
  Result,
  EnvironmentsError,
  GlobalSkillHow
> & {
  readonly outcome: (result: Result, earlier: ReadonlyArray<AgentChange>) => GlobalSkillOutcome;
};

/** A refusal the caller reads: nothing was done, and why. */
const refusal = (message: string) =>
  EnvironmentsError.make({ message: ownerWords(message), code: INVALID_ARGUMENT });

/**
 * A Registry message in the endpoint's words: the Registry's words of a pinned Skill are the Session's, which name the user,
 * and the endpoint's caller answers to the owner.
 */
const ownerWords = (message: string): string =>
  message.replaceAll(/\bthe user\b/g, "the owner").replaceAll(/\bThe user\b/g, "The owner");

/** The refusal of a request kept without the pin `apply` reads: nothing can be applied against what the owner saw. */
const noPin = (what: string) =>
  refusal(
    `The owner approved, but the request holds no record of the ${what} they were shown: nothing was changed. Ask again.`,
  );

/** What a Skill change at Global answers of where it reaches. */
const SERVED_GLOBAL = `Each Environment's Workspaces and spares serve it at ${SKILLS_ROOT}/<name> (read-only) from their next readying`;

/**
 * The Environments whose own Skill of a name hides one kept Global, as a sentence part: they keep (`serving`: keep
 * serving) their own.
 */
const hiddenIn = (
  overriddenIn: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  serving = false,
) =>
  overriddenIn.length === 0
    ? ""
    : `, except ${Arr.join(
        Arr.map(overriddenIn, ({ id, name }) => `Environment ${JSON.stringify(name)} (${id})`),
        ", ",
      )}, which ${overriddenIn.length === 1 ? `keeps ${serving ? "serving " : ""}its` : `keep ${serving ? "serving " : ""}their`} own Skill of the name`;

/** What the card showed of each Skill, and what it cut, as the note an ask tells its caller. */
type Unseen = { readonly files: number; readonly characters: number };

const unseenNote = (unseen: Unseen): ReadonlyArray<string> =>
  unseen.files === 0
    ? []
    : [
        `The card shows the owner only the first ${MAX_CARD_CHARS} characters of each Skill's files: ${unseen.characters} characters in ${unseen.files} file${unseen.files === 1 ? "" : "s"} are cut or left out, and the card says so, so the owner may decline. Keep a Skill at Global small enough to review in full.`,
      ];

/** Each Skill's card, and what they cut together. */
const cardsOf = <Skill>(
  skills: ReadonlyArray<Skill>,
  shown: (skill: Skill) => {
    readonly description: string;
    readonly files: Readonly<Record<string, string>>;
  },
) => {
  const cards = Arr.map(skills, (skill) => {
    const { description, files } = shown(skill);

    return { skill, card: cardOf(description, files) };
  });

  const unseen = Arr.reduce(cards, { files: 0, characters: 0 }, (total, { card }) => ({
    files: total.files + (card.unseen?.files ?? 0),
    characters: total.characters + (card.unseen?.characters ?? 0),
  }));

  return { cards, unseen };
};

/** The Skill source a recorded change holds, before or after: none for a Skill that was not kept, or not installed. */
const sourceOf = (value: AgentChange["before"]): Option.Option<SkillSource> =>
  Option.flatMap(Schema.decodeUnknownOption(SkillChangeValue)(value), ({ source }) =>
    Option.fromNullishOr(source),
  );

/** Whether a recorded change holds the Skill as modified, before it. */
const modifiedIn = (value: AgentChange["before"]): boolean =>
  Option.match(Schema.decodeUnknownOption(SkillChangeValue)(value), {
    onNone: () => false,
    onSome: ({ modified }) => modified === true,
  });

/** The earlier changes by the Skill they changed. */
const byName = (earlier: ReadonlyArray<AgentChange>): ReadonlyMap<string, AgentChange> =>
  new Map(
    Arr.map(earlier, (change) => [fieldSkill(change.field) ?? change.field, change] as const),
  );

/**
 * An install's results with what an earlier run of the same request kept: a Skill it kept is installed, with its change,
 * whatever this run found of it (unchanged, since it is kept so now).
 */
export const withEarlierInstalls = (
  results: ReadonlyArray<InstalledSkill>,
  earlier: ReadonlyArray<AgentChange>,
): ReadonlyArray<InstalledSkill> => {
  const changes = byName(earlier);

  const merged = Arr.map(results, (result): InstalledSkill => {
    const change = changes.get(result.name);

    return change === undefined || result.outcome === "installed"
      ? result
      : { name: result.name, path: result.path, outcome: "installed", change };
  });

  const missed = Arr.flatMap([...changes], ([name, change]): ReadonlyArray<InstalledSkill> =>
    Arr.some(results, (result) => result.name === name)
      ? []
      : [
          {
            name,
            path: Option.match(sourceOf(change.after), {
              onNone: () => "",
              onSome: ({ path }) => path,
            }),
            outcome: "installed",
            change,
          },
        ],
  );

  return [...merged, ...missed];
};

/** An update's results with what an earlier run of the same request moved (as `withEarlierInstalls`). */
export const withEarlierUpdates = (
  results: ReadonlyArray<SkillUpdateEntry>,
  earlier: ReadonlyArray<AgentChange>,
): ReadonlyArray<SkillUpdateEntry> => {
  const changes = byName(earlier);

  /** The update a change records: from its source before to its source after. */
  const updatedBy = (name: string, change: AgentChange): ReadonlyArray<SkillUpdateEntry> =>
    Option.match(Option.all({ from: sourceOf(change.before), to: sourceOf(change.after) }), {
      onNone: () => [],
      onSome: ({ from, to }) => [
        { name, outcome: "updated", from, to, overwrote: modifiedIn(change.before), change },
      ],
    });

  const merged = Arr.flatMap(results, (result): ReadonlyArray<SkillUpdateEntry> => {
    const change = changes.get(result.name);

    if (change === undefined || result.outcome === "updated") return [result];

    const updated = updatedBy(result.name, change);

    return updated.length === 0 ? [result] : updated;
  });

  const missed = Arr.flatMap([...changes], ([name, change]) =>
    Arr.some(results, (result) => result.name === name) ? [] : updatedBy(name, change),
  );

  return [...merged, ...missed];
};

/** How a write of Skills went for the request, from what it kept now and what an earlier run kept. */
const skillsOutcome = (
  kept: number,
  same: number,
  earlier: ReadonlyArray<AgentChange>,
): GlobalSkillOutcome =>
  kept > 0 || earlier.length > 0 ? "wrote" : same > 0 ? "found" : "changed_since";

/** The answer an ask gives in place of a request when Global has everything asked for already. */
const unchangedAnswer = (text: string, structured: HarnessAnswer["structured"]): HarnessAnswer => ({
  text: endpointText(text),
  structured,
  details: null,
});

/** The words a declined request says: the owner's refusal and reason. Only a Session's request is declined to a caller. */
const declinedText = (what: string, reason: string | null) =>
  `The owner declined ${what}: nothing was changed.${reason === null ? "" : ` Their reason: ${reason}`}`;

/** The cores of the Skill tools at Global, by tool name, over `services`. */
export const globalSkillCores = ({ environments, holdsSecret }: GlobalSkillServices) => {
  /** Fails, asking nothing, when a text holds a deploy-time credential. */
  const refuseSecrets = (
    outcome: string,
    texts: ReadonlyArray<{ readonly what: string; readonly text: string }>,
  ) => refuseSecretsIn(holdsSecret)("endpoint", texts, outcome);

  /** The refusal of a Global the Registry does not find, which it always keeps: an answer it should not give. */
  const noGlobal = EnvironmentsError.make({
    message: "cloudpid could not read the Skills kept Global just now, so nothing was asked.",
    code: NOT_FOUND,
  });

  // ─── Install ───────────────────────────────────────────────────────────────

  const installEmpty = (
    results: ReadonlyArray<InstalledSkill>,
    source: { readonly repo: string; readonly ref: string | null; readonly commit: string } | null,
  ) => installValue({ scope: GLOBAL, source, results, listed: [] });

  const install: GlobalSkillCore<GlobalInstallArgs, SkillsInstalled> = {
    tool: "environment_skill_install",
    prepare: ({ source, skills, reason }) =>
      Effect.gen(function* () {
        yield* refuseSecrets("Nothing was asked or installed", [
          { what: "the reason", text: reason },
          { what: "the source", text: source },
          ...Arr.map(skills ?? [], (name) => ({ what: "a Skill name", text: name })),
        ]);

        const previewed = yield* environments.previewInstall({
          environment: GLOBAL_ID,
          source,
          skills,
        });

        switch (previewed.status) {
          case "missing":
            return yield* noGlobal;
          case "refused":
            return yield* refusal(`Nothing was asked or installed: ${previewed.message}`);
          case "listed":
            return yield* refusal(
              Arr.join(
                [
                  `Nothing was asked or installed: ${previewed.repo} (at ${shortSha(previewed.commit)}) holds ${previewed.available.length} Skills and none was named:`,
                  ...Arr.map(
                    previewed.available,
                    (skill) => `- ${skillLine(skill)}: ${skill.description}`,
                  ),
                  'Choose, then call environment_skill_install again with id "*", the same source and skills set to their names (["*"] for all of them).',
                ],
                "\n",
              ),
            );
          case "previewed":
            break;
        }

        const { repo, ref, commit, rejected } = previewed;
        const ready = Arr.filter(previewed.skills, (skill) => !skill.unchanged);
        const same = Arr.filter(previewed.skills, (skill) => skill.unchanged);
        const where = { repo, ref, commit };
        const pinned = skillSourceText({ repo, path: "", ref, commit });

        const sameResults = Arr.map(same, ({ name, path }) => ({
          name,
          path,
          outcome: "unchanged" as const,
        }));

        const sameWords =
          same.length === 0
            ? []
            : [
                `${namesOf(same)} ${same.length === 1 ? "is" : "are"} kept Global from there already, so ${same.length === 1 ? "it is" : "they are"} not part of it.`,
              ];

        const refusedWords =
          rejected.length === 0
            ? []
            : [
                "Refused, so not part of it:",
                ...Arr.map(
                  rejected,
                  (skill) => `- ${skillLine(skill)}: ${ownerWords(skill.message)}`,
                ),
              ];

        if (ready.length === 0) {
          if (rejected.length > 0) {
            return yield* refusal(
              Arr.join(
                [
                  `Nothing was asked or installed: no Skill of ${pinned} could be kept Global.`,
                  ...sameWords,
                  ...refusedWords,
                ],
                "\n",
              ),
            );
          }

          return {
            card: {
              tool: "environment_skill_install",
              target: "Global",
              change: "",
              before: "",
              after: "",
              reason,
            },
            expected: null,
            known: GLOBAL,
            unchanged: unchangedAnswer(
              `Global keeps ${namesOf(same)} from ${pinned} with these files already: nothing was asked, changed or recorded.`,
              installEmpty(sameResults, where),
            ),
          } satisfies Prepared<GlobalKnown>;
        }

        if (ready.length > MAX_APPROVED_SKILLS) {
          return yield* refusal(
            `Nothing was asked or installed: ${ready.length} Skills from ${repo} would be installed at Global (${namesOf(ready)}), and one request for the owner's Approval shows at most ${MAX_APPROVED_SKILLS}, each with its files. Call again with skills naming up to ${MAX_APPROVED_SKILLS} of them, then again for the rest.`,
          );
        }

        const { cards, unseen } = cardsOf(ready, (skill) => skill);

        return {
          card: {
            tool: "environment_skill_install",
            target: "Global",
            change: `Install ${ready.length === 1 ? "the Skill" : "the Skills"} ${Arr.join(
              Arr.map(ready, ({ name }) => JSON.stringify(name)),
              ", ",
            )} from ${pinned}`,
            before: Arr.join(
              Arr.map(ready, ({ name, current }) =>
                current === null
                  ? `${name}: not kept Global`
                  : `${name}: kept Global: ${current.description} (files: ${Arr.join(current.files, ", ")})`,
              ),
              "\n",
            ),
            after: Arr.join(
              Arr.map(
                cards,
                ({ skill, card }) =>
                  `━━ ${skill.name} (${skill.path === "" ? "the repo's root" : skill.path}) ━━\n${card.after}`,
              ),
              "\n\n",
            ),
            reason,
          },
          // The pin only (L6): read again at this commit, and each Skill kept only when it is the same folder with the
          // same files, while the Skill of its name was last saved then.
          expected: {
            commit,
            skills: Arr.map(ready, ({ name, path, digest, current }) => ({
              name,
              path,
              digest,
              savedAt: current?.savedAt ?? null,
            })),
          } satisfies typeof SkillInstallPin.Encoded,
          known: GLOBAL,
          note: Arr.join([...sameWords, ...refusedWords, ...unseenNote(unseen)], "\n"),
        } satisfies Prepared<GlobalKnown>;
      }),
    apply: ({ source, skills }, expected, author) =>
      Effect.gen(function* () {
        const pin = Schema.decodeUnknownOption(SkillInstallPin)(expected);

        if (Option.isNone(pin)) return yield* noPin("Skills");

        const result = yield* environments.installSkills({
          environment: GLOBAL_ID,
          source,
          skills,
          author: { ...author, approved: true },
          pin: pin.value,
        });

        return { known: GLOBAL, result };
      }),
    outcome: (result, earlier) => {
      if (result.status !== "installed") return "refused";

      const results = withEarlierInstalls(result.results, earlier);

      return skillsOutcome(
        Arr.filter(results, (each) => each.outcome === "installed").length,
        Arr.filter(results, (each) => each.outcome === "unchanged").length,
        earlier,
      );
    },
    render: (_args, _expected, { result }, { earlier }) =>
      Effect.gen(function* () {
        switch (result.status) {
          case "missing":
            return yield* noGlobal;
          case "refused":
            return yield* refusal(
              `The owner approved, but nothing was installed: ${result.message}`,
            );
          case "listed":
            return yield* refusal(
              "The owner approved, but the repo no longer holds the Skills they were shown at that commit: nothing was installed. Ask again.",
            );
          case "installed":
            break;
        }

        const { repo, ref, commit } = result;
        const results = withEarlierInstalls(result.results, earlier);
        const saved = Arr.filter(results, (each) => each.outcome === "installed");
        const same = Arr.filter(results, (each) => each.outcome === "unchanged");
        const skipped = Arr.filter(results, (each) => each.outcome === "rejected");
        const at = `${repo} (at ${shortSha(commit)})`;

        const skippedLines = Arr.map(
          skipped,
          (each) => `- ${skillLine(each)}: ${ownerWords(each.message ?? "refused")}`,
        );

        if (saved.length === 0 && same.length === 0) {
          return yield* refusal(
            Arr.join(
              [
                `The owner approved, but nothing was installed from ${at}: no Skill was still as they were shown it.`,
                ...skippedLines,
              ],
              "\n",
            ),
          );
        }

        const overriddenIn = Arr.dedupeWith(
          Arr.flatMap(saved, (each) => each.overriddenIn ?? []),
          (left: { readonly id: string }, right: { readonly id: string }) => left.id === right.id,
        );

        const text = Arr.join(
          [
            saved.length === 0
              ? `The owner approved, and Global keeps ${namesOf(same)} from ${at} already, as approved: nothing more needed changing.`
              : `The owner approved: installed ${namesOf(saved)} at Global from ${at}.`,
            ...(saved.length === 0 || same.length === 0
              ? []
              : [
                  `${namesOf(same)} ${same.length === 1 ? "was" : "were"} kept Global from there already: nothing changed, and nothing was recorded for ${same.length === 1 ? "it" : "them"}.`,
                ]),
            ...(skipped.length === 0
              ? []
              : [
                  `Skipped (${saved.length + same.length === 0 ? "nothing else was asked" : "the others were kept"}):`,
                  ...skippedLines,
                ]),
            ...(saved.length === 0
              ? []
              : [
                  `${SERVED_GLOBAL}${hiddenIn(overriddenIn)}.`,
                  "Each change is recorded as approved, with your reason and the files before and after, and the owner can revert it on the Skills page.",
                ]),
          ],
          " ",
        );

        return {
          text: endpointText(text),
          structured: installValue({
            scope: GLOBAL,
            source: { repo, ref, commit },
            results,
            listed: [],
          }),
          details: null,
        };
      }),
    declined: ({ source }, _known, answer) => ({
      text: declinedText(`installing Skills from ${source} at Global`, answer.reason ?? null),
      structured: installEmpty([], null),
      details: null,
    }),
  };

  // ─── Update ────────────────────────────────────────────────────────────────

  /** The decoded `expected` of an update: the pins the owner approved. */
  const UpdateAsked = Schema.Struct({ pins: Schema.Array(SkillUpdatePin) });

  /** The lines that tell what became of each Skill that was not moved or found the same. */
  const notMovedLines = (results: ReadonlyArray<SkillUpdateEntry>): ReadonlyArray<string> =>
    Arr.flatMap(results, (result) =>
      result.outcome === "updated" || result.outcome === "unchanged"
        ? []
        : [`- ${result.name} (${result.outcome}): ${ownerWords(result.message)}`],
    );

  const update: GlobalSkillCore<GlobalUpdateArgs, SkillsUpdated> = {
    tool: "environment_skill_update",
    prepare: ({ names, overwrite, reason }) =>
      Effect.gen(function* () {
        yield* refuseSecrets("Nothing was asked or updated", [
          { what: "the reason", text: reason },
          ...Arr.map(names ?? [], (name) => ({ what: "a Skill name", text: name })),
        ]);

        const previewed = yield* environments.previewUpdates({
          environment: GLOBAL_ID,
          names,
          overwrite: overwrite === true,
        });

        switch (previewed.status) {
          case "missing":
            return yield* noGlobal;
          case "refused":
            return yield* refusal(`Nothing was asked or updated: ${previewed.message}.`);
          case "nothing":
            return {
              card: {
                tool: "environment_skill_update",
                target: "Global",
                change: "",
                before: "",
                after: "",
                reason,
              },
              expected: null,
              known: GLOBAL,
              unchanged: unchangedAnswer(
                'No Skill kept Global is marked update available: nothing was asked. The daily check marks a Skill when its folder changed at its Skill source on the ref it was installed from (environment_get with id "*" shows the marks); name Skills in names to update them anyway.',
                updateValue({ scope: GLOBAL, results: [], nothingMarked: true }),
              ),
            } satisfies Prepared<GlobalKnown>;
          case "done":
            break;
        }

        const ready = Arr.filter(
          previewed.results,
          (result): result is SkillUpdateReady => result.outcome === "ready",
        );

        const settled = Arr.filter(
          previewed.results,
          (result): result is SkillUpdateEntry => result.outcome !== "ready",
        );

        const same = Arr.filter(settled, (result) => result.outcome === "unchanged");
        const left = notMovedLines(settled);

        const sameWords =
          same.length === 0
            ? []
            : [
                `${namesOf(same)} ${same.length === 1 ? "is" : "are"} the same at the ref's latest commit, so not part of it.`,
              ];

        const leftWords = left.length === 0 ? [] : ["Not part of it:", ...left];

        if (ready.length === 0) {
          if (left.length > 0) {
            return yield* refusal(
              Arr.join(
                [
                  "Nothing was asked or updated: no Skill named would move.",
                  ...sameWords,
                  ...leftWords,
                ],
                "\n",
              ),
            );
          }

          return {
            card: {
              tool: "environment_skill_update",
              target: "Global",
              change: "",
              before: "",
              after: "",
              reason,
            },
            expected: null,
            known: GLOBAL,
            unchanged: unchangedAnswer(
              `${namesOf(same)} ${same.length === 1 ? "is" : "are"} the same at the ref's latest commit: nothing was asked, changed or recorded.`,
              updateValue({ scope: GLOBAL, results: settled, nothingMarked: false }),
            ),
          } satisfies Prepared<GlobalKnown>;
        }

        if (ready.length > MAX_APPROVED_SKILLS) {
          return yield* refusal(
            `Nothing was asked or updated: ${ready.length} Skills would be updated at Global (${namesOf(ready)}), and one request for the owner's Approval shows at most ${MAX_APPROVED_SKILLS}, each with its files. Name up to ${MAX_APPROVED_SKILLS} of them, then call again for the rest.`,
          );
        }

        const { cards, unseen } = cardsOf(ready, (skill) => ({
          description: `${skill.description}${skill.overwrites ? "\n⚠ EDITED since it was installed: this update replaces the edits." : ""}`,
          files: skill.files,
        }));

        const leftOut =
          left.length === 0 ? "" : `Not part of this update:\n${Arr.join(left, "\n")}\n\n`;

        return {
          card: {
            tool: "environment_skill_update",
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
            after: `${leftOut}${Arr.join(
              Arr.map(
                cards,
                ({ skill, card }) =>
                  `━━ ${skill.name} (${skill.to.path === "" ? "the repo's root" : skill.to.path}) at ${skillSourceText(skill.to)} ━━\n${card.after}`,
              ),
              "\n\n",
            )}`,
            reason,
          },
          // The pins only (L6): applied only at these commits and folders, while each Skill was last saved as it is now.
          expected: {
            pins: Arr.map(ready, (skill) => ({
              name: skill.name,
              savedAt: skill.savedAt,
              commit: skill.to.commit,
              folderHash: skill.folderHash,
            })),
          } satisfies typeof UpdateAsked.Encoded,
          known: GLOBAL,
          note: Arr.join([...sameWords, ...leftWords, ...unseenNote(unseen)], "\n"),
        } satisfies Prepared<GlobalKnown>;
      }),
    apply: ({ overwrite }, expected, author) =>
      Effect.gen(function* () {
        const asked = Schema.decodeUnknownOption(UpdateAsked)(expected);

        if (Option.isNone(asked)) return yield* noPin("update");

        const { pins } = asked.value;

        const result = yield* environments.updateSkills({
          environment: GLOBAL_ID,
          names: Arr.map(pins, (pin) => pin.name),
          overwrite: overwrite === true,
          pins,
          author: { ...author, approved: true },
        });

        return { known: GLOBAL, result };
      }),
    outcome: (result, earlier) => {
      if (result.status !== "done") return "refused";

      const results = withEarlierUpdates(result.results, earlier);

      return skillsOutcome(
        Arr.filter(results, (each) => each.outcome === "updated").length,
        Arr.filter(results, (each) => each.outcome === "unchanged").length,
        earlier,
      );
    },
    render: (_args, _expected, { result }, { earlier }) =>
      Effect.gen(function* () {
        switch (result.status) {
          case "missing":
            return yield* noGlobal;
          case "refused":
            return yield* refusal(`The owner approved, but nothing was updated: ${result.message}`);
          case "nothing":
            return yield* refusal(
              "The owner approved, but no Skill the request names is kept Global to update: nothing was updated. Ask again.",
            );
          case "done":
            break;
        }

        const results = withEarlierUpdates(result.results, earlier);
        const moved = Arr.flatMap(results, (each) => (each.outcome === "updated" ? [each] : []));
        const same = Arr.filter(results, (each) => each.outcome === "unchanged");
        const skipped = notMovedLines(results);

        if (moved.length === 0 && same.length === 0) {
          return yield* refusal(
            Arr.join(
              [
                "The owner approved, but nothing was updated: no Skill was still as they were shown it.",
                ...skipped,
              ],
              "\n",
            ),
          );
        }

        const overwrote = Arr.filter(moved, (each) => each.overwrote);

        const text = Arr.join(
          [
            moved.length === 0
              ? `The owner approved, and ${namesOf(same)} ${same.length === 1 ? "is" : "are"} at what they approved already: nothing more needed changing.`
              : `The owner approved: updated ${Arr.join(
                  Arr.map(
                    moved,
                    (each) =>
                      `${each.name} (${skillSourceText(each.from)} → ${shortSha(each.to.commit)})`,
                  ),
                  ", ",
                )} at Global.`,
            ...(overwrote.length === 0
              ? []
              : [
                  `The edits made to ${namesOf(overwrote)} were replaced; reverting the update brings them back.`,
                ]),
            ...(moved.length === 0 || same.length === 0
              ? []
              : [
                  `${namesOf(same)} ${same.length === 1 ? "was" : "were"} at the approved commit already: nothing changed, and nothing was recorded for ${same.length === 1 ? "it" : "them"}.`,
                ]),
            ...(skipped.length === 0
              ? []
              : [
                  `Skipped (${moved.length + same.length === 0 ? "nothing else was asked" : "the others were updated"}):`,
                  ...skipped,
                ]),
            ...(moved.length === 0
              ? []
              : [
                  `${SERVED_GLOBAL}.`,
                  "Each change is recorded as approved, with your reason and the files and Skill source before and after, and the owner can revert it on the Skills page.",
                ]),
          ],
          " ",
        );

        return {
          text: endpointText(text),
          structured: updateValue({ scope: GLOBAL, results, nothingMarked: false }),
          details: null,
        };
      }),
    declined: (_args, _known, answer) => ({
      text: declinedText("updating the Skills kept Global", answer.reason ?? null),
      structured: updateValue({ scope: GLOBAL, results: [], nothingMarked: false }),
      details: null,
    }),
  };

  // ─── Remove ────────────────────────────────────────────────────────────────

  /** The decoded `expected` of a removal: when the Skill was last saved, as the owner saw it. */
  const RemoveAsked = Schema.Struct({ savedAt: Schema.NullOr(Schema.Finite) });

  /** A removal's value. */
  const removeValue = (
    name: string,
    changes: ReadonlyArray<AgentChange>,
    unchanged: ReadonlyArray<string>,
  ) =>
    asOutput(
      SkillRemoveEndpointOutput,
      fittedChanges({
        scope: scopeRef(GLOBAL),
        ...changesOutput(changes),
        unchanged,
        changed: changes.length > 0,
        skill: name,
        global_served: false,
      }),
    );

  const remove: GlobalSkillCore<GlobalRemoveArgs, SkillRemoved> = {
    tool: "environment_skill_remove",
    prepare: ({ name, reason }) =>
      Effect.gen(function* () {
        yield* refuseSecrets("Nothing was asked or removed", [
          { what: "the reason", text: reason },
          { what: "the name", text: name },
        ]);

        const { skills } = yield* environments.global;
        const kept = Arr.findFirst(skills, (skill) => skill.name === name);

        if (Option.isNone(kept)) {
          return yield* EnvironmentsError.make({
            message: `Nothing was asked or removed: no Skill named ${JSON.stringify(name)} is kept Global (a Skill may be gone already). environment_get with id "${GLOBAL_ID}" lists them.`,
            code: NOT_FOUND,
          });
        }

        return {
          card: {
            tool: "environment_skill_remove",
            target: "Global",
            change: `Remove the Skill ${JSON.stringify(name)}`,
            before: `${name}: ${kept.value.description}`,
            after:
              "Removed at Global: each Environment serves its own Skill of the name if it has one",
            reason,
          },
          // The Skill as the owner saw it: removed only while it was last saved then.
          expected: { savedAt: kept.value.savedAt } satisfies typeof RemoveAsked.Encoded,
          known: GLOBAL,
        } satisfies Prepared<GlobalKnown>;
      }),
    apply: ({ name }, expected, author) =>
      Effect.gen(function* () {
        const asked = Schema.decodeUnknownOption(RemoveAsked)(expected);

        if (Option.isNone(asked)) return yield* noPin("Skill");

        const result = yield* environments.removeSkill({
          environment: GLOBAL_ID,
          name,
          expected: asked.value,
          author: { ...author, approved: true },
        });

        return { known: GLOBAL, result };
      }),
    outcome: (result) => {
      switch (result.status) {
        case "removed":
          return "wrote";
        case "absent":
          return "found";
        case "changed-since":
          return "changed_since";
        default:
          return "refused";
      }
    },
    render: ({ name }, _expected, { result }) =>
      Effect.gen(function* () {
        switch (result.status) {
          case "missing":
            return yield* noGlobal;
          case "rejected":
            return yield* refusal(
              `The owner approved, but nothing was removed:\n${result.message}`,
            );
          case "changed-since":
            return yield* refusal(
              `The owner approved, but the Skill ${name} kept Global was saved again since they were asked: nothing was removed. Ask again if it should still be removed.`,
            );
          case "absent":
            return {
              text: endpointText(
                `The owner approved, and no Skill named ${JSON.stringify(name)} is kept Global already, as approved: nothing more needed changing.`,
              ),
              structured: removeValue(name, [], [skillField(name)]),
              details: null,
            };
          case "removed":
            return {
              text: endpointText(
                Arr.join(
                  [
                    `The owner approved: removed the Skill ${name} from Global.`,
                    `Each Environment's Workspaces and spares stop serving it at ${SKILLS_ROOT}/${name} from their next readying${hiddenIn(result.overriddenIn, true)}.`,
                    "The change is recorded as approved, with your reason and the files the Skill had, and the owner can revert it on the Skills page.",
                  ],
                  " ",
                ),
              ),
              structured: removeValue(name, [result.change], []),
              details: null,
            };
        }
      }),
    declined: ({ name }, _known, answer) => ({
      text: declinedText(`removing the Skill ${name} from Global`, answer.reason ?? null),
      structured: removeValue(name, [], []),
      details: null,
    }),
  };

  return {
    environment_skill_install: install,
    environment_skill_update: update,
    environment_skill_remove: remove,
  };
};

export type GlobalSkillCores = ReturnType<typeof globalSkillCores>;
