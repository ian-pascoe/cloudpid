// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over native arrays of rows.
// An owner's repos, as the Skill directory knows them (ADR-0026, GLOSSARY.md → Skill directory,
// `docs/architecture/workspace.md` → _The Skill directory_): the owner page (`/skills/:owner`) is built from skills.sh's
// search, which has no owner listing. The search is asked for the owner's name (fuzzy, so it also finds forks and
// look-alikes, which are left out) and answers at most 200 results, so a prolific owner's list may be incomplete: the
// answer says when the limit was hit. Each repo's page asks GitHub for the full list, and a repo skills.sh does not list
// is opened there by name. Not cached: it is one search, as the Skills page's own search is.
import { queryProblem } from "@cloudpid/extensions/skill-search";
import {
  type OwnerRepo,
  type SkillDirectoryError,
  type SkillOwnerListing,
  SKILL_SEARCH_LIMIT,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { DirectoryRow, SkillDirectory } from "./skill-directory.ts";

/** The owner's repos as the Registry's RPC reads them. */
export type SkillOwners = {
  /** What the Skill directory lists of `owner`; fails with the directory's error when skills.sh does not answer. */
  readonly list: (owner: string) => Effect.Effect<SkillOwnerListing, SkillDirectoryError>;
};

/** The repo's name when `source` is `owner/repo` of `owner` (their names ignore case), else undefined. */
const repoOf = (owner: string, source: string): string | undefined => {
  const [first, name, ...rest] = source.split("/");

  return first !== undefined &&
    name !== undefined &&
    name !== "" &&
    rest.length === 0 &&
    first.toLowerCase() === owner.toLowerCase()
    ? name
    : undefined;
};

/**
 * The repos of `owner` among `rows` (what a search for the owner found): each with the Skills it has there, counted once
 * by ID, and their installs, the most installed repo first (ties by name). `capped` is whether skills.sh answered as many
 * entries (`listed`, counting any that were not Skills) as a search holds, so that some may be missing.
 */
export const groupOwnerRepos = (
  owner: string,
  rows: ReadonlyArray<DirectoryRow>,
  listed: number,
): SkillOwnerListing => {
  // By the repo's name in lower case (GitHub's names ignore case); the first spelling is the one shown.
  const repos = new Map<string, { repo: string; skills: Map<string, number> }>();

  for (const { source, skillId, installs } of rows) {
    const repo = repoOf(owner, source);

    if (repo === undefined) continue;

    const key = repo.toLowerCase();
    const group = repos.get(key) ?? { repo, skills: new Map<string, number>() };
    const id = skillId.toLowerCase();

    group.skills.set(id, Math.max(group.skills.get(id) ?? 0, installs));
    repos.set(key, group);
  }

  const grouped = Arr.fromIterable(repos.values()).map(({ repo, skills }): OwnerRepo => ({
    repo,
    skills: skills.size,
    installs: Arr.fromIterable(skills.values()).reduce((sum, installs) => sum + installs, 0),
  }));

  return {
    owner,
    repos: grouped.toSorted(
      (left, right) => right.installs - left.installs || left.repo.localeCompare(right.repo),
    ),
    capped: listed >= SKILL_SEARCH_LIMIT,
  };
};

/** `SkillOwners` over the Skill directory's search. */
export const skillOwnersOver = (directory: SkillDirectory): SkillOwners => ({
  list: (owner) => {
    const name = owner.trim();

    // A name the search refuses (one character) has nothing to ask: GitHub has such owners, the directory is no use for them.
    if (queryProblem(name) !== undefined) {
      return Effect.succeed({ owner: name, repos: [], capped: false });
    }

    return directory
      .searchListed(name)
      .pipe(Effect.map(({ rows, listed }) => groupOwnerRepos(name, rows, listed)));
  },
});
