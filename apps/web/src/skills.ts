// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over native arrays, not combinators.

// The Skills page's pure parts (ADR-0026, docs/architecture/workspace.md → Installing from GitHub): which Skills an
// Environment gets from every Environment, the lines the Installed tab shows of an install and an update, the line an
// Environment's card on the Environments page shows of its Skills, and which sections the Installed tab shows.

import {
  EVERY_ENVIRONMENT_SCOPE,
  type EnvironmentRecord,
  type EnvironmentSkill,
  type SkillInstall,
  type SkillUpdate,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";

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
