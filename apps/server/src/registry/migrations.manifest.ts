// The Registry's migrations that reached `main`, and so prod (it deploys on every push), one digest per position
// (`migrationDigests`, `@cloudpid/effect-durable/sqlite/testing`). `migrations.manifest.test.ts` fails a migration
// here that changed or went missing, and a migration not recorded yet: append its digest in the PR that adds it. Never
// edit or remove a line: CI's `Migration manifests` job (`scripts/check-migration-manifests.sh`) fails a pull request
// that does. A revert keeps the migration and adds one that undoes it (`docs/development/workers.md` → Deploys and
// Durable Object code updates → Reverts).
export const SHIPPED_MIGRATIONS: ReadonlyArray<string> = [
  "81ed258ca2c773a6",
  "800ce6a0d7b456ef",
  "2961fa4ed3caafb8",
  "b1c96f4ac4bb3507",
  "2096b1af0d163652",
  "b41e180b71078bc0",
  "ae05fb58ba30f115",
  "6a6d68e35b1d2ec6",
  "e338d03996d30951",
  "c297c1cbe09d3d48",
  "44063fcd175aabd6",
  "c668077718f9bcfd",
  "6cf22d4ae71ee3b4",
  "86c5710f45a626d1",
  "5a51cad299e83828",
  "f1d0686d8a3a3a3b",
  "37fa2e46b0744e00",
  "4c8d02d0f02594be",
  "e2af939662658e4c",
  "0c0c7741a0a427af",
  "e46968e17083fed0",
  "a5641d6e0d9216d1",
  "6efe970c444cd6fe",
  "ccb596cc61528727",
  "93ab68f8e790016a",
  "2e7bcc22f266f68f",
  "9b781dba3a72eb6b",
  "42af543173ad03ee",
  "da0fea94c67155cd",
];
