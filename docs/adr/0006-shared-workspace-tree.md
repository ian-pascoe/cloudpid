# Sessions on a Workspace share one working tree

All Sessions bound to a Workspace, and all their subagents, read and write the same `/workspace` tree, including git branch and index state. This matches how several local pi sessions share a directory. The known hazard is accepted: one Session's `git checkout`, `stash`, `rebase`, or `reset` changes the tree under every other Session, and concurrent git commands can contend for `.git/index.lock`. Keeping parallel work apart is left to the user.

## Considered Options

- **Optional or mandatory git worktree per Session.** Isolated branches and indexes, at the cost of merge workflow and UI.
- **One Workspace per Session.** Full isolation, but duplicate clones, Toolchains, and Containers.
