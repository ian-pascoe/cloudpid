// The Container's side of This branch (docs/spec.md → Diffs and review → Comparisons, ADR-0022): one command that picks
// the remote and the base, fetches the base into a private ref, takes the merge-base and lists the files, and the
// fallback that reads blobs. The fetch writes objects and `refs/cloudpid/base/<base>` and nothing else: never
// `refs/heads`, `refs/remotes`, `FETCH_HEAD`, the index or the tree (`--no-write-fetch-head --no-auto-maintenance
// --no-tags`, and every other command only reads); `plain bash` tests check each. These are bash scripts and their
// parsers; no Node built-ins, since the Workspace DO imports them.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import {
  blobSizes,
  bytesOf,
  type Counts,
  fieldsOf,
  numstatCounts,
  statusOf,
  type ContainerChange,
} from "./changes.ts";
import { shellQuote, WORKSPACE_ROOT } from "./toolchains.ts";

/** The most bytes of file list (`--raw --numstat -z`) a Comparison reads; past it the repo has too many changes to list. */
export const COMPARISON_LIST_LIMIT = 16 * 1024 * 1024;

/** The hidden refs a fetched base lands in. */
export const BASE_REF_PREFIX = "refs/cloudpid/base/";

/** What a Comparison's command is asked. */
export type ComparisonInput = {
  /** The repo's directory below the Workspace's root. */
  readonly repo: string;
  /**
   * The base branch the Workspace DO chose (the open pull request's base, so a stacked branch compares with the branch
   * under it); absent, the remote's default branch.
   */
  readonly base?: string | undefined;
  /** Fetch the base again even when it was fetched before (the owner's Refresh). */
  readonly fetch: boolean;
  /**
   * Compare pull request `number` instead of the branch checked out: its head is fetched from the remote's
   * `refs/pull/<number>/head` into `refs/cloudpid/pr/<number>` (with the base, which the Workspace DO must give, from the
   * pull request), and fetched again when the ref is missing or is not `head`, the commit the pull request is at now.
   */
  readonly pull?: { readonly number: number; readonly head?: string | undefined } | undefined;
  /**
   * Pull requests no longer open: their `refs/cloudpid/pr/<number>` refs are deleted first (`git update-ref -d`; never
   * `gc`, and nothing else is touched).
   */
  readonly drop?: ReadonlyArray<number> | undefined;
};

/** The hidden refs a fetched pull request's head lands in, `refs/cloudpid/pr/<number>`. */
export const PULL_REF_PREFIX = "refs/cloudpid/pr/";

const isPullNumber = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

/**
 * The bash script that makes a Comparison of the branch checked out in `input.repo`:
 *
 * - the remote is the branch's tracked one, else `origin`, else the only one;
 * - the base is `input.base`, else the remote's default branch (`refs/remotes/<remote>/HEAD`, else `ls-remote --symref`),
 *   else, without a usable remote, the first of `main`, `master`, `trunk`, `develop` that exists here;
 * - with a remote, `git fetch --refmap= --no-write-fetch-head --no-auto-maintenance --no-tags --no-recurse-submodules
 *   --no-prune -- <remote> '+refs/heads/<base>:refs/cloudpid/base/<base>'` when `input.fetch` or the ref is missing (a second try on `cannot
 *   lock ref`); without one, the local branch is the base. For a pull request (`input.pull`) the same fetch also takes
 *   `'+refs/pull/<n>/head:refs/cloudpid/pr/<n>'`, the head is that ref's commit, and a repo with no remote has no pull
 *   requests; The empty `--refmap` is what keeps git from also updating
 *   `refs/remotes/<remote>/<base>` (the opportunistic update of a remote-tracking branch that a configured remote's
 *   `fetch` refspec matches);
 * - `git merge-base`, the commits beyond it, and `git --no-optional-locks diff -M --no-ext-diff --no-textconv --no-color
 *   --raw --numstat -z <merge-base> <head>` with the sizes of the blobs it names.
 *
 * It prints `field` lines (one value each, base64) and `ok`, or an `error` line (a kind, then git's message, base64)
 * after the `base` field when the base was chosen.
 */
