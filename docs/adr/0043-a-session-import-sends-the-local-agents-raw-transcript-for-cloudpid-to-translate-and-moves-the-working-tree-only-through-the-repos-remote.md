---
status: accepted (the extension is installed from the repo and follows `main`, no longer published after the deploy it targets: docs/architecture/mcp-endpoint.md → The `/cloudpid` command → Distribution)
---

# A Session import sends the Local agent's raw transcript for cloudpid to translate, and moves the working tree only through the Repo's remote

A Local agent (pi on the owner's machine) hands cloudpid a conversation and a working tree through the MCP endpoint. Its transcript format and the owner's machine are outside cloudpid, and the pi extension that sends them (`packages/pi-cloudpid`) is built from this repo but installed on the owner's machine apart from cloudpid's deploys. So the Local agent sends its active Session branch as it stands (the header line and that branch's entry lines, `format: pi-session-jsonl`) through the sliced import channel, and cloudpid translates it in deployed code. The translator holds pinned schemas for the pi extension state it maps (Todo List, Notes, the saved Handoff). It bounds entries by the caps live entries get. It counts what it cuts, drops or closes instead of failing, writes no system entries, and appends an import notice as the last entry. The working tree never travels as files. Local commits are pushed as the new Workspace's branch (fast-forward only). Uncommitted Changes, untracked files included and ignored files never, are pushed as one commit on HEAD to the `carry_ref` that `session_import_begin` returns, and the new Workspace's readying applies them as Carried Changes, uncommitted still, as it does for a Fork. An import never lands in an existing Workspace.

## Considered options

- **Translating on the laptop**: the laptop's code would duplicate cloudpid's entry model and be updated apart from it, so every change to pi-durable entries would need a pi update first.
- **Uploading the tree or a patch**: a second upload channel, plus size limits for files, to do what the remote and the Fork carry already do.
- **A `wip:` commit on the local branch**: it fails this repo's commitlint and pre-push hooks (so `--no-verify` on both), adds noise to the pull request's history, and shows the cloud agent as committed what its transcript calls uncommitted.
- **A summary-only import**: it loses tool results and reasoning. It is already possible as `session_start(text, branch)`.
- **The whole pi Session tree**: other branches are abandoned explorations nobody continues.

## Consequences

- There is one translator, tested in cloudpid against fixtures, including a live probe per provider that history calls to tools the request doesn't declare are accepted.
- `pi-session-jsonl` and the carry rule are contracts with laptop code. They change only additively, by a new `format` or through `carry_ref`. The extension follows `main`, so it can be ahead of the endpoint for the minutes between a merge and its deploy, and an older install can stay in use: either side must tolerate the other's version.
- The owner's local branch and index stay as they were. A confirm dialog offers to stash the carried Changes, and bringing work back is `git pull` on the same branch.
- Importing again onto a branch another Workspace holds is refused (`branch_taken`) until that Workspace is removed or another branch is named.
- Only the Repo the Local agent runs in carries its uncommitted Changes. The Environment's other Repos start from the branch on their remotes, else from their default branches.
- Imported turns count in neither Usage nor the Spend limit.
