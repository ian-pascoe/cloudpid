---
status: superseded by ADR-0016 (each Workspace has its own clones and Container, made from an Environment; worktrees and the shared Machine are gone)
---

# Workspaces are git worktrees on a shared Machine

Sessions on one repo need isolated branches and indexes so they can work at the same time. A Session's `git checkout`, `stash` or `reset` changed the tree under every other Session (ADR-0006). So the smallest unit a Session binds to is now a **Workspace**: one working tree of a Repo on one branch. It is either the Repo's main checkout or a git worktree that cloudpid manages, at `/workspace/.worktrees/<repo>/<id>` on branch `cloudpid/<id>`. What used to be called a Workspace (the slug, the file tree at `/workspace`, its Container, Toolchains, Snapshot and Container settings) is now a **Machine**. A Machine holds Repos, and every Workspace of a Repo shares its Machine.

Starting a Session on a Repo makes a new Workspace by default. Its worktree is made lazily, on the Machine's Container, when the Session first uses its environment, and the Setup Script runs in it. The same step remakes a worktree that was removed, from the Workspace's branch. Removing a Workspace keeps its branch. Worktrees share the Repo's `.git`, so branches are visible across Workspaces with no push in between. They also share the Container's pnpm store and Toolchains, so a new Workspace is ready in seconds rather than a cold Container's minute.

The Durable Object class stays `Workspace`: it is `@cloudflare/computer`'s Workspace, a deployed class name, and now hosts a Machine. The Registry's SQL table also keeps its old name, `workspaces`, for Machines.

## Considered Options

- **A Machine (Container and clone) per Workspace.** This isolates processes and ports as well. But every branch would cost a cold Container start, a multi-GB Snapshot, a separate synced copy of the tree, and a clone with no shared objects. It can come later as an option for one Workspace.
- **Keep one shared tree (ADR-0006)** and leave isolation to the owner. That is what made concurrent Sessions on a repo unreliable.
- **Create the worktree when the Session is created.** That would make creating a Session wait for the Container. Lazy creation also covers remaking a removed worktree with the same step.

## Consequences

- Processes, ports and CPU are still shared by every Workspace on a Machine: two dev servers on one port collide.
- The Worker Shell's git (isomorphic-git) does not follow a linked worktree's `commondir`, so `bash` sends git to the Container when the command runs in a worktree.
- Every worktree's tracked files sync into the Machine's Durable Object. Removing Workspaces that are no longer used is what keeps the Machine's storage bounded.
