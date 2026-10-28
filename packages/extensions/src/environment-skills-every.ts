// The change to the Skills kept for every Environment that waits for the owner's Approval (ADR-0026, GLOSSARY.md →
// Approval, `docs/spec.md` → Approval): `environment_skill_save` and `environment_skill_remove` with `id: "*"`. A Skill
// there steers every future Session, so it is where a prompt-injected agent would plant instructions: the owner reads
// the Skill's files on the card (which says plainly what it could not show), and the change is made only against what
// they were shown (the folder's digest, and when the Skill of the name was last saved).
//
// `environment.ts` imports this module through `./environment-skills.ts`, so what it takes from `environment.ts` is used
// inside functions only: its exports are not there yet when this module loads.
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off preferSchemaOverJson:off
import { skillField } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { type ApprovalCall, askedBefore, declined, withApproval } from "./approvals.ts";
import { EnvironmentsError } from "./environment.ts";
import { EVERY_ENVIRONMENT_ID } from "./environment-secret-marks.ts";
import {
  EVERY,
  named,
  refused,
  removedOutcome,
  savedOutcome,
  servedAt,
  type SkillToolDeps,
} from "./environment-skill-results.ts";

/**
 * What a tool's description says of the Approval of a change to the Skills kept for every Environment. It is not the
 * Limits' wording (`approval-tools.ts`): what must still hold when the owner answers is the Skill, not a setting.
 */
export const SKILL_APPROVAL =
  "The user is asked for their Approval on a card in the Session (and a notification): the call waits for the answer, with no deadline. On Approve the change is made and recorded as approved; on Decline nothing changes, and the result carries their reason. If the Skill of the name was saved again, or the folder's files changed, meanwhile, the approval does not apply and you are told to ask again.";

/**
 * The most characters of a Skill's files the Approval card shows. A Skill may be far larger (1 MB), so the card says
 * what it cut, since the owner approves what they can read.
 */
export const MAX_CARD_CHARS = 16_000;

/** What the card showed of a Skill's files, and what of them it did not. */
type Card = {
  /** The Skill as the card's _After_ shows it: its description and files, between a warning when anything is cut. */
  readonly after: string;
  /** What the card could not show: null when it showed everything. */
  readonly unseen: { readonly files: number; readonly characters: number } | null;
};

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/**
 * The files of one or more Skills as the Approval card shows them, each Skill's `SKILL.md` first, up to `MAX_CARD_CHARS`
 * characters in all (the Skills share the budget). Each Skill is `heading` (its description, or what the card says of it)
 * and its files. A file that is cut, or left out, says so where it is, and a warning that the owner has not seen the
 * rest, with how much, comes before the files and after them.
 */
export const cardOfSkills = (
  skills: ReadonlyArray<{
    readonly heading: string;
    readonly files: Readonly<Record<string, string>>;
  }>,
): Card => {
  let budget = MAX_CARD_CHARS;
  let unseenFiles = 0;
  let unseenCharacters = 0;
  let total = 0;
  let count = 0;

  const shownSkills = Arr.map(skills, ({ heading, files }) => {
    const ordered = Arr.sort(
      Record.toEntries(files),
      Order.mapInput(Order.String, ([path]: readonly [string, string]) =>
        path === "SKILL.md" ? "" : path,
      ),
    );

    const shown = Arr.map(ordered, ([path, text]) => {
      const head = `── ${path} (${bytesOf(text)} bytes)`;

      total += text.length;
      count += 1;

      if (budget <= 0) {
        unseenFiles += 1;
        unseenCharacters += text.length;

        return `${head}, NOT SHOWN ──`;
      }

      if (text.length <= budget) {
        budget -= text.length;

        return `${head} ──\n${text}`;
      }

      const cut = text.length - budget;

      unseenFiles += 1;
      unseenCharacters += cut;

      const kept = text.slice(0, budget);

      budget = 0;

      return `${head}, CUT ──\n${kept}\n… ${cut} more characters NOT SHOWN`;
    });

    return `${heading}\n\n${Arr.join(shown, "\n\n")}`;
  });

  const skill = Arr.join(shownSkills, "\n\n\n");

  if (unseenFiles === 0) return { after: skill, unseen: null };

  const warning = `⚠ NOT FULLY SHOWN: ${unseenCharacters} of ${total} characters (${unseenFiles} of ${count} files) are cut or left out below. Approving saves the whole Skill${skills.length === 1 ? "" : "s"}, including the part you have not seen: it was not reviewed. Decline, and ask for ${skills.length === 1 ? "a Skill" : "Skills"} small enough to review in full, unless you trust the part you cannot see.`;

  return {
    after: `${warning}\n\n${skill}\n\n${warning}`,
    unseen: { files: unseenFiles, characters: unseenCharacters },
  };
};

/** A Skill's files as the Approval card shows them (`cardOfSkills`), after its description. */
export const cardOf = (description: string, files: Readonly<Record<string, string>>): Card =>
  cardOfSkills([{ heading: description, files }]);

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

type EveryDeps = Pick<SkillToolDeps, "environments" | "approvals" | "log" | "notFound">;

/** Save the folder's Skill for every Environment once the owner approves it. */
export const saveEverywhere = (
  { environments, approvals, log, notFound }: EveryDeps,
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

    const previewed = yield* environments.previewSkill({
      environment: EVERY_ENVIRONMENT_ID,
      folder,
      files,
    });

    const rerun = yield* askedBefore(approvals, api);

    if (previewed.status === "missing" || previewed.status === "rejected") {
      // A rerun that no longer passes the checks asks nothing: its request, if still waiting, is withdrawn.
      if (rerun) yield* approvals.settle(String(api.taskId));

      return yield* previewed.status === "missing"
        ? notFound(EVERY_ENVIRONMENT_ID)
        : refused(`\n${previewed.message}`);
    }

    const { name, description, current } = previewed;

    if (previewed.status === "unchanged" && !rerun) {
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
    const card = cardOf(description, files);

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
        after: card.after,
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

          if (Option.isNone(asked)) {
            return yield* EnvironmentsError.make({
              message: `The user approved, but the request holds no record of the Skill they were shown: nothing was saved. Ask again.`,
            });
          }

          if (asked.value.digest !== digest) {
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

          return yield* savedOutcome(saved, {
            environments,
            log,
            notFound,
            scope: EVERY_ENVIRONMENT_ID,
            own: false,
            approved: true,
            folder,
            count: Record.size(files),
            note:
              card.unseen === null
                ? undefined
                : `The card showed the user only the first ${MAX_CARD_CHARS} characters of the Skill's files: ${card.unseen.characters} characters in ${card.unseen.files} file${card.unseen.files === 1 ? "" : "s"} were cut or left out, so that part was not reviewed. Keep a Skill for every Environment small enough to review in full.`,
          });
        }),
    );
  });

/** Remove the Skill kept for every Environment once the owner approves it. */
export const removeEverywhere = (
  { environments, approvals, log, notFound }: EveryDeps,
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

          if (Option.isNone(asked)) {
            return yield* EnvironmentsError.make({
              message: `The user approved, but the request holds no record of the Skill they were shown: nothing was removed. Ask again.`,
            });
          }

          const removed = yield* environments.removeSkill({
            environment: EVERY_ENVIRONMENT_ID,
            name,
            expected: asked.value,
            author: { conversation: api.conversationId, tool, reason, approved: true },
          });

          return yield* removedOutcome(removed, {
            environments,
            log,
            notFound,
            scope: EVERY_ENVIRONMENT_ID,
            own: false,
            approved: true,
            name,
          });
        }),
    );
  });
