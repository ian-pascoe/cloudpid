# Can the Workspace DO compute Changes without the Container?

Research for issue #102 (wayfinder map #99, "Diff viewing and Reviews with @pierre/diffs"). Versions: `@cloudflare/computer` 0.5.1 (pinned `^0.5.1` in `apps/server/package.json`, locked to 0.5.1 in `pnpm-lock.yaml`), which bundles **isomorphic-git 1.40.0** (`dist/shared-C-jXUzC6.js`: `version: "1.40.0"`); real git 2.56.0 for comparisons. Repo state: `origin/main` at 3c3ab8b.

## Answer

**Yes, with a size guard and a Container fallback.** The Workspace DO can list the changed paths and hand the browser each path's HEAD blob and working-tree bytes, which is exactly what a before/after diff viewer needs. Recommendation: **Worker Shell first, Container fallback.**

1. **Worker Shell path (default).** The Workspace DO calls isomorphic-git itself (not computer's `git.status()`/`diff()`): `statusMatrix({ refresh: false })` for the list, `readBlob` for each HEAD side, a plain file read for the working side. It must pass `refresh: false`: the default (`true`, and what computer's `status`/`diff`/`diffSummary`/`git status` use) **rewrites `.git/index`**, the file the Container's real git shares. Use it when the repo is small enough (see _Conditions_).
2. **Container path (fallback, and for anything the Worker Shell path cannot be trusted with).** One command on a throwaway copy of the index, so the shared index is never written: `GIT_INDEX_FILE=<tmp> ; cp .git/index $GIT_INDEX_FILE; git add -N .; git diff HEAD -M …`. Cost: the cold start (about 10–14 s, about 2 s when restored from a snapshot; `docs/spec.md` → _Container and Toolchains_) plus the command.
3. **Conditions for falling back:** more than about 5,000 tracked files (the index header holds the count), packfiles over the existing 16 MB cap, a partial or otherwise unreadable repository, any isomorphic-git error, or a `.gitattributes` the Worker Shell path cannot honour (below). The 16 MB pack cap alone is **not** enough of a guard: file count is what exhausts memory.

What the Worker Shell path gets wrong against `git diff HEAD` is small for annotating (which needs text pairs): renames (shown as delete + add), mode-only changes (invisible), gitlink/submodule changes (invisible), and `.gitattributes`-driven line-ending/binary rules (ignored). All can be handled client-side or by the fallback; none corrupt a text pair.

## Findings

### 1. What the Workspace DO can produce

