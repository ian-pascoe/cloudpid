#!/usr/bin/env bash
# This repo's Setup Script (docs/architecture/container.md → Setup Scripts): the Container runs it in the repo's
# directory when the repo's Container is first started and whenever this file changes.
#
# - pnpm is this repo's `mise.toml`'s, which the bootstrap installs before this runs. With the Container's global pnpm
#   configuration (docs/architecture/container.md → pnpm and Turborepo off the mount), most of `node_modules` is
#   symlinks into pnpm's store on the Container's disk.
# - CI=1 turns off pnpm's prompts, since nobody can answer one: a Setup Script has no input (it also makes pnpm install
#   with --frozen-lockfile, as the lockfile is what to install). It is set here, not for every command, because CI
#   changes how other tools behave. It does not stop `prepare` from installing the git hooks (`vp config`), and
#   VP_GIT_HOOKS is left unset so that it does: an agent commits and pushes from the Container, so its commits go
#   through the same hooks as anyone's (scripts/prepare.sh). It also stops `prepare` from cloning effect and pi into
#   `.repos/` (about 5,150 files, 355 MB, not ignored, so they would sync into the Workspace DO); a Workspace that wants
#   them can run `scripts/sync-reference-repos.sh` without it.
set -euo pipefail

cd "$(dirname "$0")/.."

CI=1 pnpm install --frozen-lockfile
