// An Environment's own Skills (ADR-0026, `docs/spec.md` → The Environment's own Skills): what the Environments page lists of
// them, and how an Agent change records one. Shared by the server (which keeps and changes them) and the web app (which
// lists them and shows a change's files as diffs).
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import { shortSha } from "./comparison.ts";

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

/** A Skill kept for an Environment, as the Environments page lists it. Times are epoch milliseconds. */
export const EnvironmentSkill = Schema.Struct({
  /** Its name, from its `SKILL.md` frontmatter: also its folder's under `SKILLS_ROOT`. */
  name: Schema.String,
  description: Schema.String,
  /** When it was last saved. */
  savedAt: Schema.Finite,
  /** Where it was installed from; absent for a Skill that was never installed. A save from a Workspace keeps the source it had. */
  source: Schema.optionalKey(SkillSource),
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

/** A Skill a repo holds, as the Environments page lists it for the owner to tick. */
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

/** What an install of GitHub Skills would do, with nothing kept or recorded: what the owner is asked to approve. */
export type SkillInstallPreview =
  | { readonly status: "missing" }
  /** The source is not one, GitHub gave no answer, or the repo holds no such Skill. */
  | { readonly status: "refused"; readonly message: string }
  /** The source holds several Skills and none was named. */
  | {
      readonly status: "listed";
      readonly environment: { readonly id: string; readonly name: string };
      readonly repo: string;
      readonly ref: string | null;
      readonly commit: string;
      readonly available: ReadonlyArray<ListedSkill>;
    }
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
 * commit shown, and for each Skill shown its folder, the digest of its files, and when the Skill of its name was last saved
 * (null: none kept). The Skills are read again at the commit; one that is not as shown, or that was not shown, is not kept.
 */
export type SkillInstallPin = {
  readonly commit: string;
  readonly skills: ReadonlyArray<{
    readonly name: string;
    readonly path: string;
    readonly digest: string;
    readonly savedAt: number | null;
  }>;
};

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
