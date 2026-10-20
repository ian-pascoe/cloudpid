// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { DEFAULT_WORKSPACE } from "@cloudpid/protocol";
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

/** The slugs of the Workspaces the Registry lists, in name order. */
const slugs = async (registry: DurableObjectStub<TestRegistry>) =>
  Arr.sort(
    Arr.map(await registry.listWorkspaces(), (workspace) => workspace.slug),
    Order.String,
  );

const fresh = () => env.REGISTRIES.get(env.REGISTRIES.newUniqueId());

describe("the Registry store", () => {
  it("lists a created Session as idle with its title and timestamps", async () => {
    const registry = fresh();

    const created = await registry.createSession({ id: "s-1", title: "Fix the build" }, 1_000);

    expect(created).toEqual({
      id: "s-1",
      title: "Fix the build",
      workspace: DEFAULT_WORKSPACE,
      repo: null,
      status: "idle",
      createdAt: 1_000,
      updatedAt: 1_000,
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

  it("records a Workspace by slug once, however often it is created", async () => {
    const registry = fresh();

    await registry.createWorkspace("cloudpid", 1_000);
    const again = await registry.createWorkspace("cloudpid", 2_000);

    expect(again).toEqual({ slug: "cloudpid", createdAt: 1_000 });
    expect(await registry.listWorkspaces()).toContainEqual({ slug: "cloudpid", createdAt: 1_000 });
    expect(await slugs(registry)).toEqual(["cloudpid", DEFAULT_WORKSPACE]);
  });

  it("lists the default Workspace before any Session is created in it", async () => {
    expect(await slugs(fresh())).toEqual([DEFAULT_WORKSPACE]);
  });

  it("binds a Session to the Workspace it is created with, and lists that Workspace", async () => {
    const registry = fresh();

    const created = await registry.createSession(
      { id: "s-1", title: null, workspace: "cloudpid" },
      1_000,
    );

    expect(created.workspace).toBe("cloudpid");
    expect((await registry.getSession("s-1"))?.workspace).toBe("cloudpid");
    expect(await registry.listWorkspaces()).toContainEqual({ slug: "cloudpid", createdAt: 1_000 });
  });

  it("binds a Session created without a Workspace to the default one", async () => {
    const registry = fresh();

    await registry.createSession({ id: "s-1", title: null }, 1_000);

    expect((await registry.getSession("s-1"))?.workspace).toBe(DEFAULT_WORKSPACE);
    expect(await slugs(registry)).toEqual([DEFAULT_WORKSPACE]);
  });

  it("opens a Registry written before Sessions had Workspaces, binding its Sessions to the default", async () => {
    await runInDurableObject(fresh(), (_instance: TestRegistry, state) => {
      const { storage } = state;
      const { sql } = storage;

      // The first deployed schema: no `workspace` column, no schema version.
      sql.exec("DROP TABLE sessions");
      sql.exec("DROP TABLE schema_version");
      sql.exec(`CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`);
      sql.exec("INSERT INTO sessions VALUES ('old', 'Before', 'idle', 1, 1)");

      const store = openRegistryStore(storage);

      expect(store.getSession("old")).toMatchObject({ id: "old", workspace: DEFAULT_WORKSPACE });
      // Opening again changes nothing, and the new column is writable.
      expect(
        openRegistryStore(storage).createSession({ id: "new", title: null, workspace: "a" }, 2),
      ).toMatchObject({
        workspace: "a",
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
      { id: "s-1", title: null, workspace: "cloudpid", repo: "pi" },
      1_000,
    );

    expect(created).toMatchObject({ workspace: "cloudpid", repo: "pi" });
    expect(await registry.getSession("s-1")).toEqual(created);
    expect(await registry.listSessions()).toEqual([created]);
  });

  it("adds the repo column to a Registry at the previous version, its Sessions working at the root", async () => {
    await runInDurableObject(fresh(), (_instance: TestRegistry, state) => {
      const { storage } = state;
      const { sql } = storage;

      // As the release before repos left it: version 5, Sessions without a repo column.
      sql.exec("ALTER TABLE sessions DROP COLUMN repo");
      sql.exec("DELETE FROM schema_version WHERE version = 6");
      sql.exec(
        "INSERT INTO sessions (id, title, workspace, status, created_at, updated_at) VALUES ('old', NULL, 'a', 'idle', 1, 1)",
      );

      const store = openRegistryStore(storage);

      expect(store.getSession("old")).toMatchObject({ workspace: "a", repo: null });
      expect(store.createSession({ id: "new", title: null, repo: "pi" }, 2)).toMatchObject({
        repo: "pi",
      });
    });
  });

  it("keeps its Sessions and Workspaces across an eviction", async () => {
    const registry = fresh();

    await registry.createSession({ id: "s-1", title: "Survivor", workspace: "cloudpid" }, 1_000);
    await registry.setSessionStatus("s-1", "running", 2_000);

    await evictDurableObject(registry);

    // A new instance reopens the same storage.
    expect(await registry.listSessions()).toMatchObject([
      { id: "s-1", title: "Survivor", workspace: "cloudpid", status: "running", updatedAt: 2_000 },
    ]);
    expect(await registry.listWorkspaces()).toContainEqual({ slug: "cloudpid", createdAt: 1_000 });
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
