// An Environment's own Skills (ADR-0026, `docs/architecture/workspace.md` → The Environment's own Skills): what the Skills page lists of
// them, and how an Agent change records one. Shared by the server (which keeps and changes them) and the web app (which
// lists them and shows a change's files as diffs).
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import { shortSha } from "./comparison.ts";
import type { AgentChange } from "./registry.ts";

/**
 * What the owner's Approval of a change to a Skill was asked against: when the Skill of the name was last saved (`null`:
 * none kept). The Registry applies the change only while that still holds, else it answers `changed-since`.
 */
export type SkillExpectation = { readonly savedAt: number | null };

/** Where every Workspace serves its Skill set, read-only: a Skill named `name` is at `<SKILLS_ROOT>/<name>`. */
export const SKILLS_ROOT = "/workspace/.agents/skills";

/**
 * Where a Skill was installed from (ADR-0026, GLOSSARY.md → Skill source): a GitHub repo, the Skill's folder in it, the
 * ref the installer named, and the commit that ref resolved to, which is what the Skill's files are.
 */
export const SkillSource = Schema.Struct({
  /** `owner/name`. */
  repo: Schema.String,
  /** The Skill's folder in the repo; empty for a Skill at the repo's root. */
  path: Schema.String,
  /** The ref named (a branch, tag or commit); null when none was and the repo's default branch was used. */
  ref: Schema.NullOr(Schema.String),
  /** The commit it resolved to, in full. */
  commit: Schema.String,
});

export type SkillSource = typeof SkillSource.Type;

/** The page on GitHub that shows a Skill's folder at the commit it was installed at. */
export const skillSourceUrl = ({ repo, path, commit }: SkillSource): string =>
  `https://github.com/${repo}/tree/${commit}${path === "" ? "" : `/${Arr.join(Arr.map(path.split("/"), encodeURIComponent), "/")}`}`;

/**
 * Where a Skill came from as the page and the tools say it: its folder in the repo, the ref named (when one was) and the
 * short commit it was pinned to, as `mattpocock/skills/skills/grill-me at c0ffee0`. A repo with no folder (`path` empty) is
 * the repo alone.
 */
export const skillSourceText = ({ repo, path, ref, commit }: SkillSource): string =>
  `${repo}${path === "" ? "" : `/${path}`} at ${ref === null ? "" : `${ref}, `}${shortSha(commit)}`;

/** A Skill kept for an Environment, as the Skills page lists it. Times are epoch milliseconds. */
export const EnvironmentSkill = Schema.Struct({
  /** Its name, from its `SKILL.md` frontmatter: also its folder's under `SKILLS_ROOT`. */
  name: Schema.String,
  description: Schema.String,
  /** When it was last saved. */
  savedAt: Schema.Finite,
  /** Where it was installed from; absent for a Skill that was never installed. A save from a Workspace keeps the source it had. */
  source: Schema.optionalKey(SkillSource),
  /**
   * Whether the agent edited it since it was installed (GLOSSARY.md → Skill source): an update refuses it unless asked to
   * overwrite. False or absent when it is not.
   */
  modified: Schema.optionalKey(Schema.Boolean),
  /** Whether the daily check found its folder changed at the ref's head: an update would move it. False or absent when not. */
  updateAvailable: Schema.optionalKey(Schema.Boolean),
});

export type EnvironmentSkill = typeof EnvironmentSkill.Type;

const SKILL_FIELD = "skills.";

/** An Agent change's field for one Skill, by name: its files before and after (`SkillChangeValue`), null for none. */
export const skillField = (name: string): string => `${SKILL_FIELD}${name}`;

/** The Skill an Agent change's field names, or null for another field. */
export const fieldSkill = (field: string): string | null =>
  field.startsWith(SKILL_FIELD) ? field.slice(SKILL_FIELD.length) : null;

/**
 * What an Agent change of a Skill records before and after it: each file's path in the Skill's folder with the hash of
 * its content, which the Registry keeps once per hash (`skillChangeFiles` answers the texts).
 */
