// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over the Skill's view, native arrays.
// A Skill's page's state (`/settings/:scope/skills/:owner/:repo/:skill`; ADR-0026,
// docs/architecture/client-and-protocol.md → Settings page):
// the Skill as GitHub has it at a ref (its SKILL.md and the files an install takes, read by the main Worker as the GitHub
// App), and where it is installed here, from the Skills each scope keeps. Its failures are the repo page's
// (`skillRepoFailureOf`): the same `SkillRepoError`, with kind `no_skill` for a repo that has no such Skill.

import type { EnvironmentSkill, SkillView } from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { environmentListAtom } from "./environments-state.ts";
import { GLOBAL } from "./environments.ts";
import { RegistryClient } from "./registry.ts";
import { environmentSkillsAtom, type SkillsToInstall } from "./skills-state.ts";
import { copiesOfSkill } from "./skills.ts";

/** A Skill's page, as `skillViewAtom` is keyed: the Skill as the URL names it, at a ref. */
export interface SkillViewKey {
  readonly owner: string;
  readonly repo: string;
  /** What `:skill` says: the Skill's name, or its folder's. */
  readonly skill: string;
  /** `?path=`: the folder of the Skill (`""`: the repo's root); undefined when the URL names none. */
  readonly path: string | undefined;
  /** `?ref=`: the branch, tag or commit; undefined is the repo's default branch. */
  readonly ref: string | undefined;
}

/** The key of a Skill's page, so equal keys are equal values, as a family compares them. */
export const skillViewKey = (
  owner: string,
  repo: string,
  skill: string,
  path?: string,
  ref?: string,
): SkillViewKey => ({ owner, repo, skill, path, ref });

/** What `viewSkill` is asked, built up from what the URL names. */
interface ViewSkillPayload {
  readonly owner: string;
  readonly repo: string;
  readonly skill: string;
  path?: string;
  ref?: string;
}

/**
 * What GitHub has of the Skill at the ref, read by the main Worker as the GitHub App: its SKILL.md and the files an install
 * takes, read at one commit, with its installs (when skills.sh knows them) and where it is installed; or the Skills the
 * name could mean; or a `SkillRepoError` saying why there is none. It is on the `skill-badges` key, so an install (which
 * invalidates it) asks again and the badges follow; that asks GitHub for the commit and the tree again.
 */
export const skillViewAtom = Atom.family(({ owner, repo, skill, path, ref }: SkillViewKey) => {
  const payload: ViewSkillPayload = { owner, repo, skill };

  if (path !== undefined) payload.path = path;

  if (ref !== undefined) payload.ref = ref;

  return RegistryClient.query("viewSkill", payload, { reactivityKeys: ["skill-badges"] });
});

/**
 * What Install opens the install confirm for: this Skill of its repo by its folder (a name does not say which Skill: two
 * folders can declare one), with its name as the label, at the page's `ref` so the install pins to it (never the whole
 * repo).
 */
export const skillToInstall = (skill: SkillView, ref: string | undefined): SkillsToInstall => ({
  source: skill.repo,
  skills: [skill.name],
  folders: [skill.path],
  ref,
});

/** One scope that keeps a copy of a Skill: the scope, and all of its Skills (what its Update and Remove dialogs look in). */
export interface SkillCopies {
  /** The Environment's id, or `GLOBAL`. */
  readonly scope: string;
  readonly skills: readonly EnvironmentSkill[];
  /** The scope's Skills that came from this Skill. */
  readonly copies: readonly EnvironmentSkill[];
}

/** Where the Skill in folder `path` of `repo` is installed, in the scopes that keep a copy; `loading` while one is still asked. */
export interface InstalledCopies {
  readonly loading: boolean;
  readonly scopes: readonly SkillCopies[];
}

/** The Skill of a repo's folder, as `installedCopiesAtom` is keyed. */
export interface InstalledCopiesKey {
  readonly repo: string;
  readonly path: string;
}

/**
 * The copies of the Skill kept Global and by each Environment, matched by their Skill source's repo and
 * folder (as the badges are, never by name alone), from the same lists the Installed tab shows, so Update and Remove
 * there and here act on one state and a change shows at once on both.
 */
export const installedCopiesAtom = Atom.family(({ repo, path }: InstalledCopiesKey) =>
  Atom.readable((get): InstalledCopies => {
    const environments = get(environmentListAtom);
    const scopes = [GLOBAL, ...(environments ?? []).map(({ id }) => id)];
    const found: SkillCopies[] = [];
    let loading = environments === null;

    for (const scope of scopes) {
      const answer = get(environmentSkillsAtom(scope));
      const kept = AsyncResult.value(answer);

      // A scope whose Skills cannot be read has no copy to show; one not answered yet may have.
      if (Option.isNone(kept)) {
        loading ||= !AsyncResult.isFailure(answer);
        continue;
      }

      const copies = copiesOfSkill(kept.value, repo, path);

      if (copies.length > 0) found.push({ scope, skills: kept.value, copies });
    }

    return { loading, scopes: found };
  }),
);
