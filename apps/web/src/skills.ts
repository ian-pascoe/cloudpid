// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over native arrays, not combinators.

// The Skills page's pure parts (ADR-0026, docs/architecture/workspace.md → Installing from GitHub): which Skills an
// Environment gets from every Environment, the lines the Installed tab shows of an install and an update, the line an
// Environment's card on the Environments page shows of its Skills, and which sections the Installed tab shows.

import {
  EVERY_ENVIRONMENT_SCOPE,
  type EnvironmentRecord,
  type EnvironmentSkill,
  type SkillInstall,
  type SkillInstalledIn,
  type SkillSource,
  type SkillUpdate,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import { skillPagePath } from "./router.ts";

/** The names of the Skills kept for every Environment that an Environment gets, and of its own that override one. */
export type InheritedSkills = {
  readonly inherited: readonly string[];
  readonly overridden: readonly string[];
};

/**
 * The Skills kept for every Environment (`every`) that an Environment keeping the Skills `own` gets, by name, and the
 * ones of its own that override one: the counterpart of `inheritedVariables`. Its own wins.
 */
export const inheritedSkills = (
  own: readonly EnvironmentSkill[],
  every: readonly EnvironmentSkill[],
): InheritedSkills => {
  const kept = new Set(own.map((skill) => skill.name));
  const names = every.map((skill) => skill.name).toSorted();

  return {
    inherited: names.filter((name) => !kept.has(name)),
    overridden: names.filter((name) => kept.has(name)),
  };
};

const skills = (count: number): string => {
  if (count === 0) return "No skills";

  return count === 1 ? "1 skill" : `${count} skills`;
};

/**
 * How many Skills a card of the Environments page says it has: an Environment keeping `own` serves those and the ones
 * kept for every Environment (`every`) it does not override, and says how many came from every Environment; the card for
 * every Environment (no `every`) counts its own.
 */
export const skillCountText = (
  own: readonly EnvironmentSkill[],
  every?: readonly EnvironmentSkill[],
): string => {
  const { inherited } = inheritedSkills(own, every ?? []);
  const total = skills(own.length + inherited.length);

  return inherited.length === 0 ? total : `${total}, ${inherited.length} from every environment`;
};

/**
 * The scopes whose Skills the Installed tab shows, in order: those kept for every Environment (`*`), then each
 * Environment's, or only the one `filter` names (`?environment=`); none when it names an Environment not listed.
 */
export const installedScopes = (
  environments: readonly EnvironmentRecord[],
  filter: string | undefined,
): readonly string[] => {
  const all = [EVERY_ENVIRONMENT_SCOPE, ...environments.map((environment) => environment.id)];

  return filter === undefined ? all : all.filter((scope) => scope === filter);
};

/** What an install answered, a line for each Skill it kept, found already kept, or refused (and why). */
export const installOutcomeLines = (
  skills: Extract<SkillInstall, { readonly status: "installed" }>["skills"],
): ReadonlyArray<string> =>
  Arr.map(skills, ({ name, outcome, message }) => {
    switch (outcome) {
      case "installed":
        return `${name}: installed`;
      case "unchanged":
        return `${name}: already installed from this commit, nothing changed`;
      case "rejected":
        return `${name}: refused${message === undefined ? "" : `: ${message}`}`;
    }
  });

/** What the owner's update answered, a line for each Skill: moved, the same already, refused for its edits, or refused. */
export const updateOutcomeLines = (skills: SkillUpdate["skills"]): ReadonlyArray<string> =>
  Arr.map(skills, ({ name, outcome, message }) => {
    switch (outcome) {
      case "updated":
        return `${name}: updated to the latest commit`;
      case "unchanged":
        return `${name}: already up to date, nothing changed`;
      case "modified":
        return `${name}: not updated: ${message ?? "it was edited since it was installed"}`;
      case "rejected":
        return `${name}: not updated${message === undefined ? "" : `: ${message}`}`;
    }
  });

/**
 * The owner and repo of a Skill directory row's `source`, or null when it is not a GitHub `owner/repo` (skills.sh also
 * lists sources such as a domain): such a row has no repo page and cannot be installed.
 */
export const githubSource = (
  source: string,
): { readonly owner: string; readonly repo: string } | null => {
  const found = /^([^/\s]+)\/([^/\s]+)$/.exec(source);
  const [, owner, repo] = found ?? [];

  return owner === undefined || repo === undefined ? null : { owner, repo };
};

/**
 * The badges a Skill directory row shows of where its Skill is installed here, in order: for every Environment, or in N
 * Environments that keep their own; and update available. None for a Skill installed nowhere.
 */
export const directoryBadges = (installed: SkillInstalledIn | undefined): ReadonlyArray<string> => {
  if (installed === undefined) return [];

  const { everyEnvironment, environments, updateAvailable } = installed;
  const where = [];

  if (everyEnvironment) where.push("Installed · every environment");
  else if (environments.length > 0) {
    where.push(
      `Installed · in ${environments.length} ${environments.length === 1 ? "environment" : "environments"}`,
    );
  }

  if (updateAvailable) where.push("update available");

  return where;
};

/** The Hot tab's change figure: "+4", or "−3" for a fall. */
export const changeText = (change: number): string =>
  change < 0 ? `\u2212${-change}` : `+${change}`;

/**
 * The source an install takes for `source` (`owner/repo`) at `ref` (a branch, tag or commit): a GitHub tree URL, which is
 * how an install names a ref, with the ref encoded so a branch such as `feature/x` stays one segment. Without a ref, the
 * source as it is, which installs from the repo's default branch.
 */
export const installSource = (source: string, ref?: string): string =>
  ref === undefined || ref === ""
    ? source.trim()
    : `https://github.com/${source.trim()}/tree/${encodeURIComponent(ref)}`;

/**
 * The page of the Skill an installed copy came from: `/skills/:owner/:repo/:skill` at the ref it was installed from, naming
 * the Skill's folder (so two Skills of a repo that share a name are not mixed up). Null when the Skill source's repo is
 * not an `owner/repo` of GitHub's.
 */
export const skillPageOfSource = (name: string, source: SkillSource): string | null => {
  const github = githubSource(source.repo);

  return github === null
    ? null
    : skillPagePath(github.owner, github.repo, name, source.ref ?? undefined, source.path);
};

/**
 * The copies among `skills` (one scope's) that came from the Skill in folder `path` of `repo` (GitHub's names ignore
 * case): matched by Skill source, as the Registry's badges are, never by name alone.
 */
export const copiesOfSkill = (
  skills: readonly EnvironmentSkill[],
  repo: string,
  path: string,
): readonly EnvironmentSkill[] =>
  skills.filter(
    ({ source }) =>
      source !== undefined &&
      source.repo.toLowerCase() === repo.toLowerCase() &&
      source.path === path,
  );

/** A SKILL.md without its frontmatter (the leading `---` block), which the page shows as the Skill's name and description. */
export const skillMdBody = (text: string): string => {
  const frontmatter = /^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);

  return frontmatter === null ? text : text.slice(frontmatter[0].length).replace(/^(?:\r?\n)+/, "");
};

/** A file of a repo on GitHub, at `commit`: `path` is the file's in the repo. */
export const githubFileUrl = (repo: string, commit: string, path: string): string =>
  `https://github.com/${repo}/blob/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;
