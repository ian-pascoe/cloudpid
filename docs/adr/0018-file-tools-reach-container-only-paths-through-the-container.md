---
status: accepted, partly supersedes ADR-0008
---

# The agent's file tools and commands reach Container-only paths through the Container

The Worker Shell and the file tools see only the Workspace's files, the ones its Durable Object holds. The Container also has files of its own: its Container-only paths. Inside the Workspace, those are dependency directories, build output and caches (`node_modules`, `.venv`, `target`, `.cache`, …, plus the Environment's own). Outside it, every path counts (`/tmp`, `~`, the Toolchains). An agent that ran `pnpm install` was told `node_modules/effect/package.json` did not exist, `ls` of a repo left `node_modules` out (so dependencies looked uninstalled), and `write` to `/tmp` succeeded on the Durable Object's side where no command could see it. Telling the model about two file systems did not fix the confusion, so the harness hides the split instead.

A model tool's file operation (`read`, `write`, `edit`, `ls`, `find`, `grep`) on a Container-only path runs on the Container, starting it if it is stopped. The Workspace DO decides by the patterns the current launch was given, or the next launch's when none runs, matched as computerd matches them. It never checks whether the file exists. `@cloudflare/computer` reaches a Container only through commands, so each operation is a script the Workspace DO runs there. Bytes cross through stage files under `/workspace/.cloudpid/tmp`, which computer syncs before and after each command. Only the model's own tools ask for this, through `reachContainer` on each request. The composer's lookups, Skill and Prompt template discovery and the Panes still see only the Workspace's files and never start the Container. `ls`, `find` and `grep` on the Workspace's own paths still never start it either. That part of ADR-0008 stands; the rest of ADR-0008's guarantee does not. `bash` routes a command to the Container up front when one of its path words resolves to a Container-only path. When a command that writes no file fails on the Worker Shell with "No such file or directory" for such a path, it reruns there.

The harness's own files move into the Workspace so that both sides see them: temp files and `bash` spills go to `/workspace/.cloudpid/tmp` (removed after 24 hours unused, with no size cap), clone staging to `/workspace/.cloudpid/tmp/clone-<repo>`, and Attachments to `/workspace/.cloudpid/uploads`. The harness appends `!/.cloudpid` and `!/.cloudpid/**` to every launch's patterns, so nothing an Environment adds makes them local. The Container's per-start state (`/tmp/cloudpid-start-due…`, `/var/lib/cloudpid`) stays on its disk, since a restart must clear it. Existing `/workspace/.uploads` directories are not migrated.

## Considered options

- **Better errors only**: tell the model which paths are the Container's and point it at `bash`. This was rejected because the model still has to keep two file systems in mind, and `ls` would still hide `node_modules`.
- **Make gitignored paths Container-only too**: this would have made `.alchemy/` (deploy state) and `.env*` (secrets) local, so a Container restart would lose them and Snapshots and Builds would carry them. Only the built-in patterns and the Environment's own count.
- **Ranged reads on the Container**: pi-durable's line scan needs every byte to count decoded UTF-8 exactly. So a reader copies the whole file into the Workspace DO when it opens it, a snapshot like the DO's own hard-linked readers. Files over 32 MB are left to `bash` (`head`, `sed -n`).

## Consequences

- A write after a read on the Container (`edit`) replaces the file only if its SHA-256 is unchanged since the read. Otherwise it fails with "read it again". The file is replaced in one step, keeping its mode.
- `ls` of a synced directory adds its Container-only entries, marked `(container-only)`, only while the Container runs, because a listing does not start it.
- Adding `!/.cloudpid` and `!/.cloudpid/**` changes every launch's patterns. So the first launch after the deploy restores no Snapshot or Build taken with the old ones, and starts from the image.