export const SkillChangeValue = Schema.Struct({
  files: Schema.Record(Schema.String, Schema.String),
  /** Where the Skill was installed from, when it was (a revert puts it back with the files). */
  source: Schema.optionalKey(SkillSource),
  /** Whether the Skill was marked modified (a revert puts the mark back with the files). Absent when it was not. */
  modified: Schema.optionalKey(Schema.Boolean),
});

export type SkillChangeValue = typeof SkillChangeValue.Type;

/** One file of a Skill as a change shows it: its path in the Skill's folder and its text. */
export const SkillFile = Schema.Struct({ path: Schema.String, text: Schema.String });

export type SkillFile = typeof SkillFile.Type;

/** A Skill's files before and after an Agent change, by path; null where the Skill was not there. */
export const SkillChangeFiles = Schema.Struct({
  before: SkillFile.pipe(Schema.Array, Schema.NullOr),
  after: SkillFile.pipe(Schema.Array, Schema.NullOr),
});

export type SkillChangeFiles = typeof SkillChangeFiles.Type;

/** A Skill a repo holds, as the Skills page lists it for the owner to tick. */
export const ListedSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** Its folder in the repo; empty for the repo's root. */
  path: Schema.String,
});

export type ListedSkill = typeof ListedSkill.Type;

/** A Skill an install of a repo's Skills would keep, as its owner is shown it for their Approval. */
export type PreviewedSkill = {
  readonly name: string;
  /** Its folder in the repo. */
  readonly path: string;
  readonly description: string;
  /** Its files' text, by path in its folder. */
  readonly files: Readonly<Record<string, string>>;
  /** A digest of the files, computed by the Registry: what an Approval pins. */
  readonly digest: string;
  /** The scope keeps the Skill with these files and this Skill source already: nothing to approve. */
  readonly unchanged: boolean;
  /** The Skill of the name the scope keeps now, with its files' paths. Null for a new Skill. */
  readonly current: {
    readonly description: string;
    readonly savedAt: number;
    readonly files: ReadonlyArray<string>;
  } | null;
};

/** How the install of one Skill from GitHub went. */
export type InstalledSkill = {
  readonly name: string;
  /** Its folder in the repo. */
  readonly path: string;
  readonly outcome: "installed" | "unchanged" | "rejected";
  /** Why it was refused: each problem a line. */
  readonly message?: string | undefined;
  /** The Agent change that kept it (the agent's install only). */
  readonly change?: AgentChange | undefined;
  /** For a Skill kept for every Environment: the Environments whose own Skill of the name hides it. */
  readonly overriddenIn?: ReadonlyArray<{ readonly id: string; readonly name: string }> | undefined;
};

/** How an install of Skills from GitHub went, as the Registry answers it. */
export type SkillInstallation =
  | { readonly status: "missing" }
  /** Nothing was installed: the source is not one, GitHub gave no answer, or the repo holds no such Skill. */
  | { readonly status: "refused"; readonly message: string }
  /** The source holds several Skills and none was named: the list, and nothing installed. */
  | {
      readonly status: "listed";
      readonly environment: { readonly id: string; readonly name: string };
      readonly repo: string;
      readonly ref: string | null;
      readonly commit: string;
      readonly available: ReadonlyArray<ListedSkill>;
    }
  | {
      readonly status: "installed";
      readonly environment: { readonly id: string; readonly name: string };
      readonly repo: string;
      readonly ref: string | null;
      readonly commit: string;
      /** Each Skill the source gave, in the order the Registry answered. */
      readonly results: ReadonlyArray<InstalledSkill>;
    };

/** What an install of GitHub Skills would do, with nothing kept or recorded: what the owner is asked to approve. */
export type SkillInstallPreview =
  | Exclude<SkillInstallation, { readonly status: "installed" }>
  | {
      readonly status: "previewed";
      readonly environment: { readonly id: string; readonly name: string };
      readonly repo: string;
      readonly ref: string | null;
      readonly commit: string;
      /** The Skills the install would keep, and those the scope keeps already. */
      readonly skills: ReadonlyArray<PreviewedSkill>;
      /** The Skills the repo holds that the install would not keep, each with why. */
      readonly rejected: ReadonlyArray<{
        readonly name: string;
        readonly path: string;
        readonly message: string;
      }>;
    };

