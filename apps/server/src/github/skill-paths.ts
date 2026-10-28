// Which folders of a GitHub repo hold Skills (ADR-0026, `docs/spec.md` → _The Environment's own Skills_ → _Installing from
// GitHub_): the `SKILL.md` path rules of the `skills` CLI, ported from `findSkillMdPaths` and `PRIORITY_PREFIXES` in
// `skills@1.7.4` (`dist/cli.mjs`), the function the CLI runs on a repo's tree from GitHub's Trees API. cloudpid does not
// run the CLI (it has no library entry point), so the rules are kept here and held to the CLI's own cases
// (`skill-paths.test.ts`).
//
// MIT License
//
// Copyright (c) 2026 Vercel, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// The port keeps the CLI's logic and its order of results; it is written in the repo's style (immutable where it reads
// the same, no mutation of the tree).
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off asyncFunction:off

/** One entry of a repo's tree, as GitHub's Trees API lists it. */
export type TreeEntry = {
  readonly path: string;
  readonly type: "blob" | "tree" | "commit";
  readonly sha: string;
  /** A blob's size in bytes. */
  readonly size?: number | undefined;
};

/** The directories the CLI looks in first, in its order: the repo's root, then the places agents keep Skills. */
export const PRIORITY_PREFIXES: ReadonlyArray<string> = [
  "",
  "skills/",
  "skills/.curated/",
  "skills/.experimental/",
  "skills/.system/",
  ".agents/skills/",
  ".claude/skills/",
  ".cline/skills/",
  ".codebuddy/skills/",
  ".codex/skills/",
  ".commandcode/skills/",
  ".continue/skills/",
  ".factory/skills/",
  ".github/skills/",
  ".goose/skills/",
  ".grok/skills/",
  ".iflow/skills/",
  ".junie/skills/",
  ".kilo/skills/",
  ".kilocode/skills/",
  ".kimchi/skills/",
  ".kiro/skills/",
  ".minimax/skills/",
  ".mux/skills/",
  ".neovate/skills/",
  ".opencode/skills/",
  ".openhands/skills/",
  ".pi/skills/",
  ".posit/assistant/skills/",
  ".qoder/skills/",
  ".roo/skills/",
  ".trae/skills/",
  ".windsurf/skills/",
  ".zcode/skills/",
  ".zencoder/skills/",
];

/** Directory names a container's nested Skill is not looked for in. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
]);

/** The deepest path (in segments) of a `SKILL.md` that is taken when no priority directory holds one. */
const MAX_FALLBACK_SEGMENTS = 6;

/**
 * The paths of the `SKILL.md` files `tree` holds that are Skills, as the CLI picks them, under `subpath` when given
 * (a folder of the repo, with or without a trailing slash): the repo's root, then each priority directory in turn (a
 * Skill directly in it, or one or two folders below it, never below another Skill), and, when no priority directory has
 * any, every `SKILL.md` at most six segments deep. A path is the file's, as the tree gives it (`SKILL.md` in any case).
 */
export const findSkillMdPaths = (
  tree: { readonly tree: ReadonlyArray<Pick<TreeEntry, "path" | "type">> },
  subpath?: string,
): string[] => {
  const allSkillMds = tree.tree
    .filter((entry) => entry.type === "blob" && entry.path.toLowerCase().endsWith("skill.md"))
    .map((entry) => entry.path);

  const prefix =
    subpath === undefined || subpath === "" ? "" : subpath.endsWith("/") ? subpath : `${subpath}/`;

  const filtered =
    prefix === ""
      ? allSkillMds
      : allSkillMds.filter((path) => path.startsWith(prefix) || path === `${prefix}SKILL.md`);

  if (filtered.length === 0) return [];

  const priorityResults: string[] = [];
  const seen = new Set<string>();
  const lowerSkillMdSet = new Set(filtered.map((path) => path.toLowerCase()));

  const take = (skillMd: string) => {
    if (seen.has(skillMd)) return;

    priorityResults.push(skillMd);
    seen.add(skillMd);
  };

  for (const priorityPrefix of PRIORITY_PREFIXES) {
    const fullPrefix = prefix + priorityPrefix;
    const isContainer = priorityPrefix !== "";

    for (const skillMd of filtered) {
      if (!skillMd.startsWith(fullPrefix)) continue;

      const rest = skillMd.slice(fullPrefix.length);

      if (rest.toLowerCase() === "skill.md") {
        take(skillMd);
        continue;
      }

      const parts = rest.split("/");

      if (parts.length === 2 && (parts[1] ?? "").toLowerCase() === "skill.md") {
        take(skillMd);
        continue;
      }

      const skillDirs = parts.slice(0, -1);

      const hasAncestorSkill = skillDirs.slice(0, -1).some((_, index) => {
        const ancestorPath = skillDirs.slice(0, index + 1).join("/");

        return lowerSkillMdSet.has(`${fullPrefix}${ancestorPath}/SKILL.md`.toLowerCase());
      });

      if (
        isContainer &&
        parts.length >= 3 &&
        parts.length <= 4 &&
        (parts.at(-1) ?? "").toLowerCase() === "skill.md" &&
        skillDirs.every((part) => !SKIP_DIRS.has(part)) &&
        !hasAncestorSkill
      ) {
        take(skillMd);
      }
    }
  }

  if (priorityResults.length > 0) return priorityResults;

  return filtered.filter((path) => path.split("/").length <= MAX_FALLBACK_SEGMENTS);
};

