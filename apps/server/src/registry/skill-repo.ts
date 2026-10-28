// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off globalFetch:off -- plain functions over values; GitHub is read through a Promise API.
// The Skills a GitHub repo holds, for the repo page (`/skills/:owner/:repo`; ADR-0026, GLOSSARY.md → Skill directory,
// `docs/architecture/workspace.md` → _The Skill directory_): every Skill the walk an install uses finds in the repo at a ref,
// read by the main Worker as the GitHub App with a read-only token (`skill-reader.ts`), so private repos the app can read are
// listed and no token reaches a browser or a Session DO. The Skill's own page (`/skills/:owner/:repo/:skill`) reads the same
// repo at the same ref through the same `SkillRepos` seam and the same `SkillRepoError` (`view`); the owner page needs no
// GitHub.
//
// Why the Worker's Cache API holds what a listing reads of each `SKILL.md`, as the Skill directory's leaderboards are
// kept (`skill-directory.ts`): a blob's SHA names its content for ever, so the answer for it never goes stale and is put
// once, under a key of the repo and the SHA; the next listing of the repo, at any ref or commit, reads from GitHub only the
// `SKILL.md` files that changed. It needs no table, migration or sweep in the Registry's SQLite, and a Durable Object has
// no Cache API, which is why the Worker lists (it holds the GitHub App's key as the draft's branches need). Only the
// name, description and internal mark are kept, not the file. The key carries a version, so a change in how a `SKILL.md`
// is read makes new entries. What each listing still asks GitHub for is the commit and the tree (two requests), which are
// what say that the repo is readable now, so a repo the app lost access to is never served from the cache.
import { queryProblem } from "@cloudpid/extensions/skill-search";
import {
  type RepoSkill,
  SkillRepoError,
  type SkillRepoErrorKind,
  type SkillRepoListing,
  type SkillView,
  type SkillViewAnswer,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import {
  type ListedSkill,
  listRepoSkills,
  type RepoReader,
  type SkillMdCache,
  type SkillMdInfo,
  type SkillViewing,
  type SkippedSkill,
  skillIdOf,
  slug,
  viewSkill,
} from "../github/skill-fetch.ts";
import { parseSkillSource } from "../github/skill-source.ts";
import { installedIn, type InstalledSkillRef } from "./skill-badges.ts";
import type { DirectoryRow, LeaderboardCache } from "./skill-directory.ts";

/** What a listing of a repo reads of GitHub, before the joins with the Skill directory and the installed Skills. */
export type SkillRepoRows = Omit<SkillRepoListing, "skills" | "unreadable"> & {
  readonly skills: ReadonlyArray<ListedSkill & { readonly skillId: string }>;
  readonly unreadable: ReadonlyArray<Pick<SkippedSkill, "path" | "message">>;
};

/** What a Skill's page reads of GitHub, before the joins with the Skill directory and the installed Skills. */
export type SkillViewRows = Omit<SkillView, "installs" | "installed">;

/** What `SkillRepos.view` reads: the Skill, or the Skills its name could mean. */
export type SkillViewed =
  | { readonly status: "found"; readonly skill: SkillViewRows }
  | Extract<SkillViewAnswer, { readonly status: "ambiguous" }>;

/** The repo a page names, at a ref: `ref` absent or empty is the default branch. */
export type SkillRepoAsk = {
  readonly owner: string;
  readonly repo: string;
  readonly ref?: string | undefined;
};

/** GitHub's repos as the Registry's RPCs read them. Fails with a `SkillRepoError` the page shows plainly. */
export type SkillRepos = {
  /** Every Skill the repo holds at the ref, from GitHub, with each `SKILL.md` read once per blob. */
  readonly list: (ask: SkillRepoAsk) => Effect.Effect<SkillRepoRows, SkillRepoError>;
  /**
   * The Skill `skill` of the repo at the ref, found as an install finds a named Skill, or the one in the folder `path`:
   * its `SKILL.md` and the files an install takes, read at the ref's head; or the Skills the name could mean. Fails with
   * kind `no_skill` when the repo, readable, holds no such Skill.
   */
  readonly view: (
    ask: SkillRepoAsk & { readonly skill: string; readonly path?: string | undefined },
  ) => Effect.Effect<SkillViewed, SkillRepoError>;
};

/**
 * What a Skill's page (`/skills/:owner/:repo/:skill`) calls it: its folder's name, or its own name for a Skill at the
 * repo's root, which has no folder. It is how a link names a Skill, so a page that finds the Skill again uses this.
 */
export { skillIdOf };

/** How long the answer for a blob is kept: the max-age of what is put. The blob's content does not change; the cache may forget. */
export const SKILL_MD_TTL_SECONDS = 30 * 24 * 3_600;

const Info = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    name: Schema.String,
    description: Schema.String,
    internal: Schema.Boolean,
  }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
]);

