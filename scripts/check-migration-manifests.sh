#!/usr/bin/env bash
# Fails when a migration manifest (`migrations.manifest.ts`, `docs/development/workers.md` → Deploys and Durable Object
# code updates → Reverts) at <base> is not a prefix of the one in the working tree: a digest removed, changed,
# reordered, or its file deleted or moved. The manifests are append-only. A `git revert` of the change that added a
# migration removes the manifest's line with it, and the manifest test then passes; this is what makes that revert fail,
# so it has to keep the line, and the manifest test fails the migration that went missing.
#
# Usage: scripts/check-migration-manifests.sh <base commit>   (CI: the pull request's base; needs only that commit)
set -euo pipefail

base=${1:?usage: check-migration-manifests.sh <base commit>}

# The digests in a manifest, one per line, in order.
digests() { { grep -oE '^[[:space:]]*"[0-9a-f]{16}"' | tr -d ' "' ; } || true; }

failed=0

while IFS= read -r path; do
  shipped=$(git show "$base:$path" | digests)
  count=$(grep -c . <<<"$shipped" || true)

  if [ -f "$path" ]; then now=$(digests <"$path"); else now=""; fi

  if [ "$(head -n "$count" <<<"$now")" != "$shipped" ]; then
    echo "::error file=$path::$path is append-only: the digests at $base are not its first $count lines" >&2
    echo "$path: a digest that shipped was removed, changed or moved (or the file is gone). Keep every line; a revert keeps the migration and adds one that undoes it." >&2
    failed=1
  fi
done < <(git ls-tree -r --name-only "$base" | grep -E '(^|/)migrations\.manifest\.ts$' || true)

exit "$failed"
