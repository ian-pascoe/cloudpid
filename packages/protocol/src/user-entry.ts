// The owner's message after the Session expanded it (docs/adr/0001-expand-skills-and-prompt-templates-at-submit.md): a
// message that names a Skill (`/skill:name`, `$name`) or starts with a Prompt template's `/name` is submitted as a
// `cloudpid.user` entry whose model message is the expansion and whose data keeps what the owner typed, which the
// transcript and the Session's title show instead.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over an entry's JSON and its text.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AttachedPage } from "./attached-pages.ts";
import { ReviewData } from "./review.ts";

/** The kind of an owner's message the Session expanded. */
export const USER_ENTRY_KIND = "cloudpid.user";

/** A Skill an expanded message carries: its name and the path of its `SKILL.md`. */
export const ExpandedSkill = Schema.Struct({ name: Schema.String, location: Schema.String });

export type ExpandedSkill = typeof ExpandedSkill.Type;

/**
 * The data of a `cloudpid.user` entry: the text the owner typed (`display`, empty when they typed none), the Skills
 * expanded into the model's message, the pages attached to it (`pages`, what the Session read of them; the model
 * got them as a block of page content, which the transcript shows as chips instead), and for a Review, the Annotations
 * it sent (`review`), whose Markdown ends the model message's first text, after the summary.
 */
export const UserEntryData = Schema.Struct({
  display: Schema.String,
  skills: Schema.Array(ExpandedSkill),
  pages: AttachedPage.pipe(Schema.Array, Schema.optionalKey),
  review: Schema.optionalKey(ReviewData),
});

export type UserEntryData = typeof UserEntryData.Type;

const decodeData = Schema.decodeUnknownOption(UserEntryData);

/** The typed text and Skills of an entry the Session expanded, or undefined for any other entry. */
export const userEntryData = (entry: {
  readonly kind: string;
  readonly data?: unknown;
}): UserEntryData | undefined =>
  entry.kind === USER_ENTRY_KIND ? Option.getOrUndefined(decodeData(entry.data)) : undefined;

/** A Skill as the model reads it, in local pi's block: `body` is its `SKILL.md` without the frontmatter. */
export const skillBlock = (skill: {
  readonly name: string;
  readonly location: string;
  readonly body: string;
}): string => {
  const baseDir = skill.location.slice(0, Math.max(skill.location.lastIndexOf("/"), 0)) || "/";

  return `<skill name="${skill.name}" location="${skill.location}">\nReferences are relative to ${baseDir}.\n\n${skill.body}\n</skill>`;
};

const CLOSE = "\n</skill>";

const openingOf = (skill: ExpandedSkill): string =>
  `<skill name="${skill.name}" location="${skill.location}">`;

/**
 * The text after the blocks of an expansion whose owner typed `display`: the typed text itself, or what follows a
 * leading `/skill:name`. Empty when the owner typed nothing more.
 */
const typedTails = (display: string): readonly string[] => {
  const lead = /^\/skill:\S+(?:\s+([\s\S]*))?$/.exec(display);

  return lead === null ? [display] : [(lead[1] ?? "").trim(), display];
};

/** `text` with the links its `$name` Skill references became put back as typed. */
const unlinked = (text: string): string => text.replace(/\[(\$[^\]\s]+)\]\(\/[^\s()]*\)/g, "$1");

/**
 * The block of each Skill of `data` in `text`, the expansion the model got, in the order of `data.skills`; undefined for
 * one that is not there. The expansion is the blocks, in that order, each separated from the next by a blank line, then
 * the typed text, its `$name` references linked: a block ends where the next one starts, and the last where the typed
 * text does, so a body that holds `</skill>` itself is not cut short.
 */
export const skillBlocksIn = (
  text: string,
  data: UserEntryData,
): ReadonlyArray<string | undefined> => {
  const starts: number[] = [];
  let from = 0;

  for (const skill of data.skills) {
    const start = text.indexOf(openingOf(skill), from);

    starts.push(start);

    if (start !== -1) from = start + openingOf(skill).length;
  }

  const tails = typedTails(data.display);

  const lastEnd = (start: number): number | undefined => {
    const ends: number[] = [];

    for (let end = text.indexOf(CLOSE, start); end !== -1; end = text.indexOf(CLOSE, end + 1)) {
      const after = end + CLOSE.length;

      if (after === text.length || text.startsWith("\n\n", after)) ends.push(after);
    }

    // Where what follows is the typed text; else the last end, a typed text holding `</skill>` being rarer than a body.
    return (
      ends.find((end) => {
        const rest = text.slice(end + 2);

        return tails.some((tail) => tail === rest || tail === unlinked(rest));
      }) ?? ends.at(-1)
    );
  };

  return starts.map((start, index) => {
    if (start === -1) return undefined;

    const next = starts.slice(index + 1).find((later) => later !== -1);
    const end = next === undefined ? lastEnd(start) : next - 2;

    return end === undefined || !text.startsWith(CLOSE, end - CLOSE.length)
      ? undefined
      : text.slice(start, end);
  });
};
