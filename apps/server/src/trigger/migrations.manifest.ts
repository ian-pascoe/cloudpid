// The `Trigger` object's migrations that reached `main`, and so prod (it deploys on every push), one digest per position
// (`migrationDigests`, `@cloudpid/effect-durable/sqlite/testing`). `migrations.manifest.test.ts` fails a migration
// here that changed or went missing, and a migration not recorded yet: append its digest in the PR that adds it. Never
// edit or remove a line: CI's `Migration manifests` job (`scripts/check-migration-manifests.sh`) fails a pull request
// that does. A revert keeps the migration and adds one that undoes it (`docs/development/workers.md` → Deploys and
// Durable Object code updates → Reverts).
export const SHIPPED_MIGRATIONS: ReadonlyArray<string> = [
  // 1: `trigger_meta` (the definition and the cursor), `trigger_pending` (with its admitted Session) and
  // `trigger_fires`, the fire log.
  "a8419e2c21873eff",
];
