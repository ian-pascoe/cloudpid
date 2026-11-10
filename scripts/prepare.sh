#!/usr/bin/env bash
# The root `prepare` script: after a development install, the git hooks, the effect-tsgo patch, the tsrslint link and
# the reference repositories. A production install (`pi install git:github.com/ian-pascoe/cloudpid` runs one to load
# the `/cloudpid` extension, packages/pi-cloudpid → Install) has none of the development tools, so it does none of them.
set -euo pipefail

cd "$(dirname "$0")/.."

# npm, pnpm and Bun leave the development dependencies out of a production install (`--omit=dev`, `--prod`); npm also
# says so in `npm_config_omit`. Husky is a development dependency, so its absence says so for every package manager.
case " ${npm_config_omit:-} " in
*" dev "*) exit 0 ;;
esac

if [[ "${NODE_ENV:-}" == production || ! -x node_modules/.bin/husky ]]; then
  exit 0
fi

node_modules/.bin/husky
node_modules/.bin/effect-tsgo patch --typescript
./scripts/link-tsrslint.sh
./scripts/sync-reference-repos.sh
