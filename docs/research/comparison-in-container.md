# How the Container computes a Comparison without touching the shared tree

Ticket: #103 (map #99). Question: get a Comparison's diff (current branch against its base, or an open PR) in the Container without disturbing the Workspace's working tree, index or checked-out branch ([ADR-0006](../adr/0006-shared-workspace-tree.md)).

Method: git's manual (git-scm.com/docs), the `gh` manual (cli.github.com/manual), GitHub's REST and Docs pages, plus experiments in the Container (git 2.56.0, gh 2.102.0) against a blobless clone of the public `cli/cli` and a scratch local repo under `/tmp`. Claims marked **(measured)** come from those runs, not from a manual.

## Answer and recommendation

1. **Fetch into a private ref namespace, never into `refs/heads`, `refs/remotes` or the index.** Run, in the repo directory:
   `git fetch --no-write-fetch-head --no-auto-maintenance --no-tags origin '+refs/heads/<default>:refs/cloudpid/base' '+refs/pull/<n>/head:refs/cloudpid/pr/<n>'`.
   A fetch writes only objects and the refs it is told to; it does not read or write the index or working tree (measured: `.git/index` mtime/size and `git status` unchanged). `refs/pull/<n>/head` exists on the base repo for fork PRs too (measured: a fork PR fetched fine), so no fork remote or `gh pr checkout` is needed.
