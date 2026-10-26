// Which files of a Diff pane start folded (`docs/spec.md` → Diffs and review → Diff pane): decided from the file list
// alone, before any content loads. Lockfiles, generated or minified names, files under `generated/`, `__generated__/`,
// `vendor/` or `third_party/`, what the root `.gitattributes` marks `linguist-generated` or `linguist-vendored` (the
// list's flags; `=false` unmarks a file whatever its name says), files with more than 1,000 changed lines, and deleted
// files. The owner opens and folds them by hand after that.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over values, called from React, over native arrays.
import type { ChangeEntry } from "@cloudpid/protocol";

/** Why a file starts folded, which its header says. */
export type FoldReason = "deleted" | "lockfile" | "generated" | "vendored" | "large";

/** A file with more changed lines than this (added and deleted together) starts folded. */
export const LARGE_FILE_LINES = 1000;

/** Lockfiles, by their whole name. */
const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "Pipfile.lock",
  "pdm.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
  "go.work.sum",
  "mix.lock",
  "flake.lock",
  "Podfile.lock",
  "pubspec.lock",
  "packages.lock.json",
  "gradle.lockfile",
  "mise.lock",
  "Package.resolved",
  "Cartfile.resolved",
]);

/** Names that generated or minified files have: bundles, source maps, protobuf and Dart codegen, `*.generated.*`. */
const GENERATED_NAME =
  /(?:\.min\.(?:js|mjs|cjs|css)|\.(?:js|mjs|cjs|css)\.map|\.pb\.go|_pb2(?:_grpc)?\.py|\.g\.dart|\.freezed\.dart|\.designer\.cs|\.generated\.[^./]+)$/;

/** Directories whose files are generated. */
const GENERATED_DIRECTORIES: ReadonlySet<string> = new Set(["generated", "__generated__"]);

/** Directories whose files are vendored. */
const VENDORED_DIRECTORIES: ReadonlySet<string> = new Set(["vendor", "third_party"]);

/** The directories `path` is under, and its name. */
const partsOf = (path: string) => {
  const segments = path.split("/");

  return { directories: segments.slice(0, -1), name: segments.at(-1) ?? "" };
};

/** Why `entry` starts folded, or undefined when it starts open. */
export const foldReason = (entry: ChangeEntry): FoldReason | undefined => {
  if (entry.status === "deleted") return "deleted";

  const { directories, name } = partsOf(entry.path);

  // An explicit `linguist-generated=false` (or `linguist-vendored=false`) beats what the name or directory suggests.
  if (entry.generated !== false) {
    if (LOCKFILES.has(name)) return "lockfile";

    if (
      entry.generated === true ||
      GENERATED_NAME.test(name) ||
      directories.some((directory) => GENERATED_DIRECTORIES.has(directory))
    ) {
      return "generated";
    }
  }

  if (
    entry.vendored === true ||
    (entry.vendored !== false &&
      directories.some((directory) => VENDORED_DIRECTORIES.has(directory)))
  ) {
    return "vendored";
  }

  if ((entry.additions ?? 0) + (entry.deletions ?? 0) > LARGE_FILE_LINES) return "large";

  return undefined;
};

/** What a folded file's header says of why it is folded. */
export const FOLD_REASON_LABEL: Readonly<Record<FoldReason, string>> = {
  deleted: "Deleted",
  lockfile: "Lockfile",
  generated: "Generated",
  vendored: "Vendored",
  large: "Large",
};
