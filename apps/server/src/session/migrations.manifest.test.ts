// The migration check is Promise-based, so this test is too.
// @effect-diagnostics asyncFunction:off
import { shippedMigrationProblems } from "@cloudpid/effect-durable/sqlite/testing";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "./import-staging.ts";
import { SHIPPED_MIGRATIONS } from "./migrations.manifest.ts";

describe("the Session's migrations", () => {
  it("are the ones that shipped, in order, with only new ones after them", async () => {
    expect(await shippedMigrationProblems(MIGRATIONS, SHIPPED_MIGRATIONS)).toEqual([]);
  });
});