- The DO owns the files: `ComputerWorkspace` (`apps/server/src/workspace/Workspace.ts`) keeps `/workspace`, `.git` included, in DO SQLite; the Worker Shell and the Container see the same tree through computer's sync (`docs/spec.md` → _Backends_). computer exposes `workspace.provider()` ("the underlying dofs `SQLiteWorkspaceProvider` … a node:fs surface", `@cloudflare/computer@0.5.1` `dist/index.d.ts`, `get provider` doc comment) and a typed `workspace.git` client (`dist/shared-BTtKnEVB.d.ts`: `status`, `diff`, `diffSummary`, `catFile`, `lsFiles`, `lsTree`, …).
- The typed client does not expose `statusMatrix`, only `status()`, which flattens it into `StatusEntry { path, index, worktree }`, with a staged column that is wrong when the index holds staged entries (`dist/git.js` `statusWith`/`indexCode`; `docs/spec.md` → _Known risks_). `diff()`/`diffSummary()` (`collectDiffEntries`, `dist/git.js`) decode both sides as lossy UTF-8 text and make a patch with the `diff` package, so a binary file becomes garbage text, and an unborn HEAD returns `[]` (`resolveRef` failure is swallowed), though git treats everything as untracked.
- **Therefore build on isomorphic-git directly** (add `isomorphic-git@1.40.0` to `apps/server`, matching computer's bundle, plus the same `@platformatic/vfs` glue computer uses: `workspaceIsomorphicGitClient` in `dist/git.js`). `statusMatrix` → `[path, head, workdir, stage]`; `head !== workdir` is the same set as `git diff HEAD --name-status` (isomorphic-git docs: https://isomorphic-git.org/docs/en/statusMatrix). HEAD side: `readBlob({ oid: headOid, filepath })`; working side: a file read.
- Staged vs unstaged does not matter for `git diff HEAD` (HEAD against the working tree). Checked: `staged.txt` with a staged and an unstaged edit appears once, as `[ "staged.txt", 1, 2, 3 ]`; HEAD against working tree is the right pair.

### 2. What it gets wrong against `git diff HEAD`

Experiment: scratch repo `/tmp/exp` (script in the research session; recreate with the steps listed), isomorphic-git 1.40.0 on Node `fs`, real git 2.56.0. computer uses the same code over a different `fs`.

| Case | Real git | isomorphic-git 1.40.0 | Consequence |
| --- | --- | --- | --- |
| Content edit, delete, untracked file, new dir | listed (untracked via `ls-files --others`) | listed (`[…,0,2,0]` per file, untracked one by one) | Same set. Untracked files are listed one by one rather than as `dir/`; fine for Changes. |
| Rename (`git mv`, unstaged) | `-M` pairs them (`diff.renames` default) | delete + untracked add | Pair client-side by blob id or similarity, or accept two entries. |
| Mode change (`chmod +x`) | `mode change 100644 => 100755` | **absent from the matrix** (only oids compared) | Invisible; harmless for annotation. |
| Binary | `Bin 2000 -> 2000 bytes` | listed as changed; bytes are available | Detect binary client-side (git's rule: a NUL in the first 8000 bytes). |
| Symlink retarget | `120000` change | listed as changed (`readlink` content) | Fine. |
| Submodule (gitlink) pointer moved | `Subproject commit a..b` | **invisible** (`commit` type rows return `null`; matrix showed only `.gitmodules`) | Missed; the fallback or a note. |
| Nested repo (untracked dir with `.git`) | `nestedrepo/` as one entry | lists the files inside | Minor. |
| `core.autocrlf=true`, CRLF working file | no diff | honoured (`autocrlf` is read in `content()`; `[1,1,1]`) | Same. |
| `.gitattributes` (`eol=lf`, `text`, `binary`, filters, LFS) | normalises on compare: working CRLF vs LF HEAD gave **no diff** | **not read** (no `gitattributes` in the source); same file reported changed | False positive for a CRLF-vs-LF difference under `eol=lf`. Fall back, or normalise client-side when the repo has a `.gitattributes`. |
| `.gitignore`, `.git/info/exclude`, nested `.gitignore` incl. negation | honoured | honoured (all matched git in the test) | Same. |
| `core.excludesFile` (global ignore) | honoured | **not honoured** (`glob.txt` shown) | Container's global git config sets only a credential helper, so no global excludes exist in practice. |
| Tracked file under `TOOLCHAIN_IGNORE` (e.g. a committed `target/…`) | present | `[1,0,1]` = deleted, because the Worker Shell's tree does not hold ignored paths (`docs/spec.md` → _Known risks_) | Drop rows with `workdir === 0` whose path matches `TOOLCHAIN_IGNORE` (`apps/sandbox-image/src/toolchains.ts`). |
| No commits yet | `git diff HEAD` fails (everything untracked) | matrix works (all `[0,2,0]`) | Fine with direct `statusMatrix`; computer's `diff()` returns `[]`. |
| Partial / `--filter` clone | blobs fetched on demand | not tested (the scratch clone failed: shallow source) | Treat as fallback. |

**The default `refresh: true` writes `.git/index`.** isomorphic-git's `statusMatrix` default `refresh = true` ("when false, do not refresh the `.git/index` stat cache for files whose contents still match the staged blob. The call becomes read-only with respect to the index, at the cost of recomputing the SHA1 on subsequent calls": isomorphic-git docs, statusMatrix). Measured: after `touch`ing tracked files, the default call changed `.git/index` (sha1 `e371…` → `711c…`) and `refresh: false` left it alone. computer's code calls `statusMatrix` without the flag (`dist/git.js` `statusWith` ~l.195, `collectDiffEntries` ~l.2456), so `git status`/`git diff` on the Worker Shell today can rewrite the index that the Container's real git also owns (isomorphic-git takes no `.git/index.lock`). Worth a line in _Known risks_.

### 3. Memory and time on the 128 MB DO

**Caveat: measured on Node 22 / V8 (`peakHeap` polled every 3 ms, scratch clone, every tracked file `touch`ed so isomorphic-git must hash each one, the worst case for index stat drift), not inside workerd.** DO numbers could differ; nothing here was run on the DO. The 128 MB limit is `docs/spec.md`'s figure for the Workspace DO; the DO's default CPU limit per request is 30 s (https://developers.cloudflare.com/durable-objects/platform/limits/).

| Repo (depth-1 clone) | Tracked files | `.git/objects/pack` | `statusMatrix` | Peak JS heap / ArrayBuffers | Result |
| --- | --- | --- | --- | --- | --- |
| cloudpid | 582 | 1.3 MB | 0.3 s | 19 MB / 9 MB | fine |
| colinhacks/zod | 742 | 7.4 MB | 0.2 s clean, 0.4 s all-stat-dirty | 18 MB / 15–39 MB | fine |
| facebook/react | 7,260 | 11 MB | 2.4–3.3 s | 97 MB / 23–45 MB; live set fits `--max-old-space-size=64`, **fails at 48** | tight on 128 MB |
| microsoft/TypeScript | 67,923 | 37 MB (over the cap) | 11 s clean, 25 s all-stat-dirty | 830 MB | dead; even `--max-old-space-size=128` aborted |

- Heap grows roughly with tracked file count (about 8–13 KB per file: the index, the HEAD tree walk and the workdir walk), not with pack size. React's pack is under the 16 MB cap yet 7k files already needs about 50–60 MB live heap on top of everything else the DO holds. So **file count needs its own guard**, about 5,000 tracked files, until measured in workerd.
- Pack memory: isomorphic-git reads the pack whole (`docs/spec.md` → _Known risks_); the ArrayBuffers column is consistent with that (zod's 7.4 MB pack gave up to 39 MB with a stat-drift run). The 16 MB cap holds for packs; full-history clones are usually much larger than the depth-1 packs measured here (only cloudpid's own full pack, 2.4 MB, was measured), so the cap will often send real clones to the Container.
- Stat drift is a cost multiplier. isomorphic-git trusts the index entry only if mtime, ctime, uid, gid, ino, mode and size equal the file's stat (`compareStats`, isomorphic-git 1.40.0 `index.js`); otherwise it reads and SHA-1s the file. The index is written by the Container's git, with the Container's inode/ctime values, and the DO's SQLite VFS reports its own stats, so after a Container commit/`git add` they likely differ for every file (the "touched" rows above). Not verified against computer's sync (open question 1). `refresh: false` keeps re-hashing each call; `refresh: true` would repair it but writes the shared index.
- Mitigation: pass `filepaths`/`filter` to narrow a call, or cache by index mtime.

### 4. The Container path

Measured with real git 2.56.0 on the TypeScript clone (67,923 files), warm disk:

| Command | Time | Notes |
| --- | --- | --- |
| `git diff HEAD --stat` after touching every file | 4.6–5.8 s | rehashes; **rewrites `.git/index`**, even with `GIT_OPTIONAL_LOCKS=0` (index sha1 changed) |
| same, index already refreshed | 0.13 s | |
| `git ls-files --others --exclude-standard` | 0.1 s | untracked list; honours `core.excludesFile` |
| `GIT_INDEX_FILE=<copy>; git add -N .; git diff HEAD -M` | 0.4 s (5.8 s the first time, all stat-dirty) | untracked files become `new file` entries in the patch; `.git/index` unchanged (sha1 identical before/after) |
| `-c diff.autoRefreshIndex=false diff HEAD` | leaves index alone | stat-only changes then count as changed in `--stat`'s file count (31 vs 2 files in the test), so prefer the private index |

- `git add -N` on the shared index is out (ticket and ADR-0006: shared index). A private copy via `GIT_INDEX_FILE` (https://git-scm.com/docs/git, Environment Variables) avoids it. Alternatives: `git diff --no-index -- /dev/null <file>` per untracked file (works; exit status 1 when different) or reading untracked files from the DO and diffing against empty in the browser (no Container needed for the content, only for the list).
- `git diff` refreshing the index is documented behaviour: `diff.autoRefreshIndex`, https://git-scm.com/docs/git-config (and see https://git-scm.com/docs/git-diff for `--raw`, `--numstat -z`, `-M`, `--binary`).
- Cost on top of the command: cold start about 10 s, 14 s with the bootstrap, about 2 s from a snapshot (`docs/spec.md`); computer pushes the DO's changes to the Container before the command and pulls after (`docs/spec.md` → _Backends_). Container output to `bash` is a stream; for the UI ask for `--raw -z` plus `--numstat -z` first (small), then fetch only patches/blob pairs for files the user opens, with a per-file byte cap, so lockfiles and generated files never travel whole. Real git also fixes renames, mode changes, gitlinks and `.gitattributes` for free.
- The Container cannot see what the DO has not synced yet, and the DO cannot see the Container's `TOOLCHAIN_IGNORE` paths; the Container path reads the true tree (including those tracked-but-ignored files), the Worker Shell path does not.

### 5. Recommendation, with conditions

**Worker Shell with a Container fallback.**

- Use the Worker Shell path when: repo has ≤ ~5,000 tracked files, packfiles ≤ 16 MB (existing `MAX_PACK_BYTES`), no `.gitattributes` with `text`/`eol`/`binary`/`filter`/`-diff` rules (or normalise client-side), and the user only needs text pairs. This is the common case for the repos an agent works in, answers in under a second for small ones, and never starts the Container.
- Use the Container when: any guard trips, isomorphic-git throws, or the user asks for a Comparison (needs `fetch`, outside this ticket).
- Either way, write the Worker Shell path with `refresh: false`, build the git view per call (as `workerShellGit` does, to avoid its cached index; see `apps/server/src/workspace/git.ts`), and filter `TOOLCHAIN_IGNORE`-matched deletions.
- The client should treat each file's pair as the source of truth for annotation (HEAD blob text, working text), detect binary and big files itself, and pair renames by blob id.

## Open questions

1. **Stat drift in the real DO.** Do the stats the DO reports for a file match what real git wrote into `.git/index` after a Container command (computer's sync of mtime/ctime/ino/uid/gid)? If not, every refresh hashes all tracked files. Needs a deployed measurement (or a workerd test with files real git wrote, like `bash.workerd.test.ts`).
2. **workerd memory and CPU.** The numbers above are Node/V8. A workerd test (or deployed run) at 1k, 3k, 5k, 7k files to set the file-count guard and see whether 5,000 is right.
3. **Writing tools mid-run.** Changes refresh after a writing tool call; a long-running Container command's writes only reach the DO when computer pulls after the command. Can Changes be stale while a Container command runs (a dev server rewriting files)?
4. **Index writes today.** computer's `git status`/`diff` on the Worker Shell use the default `refresh: true`. Should `workerShellGit` avoid it (needs upstream, or forking the call), given the shared index and the Container's real git?
5. **Partial/sparse clones, sha256 repos, linked worktrees, merge conflicts** (unmerged index stages) were not tested; `discoverGitdir` handles a `.git` file but the rest is unknown.
6. **`.gitattributes` policy.** Fall back whenever a `.gitattributes` exists, or normalise (`eol`, `binary`, `linguist-generated`) in the DO? The latter is also what the "Big and noisy diffs" map item will want.
7. **Full-history pack sizes** of the repos the owner actually clones, to know how often the 16 MB cap routes to the Container anyway.

## Reproducing

All in `/tmp` on the container backend: `npm pack @cloudflare/computer@0.5.1`; `npm i isomorphic-git@1.40.0`; a scratch repo with edit, delete, rename, `chmod +x`, binary, CRLF, `.gitattributes`, symlink, submodule, staged-plus-unstaged edits and ignored/untracked files compared through `git diff HEAD --raw`/`git status --short` and `statusMatrix`; `git clone --depth 1` of zod, react, TypeScript and cloudpid timed with a script that polls `process.memoryUsage()`.
