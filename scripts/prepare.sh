#!/usr/bin/env bash
# The root `prepare` script: after a development install, the git hooks, the effect-tsgo patch, the tsrslint link and
# the reference repositories. A production install has none of the development tools, so it does none of them:
# `pi install git:github.com/ian-pascoe/cloudpid` runs one to load the `/cloudpid` extension
# (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → Distribution).
set -euo pipefail

cd "$(dirname "$0")/.."

# npm, pnpm and Bun all leave the root's development dependencies out of a production install (`--omit=dev`, `--prod`),
# and Husky is one, so its absence is the one sign every package manager gives.
if [[ ! -x node_modules/.bin/husky ]]; then
  exit 0
fi

node_modules/.bin/husky
node_modules/.bin/effect-tsgo patch --typescript
./scripts/link-tsrslint.sh
./scripts/sync-reference-repos.sh