export const comparisonScript = (input: ComparisonInput, root: string = WORKSPACE_ROOT): string => {
  const pull = input.pull?.number ?? 0;
  const drop = input.drop ?? [];
  const want = input.pull?.head ?? "";

  if (input.pull !== undefined && !isPullNumber(pull)) {
    throw new Error(`Not a pull request number: ${pull}`);
  }

  if (!drop.every(isPullNumber)) throw new Error("Not pull request numbers to drop");

  if (want !== "" && !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(want)) {
    throw new Error(`Not a commit id: ${want}`);
  }

  return script(input, root, pull, want, drop);
};

const script = (
  input: ComparisonInput,
  root: string,
  pull: number,
  want: string,
  drop: ReadonlyArray<number>,
): string => `set -u -o pipefail
dir=${shellQuote(`${root}/${input.repo}`)}
base=${shellQuote(input.base ?? "")}
fetch=${input.fetch ? 1 : 0}
pull=${pull}
want=${shellQuote(want)}
drop=${shellQuote(drop.join(" "))}
limit=${COMPARISON_LIST_LIMIT}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
err="$work/err"
: >"$err"
b64() { base64 | tr -d '\\n'; }
field() { printf '%s\\t%s\\n' "$1" "$(printf '%s' "$2" | b64)"; }
fail() { printf 'error\\t%s\\t%s\\n' "$1" "$(printf '%s' "$2" | b64)"; exit 0; }
tail_err() { tail -c 2000 "$err"; }
cd "$dir" 2>/dev/null || fail failed "The repo is not on the Container"
export GIT_TERMINAL_PROMPT=0
for n in $drop; do git update-ref -d "${PULL_REF_PREFIX}$n" 2>/dev/null || true; done
head=
if [ "$pull" = 0 ]; then
  head=$(git rev-parse --verify --quiet 'HEAD^{commit}') || fail failed "The repo has no commits yet"
fi
branch=$(git symbolic-ref --quiet --short HEAD || true)
remotes=$(git remote)
remote=
tracked=
if [ -n "$branch" ]; then tracked=$(git config --get "branch.$branch.remote" || true); fi
if [ -n "$tracked" ] && printf '%s\\n' "$remotes" | grep -qxF -- "$tracked"; then
  remote=$tracked
elif printf '%s\\n' "$remotes" | grep -qxF origin; then
  remote=origin
elif [ "$(printf '%s\\n' "$remotes" | grep -c .)" = 1 ]; then
  remote=$remotes
fi
asked=$base
if [ -z "$base" ] && [ -n "$remote" ]; then
  ref=$(git symbolic-ref --quiet "refs/remotes/$remote/HEAD" || true)
  prefix="refs/remotes/$remote/"
  base=\${ref#"$prefix"}
  if [ -z "$base" ]; then
    base=$(git ls-remote --symref -- "$remote" HEAD 2>>"$err" | sed -n 's|^ref: refs/heads/\\(.*\\)\\tHEAD$|\\1|p' | head -n 1)
  fi
fi
if [ -z "$base" ] && [ "$pull" != 0 ]; then fail failed "The pull request's base branch is unknown"; fi
if [ -z "$base" ]; then
  for candidate in main master trunk develop; do
    if git show-ref --verify --quiet "refs/heads/$candidate"; then base=$candidate; break; fi
  done
fi
if [ -z "$base" ]; then
  if [ -z "$remote" ]; then fail no_remote "This repo has no remote, and no main, master, trunk or develop branch to compare with"; fi
  fail failed "The remote's default branch is unknown: $(tail_err)"
fi
field base "$base"
case "$base" in
  -*|*[[:space:]]*) fail failed "Unsupported base branch name: $base" ;;
esac
git check-ref-format "refs/heads/$base" || fail failed "Unsupported base branch name: $base"
fetched=0
if [ "$pull" != 0 ]; then branch=; fi
pullref="${PULL_REF_PREFIX}$pull"
if [ -n "$remote" ]; then
  baseref="${BASE_REF_PREFIX}$base"
  need=$fetch
  git rev-parse --verify --quiet "$baseref^{commit}" >/dev/null || need=1
  if [ "$pull" != 0 ]; then
    have=$(git rev-parse --verify --quiet "$pullref^{commit}" || true)
    if [ -z "$have" ] || { [ -n "$want" ] && [ "$have" != "$want" ]; }; then need=1; fi
  fi
  if [ "$need" = 1 ]; then
    fetch_base=(git fetch --refmap= --no-write-fetch-head --no-auto-maintenance --no-tags --no-recurse-submodules --no-prune -- "$remote" "+refs/heads/$base:$baseref")
    if [ "$pull" != 0 ]; then fetch_base+=("+refs/pull/$pull/head:$pullref"); fi
    got=0
    if "\${fetch_base[@]}" 2>"$err"; then
      got=1
    elif grep -q 'cannot lock ref' "$err"; then
      sleep 1
      if "\${fetch_base[@]}" 2>"$err"; then got=1; fi
    fi
    if [ "$got" = 0 ]; then
      if [ "$pull" != 0 ] && grep -q "couldn't find remote ref refs/pull/" "$err"; then fail failed "Pull request #$pull is not on $remote"; fi
      if grep -q "couldn't find remote ref" "$err"; then fail no_base "The base branch $base is not on $remote"; fi
      fail failed "$(tail_err)"
    fi
    fetched=1
  fi
else
  if [ "$pull" != 0 ]; then fail no_remote "Pull requests need a remote: this repo has none"; fi
  baseref="refs/heads/$base"
  if ! git rev-parse --verify --quiet "$baseref^{commit}" >/dev/null; then
    if [ -n "$asked" ]; then fail no_base "The base branch $base is not in this repo"; fi
    fail no_remote "This repo has no remote, and no $base branch to compare with"
  fi
fi
if [ "$pull" != 0 ]; then
  head=$(git rev-parse --verify --quiet "$pullref^{commit}") || fail failed "Pull request #$pull has no head here"
fi
: >"$err"
mb=$(git merge-base "$baseref" "$head" 2>"$err")
shallow=$(git rev-parse --is-shallow-repository 2>/dev/null || echo false)
if [ -n "$mb" ] && [ "$shallow" = true ] && grep -qxF "$mb" "$(git rev-parse --git-path shallow)" 2>/dev/null; then mb=; fi
if [ -z "$mb" ]; then
  if [ "$shallow" = true ]; then fail shallow "This is a shallow clone, and $base is not reached from here"; fi
  fail no_common_ancestor "No common ancestor with $base"
fi
commits=$(git rev-list --count "$mb..$head")
: >"$err"
if ! git --no-optional-locks -c core.quotepath=off diff -M --no-ext-diff --no-textconv --no-color --raw --numstat --no-abbrev -z "$mb" "$head" >"$work/list" 2>"$err"; then
  fail failed "$(tail_err)"
fi
if [ "$(wc -c <"$work/list")" -gt "$limit" ]; then fail too_big "More changes than can be listed"; fi
tr '\\0' '\\n' <"$work/list" | sed -nE 's/^:[0-7]+ [0-7]+ ([0-9a-f]+) ([0-9a-f]+) [A-Z][0-9]*$/\\1\\n\\2/p' | { grep -v '^0*$' || true; } | sort -u \\
  | git cat-file --batch-check='%(objectname) %(objectsize)' >"$work/sizes" 2>"$err" || fail failed "$(tail_err)"
field remote "$remote"
field branch "$branch"
field head "$head"
field mergebase "$mb"
field commits "$commits"
field fetched "$fetched"
{ printf 'list\\t'; b64 <"$work/list"; printf '\\n'; }
{ printf 'sizes\\t'; b64 <"$work/sizes"; printf '\\n'; }
printf 'ok\\n'
exit 0
`;