2. **Compute with `git diff -M <base>...<head>` between two commit-ish refs.** `A...B` is `git diff $(git merge-base A B) B`, and a commit-to-commit diff reads only the object database, so it is safe to run while other Sessions use the tree. Never use `gh pr checkout`, `git checkout`/`switch`, `git merge`, or a `git diff` without a commit range for this (they touch HEAD, index or tree).
3. **Hand the browser a file list plus per-file patches**, fetched lazily: one `git diff --raw/--numstat -z -M` call for the file list and stats, then `git diff -M base...head -- <path>` (for a rename, both paths) per file when it is opened. Old/new content pairs (`git cat-file --batch` on `<sha>:<path>`, blob SHAs from `--raw`) are the fallback if `@pierre/diffs` wants file contents rather than patches (the choice is for the library ticket; both data paths are cheap).
4. **The branch Comparison is commits only** (`base...HEAD` of the current branch's tip, resolved to a SHA). Uncommitted Changes already have their own surface (Changes); mixing them in would make the Comparison depend on tree state that other Sessions mutate. A PR Comparison is by definition commits only.
5. **Resolve the PR's base by merge-base, not by GitHub's `baseRefOid`.** Use `gh pr list --json` for the picker and `number`/`headRefOid` as identity; compute the merge-base locally. (Measured: for several of 30 open PRs `baseRefOid` was neither the merge-base nor the current base tip.)
6. **Cost is small once the Container is up**: measured blobless clone of `cli/cli` 1.1 s, a fetch of the base branch plus one PR head 0.2–0.4 s, `numstat` + patch 0.3 s. The dominant cost is the Container's cold start (about 10 s on Cloudflare plus bootstrap, per `docs/spec.md` → _Backends_ and _Container and Toolchains_; about 2 s when restored from a snapshot).

## Findings

### 1. Fetching without disturbing other Sessions

- `git fetch <repository> <refspec>…`: a `+<src>:<dst>` refspec updates only `<dst>`; `refs/cloudpid/*` is outside `refs/heads` and `refs/remotes`, so no checked-out branch, `origin/*` tracking ref or tag list changes ([git-fetch](https://git-scm.com/docs/git-fetch)).
- `--no-write-fetch-head`: "tells Git not to write the file" `FETCH_HEAD` ([git-fetch](https://git-scm.com/docs/git-fetch)). Measured: no `FETCH_HEAD` appeared. Without it a concurrent Session's `git merge FETCH_HEAD` could read our fetch's `FETCH_HEAD`.
- `--no-auto-maintenance` (`--no-auto-gc`): by default fetch runs `git maintenance run --auto` at the end ([git-fetch](https://git-scm.com/docs/git-fetch)); turn it off so a Comparison never triggers a repack under a running Session. `--no-tags` avoids adding tags to the shared repo (same page).
- GitHub's PR refs: `git fetch origin pull/ID/head:BRANCH_NAME` is GitHub's documented way to get a PR's head, and the `refs/pull/` namespace is read-only on the remote ([GitHub Docs: Checking out pull requests locally](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/checking-out-pull-requests-locally)). Measured: `git ls-remote origin refs/pull/14783/head` equalled the PR's `headRefOid`, and that PR came from a fork (`isCrossRepository: true`). `refs/pull/<n>/merge` also exists (GitHub's test merge) but is not the PR's own diff; do not use it.
- Default branch: `git ls-remote --symref origin HEAD` prints `ref: refs/heads/trunk	HEAD` (measured; [git-ls-remote](https://git-scm.com/docs/git-ls-remote)), or `gh repo view --json defaultBranchRef` (measured: `trunk`). The first needs no GitHub API call and also works for non-GitHub remotes.
- Partial clone: `git fetch --filter=blob:none` requests only a subset of objects ([git-fetch](https://git-scm.com/docs/git-fetch)). In a blobless clone `git diff` lazy-fetches the blobs it needs (measured, fine for a 4–25 file PR). `--no-lazy-fetch` and `--no-optional-locks` are documented global options ([git](https://git-scm.com/docs/git)); pass the latter to read-only commands (`status`) so they do not opportunistically write the index.
- Auth: the Container's git credential helper already reads `$GITHUB_TOKEN` for `https://github.com`, and `gh` reads `GH_TOKEN`/`GITHUB_TOKEN` ([gh environment](https://cli.github.com/manual/gh_help_environment); `docs/spec.md` → _Git_), so fetch and `gh pr list` need nothing new for repos the token can read. Not tested with a private repo.

### 2. The diff: `base...head`, with renames

- "`git diff A...B` is equivalent to `git diff $(git merge-base A B) B`" and shows the changes "on the branch containing and up to the second commit, starting at a common ancestor" ([git-diff](https://git-scm.com/docs/git-diff)). `git merge-base` notes there can be more than one merge base ([git-merge-base](https://git-scm.com/docs/git-merge-base)).
- Measured on a scratch repo where `main` advanced after `feat` forked: `main..feat` showed main's later change as a reversal (an extra deletion); `main...feat` showed only the branch's changes. Use three dots.
- Rename detection: `-M[<n>]`/`--find-renames[=<n>]` ([diff-options](https://git-scm.com/docs/diff-options)); pass `-M` explicitly so it never depends on config. Measured: `R097 r.txt renamed.txt`, and the patch carries `similarity index 97%`, `rename from`, `rename to`.
- Machine-readable listing: `--raw`, `--numstat`, `--name-status` with `-z` give NUL-terminated, unquoted paths ([diff-options](https://git-scm.com/docs/diff-options), `-z`). Measured forms: `--name-status -z`: `R097\0old\0new\0`; `--numstat -z`: `1\t0\t\0old\0new\0` for a rename (empty path field, then the two paths) and `-\t-\tpath` for a binary file; `--raw -z --abbrev=40`: `:100644 100644 <old sha> <new sha> R097\0old\0new\0`, which gives both blob SHAs for content pairs.
- Hardening for untrusted repos: `--no-ext-diff` and `--no-textconv` disable external diff drivers and textconv filters ([diff-options](https://git-scm.com/docs/diff-options)); add `--no-color`.

### 3. Listing open PRs and their base/head SHAs

- `gh pr list` shows open PRs by default, with `--state`, `--base`, `--head`, `--author`, `--search`, `--limit` (default 30), `--json fields`, `--jq`, and `-R [HOST/]OWNER/REPO` ([gh pr list](https://cli.github.com/manual/gh_pr_list)). `--head` does not support `<owner>:<branch>`.
- JSON fields a picker needs, all in the manual's field list and verified: `number`, `title`, `author` (`login`), `isDraft`, `baseRefName`, `headRefName`, `headRefOid`, `baseRefOid`, `isCrossRepository`, `headRepositoryOwner`, `headRepository`, `updatedAt`, `changedFiles`, `additions`, `deletions`, `url`. One call returned them. Avoid `files`, `commits`, `statusCheckRollup` and `reviews` in the list call (heavier).
- `gh pr view <n> --json baseRefOid,headRefOid,isCrossRepository,mergeable,state` and REST `GET /repos/{owner}/{repo}/pulls/{n}` (`base.sha`, `head.sha`, `changed_files`, `additions`, `deletions`, `mergeable`; [REST pulls](https://docs.github.com/en/rest/pulls/pulls)) both give SHAs (they agreed in the experiment). For PR 14783 the local `--numstat` totals (1297 added, 22 deleted, 4 files) matched `gh pr list`.
- **Caveat (measured, undocumented):** `baseRefOid`/`base.sha` is not the live base tip; across 30 open `cli/cli` PRs, many matched `git merge-base` but others did not, and none equalled the current base tip. Treat it as a hint and run `git merge-base refs/cloudpid/base <head>` locally.
- REST alternative with no local fetch: `GET /repos/{o}/{r}/compare/{base}...{head}` returns `merge_base_commit`, `ahead_by`, `behind_by`, `status` and `files[]`, but JSON files are paginated up to 3000, "Larger diffs may time out and return a 5xx", and binary files have no `patch` ([REST compare](https://docs.github.com/en/rest/commits/commits#compare-two-commits)). Good as a cheap probe, not as the source of the diff. `gh pr diff <n> [--patch] [--name-only] [--exclude glob]` ([gh pr diff](https://cli.github.com/manual/gh_pr_diff)) returns the whole diff over the network; the local diff supersedes it.

### 4. Output form for the browser and `@pierre/diffs`

| Form | How | Pro | Con |
| --- | --- | --- | --- |
| One unified patch | `git diff -M base...head` | one call, cacheable by `(baseSha, headSha)` | whole diff in memory (a 25-file PR was 77 KB; big ones can be MBs); cannot page |
| **List + per-file patch** | `--raw`/`--numstat -z` once, then `-- <path>` per file | cheap first paint, natural paging and virtualization, per-file caps | N calls; a rename needs both paths |
| Old/new content pairs | `git cat-file --batch` on `<sha>:<path>` from `--raw` | gives the library full files (context expansion, highlighting of both sides) | two blobs per file; size-gate first with `--batch-check` (type and size, no content; [git-cat-file](https://git-scm.com/docs/git-cat-file)) |

Recommendation: file list first, then a per-file patch for files under a byte cap, and content pairs only if `@pierre/diffs` needs full files. Whether it takes patches or contents is for the library ticket.

- **Cap and page:** `--numstat` gives line counts (`-`/`-` for binary) before any patch is produced; use them to collapse up front. Cap a per-file patch by bytes and offer "load anyway". Paging is by file; git has no hunk-level paging. `-U<n>` bounds context. Thresholds belong to the "big and noisy diffs" topic.
- **Binary files:** default patch is `Binary files a/bin.dat and b/bin.dat differ` (measured); `--numstat` prints two `-` ([diff-options](https://git-scm.com/docs/diff-options)); `--binary` would emit an applyable binary patch, which a viewer does not need. Show a "binary, N→M bytes" row from `--raw` plus `cat-file -s`.
- Status letters (`A`, `D`, `M`, `R`, `C`, `T`, `U`) are in `--raw`/`--name-status` ([diff-options](https://git-scm.com/docs/diff-options), `--diff-filter`); submodule changes appear as `Subproject commit` and should be collapsed.

### 5. Uncommitted changes in a branch Comparison

Recommend commits only. `git diff <merge-base>` (one commit, no `...`) diffs the working tree against that commit, including staged and unstaged changes of tracked files (measured: `added.txt | 3 +++` against 1 for commits only), but not untracked files (measured), and it reads the shared tree and index, which other Sessions change mid-flight (ADR-0006), so the same Comparison would differ between views. Changes already cover the working tree against HEAD. If a later ticket wants "branch plus dirty", show it as stacked sections.

### 6. Cost

Measured (public repo, blobless): clone 1.1 s; one `git fetch` of two refs 0.2–0.4 s; `--numstat` plus patch 0.3 s; a PR with 25 files and 1972 additions gave a 77 KB patch. Not measured: a private or very large repo's first fetch, the Container's cold start on Cloudflare (about 10 s; `docs/spec.md`), and fetches on the FUSE-synced `/workspace`: objects a fetch writes under `.git/objects` are synced files that computer pushes to the Workspace DO, so a fetch grows the DO's storage unless `.git/objects` is ignored (it is not in `TOOLCHAIN_IGNORE` today).

### 7. Failure modes (measured unless noted)

| Situation | What happens | Handling |
| --- | --- | --- |
| No remote | `git fetch origin` → `fatal: 'origin' does not appear to be a git repository`; `gh pr list` → `no git remotes found` | Branch Comparison against a local base still works with `merge-base`/`diff` on local refs; PR picker unavailable. Read `git remote` first; the remote may not be `origin`. |
| Detached HEAD | `git rev-parse --abbrev-ref HEAD` prints `HEAD`; `git diff main...HEAD` still works | Use the SHA as head and label it "detached at `<sha7>`". |
| Unknown PR or branch | `fatal: couldn't find remote ref …`, exit 128, no partial update | Show "PR gone"; refresh the picker. |
| Fork PR | works via `refs/pull/<n>/head` on the base repo | `isCrossRepository` can label it. A PR whose fork was deleted: untested. |
| Bad or missing token | `gh`: `HTTP 401: Bad credentials`; git on a private repo fails with an auth error (not tested) | Report "not authorised"; the Workspace DO already redacts the token. |
| Shallow clone | `git merge-base` may find no or a wrong base ([git-fetch](https://git-scm.com/docs/git-fetch) `--deepen`/`--unshallow`) | Check `git rev-parse --is-shallow-repository`; deepen or say the base is unknown. Not tested. |
| Unrelated histories | `git merge-base` exits 1 with no output (git-merge-base) | "No common ancestor". |
| Default branch not `main` | e.g. `trunk` | Resolve with `ls-remote --symref`. |
| Concurrent git | a fetch locks only the refs it updates; a commit-to-commit diff never takes `index.lock` (inferred, not stress-tested) | `--no-optional-locks` on read-only commands; retry once on `cannot lock ref`. |

## Open questions

- **Private repos:** confirm that the Container's credential helper lets `git fetch` and `gh pr list -R` read private repos with the deployed `CLOUDPID_GITHUB_TOKEN`; the experiments ran unauthenticated against a public repo.
- **Where the refs and objects live:** `refs/cloudpid/*` and fetched objects land in the repo's `.git` on the synced `/workspace` (DO storage growth, see Cost). Alternatives (a scratch object store under `/tmp` via `objects/info/alternates`, or ignoring `.git/objects`) are untested.
- **Patches vs content pairs** for `@pierre/diffs`: depends on the library's input; answered in the library ticket.
- **Cache key and refresh:** `(baseSha, headSha)` is a natural immutable key; when to re-fetch (open, manual refresh, after an agent push) is a UX decision.
- **Large-diff limits** (bytes per file, files per Comparison) and how a force-pushed PR head is flagged for Annotations on lines that no longer exist: left to the big/noisy-diff and Annotation topics.
- **Non-GitHub remotes:** `gh` and `refs/pull/*` are GitHub-only; the branch Comparison works for any remote, the PR picker does not.