/**
 * What the owner's Approval of an install for every Environment was asked against, which the install must still find: the
 * commit shown, and for each Skill shown its folder, the digest of its files, and when the Skill of its name was last
 * saved (null: none kept). Exactly those folders are read again at that commit; a Skill whose files are not as shown is
 * not kept.
 */
export const SkillInstallPin = Schema.Struct({
  commit: Schema.String,
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String,
      digest: Schema.String,
      savedAt: Schema.NullOr(Schema.Finite),
    }),
  ),
});

export type SkillInstallPin = typeof SkillInstallPin.Type;

/** How the install of one Skill went. */
export const SkillInstalled = Schema.Struct({
  name: Schema.String,
  /** Kept now; or already kept with these files and source, so nothing changed; or refused, with why in `message`. */
  outcome: Schema.Literals(["installed", "unchanged", "rejected"]),
  message: Schema.optionalKey(Schema.String),
});

export type SkillInstalled = typeof SkillInstalled.Type;

/**
 * What an install from a source answers (a failure is an `EnvironmentError`): the Skills it kept, each pinned to the
 * commit; or, when the source holds several Skills and none was named, the list of them and nothing kept.
 */
export const SkillInstall = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("installed"),
    repo: Schema.String,
    ref: Schema.NullOr(Schema.String),
    commit: Schema.String,
    skills: Schema.Array(SkillInstalled),
  }),
  Schema.Struct({
    status: Schema.Literal("listed"),
    repo: Schema.String,
    ref: Schema.NullOr(Schema.String),
    commit: Schema.String,
    available: Schema.Array(ListedSkill),
  }),
]);

export type SkillInstall = typeof SkillInstall.Type;

/** A Skill skills.sh lists for a search: its ID (`owner/repo/skill`), the source to install it from, and its installs. */
export const SkillSearchResult = Schema.Struct({
  id: Schema.String,
  /** `owner/repo`: what `source` takes. */
  source: Schema.String,
  skillId: Schema.String,
  name: Schema.String,
  installs: Schema.Finite,
});

export type SkillSearchResult = typeof SkillSearchResult.Type;

/** The Skill directory's lists (GLOSSARY.md → Skill directory), as skills.sh names them in its leaderboard API. */
export const SkillDirectoryView = Schema.Literals(["all-time", "trending", "hot"]);

export type SkillDirectoryView = typeof SkillDirectoryView.Type;

/** The page number of a leaderboard: from 0, 200 rows each (`SKILL_DIRECTORY_PAGE_SIZE`). */
export const SkillDirectoryPageNumber = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 1_000 }),
);

/** How many rows skills.sh answers for a leaderboard page (`SKILL_SEARCH_LIMIT` is the most a search finds). */
export const SKILL_DIRECTORY_PAGE_SIZE = 200;

/**
 * The most results skills.sh's search answers, however many are asked for. A search that returns this many may have left
 * more out, so what is built from one (an owner's repos) says it may be incomplete.
 */
export const SKILL_SEARCH_LIMIT = 200;

/** The skills.sh failure the Skills page shows plainly: it could not be reached or answered otherwise. */
export class SkillDirectoryError extends Schema.TaggedError<
  SkillDirectoryError,
  { readonly brand: unique symbol }
>()("SkillDirectoryError", {
  message: Schema.String,
}) {}

/**
 * Where a Skill of the Skill directory is installed, as the Registry works it out from the Skills it keeps, matched by
 * Skill source repo and path (not by name alone): for every Environment, or as an Environment's own Skill.
 */
export const SkillInstalledIn = Schema.Struct({
  /** The Skills kept for every Environment hold it. */
  everyEnvironment: Schema.Boolean,
  /** The ids of the Environments that keep it as their own. */
  environments: Schema.Array(Schema.String),
  /** An installed copy is marked update available (GLOSSARY.md → Skill source). */
  updateAvailable: Schema.Boolean,
});

export type SkillInstalledIn = typeof SkillInstalledIn.Type;

