// Fetching Skills from a GitHub repo (ADR-0026, `docs/spec.md` → _Installing from GitHub_): resolve the ref to a commit,
// list the commit's tree, pick the Skill folders by the `skills` CLI's path rules (`skill-paths.ts`), and read the chosen
// Skills' files at that commit. It reads GitHub through a `RepoReader` (`contents.ts` is the one that asks GitHub with the
// GitHub App's tokens), so the rules are tested without a network. Nothing is saved here: the Registry checks what comes
// out as a save does (`checkSkill`) and keeps it with its Skill source.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off asyncFunction:off missingPipeableSignature:off
import { MAX_FILE_BYTES, MAX_SKILL_BYTES, problemsIn } from "@cloudpid/extensions/skill-checks";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { readFrontmatter } from "@cloudpid/extensions/skills-discovery";
import { findSkillMdPaths, skillFilesIn, skillFolderOf, type TreeEntry } from "./skill-paths.ts";
import type { SkillSourceInput } from "./skill-source.ts";

/** A repo on GitHub. */
export type SkillRepo = { readonly owner: string; readonly name: string };

/** A commit's tree, flattened. */
export type RepoTree = {
  readonly entries: ReadonlyArray<TreeEntry>;
  /** GitHub left entries out: the repo is larger than one listing holds. */
  readonly truncated: boolean;
};

/** Why GitHub gave no answer, as the failure of a read says it. */
const FetchFailureKind = Schema.Literals([
  /** No such repo or ref, or a private repo the GitHub App cannot see. */
  "not_found",
  "rate_limited",
  /** GitHub refused the App's token. */
  "refused",
  /** The repo's tree is larger than one listing holds. */
  "truncated",
  /** The repo holds no Skill under the path. */
  "no_skills",
  /** A Skill asked for is not in the repo. */
  "no_match",
  "too_many",
  "failed",
]);

export type FetchFailureKind = typeof FetchFailureKind.Type;

/** A failed read of GitHub: what kind of failure, and what to tell. */
export class GithubReadError extends Schema.TaggedError<
  GithubReadError,
  { readonly brand: unique symbol }
>()("GithubReadError", { kind: FetchFailureKind, message: Schema.String }) {
  static of(kind: FetchFailureKind, message: string): GithubReadError {
    return GithubReadError.make({ kind, message });
  }
}

/** What fetching reads of GitHub. Each throws a `GithubReadError` when GitHub gives no answer. */
export type RepoReader = {
  /** The commit `ref` names in `repo` (the default branch's head when null). */
  readonly commit: (repo: SkillRepo, ref: string | null) => Promise<string>;
  /** The tree of `commit`, every folder below it. */
  readonly tree: (repo: SkillRepo, commit: string) => Promise<RepoTree>;
  /** The content of the blob `sha`. */
  readonly blob: (repo: SkillRepo, sha: string) => Promise<Uint8Array>;
};

/** A Skill the repo holds, as a listing shows it. */
export type ListedSkill = {
  readonly name: string;
  readonly description: string;
  /** Its folder in the repo (`""` for the repo's root). */
  readonly path: string;
};

/** A Skill read from the repo: its files' text by path in its folder. */
export type FetchedSkill = ListedSkill & { readonly files: Readonly<Record<string, string>> };

/** A Skill in the repo that was not read, and why. */
export type SkippedSkill = {
  readonly name: string;
  readonly path: string;
  readonly message: string;
};

export type SkillFetch =
  /** The Skills chosen, read at `commit`; `skipped` are ones the checks before a save refused or that cannot be read. */
  | {
      readonly status: "fetched";
      readonly repo: string;
      readonly ref: string | null;
      readonly commit: string;
      readonly skills: ReadonlyArray<FetchedSkill>;
      readonly skipped: ReadonlyArray<SkippedSkill>;
    }
  /** The repo holds several Skills and none was asked for: nothing was read but their `SKILL.md`. */
  | {
      readonly status: "listed";
      readonly repo: string;
      readonly ref: string | null;
      readonly commit: string;
      readonly available: ReadonlyArray<ListedSkill>;
    }
  | { readonly status: "failed"; readonly kind: FetchFailureKind; readonly message: string };

/** The most `SKILL.md` files read to find the Skills a repo holds. */
export const MAX_SKILL_CANDIDATES = 200;

/** The most files a Skill's folder may hold, as a save reads at most this many. */
const MAX_FILES = 500;

/** The most blobs read at once. */
const CONCURRENCY = 6;

/** How `skills` names a Skill: lower case, words joined by hyphens. */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

