// What a Skill set is, and the bundled one (ADR-0026): the shape both the Workspace DO (which mounts a set,
// `skill-set.ts`) and the Registry (which merges an Environment's own Skills over the bundle and hands the set over)
// use. No import of computer, so the Registry can load it: it does so only when it first needs the bundle, since the
// deploy loads the main Worker's modules in Node, which cannot load the bundle's `?raw` imports.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { BUNDLED_SKILLS } from "./bundled-skills.generated.ts";

/**
 * A set of Skills as the mount serves it: each file's text by its path under the mount (`<skill>/SKILL.md`, …), and a
 * hash of the contents, which says whether two sets differ without comparing their files.
 */
export const SkillSet = Schema.Struct({
  hash: Schema.NonEmptyString,
  files: Schema.Record(Schema.String, Schema.String),
});

export type SkillSet = typeof SkillSet.Type;

/** The Skills bundled with this Worker (`skills/`), with the hash computer recorded for the mount before sets existed. */
export const BUNDLED_SKILL_SET: SkillSet = {
  // SAFETY: the generator always writes a version (`bundled-skills.test.ts` recomputes it).
  hash: BUNDLED_SKILLS.version!,
  // Every file of the bundle is a `?raw` import, a string.
  files: Object.fromEntries(
    Object.entries(BUNDLED_SKILLS.files).flatMap(([path, content]) =>
      Predicate.isString(content) ? [[path, content] as const] : [],
    ),
  ),
};