/** A Skill the Skill directory lists: its source repo and ID in it, its installs, and where it is installed here. */
export const DirectorySkill = Schema.Struct({
  /** `owner/repo`: what an install takes as its source. */
  source: Schema.String,
  /** Its ID in the source: what an install names to take only this Skill. */
  skillId: Schema.String,
  name: Schema.String,
  /**
   * Its installs as skills.sh counts them for the list it is in: all time (All time), the last 24 hours (Trending), or today
   * (Hot, with `installsYesterday` and `change`); a search answers all time.
   */
  installs: Schema.Finite,
  /** Hot only: its installs yesterday, and the change from the day before. */
  installsYesterday: Schema.optionalKey(Schema.Finite),
  change: Schema.optionalKey(Schema.Finite),
  /** Where it is installed here; absent when it is nowhere. */
  installed: Schema.optionalKey(SkillInstalledIn),
});

export type DirectorySkill = typeof DirectorySkill.Type;

/** One page of a leaderboard: its rows in rank order, how many rows the list has, and whether a later page has more. */
export const SkillDirectoryPage = Schema.Struct({
  skills: Schema.Array(DirectorySkill),
  total: Schema.Finite,
  hasMore: Schema.Boolean,
});

export type SkillDirectoryPage = typeof SkillDirectoryPage.Type;

/** Why a repo's Skills could not be listed (a repo page, a Skill's page): what GitHub's answer says of the repo or ref. */
export const SkillRepoErrorKind = Schema.Literals([
  /**
   * GitHub has no such repo, or it is private and the GitHub App cannot read it. GitHub answers both with a 404, so
   * the two cannot be told apart; the message says what to check.
   */
  "not_found",
  /** The repo is readable but has no such branch, tag or commit. */
  "bad_ref",
  /** A Skill's page only: the repo is readable at the ref, but holds no such Skill. */
  "no_skill",
  /** The owner, repo or ref cannot be one GitHub has. */
  "invalid",
  "rate_limited",
  /** GitHub refused the GitHub App's token. */
  "refused",
  /** The repo is larger than one listing of its files holds. */
  "truncated",
  /** GitHub could not be reached or answered otherwise. */
  "failed",
]);

export type SkillRepoErrorKind = typeof SkillRepoErrorKind.Type;

/** The failure a repo's page shows plainly: why GitHub gave no listing of the repo at the ref. */
export class SkillRepoError extends Schema.TaggedError<
  SkillRepoError,
  { readonly brand: unique symbol }
>()("SkillRepoError", {
  kind: SkillRepoErrorKind,
  message: Schema.String,
}) {}

/** The longest owner, repo or ref a request for a repo's Skills may name. */
export const MAX_REPO_PART_LENGTH = 255;

/** A Skill a GitHub repo holds, as the repo page lists it. */
export const RepoSkill = Schema.Struct({
  /** Its name, from its SKILL.md's frontmatter. */
  name: Schema.String,
  /** Its description, from the same. */
  description: Schema.String,
  /** Its folder in the repo (empty for a Skill at the repo's root). */
  path: Schema.String,
  /** What its page's URL (`/skills/:owner/:repo/:skill`) calls it: its folder's name, or its name for a Skill at the root. */
  skillId: Schema.String,
  /** Its installs, all time, when the Skill directory knows the Skill; absent when it does not. */
  installs: Schema.optionalKey(Schema.Finite),
  /** Where it is installed here, matched by the repo and the Skill's folder; absent when it is nowhere. */
  installed: Schema.optionalKey(SkillInstalledIn),
});

export type RepoSkill = typeof RepoSkill.Type;

/** A `SKILL.md` in a repo that cannot be read as a Skill, and why. */
export const UnreadableSkill = Schema.Struct({
  path: Schema.String,
  message: Schema.String,
});

export type UnreadableSkill = typeof UnreadableSkill.Type;

/** One file of a Skill as an install takes it: its path in the Skill's folder, and its size in bytes when GitHub says. */
export const SkillViewFile = Schema.Struct({
  path: Schema.String,
  size: Schema.optionalKey(Schema.Int),
});

export type SkillViewFile = typeof SkillViewFile.Type;

/**
 * One Skill of a GitHub repo as a Skill's page (`/skills/:owner/:repo/:skill`) shows it: its SKILL.md and the files an
 * install would take, read at one commit of the ref.
 */
