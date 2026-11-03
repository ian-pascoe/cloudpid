// `McpHost`'s migrations that reached `main`, and so prod (it deploys on every push), one digest per position
// (`migrationDigests`, `@cloudpid/effect-durable/sqlite/testing`). `migrations.manifest.test.ts` fails a migration
// here that changed or went missing, and a migration not recorded yet: append its digest in the PR that adds it. Never
// edit or remove a line: CI's `Migration manifests` job (`scripts/check-migration-manifests.sh`) fails a pull request
// that does. A revert keeps the migration and adds one that undoes it (`docs/development/workers.md` → Deploys and
// Durable Object code updates → Reverts).
export const SHIPPED_MIGRATIONS: ReadonlyArray<string> = [
  // 1: the set as received, its revision, and the revision a wipe leaves as a floor.
  "cd5a70370e820908",
  // 2: per `conn`, the MCP inventory, the status, the era row and the Legacy session rows.
  "aecf9457beee8fe7",
  // 3: `mcp_meta`'s versions, last use and MCP sign-ins revision.
  "1988766cefcda198",
  // 4: per `conn`, the server log ring.
  "35478948f07bbf90",
  // 5: `mcp_app_ui`, `mcp_app_html_meta` and `mcp_app_html`, the App HTML by hash.
  "325ceb96ef159fca",
];