/** A changed file of a Comparison as the Container's git lists it. */
export type ContainerComparisonFile = ContainerChange & {
  /** The blob ids of the two sides, null where there is none (an addition has no old side). */
  readonly oldId: string | null;
  readonly newId: string | null;
  /** The sizes of the two sides in bytes, null where unknown or there is none. */
  readonly newBytes: number | null;
};

/** What `comparisonScript` made. */
export type ContainerComparison = {
  readonly remote: string | null;
  readonly base: string;
  /** The branch's name; null for a detached HEAD. */
  readonly branch: string | null;
  readonly head: string;
  readonly mergeBase: string;
  readonly commits: number;
  /** The base was fetched by this run. */
  readonly fetched: boolean;
  readonly files: ReadonlyArray<ContainerComparisonFile>;
};

export type ContainerComparisonErrorKind =
  | "no_remote"
  | "no_base"
  | "no_common_ancestor"
  | "shallow"
  | "too_big"
  | "failed";

/** The outcome of `comparisonScript`: the Comparison, or why there is none (with the base, if it was chosen). */
export type ParsedComparison =
  | { readonly ok: true; readonly comparison: ContainerComparison }
  | {
      readonly ok: false;
      readonly kind: ContainerComparisonErrorKind;
      readonly message: string;
      readonly base?: string;
    };

