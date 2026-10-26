---
status: accepted
---

# Diffs come from the Workspace DO; the Container only fetches

The web app shows three kinds of repo diff: **Changes** (a Workspace's uncommitted work against HEAD), **Comparisons** (a branch's or pull request's commits against where it left its base) and the **Run diff** (what the latest Run changed). Running `git diff` in the Container would be the obvious way to get them, and it would be exact. But the Container is the costly backend: it takes seconds to start, it is billed while it runs, and it stops when idle. Changes refresh by themselves after every writing call and whenever the page regains focus. If each refresh could start the Container, just looking at a Session would keep it running.

So the Workspace DO computes the diffs itself, from the files it holds and the git objects that sync into it. Changes use isomorphic-git's `statusMatrix({ refresh: false })`, which never writes the shared index, plus `readBlob` for HEAD. File contents for every source are read with `readBlob`. The Run diff's start and end copies are git objects, a tree and a commit under hidden `refs/cloudpid/runs/<conversation>/{start,end}`, written by the Workspace DO.

The Container does only what the Workspace DO cannot:

- `git fetch` into private `refs/cloudpid/*` refs, the merge-base and the file list for a Comparison;
- the fallback for Changes in repos isomorphic-git cannot handle well:
  - too many tracked files;
  - a pack over 16 MB;
  - `.gitattributes` `text`/`eol`/`binary`/`filter` rules;
  - an isomorphic-git error.

The fallback runs `git diff HEAD -M` on a private `GIT_INDEX_FILE`. Nothing automatic ever starts the Container: an automatic refresh that needs the fallback keeps the last result and marks it "may be out of date", and only the owner's Refresh starts it.

Each source sits behind one Workspace DO module that picks the backend inside it, so neither the Session DO nor the web app knows which one ran.

## Considered options

- **Always the Container.** Exact, including `-M` rename detection and attributes. Rejected because every view of a stopped Workspace would start it.
- **The browser computes the diffs.** It has no access to the tree or the objects, and every client would repeat the work.
- **A Run diff built from Call diffs** (Codex's way). It misses `bash` (formatters, codegen, `git mv`, branch switches), so it was rejected in favour of saved trees (T3 Code's way).

## Consequences

- Without the Container, renames are paired only when the contents are identical, so a renamed-and-edited file shows as a delete plus an add.
- Tracked files under Container-only paths are left out of Changes.
- The Workspace DO's 128 MB limits how big a repo it can diff itself. The guard is set by measurement.
- A Comparison's fetched objects and the Run copies grow the Workspace DO's synced storage. That is accepted.

Decided on the map "Diff viewing and Reviews with @pierre/diffs" (#99): #102, #103, #106, #107 and #220.