/** A frontmatter value as one line of printable text, as the CLI's `sanitizeMetadata` makes it. */
const oneLine = (value: string): string =>
  value
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim();

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** `run` over `items`, at most `CONCURRENCY` at a time, in order. */
const mapLimited = async <A, B>(
  items: ReadonlyArray<A>,
  run: (item: A) => Promise<B>,
): Promise<B[]> => {
  const results: B[] = [];
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const at = next++;

      // SAFETY: `at` is below `items.length`.
      results[at] = await run(items[at] as A);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));

  return results;
};

const decoder = new TextDecoder();

/** A `SKILL.md` found in the repo, read. */
type Candidate = ListedSkill & {
  readonly skillMdPath: string;
  readonly internal: boolean;
};

const failed = (kind: FetchFailureKind, message: string): SkillFetch => ({
  status: "failed",
  kind,
  message,
});

/** The names a repo's Skills have, for a message. */
const namesOf = (candidates: ReadonlyArray<ListedSkill>): string =>
  candidates.map((candidate) => candidate.name).join(", ");

/**
 * Fetch from `source` the Skills `skills` names (by name, or `["*"]` for all of them), else the one the repo holds, else
 * a listing of those it holds. Reads the tree at the commit the source's ref resolves to, so what is fetched is one
 * commit's.
 */
