// The import's tables in a Session object, against real Durable Object storage (`docs/architecture/mcp-endpoint.md` →
// Session import → The import channel): made by the first write, and brought up to date by every migration added later.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Migration } from "@cloudpid/effect-durable/sqlite";
import { describe, expect, it } from "vite-plus/test";
import type { TestSession } from "./host.fixture.ts";
import { importStaging, MIGRATIONS } from "./import-staging.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
    }
  }
}

const record = {
  phase: "staging",
  size: 3,
  via: { auth: "oauth", client: { name: "claude-code" } },
  workspace: { branch: "feature/x", repos: [] },
  attempts: 0,
} as const;

/** The next migration: one more table, as a later change to the Session's tables adds. */
const next: Migration = (sql) => {
  sql.exec("CREATE TABLE import_later (id INTEGER PRIMARY KEY) STRICT");
};

const later = [...MIGRATIONS, next];

describe("the import's tables in a Session object", () => {
  const tablesOf = (state: DurableObjectState) =>
    state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' ORDER BY name",
      )
      .toArray()
      .map((row) => row.name);

  it("makes them on the first write, not on a read, and reaches them with a later migration on a read", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());

    await runInDurableObject(stub, (_instance: TestSession, state) => {
      // A store that was never written: reads find nothing and make nothing, however many migrations there are.
      const staging = importStaging(state.storage, later);

      expect(staging.record()).toBeUndefined();
      expect(staging.received()).toBe(0);
      expect(tablesOf(state).filter((name) => name.startsWith("import_"))).toEqual([]);

      // The first write, under the first migration only: the tables of that release.
      importStaging(state.storage).save(record);

      expect(tablesOf(state)).toEqual(
        expect.arrayContaining(["import_slices", "import_state", "schema_version"]),
      );
      expect(tablesOf(state)).not.toContain("import_later");

      // A later release reads the import it found: its migration reaches the object that already has the tables.
      expect(importStaging(state.storage, later).record()).toMatchObject({ phase: "staging" });
      expect(tablesOf(state)).toContain("import_later");
      expect(
        state.storage.sql
          .exec<{ version: number }>("SELECT MAX(version) AS version FROM schema_version")
          .one().version,
      ).toBe(2);

      // The release before it, opened again over the newer tables, still works.
      expect(importStaging(state.storage).record()).toMatchObject({ phase: "staging" });
    });
  });

  it("reaches them with a later migration on a write too", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());

    await runInDurableObject(stub, (_instance: TestSession, state) => {
      importStaging(state.storage).save(record);
      importStaging(state.storage, later).save({ ...record, attempts: 1 });

      expect(tablesOf(state)).toContain("import_later");
    });
  });
});
