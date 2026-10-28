// The Container's side of the Run diff's copies (docs/architecture/diffs-and-review.md → Run diff, ADR-0022): for a repo the
// Workspace DO cannot list itself (the Container's git is the fallback Changes uses too), one command that saves the
// working tree as git objects, a tree and a commit under `refs/cloudpid/runs/<scope>/{start,end}`. It runs on a private
// copy of the repo's index (`GIT_INDEX_FILE`, which keeps the stat data of the files git has already seen, so only the
// files that changed are read), so the shared `.git/index`, `refs/heads`, `refs/remotes` and the tree are never written:
// it only adds objects and the one hidden ref. These are bash scripts and their parsers; no Node built-ins, since the
// Workspace DO imports them.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import { bytesOf, EMPTY_TREE_ID } from "./changes.ts";
import { shellQuote, WORKSPACE_ROOT } from "./toolchains.ts";

/** The hidden refs of a Run's copies: `refs/cloudpid/runs/<scope>/start` and `…/end`. */
export const RUN_REF_PREFIX = "refs/cloudpid/runs/";

/** What a copy's ref may be: the Session's scope, then `start` or `end`, nothing else reaches the script. */
const COPY_REF = /^refs\/cloudpid\/runs\/[A-Za-z0-9_-]{1,64}\/(?:start|end)$/;

/** How long a copy may take on the Container before the command stops itself, in seconds. */
export const RUN_COPY_TIMEOUT_SECONDS = 20;

/** What a copy of one repo is asked. */
export type RunCopyInput = {
  /** The repo's directory below the Workspace's root. */
  readonly repo: string;
  /** The hidden ref the copy's commit is written to. */
  readonly ref: string;
  /** More files than this differ from HEAD: the repo is not copied ("too many changed files"). */
  readonly maxFiles: number;
  /** A file bigger than this many bytes, or a binary one, is not stored: only its size and hash are recorded. */
  readonly maxStoredBytes: number;
  /** A file not stored is hashed only up to this many bytes. */
  readonly maxHashedBytes: number;
  /** The command stops itself after this long; `RUN_COPY_TIMEOUT_SECONDS` when left out. */
  readonly timeoutSeconds?: number;
};

const isCount = (value: number): boolean => Number.isInteger(value) && value >= 0;

/**
 * The bash command that saves the working tree of `input.repo` as a commit. The private index starts as a copy of the
 * repo's own with its modification time (git tells a file edited in the same instant as the index was written by comparing the two; a copy dated later would hide the edit), read from HEAD when there is none, so `git update-index` reads only the files whose stat changed. The files
 * that differ from HEAD are found (changed since the index, untracked and not ignored, staged), counted, and sorted before
 * anything is stored: past `maxFiles` nothing is saved; a file over `maxStoredBytes`, or one with a NUL byte, is left as
 * HEAD has it and recorded by size and hash. The rest are put in the index, and `git write-tree` and `git commit-tree`
 * (parent HEAD) save it, and `git update-ref` points `input.ref` at the commit. It prints an `unstored` line for each file
 * left out, then `ok`, the commit and how many files differ from HEAD; `toomany` and the count (nothing is saved); or
 * `error` and git's message (base64). It ends itself after `timeoutSeconds`, so it never writes the ref after the caller
 * has given up.
 */
