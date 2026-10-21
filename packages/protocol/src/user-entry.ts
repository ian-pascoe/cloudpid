// The owner's message after the Session expanded it (docs/adr/0001-expand-skills-and-prompt-templates-at-submit.md): a
// message that names a Skill (`/skill:name`, `$name`) or starts with a Prompt template's `/name` is submitted as a
// `cloudpid.user` entry whose model message is the expansion and whose data keeps what the owner typed, which the
// transcript and the Session's title show instead.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over an entry's JSON.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The kind of an owner's message the Session expanded. */
export const USER_ENTRY_KIND = "cloudpid.user";

/** A Skill an expanded message carries: its name and the path of its `SKILL.md`. */
export const ExpandedSkill = Schema.Struct({ name: Schema.String, location: Schema.String });

export type ExpandedSkill = typeof ExpandedSkill.Type;

/** The data of a `cloudpid.user` entry: the text the owner typed, and the Skills expanded into the model's message. */
export const UserEntryData = Schema.Struct({
  display: Schema.String,
  skills: Schema.Array(ExpandedSkill),
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

/** The block of `skill` in the text the model got, or undefined when it is not there. */
export const skillBlockIn = (text: string, skill: ExpandedSkill): string | undefined => {
  const start = text.indexOf(`<skill name="${skill.name}" location="${skill.location}">`);

  if (start === -1) return undefined;

  const end = text.indexOf("\n</skill>", start);

  return end === -1 ? undefined : text.slice(start, end + "\n</skill>".length);
};
