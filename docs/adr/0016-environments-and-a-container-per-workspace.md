---
status: accepted, supersedes ADR-0015
---

# Environments, and a Container per Workspace

ADR-0015 put every Workspace of a repo on one shared Machine: worktrees of one clone, one Container. Their branches were their own, but their processes, ports, CPU and memory were not. Two agents' dev servers collided, and one agent's build slowed the others. Claude Code's cloud sessions, Codex's cloud tasks and Cursor's Cloud Agents all give each thread a machine of its own, so cloudpid does too.

The owner now makes **Environments**. An Environment is its Repos (none or several) and their configuration: Toolchains, variables, Secrets, the Container's size, idle time and Container-only paths, and Setup and Start Scripts. A Session binds to a **Workspace** made from an Environment. The Workspace holds its own clones of the Environment's Repos, all on one branch (`cloudpid/<id>` unless the owner names one, from a base branch the owner picks), and has a Container of its own. A new Session gets a new Workspace unless it is started in one that exists. Worktrees, the main checkout and the shared Machine are gone. "Machine" no longer appears in the UI. The Durable Object class stays `Workspace`: one instance, with its Container, now hosts one Workspace, which is what `@cloudflare/computer` means by the word.

Each Environment has a **Build**. A Build is a Snapshot of a Container with the Environment's Toolchains installed and everything its Setup Scripts download cached outside `/workspace`: package stores, Docker images. The scripts run on scratch clones that the Build then drops, and computerd's store is reset when a Container starts from the Build, so the new Workspace's Durable Object is not handed another's sync state. A Build is made again when the Environment's configuration changes or a Repo's default branch moves, and a Build that fails leaves the last good one in use, as Cursor's do. A Build does not carry the Repos' clones: the spike (#170) found that the cost of a new Workspace is getting its files into its Durable Object, not the network, and a clone in the Build would still pay that. Instead, each Environment keeps one **spare Workspace** made ahead from its latest Build: cloned (full clones, so switching branches fetches no blobs), set up, then stopped with its Container snapshotted. The next new Workspace takes the spare (its Container restores in about 2 s) and checks out its branch, and another spare is made in the background. A Start Script runs at each start of a Workspace's Container to bring up services (databases, dev dependencies), which a Snapshot cannot hold. Docker runs in the Container for them, with its daemon's IP forwarding and iptables off (the Container's `/proc/sys` is read-only), so published ports reach the Workspace's localhost but bridge-networked containers have no internet.

Environment variables are plain: the agent can read them, and they reach every command and the Build. Secrets kept for an Environment (or for every Environment) are Secrets like `secret_ask`'s, used by reference and scrubbed from output, but they do not expire. One reaches a Build only when the owner marks it so, since every Workspace made from that Build shares its Snapshot. The scan before each Snapshot looks for every such Secret, not only the GitHub token.

Existing Machines, with their Sessions, are reset at the cutover rather than migrated.

## Considered Options

- **Namespaces in the shared Container.** A network namespace and a cgroup per Workspace would end port collisions and cap each one's memory. But every Workspace would still share the Container's 2 vCPU and 6 GiB, and one crash would take down all of them.
- **A Container per Workspace over the Machine's shared files.** This would keep the shared `.git`. But several Containers would write one `.git` through computer's sync, where git's lock files do not hold. Every Container would also sync through the one Machine Durable Object, which moves the contention there.
- **Custom Docker images.** With the `durable_object` scheduling policy, a Durable Object can start only images declared at deploy time, a Snapshot, or Cloudflare's managed image. Runtime images would mean deploying from inside cloudpid, or running commands in an unpacked image's root filesystem. Neither is worth it: Setup and Start Scripts, with mise, cover what an image would add.

## Consequences

- Branches move between Workspaces only through the remote. Removing a Workspace loses its uncommitted changes and its unpushed commits.
- The Worker Shell's git works in every Workspace again: no linked worktrees, no `commondir`.
- Measured on a `custom-2` Container (#170): getting a repo's files into a Workspace costs about 3.5 ms a file through FUSE plus about 33 s per 9,000 files of sync into the Durable Object, whatever the network. That is 73 s for svelte (9,270 files) against 5 s for cloudpid (650), with `pnpm install` against a warm store adding about 7 s. The spare Workspace takes all of it off the path of a new Session; without a spare (the first Workspace after a Build, or two Sessions in quick succession), a new Workspace waits for it.
- Each Workspace's Durable Object holds its own copy of the Environment's Repos, and each running Container is billed for its own memory and disk: about 6¢ per running hour on `custom-2` (2026-10 prices), before CPU. Workspaces used one after another cost what one Machine did; Workspaces running side by side cost one Container each. The spare adds one idle copy and Snapshot per Environment, with no running Container. A policy for removing unused Workspaces is what bounds storage and Snapshots.
- A subagent shares its parent's Workspace unless it is started in a Subagent Workspace of its own (ADR-0021).