const decodeInfo = Schema.decodeUnknownOption(Schema.fromJsonString(Info));

/**
 * The cache's key of the blob `sha` of `repo`: not a URL anything serves, only a name the Cache API takes. GitHub's names
 * ignore case, so the key does too.
 */
export const skillMdKey = ({ owner, name }: { owner: string; name: string }, sha: string): string =>
  `https://skill-md.cloudpid.invalid/v1/${encodeURIComponent(owner.toLowerCase())}/${encodeURIComponent(name.toLowerCase())}/${sha}`;

/** What a listing reads of each `SKILL.md`, kept in `cache` by blob. */
export const skillMdCacheOver = (cache: LeaderboardCache): SkillMdCache => ({
  get: async (repo, sha) => {
    const hit = await cache.match(skillMdKey(repo, sha));

    return hit === undefined ? undefined : Option.getOrUndefined(decodeInfo(await hit.text()));
  },
  put: async (repo, sha, info: SkillMdInfo) => {
    await cache.put(
      skillMdKey(repo, sha),
      new Response(JSON.stringify(info), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${SKILL_MD_TTL_SECONDS}`,
        },
      }),
    );
  },
});

/** The failure a page shows of a failed read of GitHub. */
const errorKind = (kind: string): SkillRepoErrorKind => {
  switch (kind) {
    case "no_match":
      return "no_skill";
    case "not_found":
    case "bad_ref":
    case "rate_limited":
    case "refused":
    case "truncated":
      return kind;
    default:
      return "failed";
  }
};

/** The repo a page names as GitHub names it, or why it cannot be one (the checks an install's source has). */
const repoOf = ({
  owner,
  repo,
  ref,
}: SkillRepoAsk):
  | {
      readonly ok: true;
      readonly name: { owner: string; name: string };
      readonly ref: string | null;
    }
  | { readonly ok: false; readonly message: string } => {
  const named = ref === undefined || ref === "" ? null : ref;

  // A ref goes through the source parser as a tree URL, whose ref segment is checked as an install's is.
  const parsed = parseSkillSource(
    named === null
      ? `${owner}/${repo}`
      : `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(named)}`,
  );

  if (!parsed.ok || parsed.source.owner !== owner || parsed.source.name !== repo) {
    return {
      ok: false,
      message: `${owner}/${repo}${named === null ? "" : ` at ${named}`} is not a repo and ref GitHub can have`,
    };
  }

  return { ok: true, name: { owner, name: repo }, ref: parsed.source.ref };
};

/** What a page shows of a Skill the walk found, or the Skills a name could mean. */
const viewedRows = (viewing: Exclude<SkillViewing, { readonly status: "failed" }>): SkillViewed => {
  if (viewing.status === "ambiguous") return viewing;

  const skill: Types.Mutable<SkillViewRows> = {
    repo: viewing.repo,
    ref: viewing.ref,
    commit: viewing.commit,
    name: viewing.skill.name,
    description: viewing.skill.description,
    path: viewing.skill.path,
    skillId: skillIdOf(viewing.skill),
    skillMd: viewing.skillMd,
    files: viewing.files,
  };

  if (viewing.refused !== undefined) skill.refused = viewing.refused;

  return { status: "found", skill };
};

/** `SkillRepos` over GitHub, read through `reader`, each `SKILL.md`'s reading kept in `cache`. */
export const skillReposOver = ({
  reader,
  cache,
}: {
  readonly reader: RepoReader;
  readonly cache: LeaderboardCache;
}): SkillRepos => {
  const skillMds = skillMdCacheOver(cache);

  const failure = (kind: string, message: string) =>
    Effect.fail(SkillRepoError.make({ kind: errorKind(kind), message }));

  return {
    list: (ask) => {
      const asked = repoOf(ask);

      if (!asked.ok)
        return Effect.fail(SkillRepoError.make({ kind: "invalid", message: asked.message }));

      return Effect.promise(() =>
        listRepoSkills(reader, { repo: asked.name, ref: asked.ref, cache: skillMds }),
      ).pipe(
        Effect.flatMap((listing) =>
          listing.status === "failed"
            ? failure(listing.kind, listing.message)
            : Effect.succeed({
                repo: listing.repo,
                ref: listing.ref,
                commit: listing.commit,
                skills: listing.skills.map((skill) => ({ ...skill, skillId: skillIdOf(skill) })),
                unreadable: listing.unreadable.map(({ path, message }) => ({ path, message })),
                internal: listing.internal,
                omitted: listing.omitted,
              }),
        ),
      );
    },
    view: ({ skill, path, ...ask }) => {
      const asked = repoOf(ask);

      if (!asked.ok)
        return Effect.fail(SkillRepoError.make({ kind: "invalid", message: asked.message }));

      return Effect.promise(() =>
        viewSkill(reader, { repo: asked.name, ref: asked.ref, skill, path, cache: skillMds }),
      ).pipe(
        Effect.flatMap((viewing) =>
          viewing.status === "failed"
            ? failure(viewing.kind, viewing.message)
            : Effect.succeed(viewedRows(viewing)),
        ),
      );
    },
  };
};

/**
 * The query that finds a repo's Skills in the Skill directory's search: skills.sh matches the source's name, fuzzily, so
 * some of a big repo's Skills may be missing from what it answers (their installs are left blank).
 */
export const repoSearchQuery = (repo: string): string | undefined =>
  queryProblem(repo) === undefined ? repo : undefined;

/**
 * `rows` with each Skill's installs and where it is installed. Installs come from the Skill directory's `found` rows of the
 * same repo (GitHub's names ignore case), matched by the Skill's ID in the directory against the folder's name, else
 * the Skill's name (how an install names a Skill); a Skill whose ID another Skill of the repo shares is left blank, as the
 * directory cannot say which it counts. Where it is installed is matched exactly by repo and folder (`installedIn`).
 * Those the directory knows by installs come first, the rest in the walk's order.
 */
export const joinRepoSkills = (
  rows: SkillRepoRows,
  installed: ReadonlyArray<InstalledSkillRef>,
  found: ReadonlyArray<DirectoryRow>,
): SkillRepoListing => {
  const installsOf = new Map<string, number>();

  for (const row of found) {
    if (row.source.toLowerCase() !== rows.repo.toLowerCase()) continue;

    const id = slug(row.skillId);

    installsOf.set(id, Math.max(installsOf.get(id) ?? 0, row.installs));
  }

  const idCounts = new Map<string, number>();

  for (const { skillId } of rows.skills) {
    idCounts.set(slug(skillId), (idCounts.get(slug(skillId)) ?? 0) + 1);
  }

  const skills = rows.skills.map(({ name, description, path, skillId }): RepoSkill => {
    const unique = (idCounts.get(slug(skillId)) ?? 0) === 1;

    const installs = unique
      ? (installsOf.get(slug(skillId)) ?? installsOf.get(slug(name)))
      : undefined;

    const where = installedIn(installed, { repo: rows.repo, path });

    const skill: Types.Mutable<RepoSkill> = {
      name,
      description,
      path,
      skillId,
    };

    if (installs !== undefined) skill.installs = installs;

    if (where !== undefined) skill.installed = where;

    return skill;
  });

  return {
    ...rows,
    skills: skills.toSorted((left, right) => (right.installs ?? -1) - (left.installs ?? -1)),
  };
};

/**
 * A Skill's page's answer: `rows` with the Skill's installs and where it is installed. The installs come from the Skill
 * directory's `found` rows of the same repo, matched as `joinRepoSkills` matches the repo's Skills; where it is installed
 * is matched exactly by repo and folder.
 */
export const joinSkillView = (
  rows: SkillViewRows,
  installed: ReadonlyArray<InstalledSkillRef>,
  found: ReadonlyArray<DirectoryRow>,
): SkillView => {
  const [skill] = joinRepoSkills(
    {
      repo: rows.repo,
      ref: rows.ref,
      commit: rows.commit,
      skills: [
        { name: rows.name, description: rows.description, path: rows.path, skillId: rows.skillId },
      ],
      unreadable: [],
      internal: 0,
      omitted: 0,
    },
    installed,
    found,
  ).skills;

  const view: Types.Mutable<SkillView> = { ...rows };

  if (skill?.installs !== undefined) view.installs = skill.installs;

  if (skill?.installed !== undefined) view.installed = skill.installed;

  return view;
};
