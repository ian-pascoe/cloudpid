// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over the listing, native arrays.
// The repo page's state (`/skills/:owner/:repo`; ADR-0026, docs/architecture/client-and-protocol.md → Skills page): the
// Skills GitHub has in the repo at a ref, with their installs and where each is installed, and which of them are checked
// for Install selected. The Skill's page (#309) asks for the repo through the same key and the same failure; the owner's
// page (#310) has no GitHub to ask.

import {
  type RepoSkill,
  SkillRepoError,
  type SkillRepoErrorKind,
  type SkillRepoListing,
} from "@cloudpid/protocol";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { messageOf, RegistryClient } from "./registry.ts";
import type { SkillsToInstall } from "./skills-state.ts";

/** A repo at a ref, as the families of this file are keyed. */
export interface SkillRepoKey {
  readonly owner: string;
  readonly repo: string;
  /** The branch, tag or commit; undefined is the repo's default branch. */
  readonly ref: string | undefined;
}

/** The key of `owner`/`repo` at `ref`, so equal keys are equal values, as a family compares them. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain constructor of a key, called from React.
export const skillRepoKey = (owner: string, repo: string, ref?: string): SkillRepoKey => ({
  owner,
  repo,
  ref,
});

/**
 * What GitHub has in the repo at the ref, read by the main Worker as the GitHub App: every Skill with its description,
 * installs (blank when unknown) and badges, or a `SkillRepoError` saying why there is no listing. It is on the
 * `skill-badges` key, so an install (which invalidates it) asks again and the badges follow; that asks GitHub for the
 * commit and the tree again, never for a `SKILL.md` it has read.
 */
export const skillRepoAtom = Atom.family(({ owner, repo, ref }: SkillRepoKey) =>
  RegistryClient.query(
    "listRepoSkills",
    ref === undefined ? { owner, repo } : { owner, repo, ref },
    { reactivityKeys: ["skill-badges"] },
  ),
);

/** Why a repo could not be listed: what kind of failure, for the page to say, and GitHub's own words. */
export interface SkillRepoFailure {
  readonly kind: SkillRepoErrorKind;
  readonly message: string;
}

/** Why an atom's last answer from the repo's RPC is a failure, or null. Anything that is not the RPC's error is a plain failure. */
export const skillRepoFailureOf = <A, E>(
  result: AsyncResult.AsyncResult<A, E>,
): SkillRepoFailure | null => {
  if (!AsyncResult.isFailure(result)) return null;

  const error = Cause.squash(result.cause);

  return Schema.is(SkillRepoError)(error)
    ? { kind: error.kind, message: error.message }
    : { kind: "failed", message: messageOf(result.cause) };
};

/**
 * The folders of the Skills checked on a repo's page, for Install selected. A repo at another ref is another page with
 * its own checks.
 */
export const checkedSkillsAtom = Atom.family((_key: SkillRepoKey) =>
  Atom.make<ReadonlySet<string>>(new Set<string>()),
);

/** The Skills of `listing` that `checked` (their folders) names, in the listing's order: what Install selected takes. */
export const checkedSkillsOf = (
  listing: SkillRepoListing,
  checked: ReadonlySet<string>,
): ReadonlyArray<RepoSkill> => listing.skills.filter((skill) => checked.has(skill.path));

/**
 * What Install selected opens the target picker for: the checked Skills of the repo, named by the folder that holds each
 * (a name does not say which Skill: two folders can declare one, and a name can be another folder's) with their names as
 * labels, from the repo itself (never the whole repo), at the page's `ref` so the install pins to it; null while none is
 * checked.
 */
export const installSelected = (
  listing: SkillRepoListing,
  checked: ReadonlySet<string>,
  ref: string | undefined,
): SkillsToInstall | null => {
  const skills = checkedSkillsOf(listing, checked);

  return skills.length === 0
    ? null
    : {
        source: listing.repo,
        skills: skills.map((skill) => skill.name),
        folders: skills.map((skill) => skill.path),
        ref,
      };
};