export const SkillView = Schema.Struct({
  /** `owner/name`, as asked. */
  repo: Schema.String,
  /** The ref asked for; null for the repo's default branch. */
  ref: Schema.NullOr(Schema.String),
  /** The commit it was read at, in full. */
  commit: Schema.String,
  /** Its name and description, from its SKILL.md's frontmatter. */
  name: Schema.String,
  description: Schema.String,
  /** Its folder in the repo (empty for a Skill at the repo's root). */
  path: Schema.String,
  /** What its page's URL calls it (`RepoSkill.skillId`). */
  skillId: Schema.String,
  /** Its SKILL.md as it is at the commit, frontmatter included. */
  skillMd: Schema.String,
  /** The files an install takes of its folder, `SKILL.md` first, then by path. */
  files: Schema.Array(SkillViewFile),
  /** Why an install would refuse it for its size (too many files or bytes); absent when it fits. */
  refused: Schema.optionalKey(Schema.String),
  /** Its installs, all time, when the Skill directory knows the Skill; absent when it does not. */
  installs: Schema.optionalKey(Schema.Finite),
  /** Where it is installed here, matched by the repo and the Skill's folder; absent when it is nowhere. */
  installed: Schema.optionalKey(SkillInstalledIn),
});

export type SkillView = typeof SkillView.Type;

/** What a Skill's page answers: the Skill, or the Skills of the repo its name could mean. */
export const SkillViewAnswer = Schema.Union([
  Schema.Struct({ status: Schema.Literal("found"), skill: SkillView }),
  /**
   * The name is the name or the folder of several Skills of the repo, so none is shown: a link to each, by its folder,
   * in the walk's order.
   */
  Schema.Struct({
    status: Schema.Literal("ambiguous"),
    repo: Schema.String,
    ref: Schema.NullOr(Schema.String),
    commit: Schema.String,
    candidates: Schema.Array(
      Schema.Struct({ name: Schema.String, description: Schema.String, path: Schema.String }),
    ),
  }),
]);

export type SkillViewAnswer = typeof SkillViewAnswer.Type;

/** What GitHub has of a repo at a ref: every Skill the walk the install uses finds, read at one commit. */
export const SkillRepoListing = Schema.Struct({
  /** `owner/name`, as asked. */
  repo: Schema.String,
  /** The ref asked for; null for the repo's default branch. */
  ref: Schema.NullOr(Schema.String),
  /** The commit it was read at, in full. */
  commit: Schema.String,
  /** The Skills, those the directory knows by installs first. */
  skills: Schema.Array(RepoSkill),
  /** `SKILL.md` files that are not Skills (no name or description, or too large). */
  unreadable: Schema.Array(UnreadableSkill),
  /** How many Skills the repo marks `metadata.internal`, which an install leaves out unless one is named: not in `skills`. */
  internal: Schema.Int,
  /** How many `SKILL.md` files were not read, past the 200 a listing reads: any of them may be a Skill, internal or not one. */
  omitted: Schema.Int,
});

export type SkillRepoListing = typeof SkillRepoListing.Type;

/** A repo of an owner that the Skill directory lists Skills of, as the owner page shows it. */
export const OwnerRepo = Schema.Struct({
  /** The repo's name, without the owner, as skills.sh spells it. */
  repo: Schema.String,
  /** How many of its Skills the directory's search found: at most what the search holds, so possibly fewer than the repo has. */
  skills: Schema.Int,
  /** Their installs, all time, added up. */
  installs: Schema.Finite,
});

export type OwnerRepo = typeof OwnerRepo.Type;

/** What the Skill directory knows of an owner (a GitHub user or organization): its repos that hold Skills. */
export const SkillOwnerListing = Schema.Struct({
  /** The owner as asked. */
  owner: Schema.String,
  /** The owner's repos, the most installed first. Empty when the directory lists nothing of the owner. */
  repos: Schema.Array(OwnerRepo),
  /**
   * Whether the search that found them hit its limit of 200 results, so that it may have left some of the owner's Skills
   * and repos out. Search is fuzzy, too: even below the limit a repo can be missing.
   */
  capped: Schema.Boolean,
});

