// The migration check is Promise-based, so this test is too.
// @effect-diagnostics asyncFunction:off
import { shippedMigrationProblems } from "@cloudpid/effect-durable/sqlite/testing";
import { describe, expect, it } from "vite-plus/test";
import { SHIPPED_MIGRATIONS } from "./migrations.manifest.ts";
import { MIGRATIONS } from "./store.ts";

describe("McpHost's migrations", () => {
  it("are the ones that shipped, in order, with only new ones after them", async () => {
    expect(await shippedMigrationProblems(MIGRATIONS, SHIPPED_MIGRATIONS)).toEqual([]);
  });
});
