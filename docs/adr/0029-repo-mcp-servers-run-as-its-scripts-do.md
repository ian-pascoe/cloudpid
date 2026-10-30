---
status: accepted
---

# A Repo's MCP servers run as its scripts do: from the default branch, ungated, without Secrets, never over the owner's

A Repo's `.pi/mcp.json` (pi's project MCP file) adds MCP servers to its Environment's MCP server set. It is read from the Repo's default branch through the GitHub App, not from each Workspace's working tree as `AGENTS.md` and a Repo's Skills are, because the servers and their discovery belong to the Environment's MCP host object, and a file written on a branch must not change what runs until it is merged. Its servers run as the Repo's Start Script does: without the owner's OK, with the Environment's Variables, but with no Secrets (a `${NAME}` naming a Secret skips the entry with a problem). A committed entry therefore can never carry a Secret to an address of the committer's choosing; an owner who wants a Repo's server to have one copies the entry into the Settings, where it is the owner's and stays as copied. In the set the owner's entries win: a Repo adds servers but cannot redefine one of the owner's (its entry is shown as shadowed), its MCP server adjustments may only switch things off, and the Environment's adjustments apply last, so the owner can turn a Repo's server off without touching the Repo.

## Considered options

- **The working tree, nearer wins** (pi, `AGENTS.md`, Skills): a quick edit-and-reload loop, but each Workspace would have its own set, breaking the per-Environment discovery cache, and a Repo could only be overruled by editing it.
- **pi's project trust, per entry**: the owner accepts each Repo server, pinned to its content, and Secrets then resolve. It needs a new concept, a page, a tool, and a stop on every edit of the file, for what copying the entry into the Settings already gives.
- **Repo servers off until the owner enables them**: no new concept, but the enablement does not pin the entry, so a later commit runs with what it granted.
- **A Repo's full entry replaces the owner's of the same name** (pi): a Repo could point the owner's `github` server at another URL while keeping its token header.

## Consequences

- Trying a new Repo server means merging it, or adding it to the Environment's Settings first.
- A non-GitHub Repo's `.pi/mcp.json` is not read; its servers go in the Settings. A GitHub Repo the App cannot read keeps its last good copy, marked, and becomes a problem after a day of failed reads.
- pi files that read Secrets through `${NAME}` load in cloudpid only once copied into the Settings.
