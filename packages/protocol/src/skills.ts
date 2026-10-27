// An Environment's own Skills (ADR-0026, `docs/spec.md` → Agent changes → Skills): what the Environments page lists of
// them, and how an Agent change records one. Shared by the server (which keeps and changes them) and the web app (which
// lists them and shows a change's files as diffs).
import * as Schema from "effect/Schema";

/** Where every Workspace serves its Skill set, read-only: a Skill named `name` is at `<SKILLS_ROOT>/<name>`. */
export const SKILLS_ROOT = "/workspace/.agents/skills";

/** A Skill kept for an Environment, as the Environments page lists it. Times are epoch milliseconds. */
export const EnvironmentSkill = Schema.Struct({
  /** Its name, from its `SKILL.md` frontmatter: also its folder's under `SKILLS_ROOT`. */
  name: Schema.String,
  description: Schema.String,
  /** When it was last saved. */
  savedAt: Schema.Finite,
});

export type EnvironmentSkill = typeof EnvironmentSkill.Type;

const SKILL_FIELD = "skills.";

/** An Agent change's field for one Skill, by name: its files before and after (`SkillChangeValue`), null for none. */
export const skillField = (name: string): string => `${SKILL_FIELD}${name}`;

/** The Skill an Agent change's field names, or null for another field. */
export const fieldSkill = (field: string): string | null =>
  field.startsWith(SKILL_FIELD) ? field.slice(SKILL_FIELD.length) : null;

/**
 * What an Agent change of a Skill records before and after it: each file's path in the Skill's folder with the hash of
 * its content, which the Registry keeps once per hash (`skillChangeFiles` answers the texts).
 */
export const SkillChangeValue = Schema.Struct({
  files: Schema.Record(Schema.String, Schema.String),
});

export type SkillChangeValue = typeof SkillChangeValue.Type;

/** One file of a Skill as a change shows it: its path in the Skill's folder and its text. */
export const SkillFile = Schema.Struct({ path: Schema.String, text: Schema.String });

export type SkillFile = typeof SkillFile.Type;

/** A Skill's files before and after an Agent change, by path; null where the Skill was not there. */
export const SkillChangeFiles = Schema.Struct({
  before: Schema.NullOr(Schema.Array(SkillFile)),
  after: Schema.NullOr(Schema.Array(SkillFile)),
});

export type SkillChangeFiles = typeof SkillChangeFiles.Type;
