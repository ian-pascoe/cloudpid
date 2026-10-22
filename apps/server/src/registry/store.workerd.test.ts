// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { DEFAULT_MACHINE } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, openRegistryStore } from "./store.ts";
import type { TestRegistry } from "./store.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly REGISTRIES: DurableObjectNamespace<TestRegistry>;
    }
  }
}

/** The slugs of the Machines the Registry lists, in name order. */
const slugs = async (registry: DurableObjectStub<TestRegistry>) =>
  Arr.sort(
    Arr.map(await registry.listMachines(), (machine) => machine.slug),
    Order.String,
  );

const fresh = () => env.REGISTRIES.get(env.REGISTRIES.newUniqueId());

/**
 * Expect the store to refuse to create a Session. It is called in the object, not over RPC: a refusal in a storage
 * transaction is otherwise also reported as an unhandled rejection.
 */
const refuses = (
  registry: DurableObjectStub<TestRegistry>,
  ...input: Parameters<TestRegistry["createSession"]>
) =>
  runInDurableObject(registry, (instance: TestRegistry) => {
    expect(() => instance.createSession(...input)).toThrow();
  });

/** Undo migration 10 (Workspaces of their own), as the stores before it were. */
const withoutWorkspaces = (sql: SqlStorage) => {
  sql.exec("DROP TABLE worktrees");
  sql.exec("ALTER TABLE sessions DROP COLUMN worktree");
};

/** Undo migrations 8 to 10 (Machine names, archived Sessions, Workspaces), as the stores before them were. */
const withoutNamesOrArchive = (sql: SqlStorage) => {
  withoutWorkspaces(sql);
  sql.exec("DROP INDEX workspaces_by_name");
  sql.exec("ALTER TABLE workspaces DROP COLUMN name");
  sql.exec("ALTER TABLE sessions DROP COLUMN archived_at");
};

