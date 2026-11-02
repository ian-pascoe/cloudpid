#!/bin/sh
# Points oxlint's type-aware backend at tsrslint (https://github.com/maschwenk/tsrslint), the Rust port of tsgolint
# on tsrs, by linking its native binary as `node_modules/.bin/tsgolint`, the path oxlint looks for. Linking it once
# here covers every way oxlint starts (package scripts under Turborepo, lint-staged, editors) without passing
# `OXLINT_TSGOLINT_PATH` to each. Run by `prepare`, so after every `bun install`.
#
# Temporary: once tsrs ships its own linter (https://github.com/oxc-project/tsrs/issues/378), oxlint finds it in
# `node_modules/.bin` itself, and this script and `@maschwenk/tsrslint` go.
set -eu

cd "$(dirname "$0")/.."

if ! binary=$(node_modules/.bin/tsrslint-path 2>/dev/null); then
  echo "link-tsrslint: no tsrslint binary for this platform; oxlint --type-aware will not find a backend" >&2
  exit 0
fi

ln -sf "$binary" node_modules/.bin/tsgolint
