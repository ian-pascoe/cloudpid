// What a Skill set is (ADR-0026): the shape both the Workspace DO (which mounts a set, `skill-set.ts`) and the Registry
// (which merges the Skills kept for an Environment into one and hands it over) use. No import of computer, so the
// Registry can load it.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off
import * as Schema from "effect/Schema";

/**
 * A set of Skills as the mount serves it: each file's text by its path under the mount (`<skill>/SKILL.md`, …), and a
 * hash of the contents, which says whether two sets differ without comparing their files.
 */
export const SkillSet = Schema.Struct({
  hash: Schema.NonEmptyString,
  files: Schema.Record(Schema.String, Schema.String),
});

export type SkillSet = typeof SkillSet.Type;

/**
 * The hash of a set with no file: SHA-256 of nothing, which is what the Registry's merge makes of no file (`mergeSkills`).
 * Never a version computer recorded for a mount that held Skills before, so a Workspace that mounted others is copied
 * again, empty, at its next index.
 */
export const EMPTY_SKILL_SET_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** The Skill set of a Workspace that was handed none: no Skill. */
export const EMPTY_SKILL_SET: SkillSet = { hash: EMPTY_SKILL_SET_HASH, files: {} };
