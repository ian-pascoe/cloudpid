// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- the badges are worked out over native arrays.
// Where the Skills of the Skill directory are installed here (GLOSSARY.md → Skill directory, `docs/architecture/workspace.md` →
// _The Skill directory_): the badges of a row (installed for every Environment, installed in N Environments, update
// available), worked out in the Registry from the Skills it keeps so that every page that lists Skills (the lists, a repo's
// Skills, a Skill's page) answers them the same way. A copy matches by its Skill source's repo and path, not by name alone.
import type { SkillInstalledIn } from "@cloudpid/protocol";
import { slug } from "../github/skill-fetch.ts";
import type { Skills } from "./skills.ts";

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
 * The kept copies that are the Skill `wanted`, in the same repo (GitHub's names ignore case). With a folder, the copy in
 * exactly that folder. With only the Skill's ID in the source (skills.sh's leaderboards and search name a Skill by its
 * SKILL.md name, which is not always its folder's), as an install resolves the ID (`skills: [skillId]`, `skill-fetch.ts`):
 * the copies of that name, else those in a folder named so, so that a row and its install agree and two Skills of a repo
 * do not share a badge.
 */
const copiesOf = (
  installed: ReadonlyArray<InstalledSkillRef>,
  wanted: WantedSkill,
): ReadonlyArray<InstalledSkillRef> => {
  const repo = wanted.repo.toLowerCase();
  const inRepo = installed.filter((ref) => ref.repo.toLowerCase() === repo);

  if ("path" in wanted) return inRepo.filter((ref) => ref.path === wanted.path);

  const id = slug(wanted.skillId);

  if (id === "") return [];

  const named = inRepo.filter((ref) => slug(ref.name) === id);

  return named.length > 0 ? named : inRepo.filter((ref) => slug(folderName(ref.path)) === id);
};

/** Where the Skill `wanted` is installed according to `installed`, or undefined when nowhere. */
export const installedIn = (
  installed: ReadonlyArray<InstalledSkillRef>,
  wanted: WantedSkill,
): SkillInstalledIn | undefined => {
  const found = copiesOf(installed, wanted);

  if (found.length === 0) return undefined;

  const environments = new Set<string>();

  for (const { scope } of found) if (scope !== "*") environments.add(scope);

  return {
    everyEnvironment: found.some(({ scope }) => scope === "*"),
    environments: [...environments].toSorted(),
    updateAvailable: found.some(({ updateAvailable }) => updateAvailable),
  };
};

/** The Skills the Registry keeps that have a Skill source, in any scope, as the badges read them. */
export const installedSkillRefs = (
  skills: Pick<Skills, "listSourced">,
): ReadonlyArray<InstalledSkillRef> =>
  skills
    .listSourced()
    .flatMap(({ scope, name, source, updateAvailable }) =>
      source === null
        ? []
        : [{ scope, name, repo: source.repo, path: source.path, updateAvailable }],
    );

/** `rows` of the Skill directory, each with where its Skill is installed (none: no `installed`). */
export const withInstalled = <Row extends { readonly source: string; readonly skillId: string }>(
  rows: ReadonlyArray<Row>,
  installed: ReadonlyArray<InstalledSkillRef>,
): ReadonlyArray<Row & { readonly installed?: SkillInstalledIn }> =>
  rows.map((row) => {
    const where = installedIn(installed, { repo: row.source, skillId: row.skillId });

    return where === undefined ? row : { ...row, installed: where };
  });