describe("the Registry store", () => {
  it("lists a created Session as idle with its title and timestamps", async () => {
    const registry = fresh();

    const created = await registry.createSession({ id: "s-1", title: "Fix the build" }, 1_000);

    expect(created).toEqual({
      id: "s-1",
      title: "Fix the build",
      titleSource: "owner",
      machine: DEFAULT_MACHINE,
      repo: null,
      workspace: null,
      status: "idle",
      createdAt: 1_000,
      updatedAt: 1_000,
      archivedAt: null,
    });
    expect(await registry.listSessions()).toEqual([created]);
  });

  it("finds a registered Session by its ID, and nothing for an unknown one", async () => {
    const registry = fresh();

    const created = await registry.createSession({ id: "s-1", title: null }, 1_000);

    expect(await registry.getSession("s-1")).toEqual(created);
    expect(await registry.getSession("s-2")).toBeNull();
  });

  it("lists Sessions newest first", async () => {
    const registry = fresh();

    await registry.createSession({ id: "old", title: null }, 1_000);
    await registry.createSession({ id: "new", title: null }, 2_000);

    expect(Arr.map(await registry.listSessions(), (session) => session.id)).toEqual(["new", "old"]);
  });

  it("tracks a Session going running and back to idle", async () => {
    const registry = fresh();

    await registry.createSession({ id: "s-1", title: null }, 1_000);
    await registry.setSessionStatus("s-1", "running", 2_000);
    expect(await registry.listSessions()).toMatchObject([{ status: "running", updatedAt: 2_000 }]);

    await registry.setSessionStatus("s-1", "idle", 3_000);
    expect(await registry.listSessions()).toMatchObject([{ status: "idle", updatedAt: 3_000 }]);
  });

  it("leaves updatedAt alone when a report repeats the current status", async () => {
    const registry = fresh();

    await registry.createSession({ id: "s-1", title: null }, 1_000);
    await registry.setSessionStatus("s-1", "idle", 2_000);

    expect(await registry.listSessions()).toMatchObject([{ status: "idle", updatedAt: 1_000 }]);
  });

  it("ignores a status report for a Session it does not know", async () => {
    const registry = fresh();

    await registry.setSessionStatus("ghost", "running", 1_000);

    expect(await registry.listSessions()).toEqual([]);
  });

  it("refuses to list or write a status it does not know", async () => {
    const registry = fresh();

    await registry.createSession({ id: "s-1", title: null }, 1_000);
    // Inside the object, so the throw is caught here instead of surfacing as an uncaught exception.
    await runInDurableObject(registry, (instance: TestRegistry, state) => {
      // @ts-expect-error -- a status outside the union, as a caller that skipped the type might send
      expect(() => instance.setSessionStatus("s-1", "exploded", 2_000)).toThrow(/Unknown/);
      state.storage.sql.exec("UPDATE sessions SET status = 'exploded'");
      expect(() => instance.listSessions()).toThrow(/Unknown/);
    });
  });

  it("records a Machine by slug once, however often it is created", async () => {
    const registry = fresh();

    await registry.createMachine("cloudpid", 1_000);
    const again = await registry.createMachine("cloudpid", 2_000);

    expect(again).toEqual({ slug: "cloudpid", name: "cloudpid", createdAt: 1_000 });
    expect(await registry.listMachines()).toContainEqual({
      slug: "cloudpid",
      name: "cloudpid",
      createdAt: 1_000,
    });
    expect(await slugs(registry)).toEqual(["cloudpid", DEFAULT_MACHINE]);
  });

  it("lists the default Machine before any Session is created in it", async () => {
    expect(await slugs(fresh())).toEqual([DEFAULT_MACHINE]);
  });

  it("binds a Session to the Machine it is created with, and lists that Machine", async () => {
    const registry = fresh();

    const created = await registry.createSession(
      { id: "s-1", title: null, machine: "cloudpid" },
      1_000,
    );

    expect(created.machine).toBe("cloudpid");
    expect((await registry.getSession("s-1"))?.machine).toBe("cloudpid");
    expect(await registry.listMachines()).toContainEqual({
      slug: "cloudpid",
      name: "cloudpid",
      createdAt: 1_000,
    });
  });

  it("binds a Session created without a Machine to the default one", async () => {
    const registry = fresh();

    await registry.createSession({ id: "s-1", title: null }, 1_000);

    expect((await registry.getSession("s-1"))?.machine).toBe(DEFAULT_MACHINE);
    expect(await slugs(registry)).toEqual([DEFAULT_MACHINE]);
  });

  it("opens a Registry written before Sessions had Machines, binding its Sessions to the default", async () => {
    await runInDurableObject(fresh(), (_instance: TestRegistry, state) => {
      const { storage } = state;
      const { sql } = storage;

      // The first deployed schema: no `workspace` column, no schema version.
      sql.exec("DROP TABLE sessions");
      sql.exec("DROP TABLE schema_version");
      sql.exec("DROP INDEX workspaces_by_name");
      sql.exec("ALTER TABLE workspaces DROP COLUMN name");
      sql.exec(`CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`);
      sql.exec("INSERT INTO sessions VALUES ('old', 'Before', 'idle', 1, 1)");

      const store = openRegistryStore(storage);

      expect(store.getSession("old")).toMatchObject({ id: "old", machine: DEFAULT_MACHINE });
      // Opening again changes nothing, and the new column is writable.
      expect(
        openRegistryStore(storage).createSession({ id: "new", title: null, machine: "a" }, 2),
      ).toMatchObject({
        machine: "a",
      });
    });
  });

  it("keeps a document by name, replacing it when it is put again", async () => {
    const registry = fresh();

    expect(await registry.getDocument("settings")).toBeNull();

    await registry.putDocument("settings", '{"a":1}', 1_000);
    await registry.putDocument("settings", '{"a":2}', 2_000);
    await registry.putDocument("other", "x", 2_000);

    expect(await registry.getDocument("settings")).toBe('{"a":2}');
    expect(await registry.getDocument("other")).toBe("x");
  });

  it("keeps its documents across an eviction", async () => {
    const registry = fresh();

    await registry.putDocument("settings", '{"a":1}', 1_000);
    await evictDurableObject(registry);

    expect(await registry.getDocument("settings")).toBe('{"a":1}');
  });

  it("adds the document table to a Registry that was already at the previous version", async () => {
    await runInDurableObject(fresh(), (_instance: TestRegistry, state) => {
      const { storage } = state;
      const { sql } = storage;

      // As the release before the documents left it: version 3, with no document table (or any later one).
      sql.exec("DROP TABLE documents");
      sql.exec("DROP TABLE push_subscriptions");
      sql.exec("ALTER TABLE sessions DROP COLUMN repo");
      sql.exec("ALTER TABLE sessions DROP COLUMN title_source");
      withoutNamesOrArchive(sql);
      sql.exec("DELETE FROM schema_version WHERE version > 3");

      const store = openRegistryStore(storage);

      store.putDocument("settings", "{}", 2_000);
      expect(store.getDocument("settings")).toBe("{}");
    });
  });

  it("keeps a Web Push subscription by endpoint, replacing it when its keys change", async () => {
    const registry = fresh();
    const first = { endpoint: "https://push.example/a", keys: { p256dh: "k1", auth: "a1" } };
    const second = { endpoint: "https://push.example/b", keys: { p256dh: "k2", auth: "a2" } };

    expect(await registry.listPushSubscriptions()).toEqual([]);
    expect(await registry.hasPushSubscription(first.endpoint)).toBe(false);

    await registry.putPushSubscription(first, 1_000);
    await registry.putPushSubscription(second, 2_000);
    await registry.putPushSubscription({ ...first, keys: { p256dh: "k3", auth: "a3" } }, 3_000);

    expect(await registry.hasPushSubscription(first.endpoint)).toBe(true);
    expect(await registry.listPushSubscriptions()).toEqual([
      second,
      { ...first, keys: { p256dh: "k3", auth: "a3" } },
    ]);
  });

  it("forgets a Web Push subscription, and ignores one that is not kept", async () => {
    const registry = fresh();
    const kept = { endpoint: "https://push.example/a", keys: { p256dh: "k1", auth: "a1" } };

    await registry.putPushSubscription(kept, 1_000);
    await registry.deletePushSubscription("https://push.example/unknown");
    expect(await registry.listPushSubscriptions()).toEqual([kept]);

    await registry.deletePushSubscription(kept.endpoint);
    expect(await registry.listPushSubscriptions()).toEqual([]);
  });

  it("keeps its Web Push subscriptions across an eviction", async () => {
    const registry = fresh();
    const kept = { endpoint: "https://push.example/a", keys: { p256dh: "k1", auth: "a1" } };

    await registry.putPushSubscription(kept, 1_000);
    await evictDurableObject(registry);

    expect(await registry.listPushSubscriptions()).toEqual([kept]);
  });

  it("binds a Session to the repo it is created with, and keeps it", async () => {
    const registry = fresh();

    const created = await registry.createSession(
      { id: "s-1", title: null, machine: "cloudpid", repo: "pi" },
      1_000,
    );

    expect(created).toMatchObject({ machine: "cloudpid", repo: "pi" });
    expect(await registry.getSession("s-1")).toEqual(created);
    expect(await registry.listSessions()).toEqual([created]);
  });

  it("adds the repo column to a Registry at the previous version, its Sessions working at the root", async () => {
    await runInDurableObject(fresh(), (_instance: TestRegistry, state) => {
      const { storage } = state;
      const { sql } = storage;

      // As the release before repos left it: version 5, Sessions without a repo column.
      sql.exec("ALTER TABLE sessions DROP COLUMN repo");
      sql.exec("ALTER TABLE sessions DROP COLUMN title_source");
      withoutNamesOrArchive(sql);
      sql.exec("DELETE FROM schema_version WHERE version > 5");
      sql.exec(
        "INSERT INTO sessions (id, title, workspace, status, created_at, updated_at) VALUES ('old', NULL, 'a', 'idle', 1, 1)",
      );

      const store = openRegistryStore(storage);

      expect(store.getSession("old")).toMatchObject({ machine: "a", repo: null });
      expect(store.createSession({ id: "new", title: null, repo: "pi" }, 2)).toMatchObject({
        repo: "pi",
      });
    });
  });

  it("has no title source for a Session created without a title", async () => {
    const registry = fresh();

    expect(await registry.createSession({ id: "s-1", title: null }, 1_000)).toMatchObject({
      title: null,
      titleSource: null,
    });
  });

  it("sets a generated title once, on a Session that has none", async () => {
    const registry = fresh();

    await registry.createSession({ id: "s-1", title: null }, 1_000);

    expect(await registry.setGeneratedTitle("s-1", "Fix the build")).toBe(true);
    expect(await registry.getSession("s-1")).toMatchObject({
      title: "Fix the build",
      titleSource: "generated",
    });

    // A second generation does not replace the first.
    expect(await registry.setGeneratedTitle("s-1", "Something else")).toBe(false);
    expect((await registry.getSession("s-1"))?.title).toBe("Fix the build");
  });

  it("never replaces the owner's title with a generated one", async () => {
    const registry = fresh();

    await registry.createSession({ id: "named", title: "Mine" }, 1_000);
    await registry.createSession({ id: "renamed", title: null }, 1_000);
    await registry.createSession({ id: "regenerated", title: null }, 1_000);

    expect(await registry.setGeneratedTitle("named", "Generated")).toBe(false);

    // Renamed before the title was generated, and after.
    await registry.renameSession("renamed", "Also mine");
    expect(await registry.setGeneratedTitle("renamed", "Generated")).toBe(false);
    await registry.setGeneratedTitle("regenerated", "Generated");
    await registry.renameSession("regenerated", "Mine now");
    expect(await registry.setGeneratedTitle("regenerated", "Generated again")).toBe(false);

    expect(await registry.getSession("named")).toMatchObject({
      title: "Mine",
      titleSource: "owner",
    });
    expect(await registry.getSession("renamed")).toMatchObject({
      title: "Also mine",
      titleSource: "owner",
    });
    expect(await registry.getSession("regenerated")).toMatchObject({
      title: "Mine now",
      titleSource: "owner",
    });
  });

  it("renames a Session, leaving its other fields alone, and ignores one it does not know", async () => {
    const registry = fresh();

    await registry.createSession({ id: "s-1", title: null, machine: "cloudpid" }, 1_000);
    await registry.setSessionStatus("s-1", "running", 2_000);

    expect(await registry.renameSession("s-1", "Fix the build")).toEqual({
      id: "s-1",
      title: "Fix the build",
      titleSource: "owner",
      machine: "cloudpid",
      repo: null,
      workspace: null,
      status: "running",
      createdAt: 1_000,
      updatedAt: 2_000,
      archivedAt: null,
    });
    expect(await registry.renameSession("ghost", "Nope")).toBeNull();
    expect(await registry.listSessions()).toHaveLength(1);
  });

  it("adds the title source to a Registry at the previous version: a title it holds is the owner's", async () => {
    await runInDurableObject(fresh(), (_instance: TestRegistry, state) => {
      const { storage } = state;
      const { sql } = storage;

      // As the release before generated titles left it: version 6, Sessions without a title source.
      sql.exec("ALTER TABLE sessions DROP COLUMN title_source");
      withoutNamesOrArchive(sql);
      sql.exec("DELETE FROM schema_version WHERE version >= 7");
      sql.exec(
        "INSERT INTO sessions (id, title, workspace, status, created_at, updated_at) VALUES ('named', 'Mine', 'a', 'idle', 1, 1), ('bare', NULL, 'a', 'idle', 2, 2)",
      );

      const store = openRegistryStore(storage);

      expect(store.getSession("named")).toMatchObject({ title: "Mine", titleSource: "owner" });
      expect(store.getSession("bare")).toMatchObject({ title: null, titleSource: null });
      expect(store.setGeneratedTitle("named", "Generated")).toBe(false);
      expect(store.setGeneratedTitle("bare", "Generated")).toBe(true);
    });
  });

  it("archives a Session, keeping it whole and listed, and unarchives it", async () => {
    const registry = fresh();

    const created = await registry.createSession(
      { id: "s-1", title: "Keep me", machine: "cloudpid", repo: "pi" },
      1_000,
    );

    const archived = await registry.archiveSession("s-1", 5_000);

    expect(archived).toEqual({ ...created, archivedAt: 5_000 });
    expect(await registry.listSessions()).toEqual([archived]);

    // Archiving again keeps the first time.
    expect(await registry.archiveSession("s-1", 6_000)).toMatchObject({ archivedAt: 5_000 });

    expect(await registry.unarchiveSession("s-1")).toEqual(created);
    expect(await registry.getSession("s-1")).toEqual(created);
  });

  it("archives and unarchives nothing for a Session it does not know", async () => {
    const registry = fresh();

    expect(await registry.archiveSession("ghost", 1_000)).toBeNull();
    expect(await registry.unarchiveSession("ghost")).toBeNull();
  });

  it("deletes a Session, and only that one", async () => {
    const registry = fresh();

    await registry.createSession({ id: "s-1", title: null }, 1_000);
    await registry.createSession({ id: "s-2", title: null }, 2_000);

    expect(await registry.deleteSession("s-1")).toBe(true);
    expect(await registry.getSession("s-1")).toBeNull();
    expect(await registry.listSessions()).toMatchObject([{ id: "s-2" }]);
    expect(await registry.deleteSession("s-1")).toBe(false);
  });

  it("names a new Machine after its slug", async () => {
    const registry = fresh();

    expect(await registry.createMachine("cloudpid", 1_000)).toMatchObject({
      slug: "cloudpid",
      name: "cloudpid",
    });
    expect(await registry.getMachine(DEFAULT_MACHINE)).toMatchObject({
      name: DEFAULT_MACHINE,
    });
    expect(await registry.getMachine("ghost")).toBeNull();
  });

  it("renames a Machine, keeping its slug, and refuses a name another Machine has in any case", async () => {
    const registry = fresh();

    await registry.createMachine("cloudpid", 1_000);
    await registry.createMachine("pi", 2_000);

    expect(await registry.renameMachine("cloudpid", "Pi on Cloudflare")).toEqual({
      status: "renamed",
      machine: { slug: "cloudpid", name: "Pi on Cloudflare", createdAt: 1_000 },
    });
    expect(await registry.renameMachine("pi", "PI ON CLOUDFLARE")).toEqual({ status: "taken" });
    expect(await registry.renameMachine("pi", "CloudPid")).toMatchObject({ status: "renamed" });
    // A Machine may change the case of its own name.
    expect(await registry.renameMachine("cloudpid", "pi on cloudflare")).toMatchObject({
      status: "renamed",
    });
    expect(await registry.renameMachine("ghost", "Anything")).toEqual({ status: "missing" });
    expect(await registry.getMachine("pi")).toMatchObject({ name: "CloudPid" });
  });

  it("gives a new Machine whose slug another Machine is named a name of its own", async () => {
    const registry = fresh();

    await registry.renameMachine(DEFAULT_MACHINE, "cloudpid");

    expect(await registry.createMachine("cloudpid", 1_000)).toMatchObject({
      slug: "cloudpid",
      name: "cloudpid 2",
    });
  });

  it("deletes a Machine's record, after which its slug registers afresh", async () => {
    const registry = fresh();

    await registry.createMachine("cloudpid", 1_000);
    await registry.renameMachine("cloudpid", "Old name");

    expect(await registry.deleteMachine("cloudpid")).toBe("deleted");
    expect(await registry.getMachine("cloudpid")).toBeNull();
    expect(await slugs(registry)).toEqual([DEFAULT_MACHINE]);
    expect(await registry.deleteMachine("cloudpid")).toBe("missing");

    expect(await registry.createMachine("cloudpid", 9_000)).toEqual({
      slug: "cloudpid",
      name: "cloudpid",
      createdAt: 9_000,
    });
  });

  it("keeps a Machine's record while a Session is still bound to it", async () => {
    const registry = fresh();

    await registry.createSession({ id: "late", title: null, machine: "cloudpid" }, 1_000);

    expect(await registry.deleteMachine("cloudpid")).toBe("in-use");
    expect(await slugs(registry)).toContain("cloudpid");

    await registry.deleteSession("late");

    expect(await registry.deleteMachine("cloudpid")).toBe("deleted");
  });

  it("refuses a Machine name another one has in any case, beyond ASCII", async () => {
    const registry = fresh();

    await registry.createMachine("fruit", 1_000);
    await registry.createMachine("more", 2_000);
    await registry.renameMachine("fruit", "Äpfel");

    expect(await registry.renameMachine("more", "äPFEL")).toEqual({ status: "taken" });
  });

  it("names the Machines of a Registry at the previous version after their slugs, and leaves its Sessions unarchived", async () => {
    await runInDurableObject(fresh(), (_instance: TestRegistry, state) => {
      const { storage } = state;
      const { sql } = storage;

      // As the release before names and archiving left it: version 7.
      withoutNamesOrArchive(sql);
      sql.exec("DELETE FROM schema_version WHERE version > 7");
      sql.exec("INSERT INTO workspaces (slug, created_at) VALUES ('cloudpid', 5)");
      sql.exec(
        "INSERT INTO sessions (id, title, workspace, status, created_at, updated_at) VALUES ('old', NULL, 'cloudpid', 'idle', 1, 1)",
      );

      const store = openRegistryStore(storage);

      expect(store.getMachine("cloudpid")).toEqual({
        slug: "cloudpid",
        name: "cloudpid",
        createdAt: 5,
      });
      expect(store.getSession("old")).toMatchObject({ archivedAt: null });
      expect(store.renameMachine(DEFAULT_MACHINE, "CLOUDPID")).toEqual({ status: "taken" });
    });
  });

  it("creates a Session in a new Workspace of its own, registering the Workspace with it", async () => {
    const registry = fresh();

    const created = await registry.createSession(
      {
        id: "s-1",
        title: null,
        machine: "cloudpid",
        repo: "app",
        workspace: { kind: "new", id: "1a2b3c4d", branch: "cloudpid/1a2b3c4d" },
      },
      1_000,
    );

    expect(created).toMatchObject({ machine: "cloudpid", repo: "app", workspace: "1a2b3c4d" });
    expect(await registry.getSession("s-1")).toEqual(created);
    expect(await registry.listWorkspaces()).toEqual([
      {
        id: "1a2b3c4d",
        machine: "cloudpid",
        repo: "app",
        branch: "cloudpid/1a2b3c4d",
        directory: "/workspace/.worktrees/app/1a2b3c4d",
        createdAt: 1_000,
      },
    ]);
  });

  it("binds a Session to a Workspace that exists, and one without to its repo's main checkout", async () => {
    const registry = fresh();
    const workspace = { kind: "new" as const, id: "1a2b3c4d", branch: "feature" };

    await registry.createSession({ id: "first", title: null, repo: "app", workspace }, 1_000);

    expect(
      await registry.createSession(
        { id: "second", title: null, repo: "app", workspace: { kind: "existing", id: "1a2b3c4d" } },
        2_000,
      ),
    ).toMatchObject({ workspace: "1a2b3c4d" });
    expect(
      await registry.createSession({ id: "main", title: null, repo: "app" }, 3_000),
    ).toMatchObject({ workspace: null });
    expect(await registry.listWorkspaces()).toHaveLength(1);
  });

  it("registers neither the Session nor the Workspace when the Workspace's id is taken", async () => {
    const registry = fresh();
    const workspace = { kind: "new" as const, id: "1a2b3c4d", branch: "feature" };

    await registry.createSession({ id: "first", title: null, repo: "app", workspace }, 1_000);

    await refuses(registry, { id: "second", title: null, repo: "app", workspace }, 2_000);
    expect(await registry.getSession("second")).toBeNull();
  });

  it("registers no Session in a Workspace that is gone, or of another Machine or repo", async () => {
    const registry = fresh();
    const workspace = { kind: "new" as const, id: "1a2b3c4d", branch: "feature" };

    await registry.createSession({ id: "first", title: null, repo: "app", workspace }, 1_000);

    for (const [input, id] of [
      [{ repo: "app", workspace: { kind: "existing" as const, id: "deadbeef" } }, "gone"],
      [{ repo: "other", workspace: { kind: "existing" as const, id: "1a2b3c4d" } }, "repo"],
      [
        { machine: "m", repo: "app", workspace: { kind: "existing" as const, id: "1a2b3c4d" } },
        "machine",
      ],
    ] as const) {
      await refuses(registry, { id, title: null, ...input }, 2_000);
      expect(await registry.getSession(id)).toBeNull();
    }
  });

  it("registers no second Workspace of a repo on a branch one is on", async () => {
    const registry = fresh();

    await registry.createSession(
      {
        id: "first",
        title: null,
        repo: "app",
        workspace: { kind: "new", id: "1a2b3c4d", branch: "feature" },
      },
      1_000,
    );

    await refuses(
      registry,
      {
        id: "second",
        title: null,
        repo: "app",
        workspace: { kind: "new", id: "5e6f7a8b", branch: "feature" },
      },
      2_000,
    );
    expect(await registry.getSession("second")).toBeNull();
    expect(await registry.listWorkspaces()).toHaveLength(1);

    // Another repo's, or another Machine's, may be on it.
    await registry.createSession(
      {
        id: "third",
        title: null,
        machine: "m",
        repo: "app",
        workspace: { kind: "new", id: "9c0d1e2f", branch: "feature" },
      },
      3_000,
    );
    expect(await registry.listWorkspaces()).toHaveLength(2);
  });

  it("deletes a Workspace's record only once no Session is bound to it", async () => {
    const registry = fresh();

    await registry.createSession(
      {
        id: "s-1",
        title: null,
        repo: "app",
        workspace: { kind: "new", id: "1a2b3c4d", branch: "b" },
      },
      1_000,
    );

    expect(await registry.deleteWorkspace("1a2b3c4d")).toBe("in-use");

    await registry.deleteSession("s-1");

    expect(await registry.deleteWorkspace("1a2b3c4d")).toBe("deleted");
    expect(await registry.getWorkspace("1a2b3c4d")).toBeNull();
    expect(await registry.deleteWorkspace("1a2b3c4d")).toBe("missing");
  });

  it("deletes the unbound Workspaces of a Machine, or of one of its repos", async () => {
    const registry = fresh();

    const make = (id: string, machine: string, repo: string) =>
      registry.createSession(
        { id: `s-${id}`, title: null, machine, repo, workspace: { kind: "new", id, branch: id } },
        1_000,
      );

    await make("00000001", "m", "app");
    await make("00000002", "m", "app");
    await make("00000003", "m", "other");
    await make("00000004", "n", "app");
    await registry.deleteSession("s-00000001");
    await registry.deleteSession("s-00000003");
    await registry.deleteSession("s-00000004");

    await registry.deleteWorkspacesOf("m", "app");

    const ids = async () => Arr.map(await registry.listWorkspaces(), (w) => w.id).sort();

    // Bound to a Session, so kept; another repo; another Machine.
    expect(await ids()).toEqual(["00000002", "00000003", "00000004"]);

    await registry.deleteWorkspacesOf("m");

    expect(await ids()).toEqual(["00000002", "00000004"]);
  });

  it("forgets a Machine's Workspaces with the Machine", async () => {
    const registry = fresh();

    await registry.createSession(
      {
        id: "s-1",
        title: null,
        machine: "m",
        repo: "app",
        workspace: { kind: "new", id: "1a2b3c4d", branch: "b" },
      },
      1_000,
    );
    await registry.deleteSession("s-1");

    expect(await registry.deleteMachine("m")).toBe("deleted");
    expect(await registry.listWorkspaces()).toEqual([]);
  });

  it("adds Workspaces to a Registry at the previous version, its Sessions in their repos' main checkouts", async () => {
    await runInDurableObject(fresh(), (_instance: TestRegistry, state) => {
      const { storage } = state;
      const { sql } = storage;

      // As the release before Workspaces of their own left it: version 9.
      withoutWorkspaces(sql);
      sql.exec("DELETE FROM schema_version WHERE version > 9");
      sql.exec(
        "INSERT INTO sessions (id, title, workspace, repo, status, created_at, updated_at) VALUES ('old', NULL, 'a', 'app', 'idle', 1, 1)",
      );

      const store = openRegistryStore(storage);

      expect(store.getSession("old")).toMatchObject({ repo: "app", workspace: null });
      expect(store.listWorkspaces()).toEqual([]);
    });
  });

  it("keeps its Sessions and Machines across an eviction", async () => {
    const registry = fresh();

    await registry.createSession({ id: "s-1", title: "Survivor", machine: "cloudpid" }, 1_000);
    await registry.setSessionStatus("s-1", "running", 2_000);

    await evictDurableObject(registry);

    // A new instance reopens the same storage.
    expect(await registry.listSessions()).toMatchObject([
      { id: "s-1", title: "Survivor", machine: "cloudpid", status: "running", updatedAt: 2_000 },
    ]);
    expect(await registry.listMachines()).toContainEqual({
      slug: "cloudpid",
      name: "cloudpid",
      createdAt: 1_000,
    });
  });

  it("leaves no trace of a migration step that fails partway, and runs it whole next time", async () => {
    await runInDurableObject(fresh(), (_instance: TestRegistry, state) => {
      const { storage } = state;
      const { sql } = storage;
      const versions = () => sql.exec("SELECT MAX(version) AS version FROM schema_version").one();

      const failing = [
        ...MIGRATIONS,
        (steps: SqlStorage) => {
          steps.exec("CREATE TABLE half_done (a INTEGER)");
          throw new Error("boom");
        },
      ];

      expect(() => migrate(storage, failing)).toThrow("boom");
      expect(versions()).toEqual({ version: MIGRATIONS.length });
      expect(sql.exec("SELECT name FROM sqlite_master WHERE name = 'half_done'").toArray()).toEqual(
        [],
      );

      // A step that no longer fails now runs in full, and is recorded.
      migrate(storage, [
        ...MIGRATIONS,
        (steps) => steps.exec("CREATE TABLE half_done (a INTEGER)"),
      ]);
      expect(versions()).toEqual({ version: MIGRATIONS.length + 1 });
    });
  });
});
