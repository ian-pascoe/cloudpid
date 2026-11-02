// The migration checks are Promise-based, so these tests are too.
// @effect-diagnostics asyncFunction:off
import { describe, expect, it } from "vitest";
import type { Migration } from "./sqlite.ts";
import { migrationDigests, refusingStorage, shippedMigrationProblems } from "./sqlite-testing.ts";

/** A storage shaped like a Durable Object's: the KV API, `transactionSync`, and `sql` (`exec`, `databaseSize`). */
const fakeStorage = () => {
  const kv = new Map<string, number>();

  return {
    kv,
    get: (key: string) => Promise.resolve(kv.get(key)),
    put: (key: string, value: number) => {
      kv.set(key, value);

      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(kv.delete(key)),
    list: () => Promise.resolve(new Map(kv)),
    transaction: <T>(closure: () => Promise<T>): Promise<T> => closure(),
    transactionSync: <T>(closure: () => T): T => closure(),
    sql: { exec: (query: string) => query.length, databaseSize: 4096 },
  };
};

describe("refusingStorage", () => {
  it("behaves as the storage it wraps until it is tripped", async () => {
    const real = fakeStorage();
    const { storage } = refusingStorage(real);

    await storage.put("a", 1);

    expect(await storage.get("a")).toBe(1);
    expect(storage.transactionSync(() => "ran")).toBe("ran");
    expect(storage.sql.exec("SELECT 1")).toBe(8);
    expect(storage.sql.databaseSize).toBe(4096);
  });

  it("throws from every storage operation once tripped, and not before", async () => {
    const real = fakeStorage();
    const gate = refusingStorage(real);

    expect(gate.tripped()).toBe(false);

    gate.trip();

    expect(gate.tripped()).toBe(true);
    expect(() => gate.storage.sql.exec("SELECT 1")).toThrow("sql.exec");
    expect(() => gate.storage.sql.databaseSize).toThrow("sql.databaseSize");
    expect(() => gate.storage.transactionSync(() => "ran")).toThrow("transactionSync");
    // The platform rejects its Promise-returning members, rather than throwing from the call.
    await expect(gate.storage.get("a")).rejects.toThrow("get");
    await expect(gate.storage.put("a", 1)).rejects.toThrow("put");
    await expect(gate.storage.delete("a")).rejects.toThrow("delete");
    await expect(gate.storage.list()).rejects.toThrow("list");
    await expect(gate.storage.transaction(() => Promise.resolve(1))).rejects.toThrow("transaction");
  });

  it("refuses a method captured before the trip, when it is called", async () => {
    const gate = refusingStorage(fakeStorage());
    const { exec } = gate.storage.sql;
    const { put } = gate.storage;

    expect(exec("SELECT 1")).toBe(8);

    gate.trip();

    expect(() => exec("SELECT 1")).toThrow("sql.exec");
    await expect(put("a", 1)).rejects.toThrow("put");
  });

  it("refuses a call a transaction started before the trip, and leaves the real storage as it was", async () => {
    const real = fakeStorage();
    const gate = refusingStorage(real);

    await gate.storage.put("kept", 1);

    expect(() =>
      gate.storage.transactionSync(() => {
        gate.trip();
        gate.storage.sql.exec("INSERT");
      }),
    ).toThrow("sql.exec");

    // A new instance opens the same storage.
    expect(real.kv.get("kept")).toBe(1);
  });
});

const create =
  (table: string): Migration =>
  (sql) => {
    sql.exec(`CREATE TABLE ${table} (a INTEGER)`);
  };

describe("shippedMigrationProblems", () => {
  const shipped = migrationDigests([create("a"), create("b")]);

  it("passes migrations that match what shipped", async () => {
    expect(await shippedMigrationProblems([create("a"), create("b")], await shipped)).toEqual([]);
  });

  it("fails a migration at a shipped position that changed", async () => {
    const problems = await shippedMigrationProblems(
      [create("a"), create("changed")],
      await shipped,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^Migration 2 changed since it shipped/);
  });

  it("fails a migration that disappeared", async () => {
    const problems = await shippedMigrationProblems([create("a")], await shipped);

    expect(problems).toEqual([expect.stringMatching(/^Migration 2 shipped but is gone/)]);
  });

  it("fails a revert that let a new migration take a shipped migration's number", async () => {
    // Migration 2 was replaced by a different change, the manifest line kept. (A revert that drops the line too is
    // `scripts/check-migration-manifests.sh`'s, in `check-migration-manifests.test.ts`.)
    const problems = await shippedMigrationProblems([create("a"), create("other")], await shipped);

    expect(problems).toEqual([expect.stringMatching(/^Migration 2 changed/)]);
  });

  it("fails a migration the manifest does not record yet, naming its digest", async () => {
    const [, , digest] = await migrationDigests([create("a"), create("b"), create("c")]);

    expect(
      await shippedMigrationProblems([create("a"), create("b"), create("c")], await shipped),
    ).toEqual([`Migration 3 is not in the manifest: append "${digest}" to it.`]);
  });

  it("ignores formatting and comments, and sees a statement or a binding change", async () => {
    const [plain, spaced, bound, rebound] = await migrationDigests([
      (sql) => sql.exec("INSERT INTO t VALUES (?)", 1),
      (sql) => {
        // A comment, and the same statement over lines.
        sql.exec("INSERT   INTO t\n   VALUES (?)", 1);
      },
      (sql) => sql.exec("INSERT INTO t VALUES (?)", 2),
      (sql) => sql.exec("INSERT INTO u VALUES (?)", 1),
    ]);

    expect(spaced).toBe(plain);
    expect(bound).not.toBe(plain);
    expect(rebound).not.toBe(plain);
  });
});