/** The folder a `SKILL.md` at `skillMdPath` is in (`""` for the repo's root): the Skill's own folder. */
export const skillFolderOf = (skillMdPath: string): string => {
  const lower = skillMdPath.toLowerCase();

  if (lower.endsWith("/skill.md")) return skillMdPath.slice(0, -9);

  if (lower === "skill.md") return "";

  return skillMdPath.slice(0, -9);
};

/** Files of a Skill's folder that are not installed, by name. */
const EXCLUDED_FILES: ReadonlySet<string> = new Set(["metadata.json"]);

/** Directories of a Skill's folder that are not installed, wherever they are in it. */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set([".git", "__pycache__", "__pypackages__"]);

/** Whether the file at `path` (relative to a Skill's folder) is part of an installed Skill: the CLI's rules for what a Skill holds. */
export const isInstallablePath = (path: string): boolean => {
  const parts = path.split("/");
  const fileName = parts.at(-1);

  if (fileName === undefined || fileName === "" || EXCLUDED_FILES.has(fileName)) return false;

  return parts.slice(0, -1).every((part) => !EXCLUDED_DIRS.has(part));
};

/**
 * The files of the Skill whose `SKILL.md` is at `skillMdPath`, from `tree`'s blobs: each by its path in the Skill's
 * folder. The CLI installs only the `SKILL.md` of a Skill at the repo's root (the rest of the repo is not the Skill's).
 */
export const skillFilesIn = (
  tree: { readonly tree: ReadonlyArray<TreeEntry> },
  skillMdPath: string,
): ReadonlyArray<TreeEntry & { readonly relative: string }> => {
  const folder = skillFolderOf(skillMdPath);

  if (folder === "") {
    return tree.tree
      .filter((entry) => entry.type === "blob" && entry.path === skillMdPath)
      .map((entry) => ({ ...entry, relative: entry.path }));
  }

  const prefix = `${folder}/`;

  return tree.tree
    .filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry, relative: entry.path.slice(prefix.length) }))
    .filter((entry) => isInstallablePath(entry.relative));
};

/**
 * The path of the `SKILL.md` of the Skill whose folder is `folder` (`""` for the repo's root) in `tree`, in whatever case
 * the tree has it (`SKILL.md` first), or undefined when the folder holds none.
 */
export const skillMdIn = (
  tree: { readonly tree: ReadonlyArray<Pick<TreeEntry, "path" | "type">> },
  folder: string,
): string | undefined => {
  const prefix = folder === "" ? "" : `${folder}/`;
  const wanted = `${prefix}skill.md`;

  const found = tree.tree.filter(
    (entry) => entry.type === "blob" && entry.path.toLowerCase() === wanted,
  );

  return (found.find((entry) => entry.path === `${prefix}SKILL.md`) ?? found[0])?.path;
};

/**
 * A digest of the Skill's folder at one commit, for telling whether it moved: SHA-256 of the git blob SHA of each file
 * the folder installs (`skillFilesIn`), by path. The folder's own tree SHA would also move for files an install leaves out
 * (`metadata.json`, `.git`) and, for a Skill at the repo's root, for any commit at all.
 */
export const folderHashOf = async (
  tree: { readonly tree: ReadonlyArray<TreeEntry> },
  skillMdPath: string,
): Promise<string> => {
  const lines = skillFilesIn(tree, skillMdPath)
    .map((entry) => `${entry.relative}\0${entry.sha}\n`)
    .toSorted();

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lines.join("")));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
