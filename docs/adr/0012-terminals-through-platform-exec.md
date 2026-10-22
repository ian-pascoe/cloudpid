# Terminals run through the platform's exec, outside computer, with the Workspace DO syncing them

A Terminal needs a PTY, and neither `@cloudflare/computer` (0.5.1, nor 0.6.0) nor computerd has one: computerd runs every command with `sh -c` over pipes, and its exec takes only argv, cwd, env, timeout and a one-shot stdin. The platform's `ctx.container.exec` does (`pty: { cols, rows }`, streaming stdin, `resize()`), so the Workspace DO starts each Terminal's shell with it, beside computer rather than through it. computer syncs files only around its own commands (a push before, a pull after; there is no change feed), so a shell it did not start would neither see the Workspace DO's writes nor have its own reach the Worker Shell and the agent's file tools. The Workspace DO therefore syncs for it: it connects through computer before a shell starts (so the bootstrap runs and the files are pushed), pulls once a tab's output has been quiet for 1 s (at most every 2 s) and when a shell exits or a tab closes, pushes when the DO's files change while a Terminal runs (at most every 2 s), and pulls before an idle stop's snapshot. A Terminal's typing and output count as Container use, since computer's own accounting never sees them.

## Considered Options

- **Wait for computer to add a PTY.** Its changelog shows none planned, and a Terminal is wanted now; when computer gains one, the Terminal can move onto it and this sync goes away.
- **A PTY server in the image (ttyd, or our own) reached through `getTcpPort().fetch`.** It is one more process under the supervisor, one more port and secret, and it still sits outside computer's sync, so it saves nothing over the platform's exec.
- **Shell escapes and the agent's `bash` only, no Terminal.** That was the spec's position ("computer has no PTY"); it leaves interactive programs (editors, REPLs, `git add -p`) out of reach.

## Consequences

When both sides change one file between syncs, the Container's write wins (computer's rule). A Terminal's writes that are not yet pulled when the Container dies outright are lost (an idle stop pulls first). Terminals end with the Workspace DO's instance, since it holds the exec handles: an eviction or a deploy ends them, and a tab offers to start a new shell. The first implementation step is to check this sync on a deployed stage (real FUSE) and under `alchemy dev` (computerd's userspace shim); if it does not hold, this decision is revisited.