export const fetchSkills = async (
  reader: RepoReader,
  {
    source,
    skills,
  }: { readonly source: SkillSourceInput; readonly skills?: ReadonlyArray<string> | undefined },
): Promise<SkillFetch> => {
  const repo: SkillRepo = { owner: source.owner, name: source.name };

  try {
    const commit = await reader.commit(repo, source.ref);
    const tree = await reader.tree(repo, commit);

    if (tree.truncated) {
      return failed(
        "truncated",
        `GitHub listed only part of ${source.repo}'s files (the repo is larger than one listing holds), so its Skills cannot be found reliably. Install from a smaller repo, or fork the Skills into one.`,
      );
    }

    const skillMds = findSkillMdPaths({ tree: tree.entries }, source.path || undefined).filter(
      (path) => basename(path).toLowerCase() === "skill.md",
    );

    const where = source.path === "" ? source.repo : `${source.repo} under ${source.path}`;

    if (skillMds.length === 0) {
      return failed("no_skills", `${where} holds no Skill (no folder with a SKILL.md).`);
    }

    const wanted = [...(skills ?? []), ...(source.skill === null ? [] : [source.skill])];
    const all = wanted.includes("*");
    const names = wanted.filter((name) => name !== "*");

    // Named Skills whose folder is named the same are found without reading the others' `SKILL.md`.
    const byFolder = skillMds.filter((path) =>
      names.some((name) => slug(basename(skillFolderOf(path))) === slug(name)),
    );

    const folderAnswers = names.every((name) =>
      byFolder.some((path) => slug(basename(skillFolderOf(path))) === slug(name)),
    );

    const toRead = !all && names.length > 0 && folderAnswers ? byFolder : skillMds;

    if (toRead.length > MAX_SKILL_CANDIDATES) {
      return failed(
        "too_many",
        `${where} holds ${toRead.length} Skills, more than the ${MAX_SKILL_CANDIDATES} that can be listed: name a folder with a tree URL, or the Skills to install.`,
      );
    }

    const blobs = new Map<string, Promise<Uint8Array>>();

    const blob = (entry: TreeEntry) => {
      let read = blobs.get(entry.sha);

      if (read === undefined) {
        read = reader.blob(repo, entry.sha);
        blobs.set(entry.sha, read);
      }

      return read;
    };

    const entryOf = new Map(tree.entries.map((entry) => [entry.path, entry] as const));
    const skipped: SkippedSkill[] = [];

    const read = await mapLimited(toRead, async (skillMdPath): Promise<Candidate | undefined> => {
      const entry = entryOf.get(skillMdPath);
      const folder = skillFolderOf(skillMdPath);

      if (entry === undefined) return undefined;

      if (entry.size !== undefined && entry.size > MAX_FILE_BYTES) {
        skipped.push({
          name: basename(folder) || source.name,
          path: folder,
          message: `SKILL.md: ${entry.size} bytes, more than the ${MAX_FILE_BYTES} a Skill's file may be`,
        });

        return undefined;
      }

      const text = decoder.decode(await blob(entry));
      const frontmatter = readFrontmatter(text);
      const name = Predicate.isString(frontmatter?.name) ? oneLine(frontmatter.name) : "";

      const description = Predicate.isString(frontmatter?.description)
        ? oneLine(frontmatter.description)
        : "";

      if (name === "" || description === "") {
        skipped.push({
          name: basename(folder) || source.name,
          path: folder,
          message: "SKILL.md's frontmatter sets no name or no description, so it is not a Skill",
        });

        return undefined;
      }

      const metadata = frontmatter?.metadata;

      const internal = Predicate.hasProperty(metadata, "internal") && metadata.internal === true;

      return { name, description, path: folder, skillMdPath, internal };
    });

    const candidates = read.filter((candidate): candidate is Candidate => candidate !== undefined);

    const listing = (list: ReadonlyArray<Candidate>): ReadonlyArray<ListedSkill> =>
      list.map(({ name, description, path }) => ({ name, description, path }));

    // The CLI leaves out the Skills a repo marks `metadata.internal` unless one is asked for by name.
    const visible = candidates.filter((candidate) => !candidate.internal);

    let chosen: ReadonlyArray<Candidate>;

    if (all) {
      chosen = visible;
    } else if (names.length > 0) {
      const found: Candidate[] = [];
      const missing: string[] = [];

      for (const name of names) {
        const lower = name.toLowerCase();

        const match = candidates.find(
          (candidate) =>
            candidate.name.toLowerCase() === lower ||
            slug(candidate.name) === slug(name) ||
            slug(basename(candidate.path)) === slug(name),
        );

        if (match === undefined) missing.push(name);
        else if (!found.includes(match)) found.push(match);
      }

      if (missing.length > 0) {
        return failed(
          "no_match",
          `${where} has no Skill named ${missing.map((name) => JSON.stringify(name)).join(", ")}.${
            visible.length === 0 ? "" : ` It holds: ${namesOf(visible)}.`
          }`,
        );
      }

      chosen = found;
    } else if (visible.length === 1) {
      chosen = visible;
    } else if (visible.length === 0) {
      return failed(
        "no_skills",
        `${where} holds no Skill that can be installed${
          skipped.length === 0
            ? ""
            : `: ${skipped.map((skip) => `${skip.path || "SKILL.md"} (${skip.message})`).join("; ")}`
        }.`,
      );
    } else {
      return {
        status: "listed",
        repo: source.repo,
        ref: source.ref,
        commit,
        available: listing(visible),
      };
    }

    // Two folders can declare one name; the first is taken.
    const taken = new Set<string>();
    const unique: Candidate[] = [];

    for (const candidate of chosen) {
      if (taken.has(candidate.name)) {
        skipped.push({
          name: candidate.name,
          path: candidate.path,
          message: `another Skill of the name ${candidate.name} was taken from the repo already`,
        });
      } else {
        taken.add(candidate.name);
        unique.push(candidate);
      }
    }

    const fetched: FetchedSkill[] = [];

    for (const candidate of unique) {
      const entries = skillFilesIn({ tree: tree.entries }, candidate.skillMdPath);
      const problems: string[] = [];

      if (entries.length > MAX_FILES) {
        problems.push(`the folder holds ${entries.length} files, more than ${MAX_FILES}`);
      }

      let total = 0;

      for (const entry of entries) {
        total += entry.size ?? 0;

        if (entry.size !== undefined && entry.size > MAX_FILE_BYTES) {
          problems.push(
            `${entry.relative}: ${entry.size} bytes, more than the ${MAX_FILE_BYTES} a Skill's file may be`,
          );
        }
      }

      if (total > MAX_SKILL_BYTES) {
        problems.push(
          `the files are ${total} bytes together, more than the ${MAX_SKILL_BYTES} a Skill may be`,
        );
      }

      if (problems.length > 0) {
        skipped.push({ name: candidate.name, path: candidate.path, message: problems.join("; ") });
        continue;
      }

      const own = basename(candidate.skillMdPath);

      const contents = await mapLimited(entries, async (entry) => ({
        entry,
        bytes: await blob(entry),
      }));

      const files: Record<string, string> = {};

      for (const { entry, bytes } of contents) {
        // A `skill.md` in another case is the Skill's `SKILL.md`.
        const path =
          entry.relative === own && entry.path === candidate.skillMdPath
            ? "SKILL.md"
            : entry.relative;

        problems.push(...problemsIn(path, bytes));
        files[path] = decoder.decode(bytes);
      }

      if (problems.length > 0) {
        skipped.push({ name: candidate.name, path: candidate.path, message: problems.join("; ") });
        continue;
      }

      fetched.push({
        name: candidate.name,
        description: candidate.description,
        path: candidate.path,
        files,
      });
    }

    return {
      status: "fetched",
      repo: source.repo,
      ref: source.ref,
      commit,
      skills: fetched,
      // In the repo's order, whichever read finished first.
      skipped: skipped.toSorted((left, right) => left.path.localeCompare(right.path)),
    };
  } catch (cause) {
    if (Schema.is(GithubReadError)(cause)) return failed(cause.kind, cause.message);

    return failed(
      "failed",
      `GitHub could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};
