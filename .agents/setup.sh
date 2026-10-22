#!/usr/bin/env bash
# This repo's Setup Script (docs/spec.md → Container and Toolchains → Setup Scripts): the Container runs it in the repo's
# directory when the repo's Container is first started and whenever this file changes.
#
# - CI=1 turns off pnpm's prompts, since nobody can answer one: a Setup Script has no input (it also makes pnpm install
#   with --frozen-lockfile, as the lockfile is what to install). It is set here, not for every command, because CI
#   changes how other tools behave.
# - SKIP_REFERENCE_REPOS=1 stops `prepare` from cloning effect and pi into `.repos/` (about 5,150 files, 355 MB, not
#   ignored, so they would sync into the Workspace DO). A Workspace that wants them can run the script by hand.
set -euo pipefail

cd "$(dirname "$0")/.."

CI=1 SKIP_REFERENCE_REPOS=1 pnpm install --frozen-lockfile