const decoder = new TextDecoder();

const textOf = (value: string): string => decoder.decode(bytesOf(value));

const ERROR_KINDS: readonly ContainerComparisonErrorKind[] = [
  "no_remote",
  "no_base",
  "no_common_ancestor",
  "shallow",
  "too_big",
  "failed",
];

/** The error kind the script printed, `failed` for one this code does not know. */
const kindOf = (printed: string): ContainerComparisonErrorKind =>
  ERROR_KINDS.find((kind) => kind === printed) ?? "failed";

const isZeroId = (id: string): boolean => /^0+$/.test(id);

type RawRecord = {
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldId: string;
  readonly newId: string;
  readonly letter: string;
  readonly path: string;
  readonly oldPath?: string;
};

/**
 * The records of `git diff --raw --numstat -z`'s field stream: the raw ones (`:<modes> <ids> <status>`, then the path, or
 * for a rename both paths), then the numstat ones, which `numstatCounts` reads.
 */
type SplitList = { readonly raw: RawRecord[]; readonly numstat: readonly string[] };

const splitList = (fields: readonly string[]): SplitList => {
  const raw: RawRecord[] = [];
  let at = 0;

  while ((fields[at] ?? "").startsWith(":")) {
    const meta = (fields[at++] ?? "").slice(1).split(" ");
    const [oldMode = "", newMode = "", oldId = "", newId = "", status = ""] = meta;
    const letter = status.charAt(0);

    if (letter === "R" || letter === "C") {
      const oldPath = fields[at++] ?? "";
      const path = fields[at++] ?? "";

      raw.push({ oldMode, newMode, oldId, newId, letter, path, oldPath });
    } else {
      raw.push({ oldMode, newMode, oldId, newId, letter, path: fields[at++] ?? "" });
    }
  }

  return { raw, numstat: fields.slice(at) };
};

const GITLINK = "160000";

/** The files of `list` (base64 `--raw --numstat -z`), with the blob sizes (base64 `cat-file --batch-check`). */
const filesOf = (list: string, sizes: string): ContainerComparisonFile[] => {
  const { raw, numstat } = splitList(fieldsOf(list));
  const counts: Counts[] = numstatCounts(numstat);
  const sized = blobSizes(sizes);

  return raw.map((record, index) => {
    const { additions = null, deletions = null } = counts[index] ?? {};
    const status = statusOf(record.letter);
    const oldId = isZeroId(record.oldId) ? null : record.oldId;
    const newId = isZeroId(record.newId) ? null : record.newId;

    const file: ContainerComparisonFile = {
      path: record.path,
      status,
      additions,
      deletions,
      // numstat's `-`, and a submodule's pointer, which has no text to show.
      binary:
        (counts[index] !== undefined && additions === null) ||
        record.oldMode === GITLINK ||
        record.newMode === GITLINK,
      oldBytes: status === "added" || oldId === null ? null : (sized.get(oldId) ?? null),
      oldId,
      newId,
      newBytes: status === "deleted" || newId === null ? null : (sized.get(newId) ?? null),
    };

    return record.letter === "R" && record.oldPath !== undefined
      ? { ...file, oldPath: record.oldPath }
      : file;
  });
};

/**
 * What `comparisonScript` printed. Output that stops short (the script was cut off) is an error, so nothing unread passes
 * for "nothing to compare".
 */
