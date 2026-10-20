// `ExecutionEnv.listFiles` in the Workspace DO: one `fs.find` walk (depth first, siblings in byte order of their names,
// symbolic links listed and not followed), filtered by hidden names, excluded names and git's ignore rules.
// pi-durable's `ExecutionEnv` is Promise-native and stays so (ADR-0003); this adapter follows it.
// @effect-diagnostics asyncFunction:off globalDate:off missingPipeableSignature:off preferEffectArray:off
import type { Workspace } from "@cloudflare/computer";
import type { FileListEntry, FileListing, ListFilesOptions } from "@earendil-works/pi-durable/env";
import ignore, { type Ignore } from "ignore";
import { HostFailure, posixCode } from "./failure.ts";
import { ancestors, isWithin } from "./paths.ts";

const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const LIMIT_MAX_BYTES = Math.floor(15.9 * 1024 * 1024);
const DEFAULT_TIMEOUT_MS = 10_000;

/** Characters `fs.find` reads as glob syntax; a name holding one is excluded after the walk instead. */
const GLOB_SYNTAX = /[*?[\]{}!\\]/;

/** `fs.find` reports a symbolic link as itself; its declared type lists only files and directories. */
const KINDS = { file: "file", dir: "directory", symlink: "symlink" } as const;

type WorkspaceFilesystem = Workspace["fs"];

/** The ignore rules of one directory, matched against paths relative to it. */
type IgnoreLayer = { readonly base: string; readonly rules: Ignore };

const bound = (value: number | undefined, fallback: number, max: number, path: string): number => {
  const resolved = value ?? fallback;

  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > max) {
    throw new HostFailure("invalid", "listFiles bounds must be non-negative safe integers", path);
  }

  return resolved;
};

const readText = async (fs: WorkspaceFilesystem, path: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(path, "utf8");
  } catch (cause) {
    const code = posixCode(cause);

    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return undefined;
    throw cause;
  }
};

const exists = async (fs: WorkspaceFilesystem, path: string): Promise<boolean> => {
  try {
    await fs.lstat(path);

    return true;
  } catch (cause) {
    if (posixCode(cause) === "ENOENT") return false;
    throw cause;
  }
};

const child = (directory: string, name: string) =>
  directory === "/" ? `/${name}` : `${directory}/${name}`;

/** The innermost directory at or above `directory` that holds `.git`: the root of its git work tree. */
const workTreeRoot = async (
  fs: WorkspaceFilesystem,
  directory: string,
): Promise<string | undefined> => {
  for (const candidate of [directory, ...ancestors(directory)]) {
    if (await exists(fs, child(candidate, ".git"))) return candidate;
  }

  return undefined;
};

const layer = async (
  fs: WorkspaceFilesystem,
  base: string,
  file: string,
): Promise<IgnoreLayer | undefined> => {
  const text = await readText(fs, file);

  return text === undefined ? undefined : { base, rules: ignore().add(text) };
};

/** Whether git ignores `path`: later layers (deeper `.gitignore` files) override earlier ones. */
const ignored = (layers: readonly IgnoreLayer[], path: string, directory: boolean): boolean => {
  let result = false;

  for (const { base, rules } of layers) {
    if (!isWithin(path, base) || path === base) continue;

    const relative = path.slice(base === "/" ? 1 : base.length + 1) + (directory ? "/" : "");
    const test = rules.test(relative);

    if (test.ignored) result = true;
    else if (test.unignored) result = false;
  }

  return result;
};

/** The files, directories and symbolic links below `path`, as `ExecutionEnv.listFiles` lists them. */
export const listFiles = async (
  fs: WorkspaceFilesystem,
  path: string,
  options: ListFilesOptions,
): Promise<FileListing> => {
  const maxEntries = bound(options.maxEntries, DEFAULT_MAX_ENTRIES, Number.MAX_SAFE_INTEGER, path);
  const maxBytes = bound(options.maxBytes, DEFAULT_MAX_BYTES, LIMIT_MAX_BYTES, path);
  const timeoutMs = bound(options.timeoutMs, DEFAULT_TIMEOUT_MS, Number.MAX_SAFE_INTEGER, path);
  const deadline = Date.now() + timeoutMs;
  const hidden = options.hidden ?? true;
  const excluded = new Set(options.exclude ?? []);

  if (!(await fs.stat(path)).isDirectory) {
    throw new HostFailure("not_directory", "Not a directory", path);
  }

  const globs = [".git", ...excluded, ...(hidden ? [] : [".*"])].flatMap((name) =>
    name === ".*" || !GLOB_SYNTAX.test(name) ? [`**/${name}`] : [],
  );

  const found = await fs.find(path, undefined, { exclude: globs });
  const root = options.gitignore === false ? undefined : await workTreeRoot(fs, path);
  const layers: IgnoreLayer[] = [];

  if (root !== undefined) {
    const exclude = await layer(fs, root, `${child(root, ".git")}/info/exclude`);

    if (exclude !== undefined) layers.push(exclude);

    // The listed directory's own rules and its parents' up to the work tree root, outermost first.
    for (const directory of [...ancestors(path).filter((up) => isWithin(up, root)), path].toSorted(
      (a, b) => a.length - b.length,
    )) {
      const rules = await layer(fs, directory, child(directory, ".gitignore"));

      if (rules !== undefined) layers.push(rules);
    }

    // Rules below the listed directory, read before the walk is filtered, since a sibling may sort before them.
    for (const entry of found) {
      if (entry.path.endsWith("/.gitignore") && entry.type === "file") {
        const rules = await layer(fs, entry.path.slice(0, -"/.gitignore".length), entry.path);

        if (rules !== undefined) layers.push(rules);
      }
    }
  }

  const prefix = path === "/" ? "/" : `${path}/`;
  const entries: FileListEntry[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  let truncated = false;

  for (const entry of found) {
    if (skipped.some((directory) => isWithin(entry.path, directory))) continue;

    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const directory = entry.type === "dir";

    const skip =
      name === ".git" ||
      excluded.has(name) ||
      (!hidden && name.startsWith(".")) ||
      ignored(
        layers.filter(({ base }) => isWithin(entry.path, base)),
        entry.path,
        directory,
      );

    if (skip) {
      if (directory) skipped.push(entry.path);
      continue;
    }

    const relative = entry.path.slice(prefix.length);
    const size = new TextEncoder().encode(relative).length + 2;

    if (entries.length + 1 > maxEntries || bytes + size > maxBytes || Date.now() > deadline) {
      truncated = true;
      break;
    }

    bytes += size;
    // SAFETY: `fs.find` reports every node with its stored type, one of the keys of `KINDS`.
    entries.push({ path: relative, kind: KINDS[entry.type as keyof typeof KINDS] });
  }

  return { entries, truncated };
};
