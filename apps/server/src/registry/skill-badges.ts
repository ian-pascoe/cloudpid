// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- the badges are worked out over native arrays.
// Where the Skills of the Skill directory are installed here (GLOSSARY.md → Skill directory, `docs/architecture/workspace.md` →
// _The Skill directory_): the badges of a row (installed for every Environment, installed in N Environments, update
// available), worked out in the Registry from the Skills it keeps so that every page that lists Skills (the lists, a repo's
// Skills, a Skill's page) answers them the same way. A copy matches by its Skill source's repo and path, not by name alone.
import type { SkillInstalledIn } from "@cloudpid/protocol";
import { slug } from "../github/skill-fetch.ts";

/** One installed Skill that has a Skill source: where it is kept, and where it came from. */
export type InstalledSkillRef = {
  /** The Environment's id that keeps it as its own, or `*` for the Skills kept for every Environment. */
  readonly scope: string;
  /** Its name, from its SKILL.md. */
  readonly name: string;
  /** Its Skill source's repo (`owner/name`) and the Skill's folder in it (empty for the repo's root). */
  readonly repo: string;
  readonly path: string;
  readonly updateAvailable: boolean;
};

/** The Skill a row is for: its source repo, and its folder in it when the list knows it, else its ID in the source. */
export type WantedSkill =
  | { readonly repo: string; readonly path: string }
  | { readonly repo: string; readonly skillId: string };

const folderName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * Whether installed Skill `ref` is the Skill `wanted`: the same repo (GitHub's names ignore case) and the same folder. The
 * Skill directory's rows (skills.sh's leaderboards and search) name a Skill by its ID in the source, not its folder, so
 * there a copy counts when its folder is named so, or, for a Skill at the repo's root, which has no folder name, when its
 * name is: how an install finds the Skill `skills: [skillId]` names.
 */
const matches = (ref: InstalledSkillRef, wanted: WantedSkill): boolean => {
  if (ref.repo.toLowerCase() !== wanted.repo.toLowerCase()) return false;

  if ("path" in wanted) return ref.path === wanted.path;

  const id = slug(wanted.skillId);
  const folder = slug(folderName(ref.path));

  return folder === "" ? slug(ref.name) === id : folder === id;
};

/** Where the Skill `wanted` is installed according to `installed`, or undefined when nowhere. */
export const installedIn = (
  installed: ReadonlyArray<InstalledSkillRef>,
  wanted: WantedSkill,
): SkillInstalledIn | undefined => {
  const found = installed.filter((ref) => matches(ref, wanted));

  if (found.length === 0) return undefined;

  const environments = new Set<string>();

  for (const { scope } of found) if (scope !== "*") environments.add(scope);

  return {
    everyEnvironment: found.some(({ scope }) => scope === "*"),
    environments: [...environments].toSorted(),
    updateAvailable: found.some(({ updateAvailable }) => updateAvailable),
  };
};

/** `rows` of the Skill directory, each with where its Skill is installed (none: no `installed`). */
export const withInstalled = <Row extends { readonly source: string; readonly skillId: string }>(
  rows: ReadonlyArray<Row>,
  installed: ReadonlyArray<InstalledSkillRef>,
): ReadonlyArray<Row & { readonly installed?: SkillInstalledIn }> =>
  rows.map((row) => {
    const where = installedIn(installed, { repo: row.source, skillId: row.skillId });

    return where === undefined ? row : { ...row, installed: where };
  });