export const runCopyScript = (input: RunCopyInput, root: string = WORKSPACE_ROOT): string => {
  if (!COPY_REF.test(input.ref)) throw new Error(`Not a Run copy ref: ${input.ref}`);

  for (const value of [input.maxFiles, input.maxStoredBytes, input.maxHashedBytes]) {
    if (!isCount(value)) throw new Error(`Not a limit: ${value}`);
  }

  const seconds = input.timeoutSeconds ?? RUN_COPY_TIMEOUT_SECONDS;

  if (!Number.isInteger(seconds) || seconds < 1) throw new Error(`Not a time limit: ${seconds}`);

  const body = `set -u -o pipefail
export LC_ALL=C
dir=${shellQuote(`${root}/${input.repo}`)}
ref=${shellQuote(input.ref)}
limit=${input.maxFiles}
max_stored=${input.maxStoredBytes}
max_hashed=${input.maxHashedBytes}
empty=${EMPTY_TREE_ID}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
err="$work/err"
: >"$err"
b64() { base64 | tr -d '\\n'; }
fail() { printf 'error\\t%s\\n' "$(printf '%s' "$1" | b64)"; exit 0; }
tail_err() { tail -c 2000 "$err"; }
cd "$dir" 2>/dev/null || fail "The repo is not on the Container"
export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_LITERAL_PATHSPECS=1
real_index=$(git rev-parse --git-path index 2>/dev/null || true)
export GIT_INDEX_FILE="$work/index"
parent=()
base=$empty
if head=$(git rev-parse --verify --quiet 'HEAD^{commit}'); then
  parent=(-p "$head")
  base=$head
fi
if [ -n "$real_index" ] && [ -f "$real_index" ]; then
  cp -p -- "$real_index" "$GIT_INDEX_FILE" 2>"$err" || fail "$(tail_err)"
elif [ "$base" != "$empty" ]; then
  git read-tree "$base" 2>"$err" || fail "$(tail_err)"
fi
git update-index -q --refresh >/dev/null 2>&1 || true
{ git diff-files --name-only -z; git ls-files -z --others --exclude-standard; git diff-index --cached --name-only -z "$base"; } 2>"$err" | sort -zu >"$work/candidates" || fail "$(tail_err)"
count=$(tr -cd '\\0' <"$work/candidates" | wc -c)
count=$((count + 0))
if [ "$count" -gt "$limit" ]; then printf 'toomany\\t%s\\n' "$count"; exit 0; fi
declare -A kind=() size=() binary=()
xargs -0 -r stat --printf='%F\\0%s\\0%n\\0' -- <"$work/candidates" >"$work/stats" 2>/dev/null || true
while IFS= read -r -d '' k && IFS= read -r -d '' s && IFS= read -r -d '' p; do
  kind[$p]=$k
  size[$p]=$s
done <"$work/stats"
: >"$work/store"
: >"$work/small"
big=()
while IFS= read -r -d '' p; do
  case "\${kind[$p]-}" in
    "") printf '%s\\0' "$p" >>"$work/store" ;;
    "directory") ;;
    "symbolic link") printf '%s\\0' "$p" >>"$work/store" ;;
    *)
      if [ "\${size[$p]}" -gt "$max_stored" ]; then big+=("$p"); else printf '%s\\0' "$p" >>"$work/small"; fi
      ;;
  esac
done <"$work/candidates"
while IFS= read -r -d '' p; do binary[$p]=1; done < <(xargs -0 -r grep -l -Z -a -P '\\x00' -- <"$work/small" 2>/dev/null || true)
upaths=()
ubinary=()
while IFS= read -r -d '' p; do
  if [ -n "\${binary[$p]-}" ]; then upaths+=("$p"); ubinary+=(1); else printf '%s\\0' "$p" >>"$work/store"; fi
done <"$work/small"
for p in \${big[@]+"\${big[@]}"}; do upaths+=("$p"); ubinary+=(0); done
: >"$work/tohash"
for p in \${upaths[@]+"\${upaths[@]}"}; do
  if [ "\${size[$p]}" -le "$max_hashed" ]; then printf '%s\\0' "$p" >>"$work/tohash"; fi
done
ids=()
if [ -s "$work/tohash" ]; then
  mapfile -t ids < <(xargs -0 git hash-object --no-filters -- <"$work/tohash" 2>"$err") || fail "$(tail_err)"
fi
: >"$work/reset"
: >"$work/unstored"
n=0
for i in \${!upaths[@]}; do
  p=\${upaths[$i]}
  id=-
  if [ "\${size[$p]}" -le "$max_hashed" ]; then
    id=\${ids[$n]-}
    n=$((n + 1))
    if [ -z "$id" ]; then fail "Hashing $p failed"; fi
  fi
  printf '%s\\0' "$p" >>"$work/reset"
  printf 'unstored\\t%s\\t%s\\t%s\\t%s\\n' "\${size[$p]}" "$id" "\${ubinary[$i]}" "$(printf '%s' "$p" | b64)" >>"$work/unstored"
done
git update-index --add --remove --replace -z --stdin <"$work/store" 2>"$err" || fail "$(tail_err)"
if [ -s "$work/reset" ]; then
  git reset -q "$base" --pathspec-from-file="$work/reset" --pathspec-file-nul 2>"$err" || fail "$(tail_err)"
fi
files=$(git diff-index --cached --name-only -z "$base" 2>"$err" | tr -cd '\\0' | wc -c) || fail "$(tail_err)"
files=$((files + \${#upaths[@]}))
tree=$(git write-tree 2>"$err") || fail "$(tail_err)"
name=$(git config user.name 2>/dev/null || true)
email=$(git config user.email 2>/dev/null || true)
export GIT_AUTHOR_NAME="\${name:-cloudpid}" GIT_AUTHOR_EMAIL="\${email:-cloudpid@localhost}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
commit=$(git commit-tree "$tree" \${parent[@]+"\${parent[@]}"} -m 'cloudpid run copy' 2>"$err") || fail "$(tail_err)"
git update-ref "$ref" "$commit" 2>"$err" || fail "$(tail_err)"
cat "$work/unstored"
printf 'ok\\t%s\\t%s\\n' "$commit" "$files"
exit 0
`;

  return `timeout --kill-after=2 ${seconds} bash -c ${shellQuote(body)}`;
};

