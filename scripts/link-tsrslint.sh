#!/usr/bin/env bash
# Links tsrslint's native binary as `node_modules/.bin/tsgolint`, where oxlint looks for its type-aware backend, so
# package scripts, lint-staged and editors all run tsrslint instead of tsgolint (docs/adr/0028-bun-for-installs-and-
# scripts-and-tsrs-for-typecheck.md → Consequences). Run by `prepare`, after every `bun install`. Once tsrs ships its
# own linter (oxc-project/tsrs#378), remove this script, its `prepare` step, `@maschwenk/tsrslint`, and the link.
set -euo pipefail

cd "$(dirname "$0")/.."

link=node_modules/.bin/tsgolint
rm -f "$link"

# tsrslint-path explains its own failure (no binary for this platform, an optional dependency left out) on stderr.
if ! binary=$(node_modules/.bin/tsrslint-path); then
  echo "link-tsrslint: no tsrslint binary; oxlint's type-aware rules will find no backend" >&2
  exit 0
fi

ln -s "$binary" "$link"
