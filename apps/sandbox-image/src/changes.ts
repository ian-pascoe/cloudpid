// The Container's side of Changes (docs/spec.md → Diffs and review → Changes, ADR-0022): the fallback the Workspace DO
// runs, with real git, for a repo isomorphic-git cannot be trusted with. Its list is `git diff HEAD -M` on a private copy
// of the index (`GIT_INDEX_FILE`), with the untracked files added there as intent-to-add, so the shared `.git/index`
// is never written; a file's HEAD side is the blob itself. These are bash scripts and their parsers; no Node built-ins,
// since the Workspace DO imports them.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import { shellQuote, WORKSPACE_ROOT } from "./toolchains.ts";

/** A changed file as the Container's git lists it. */
export type ContainerChange = {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  /** Lines added and deleted; null for a file git takes for binary. */
  readonly additions: number | null;
  readonly deletions: number | null;
  /** git takes the file for binary (`--numstat` prints `-`). */
  readonly binary: boolean;
  /** The size of the HEAD side, in bytes; null when there is none. */
  readonly oldBytes: number | null;
};

/** One repo as `changesScript` lists it, or why it could not. */
export type ContainerRepoChanges =
  | { readonly repo: string; readonly files: ReadonlyArray<ContainerChange> }
  | { readonly repo: string; readonly error: string };

/**
 * The bash script that lists the Changes of each of `repos` (directories below `root`). Per repo it prints a `repo`
 * line, then either `raw`, `numstat` and `sizes` lines (the `-z` outputs of `git diff HEAD -M --raw` and `--numstat`,
 * and the HEAD blobs' `cat-file` sizes, each base64 on one line) and `ok`, or an `error` line (git's message, base64).
 * The index each repo's git reads is a copy in a temp directory on the Container's disk, where `git add -N` records the
 * untracked files that are not ignored; `.git/index` itself is only read. A repo with no commit is compared with the
 * empty tree.
 */
export const changesScript = (repos: ReadonlyArray<string>, root: string = WORKSPACE_ROOT): string => `set -u -o pipefail
root=${shellQuote(root)}
repos=(${repos.map(shellQuote).join(" ")})
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
b64() { base64 | tr -d '\\n'; }
for repo in \${repos[@]+"\${repos[@]}"}; do
  dir="$root/$repo"
  printf 'repo\\t%s\\n' "$repo"
  rm -f "$work"/*
  export GIT_INDEX_FILE="$work/index"
  if [ -f "$dir/.git/index" ]; then cp "$dir/.git/index" "$GIT_INDEX_FILE"; fi
  base=HEAD
  if ! git -C "$dir" rev-parse --quiet --verify HEAD >/dev/null 2>&1; then
    base=$(git -C "$dir" hash-object -t tree /dev/null 2>/dev/null || echo 4b825dc642cb6eb9a060e54bf8d69288fbee4904)
  fi
  diff=(git -C "$dir" -c core.quotepath=off -c diff.renames=true diff "$base" -M --no-ext-diff --no-textconv --no-color -z)
  if git -C "$dir" add --intent-to-add . 2>"$work/err" \\
    && "\${diff[@]}" --raw --no-abbrev >"$work/raw" 2>>"$work/err" \\
    && "\${diff[@]}" --numstat >"$work/numstat" 2>>"$work/err" \\
    && { tr '\\0' '\\n' <"$work/raw" | sed -nE 's/^:[0-7]+ [0-7]+ ([0-9a-f]+) [0-9a-f]+ [A-Z][0-9]*$/\\1/p' | { grep -v '^0*$' || true; } | sort -u \\
      | git -C "$dir" cat-file --batch-check='%(objectname) %(objectsize)' >"$work/sizes"; } 2>>"$work/err"; then
    printf 'raw\\t%s\\n' "$(b64 <"$work/raw")"
    printf 'numstat\\t%s\\n' "$(b64 <"$work/numstat")"
    printf 'sizes\\t%s\\n' "$(b64 <"$work/sizes")"
    printf 'ok\\n'
  else
    printf 'error\\t%s\\n' "$(b64 <"$work/err")"
  fi
  unset GIT_INDEX_FILE
done
exit 0
`;

/** The bytes `text` (base64) holds. */
const bytesOf = (text: string): Uint8Array => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

const decoder = new TextDecoder();

/** The NUL-separated fields of base64 `text`, the trailing empty one dropped. */
const fieldsOf = (text: string): string[] => {
  const fields = decoder.decode(bytesOf(text)).split("\0");

  if (fields.at(-1) === "") fields.pop();

  return fields;
};

type RawRecord = {
  readonly oldId: string;
  readonly letter: string;
  readonly path: string;
  readonly oldPath?: string;
};

/** `git diff --raw -z`'s records: `:<modes> <ids> <status>`, then the path, or for a rename or copy both paths. */
const rawRecords = (fields: readonly string[]): RawRecord[] => {
  const records: RawRecord[] = [];

  for (let at = 0; at < fields.length; ) {
    const meta = fields[at++] ?? "";
    const [, , oldId = "", , status = ""] = meta.slice(1).split(" ");
    const letter = status.charAt(0);

    if (letter === "R" || letter === "C") {
      const oldPath = fields[at++] ?? "";
      const path = fields[at++] ?? "";

      records.push({ oldId, letter, path, oldPath });
    } else {
      records.push({ oldId, letter, path: fields[at++] ?? "" });
    }
  }

  return records;
};

