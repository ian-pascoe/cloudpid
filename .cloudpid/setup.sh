#!/usr/bin/env bash
# This repo's Setup Script (docs/architecture/container.md → Setup Scripts): the Container runs it in the repo's
# directory when the repo's Container is first started and whenever this file changes.
#
# - Bun is this repo's `mise.toml`'s, which the bootstrap installs before this runs. Bun asks nothing during an
#   install, and --frozen-lockfile installs what the lockfile says. With the Container's global Bun configuration
#   (`globalStore`, docs/architecture/container.md → Package managers off the mount) and this repo's own, most of
#   `node_modules` is symlinks into Bun's cache on the Container's disk.
# - SKIP_REFERENCE_REPOS=1 stops `prepare` from cloning effect and pi into `.repos/` (about 5,150 files, 355 MB, not
#   ignored, so they would sync into the Workspace DO). A Workspace that wants them can run the script by hand.
set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_REFERENCE_REPOS=1 bun install --frozen-lockfile