export const parseComparison = (stdout: string): ParsedComparison => {
  const fields = new Map<string, string>();
  let base: string | undefined;

  const failed = (kind: ContainerComparisonErrorKind, message: string): ParsedComparison =>
    base === undefined ? { ok: false, kind, message } : { ok: false, kind, message, base };

  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    const key = parts[0] ?? "";

    if (key === "error") {
      const kind = parts[1] ?? "";

      return failed(kindOf(kind), textOf(parts[2] ?? "").trim() || "git failed");
    }

    if (key === "ok") {
      const need = (name: string) => fields.get(name);
      const mergeBase = textOf(need("mergebase") ?? "");
      const head = textOf(need("head") ?? "");
      const commits = Number(textOf(need("commits") ?? ""));

      if (
        base === undefined ||
        mergeBase === "" ||
        head === "" ||
        !Number.isInteger(commits) ||
        need("list") === undefined
      ) {
        return failed("failed", "The Container's comparison stopped short");
      }

      const branch = textOf(need("branch") ?? "");
      const remote = textOf(need("remote") ?? "");

      return {
        ok: true,
        comparison: {
          remote: remote === "" ? null : remote,
          base,
          branch: branch === "" ? null : branch,
          head,
          mergeBase,
          commits,
          fetched: textOf(need("fetched") ?? "") === "1",
          files: filesOf(need("list") ?? "", need("sizes") ?? ""),
        },
      };
    }

    if (key === "base") base = textOf(parts[1] ?? "");
    else if (parts.length >= 2 && key !== "") fields.set(key, parts[1] ?? "");
  }

  return failed("failed", "The Container's comparison stopped short");
};

/** The blob ids a script may be asked for: 40 or 64 hex digits. */
const BLOB_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * The bash script that deletes the hidden refs `refs/cloudpid/pr/<number>` of `numbers` in the repo `repo` (pull requests
 * no longer open) with `git update-ref -d`, and nothing else: no fetch, no `gc`, the objects stay.
 */
export const dropPullRefsScript = (
  repo: string,
  numbers: ReadonlyArray<number>,
  root: string = WORKSPACE_ROOT,
): string => {
  if (!numbers.every(isPullNumber)) throw new Error("Not pull request numbers to drop");

  return `set -u
dir=${shellQuote(`${root}/${repo}`)}
drop=${shellQuote(numbers.join(" "))}
cd "$dir" 2>/dev/null || exit 0
for n in $drop; do git update-ref -d "${PULL_REF_PREFIX}$n" 2>/dev/null || true; done
exit 0
`;
};

/**
 * The bash script that reads the blobs `ids` of the repo `repo` with `git cat-file`: per id a `blob` line with its size
 * and, unless it is over `maxBytes`, its bytes (base64), or a `missing` line. The fallback for a Comparison's contents
 * when the Workspace DO cannot read them itself.
 */
export const blobsScript = (
  repo: string,
  ids: ReadonlyArray<string>,
  maxBytes: number,
  root: string = WORKSPACE_ROOT,
): string => {
  for (const id of ids) {
    if (!BLOB_ID.test(id)) throw new Error(`Not a blob id: ${id}`);
  }

  return `set -u -o pipefail
dir=${shellQuote(`${root}/${repo}`)}
ids=(${ids.join(" ")})
if [ "\${#ids[@]}" -gt 0 ]; then
  # One \`cat-file --batch\` for all: a header line (\`<id> blob <size>\`, or \`<id> missing\`), then the size bytes and a newline.
  printf '%s\\n' "\${ids[@]}" | git -C "$dir" cat-file --batch 2>/dev/null | while IFS=' ' read -r id type size; do
    if [ "$type" = missing ]; then
      printf 'missing\\t%s\\n' "$id"
    elif [ "$type" = blob ] && [ "$size" -le ${maxBytes} ]; then
      printf 'blob\\t%s\\t%s\\t%s\\n' "$id" "$size" "$(head -c "$size" | base64 | tr -d '\\n')"
      read -r _
    else
      # Whenever a size is printed its bytes follow, whatever the object is: read them, or the next header is lost.
      head -c "$size" >/dev/null
      read -r _
      if [ "$type" = blob ]; then printf 'blob\\t%s\\t%s\\t\\n' "$id" "$size"; else printf 'missing\\t%s\\n' "$id"; fi
    fi
  done
fi
exit 0
`;
};

/** A blob as `blobsScript` printed it: its size and bytes (absent over the limit). */
export type ContainerBlob = { readonly bytes: number; readonly blob?: Uint8Array };

/** What `blobsScript` printed, by blob id; an id it could not read is absent. */
export const parseBlobs = (stdout: string): Map<string, ContainerBlob> => {
  const blobs = new Map<string, ContainerBlob>();

  for (const line of stdout.split("\n")) {
    const [key, id = "", size = "", data = ""] = line.split("\t");

    if (key !== "blob" || !/^\d+$/.test(size)) continue;

    blobs.set(
      id,
      data === "" && Number(size) > 0
        ? { bytes: Number(size) }
        : { bytes: Number(size), blob: bytesOf(data) },
    );
  }

  return blobs;
};