type Counts = { readonly additions: number | null; readonly deletions: number | null };

/** `git diff --numstat -z`'s counts, in order: `-` for a binary file. A rename's paths follow in fields of their own. */
const numstatCounts = (fields: readonly string[]): Counts[] => {
  const counts: Counts[] = [];

  for (let at = 0; at < fields.length; ) {
    const [added = "", deleted = "", path = ""] = (fields[at++] ?? "").split("\t");

    // A rename's line ends with an empty path; its two paths are the next fields.
    if (path === "") at += 2;

    counts.push({
      additions: added === "-" ? null : Number(added),
      deletions: deleted === "-" ? null : Number(deleted),
    });
  }

  return counts;
};

/** `cat-file --batch-check`'s `<id> <size>` lines; a `<id> missing` line is left out. */
const blobSizes = (text: string): Map<string, number> => {
  const sizes = new Map<string, number>();

  for (const line of decoder.decode(bytesOf(text)).split("\n")) {
    const [id, size] = line.split(" ");

    if (id !== undefined && size !== undefined && /^\d+$/.test(size)) sizes.set(id, Number(size));
  }

  return sizes;
};

const statusOf = (letter: string): ContainerChange["status"] => {
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    // A copy is not asked for (`-M` only); a type change or an unmerged path is a modification.
    case "C":
      return "added";
    default:
      return "modified";
  }
};

/**
 * What `changesScript` printed, read back per repo, in the order printed. A repo whose lines stop short (the script was
 * cut off) is an error, so nothing unread passes for "no changes".
 */
export const parseChanges = (stdout: string): ContainerRepoChanges[] => {
  const repos: ContainerRepoChanges[] = [];
  let repo: string | undefined;
  let sections: Record<string, string> = {};

  const finish = (outcome: ContainerRepoChanges) => {
    repos.push(outcome);
    repo = undefined;
    sections = {};
  };

  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    const key = tab === -1 ? line : line.slice(0, tab);
    const value = tab === -1 ? "" : line.slice(tab + 1);

    if (key === "repo") {
      if (repo !== undefined) finish({ repo, error: "The Container's listing stopped short" });

      repo = value;
    } else if (repo === undefined) {
      continue;
    } else if (key === "error") {
      finish({ repo, error: decoder.decode(bytesOf(value)).trim() || "git failed" });
    } else if (key === "ok") {
      const records = rawRecords(fieldsOf(sections.raw ?? ""));
      const counts = numstatCounts(fieldsOf(sections.numstat ?? ""));
      const sizes = blobSizes(sections.sizes ?? "");

      finish({
        repo,
        files: records.map((record, index) => {
          const { additions = null, deletions = null } = counts[index] ?? {};
          const status = statusOf(record.letter);

          const file: ContainerChange = {
            path: record.path,
            status,
            additions,
            deletions,
            binary: counts[index] !== undefined && additions === null,
            oldBytes: status === "added" ? null : (sizes.get(record.oldId) ?? null),
          };

          return record.letter === "R" && record.oldPath !== undefined
            ? { ...file, oldPath: record.oldPath }
            : file;
        }),
      });
    } else if (key === "raw" || key === "numstat" || key === "sizes") {
      sections[key] = value;
    }
  }

  if (repo !== undefined) finish({ repo, error: "The Container's listing stopped short" });

  return repos;
};

/**
 * The bash script that prints the HEAD side of `path` in `repo`: a `size` line, then, unless it is over `maxBytes`, a
 * `blob` line (the bytes, base64); nothing when HEAD has no such file.
 */
export const headBlobScript = (
  repo: string,
  path: string,
  maxBytes: number,
  root: string = WORKSPACE_ROOT,
): string => `set -u -o pipefail
dir=${shellQuote(`${root}/${repo}`)}
spec=${shellQuote(`HEAD:${path}`)}
size=$(git -C "$dir" cat-file -s "$spec" 2>/dev/null) || exit 0
printf 'size\\t%s\\n' "$size"
if [ "$size" -le ${maxBytes} ]; then
  printf 'blob\\t%s\\n' "$(git -C "$dir" cat-file blob "$spec" | base64 | tr -d '\\n')"
fi
`;

/** What `headBlobScript` printed: the blob's size and its bytes (absent over the limit), or null when there is none. */
export const parseHeadBlob = (
  stdout: string,
): { readonly bytes: number; readonly blob?: Uint8Array } | null => {
  let bytes: number | undefined;
  let blob: Uint8Array | undefined;

  for (const line of stdout.split("\n")) {
    const [key, value = ""] = line.split("\t");

    if (key === "size" && /^\d+$/.test(value)) bytes = Number(value);

    if (key === "blob") blob = bytesOf(value);
  }

  if (bytes === undefined) return null;

  return blob === undefined ? { bytes } : { bytes, blob };
};