/** A file the copy did not store: too big or binary, recorded by size and hash. */
export type CopyUnstored = {
  readonly path: string;
  readonly size: number;
  /** The blob id of its bytes; null when it was too big to hash. */
  readonly id: string | null;
  /** It has a NUL byte (a file too big is not marked binary). */
  readonly binary: boolean;
};

/** What `runCopyScript` printed. */
export type ParsedRunCopy =
  | {
      readonly ok: true;
      readonly commit: string;
      readonly files: number;
      readonly unstored: ReadonlyArray<CopyUnstored>;
    }
  | { readonly ok: false; readonly kind: "too_many"; readonly files: number }
  | { readonly ok: false; readonly kind: "failed"; readonly message: string };

const decoder = new TextDecoder();

/** The outcome `runCopyScript` printed; output that stops short is a failure, so nothing unread passes for a copy. */
export const parseRunCopy = (stdout: string): ParsedRunCopy => {
  const unstored: CopyUnstored[] = [];

  for (const line of stdout.split("\n")) {
    const [key = "", first = "", second = "", third = "", fourth = ""] = line.split("\t");

    if (
      key === "unstored" &&
      /^\d+$/.test(first) &&
      /^[0-9a-f]{40}$|^[0-9a-f]{64}$|^-$/.test(second)
    ) {
      unstored.push({
        path: decoder.decode(bytesOf(fourth)),
        size: Number(first),
        id: second === "-" ? null : second,
        binary: third === "1",
      });
    }

    if (key === "ok" && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(first) && /^\d+$/.test(second)) {
      return { ok: true, commit: first, files: Number(second), unstored };
    }

    if (key === "toomany" && /^\d+$/.test(first)) {
      return { ok: false, kind: "too_many", files: Number(first) };
    }

    if (key === "error") {
      return {
        ok: false,
        kind: "failed",
        message: decoder.decode(bytesOf(first)).trim() || "git failed",
      };
    }
  }

  return { ok: false, kind: "failed", message: "The Container's copy stopped short" };
};
