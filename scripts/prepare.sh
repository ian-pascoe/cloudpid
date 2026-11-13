#!/usr/bin/env bash
# The root `prepare` script: after a development install, the git hooks, the effect-tsgo patch and the reference
# repositories. A production install has none of the development tools, so it does none of them:
# `pi install git:github.com/ian-pascoe/cloudpid` runs one to load the `/cloudpid` extension
# (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → Distribution).
set -euo pipefail

cd "$(dirname "$0")/.."

# npm and pnpm both leave the root's development dependencies out of a production install (`--omit=dev`, `--prod`), and
# Vite+ is one, so its absence is the one sign every package manager gives.
if [[ ! -x node_modules/.bin/vp ]]; then
  exit 0
fi

# The hook dispatcher for `.vite-hooks/` (`core.hooksPath`); `VP_GIT_HOOKS=0` (CI) skips it.
node_modules/.bin/vp config --no-agent
node_modules/.bin/effect-tsgo patch --typescript
./scripts/sync-reference-repos.sh