export type SkillOwnerListing = typeof SkillOwnerListing.Type;

/** How the owner's update of one Skill went. */
export const SkillUpdated = Schema.Struct({
  name: Schema.String,
  /**
   * Moved to the ref's latest commit (`updated`); its folder is the same there (`unchanged`); refused because the agent
   * edited it and no overwrite was asked (`modified`); or not updated, with why in `message` (`rejected`).
   */
  outcome: Schema.Literals(["updated", "unchanged", "modified", "rejected"]),
  message: Schema.optionalKey(Schema.String),
});

export type SkillUpdated = typeof SkillUpdated.Type;

/** What an update answers: how each Skill asked for, or marked update available, went. */
export const SkillUpdate = Schema.Struct({ skills: Schema.Array(SkillUpdated) });

export type SkillUpdate = typeof SkillUpdate.Type;

/**
 * What the owner's Approval of an update for every Environment was asked for, to apply exactly that: the commit shown, the
 * digest of the folder at it (`folderHash`), and when the Skill was last saved. The update is made only at that commit,
 * with those files, while the Skill still was last saved then.
 */
export const SkillUpdatePin = Schema.Struct({
  name: Schema.String,
  savedAt: Schema.Finite,
  commit: Schema.String,
  folderHash: Schema.String,
});

export type SkillUpdatePin = typeof SkillUpdatePin.Type;

/** What became of one Skill an update was asked for, as the Registry answers it. */
export type SkillUpdateEntry =
  | {
      readonly name: string;
      readonly outcome: "updated";
      readonly from: SkillSource;
      readonly to: SkillSource;
      /** Whether the edits the agent made to it were replaced. */
      readonly overwrote: boolean;
      /** The Agent change that kept it (the agent's update only). */
      readonly change?: AgentChange | undefined;
    }
  /** Its folder is the same at the ref's latest commit: nothing was changed or recorded. */
  | { readonly name: string; readonly outcome: "unchanged"; readonly message: string }
  /** Refused: it was edited since it was installed and no overwrite was asked. */
  | { readonly name: string; readonly outcome: "modified"; readonly message: string }
  /** Not updated: no such Skill, none installed, GitHub gave no answer, or the files fail a save's checks. */
  | { readonly name: string; readonly outcome: "rejected"; readonly message: string }
  /** It was saved again since the owner was asked: nothing was changed. */
  | { readonly name: string; readonly outcome: "changed-since"; readonly message: string };

/** A Skill an update would move, with the files it would take: for the owner's Approval card (nothing applied). */
export type SkillUpdateReady = {
  readonly name: string;
  readonly outcome: "ready";
  readonly from: SkillSource;
  readonly to: SkillSource;
  readonly description: string;
  /** Its files' text, by path in its folder. */
  readonly files: Readonly<Record<string, string>>;
  /** The digest of its folder at the new commit: what an Approval pins. */
  readonly folderHash: string;
  /** When the Skill kept was last saved: an approved update is made only while it still was then. */
  readonly savedAt: number;
  /** The Skill is modified: the update would replace the agent's edits. */
  readonly overwrites: boolean;
  /** The Skill of the name the scope keeps now, with its files' paths. */
  readonly current: { readonly description: string; readonly files: ReadonlyArray<string> };
};

/** How an update of installed Skills went, as the Registry answers it. */
export type SkillUpdateRun<Entry = SkillUpdateEntry> =
  | { readonly status: "missing" }
  /** Nothing was read or changed: more Skills than one Approval shows, or a change for every Environment with no Approval. */
  | { readonly status: "refused"; readonly message: string }
  /** No Skill was named and none is marked update available. */
  | {
      readonly status: "nothing";
      readonly environment: { readonly id: string; readonly name: string };
    }
  | {
      readonly status: "done";
      readonly environment: { readonly id: string; readonly name: string };
      /** Each Skill asked for (or marked update available), in the order it was asked. */
      readonly results: ReadonlyArray<Entry>;
    };

/** What an update would do, with nothing applied: each Skill that would move, with the files it would take. */
export type SkillUpdatePreview = SkillUpdateRun<SkillUpdateEntry | SkillUpdateReady>;
