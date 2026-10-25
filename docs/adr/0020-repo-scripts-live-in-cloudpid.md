---
status: accepted
---

# A Repo's Setup and Start Scripts live in its `.cloudpid/`

A Repo's Setup Script and Start Script were `.agents/setup.sh` and `.agents/start.sh`. `.agents/` is a directory that other coding agents read too: pi and others look in `.agents/skills`, and so does cloudpid. A script there looks like something any agent would run, and another tool could give the same file name a different meaning. Only cloudpid runs these scripts, and the way it runs them is its own. A Setup Script reruns when its SHA-256 changes and what it installs goes into Snapshots and Builds. A Start Script runs at every Container start, is stopped after 5 minutes, and must detach the services it starts. So the scripts are now `.cloudpid/setup.sh` and `.cloudpid/start.sh` (`SETUP_SCRIPT` and `START_SCRIPT`). That matches what other tools do with their own setup: `.cursor/environment.json`, `.github/copilot-setup-steps.yml`, `.devcontainer/`. Anything else cloudpid-specific that a Repo carries goes in the same directory. Shared conventions (`.agents/skills`, `.agents/prompts`, `AGENTS.md`) stay where they are.

## Considered Options

- **Keep `.agents/`**: rejected, because these scripts only make sense under cloudpid, so they should not look portable.
- **Look in both, `.cloudpid/` first**: rejected. The owner's Repos are the only users, so a fallback would keep two places to look for no one.

## Consequences

- A Repo that still has `.agents/setup.sh` or `.agents/start.sh` has no Setup or Start Script until it moves them. Nothing warns about the old path.
- A Setup Script's record is its content's SHA-256, kept under the Repo's name. A script moved without changes does not run again on a Container that already ran it.
- A Repo's `.cloudpid/` and the harness's `/workspace/.cloudpid/` (temp files, spills, Attachments: ADR-0018) share a name but are different things. The Repo's is committed config in `/workspace/<repo>/`. The harness's is throwaway state at the Workspace root. The harness's patterns (`!/.cloudpid`, `!/.cloudpid/**`) are anchored to the root, and a Repo is always cloned below it, so they never match a Repo's directory.
