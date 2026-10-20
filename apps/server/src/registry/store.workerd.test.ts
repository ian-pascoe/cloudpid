// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { DEFAULT_WORKSPACE } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import * as Arr from "effect/Array";
import { describe, expect, it } from "vitest";
import { openRegistryStore } from "./store.ts";
import type { TestRegistry } from "./store.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly REGISTRIES: DurableObjectNamespace<TestRegistry>;
    }
  }
}

const fresh = () => env.REGISTRIES.get(env.REGISTRIES.newUniqueId());

describe("the Registry store", () => {
  it("lists a created Session as idle with its title and timestamps", async () => {
    const registry = fresh();

    const created = await registry.createSession({ id: "s-1", title: "Fix the build" }, 1_000);

    expect(created).toEqual({
      id: "s-1",
      title: "Fix the build",
      workspace: DEFAULT_WORKSPACE,
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
    expect(await registry.listWorkspaces()).toEqual([{ slug: "cloudpid", createdAt: 1_000 }]);
  });

  it("binds a Session to the Workspace it is created with, and lists that Workspace", async () => {
    const registry = fresh();

    const created = await registry.createSession(
      { id: "s-1", title: null, workspace: "cloudpid" },
      1_000,
    );

    expect(created.workspace).toBe("cloudpid");
    expect((await registry.getSession("s-1"))?.workspace).toBe("cloudpid");
    expect(await registry.listWorkspaces()).toEqual([{ slug: "cloudpid", createdAt: 1_000 }]);
  });

  it("binds a Session created without a Workspace to the default one", async () => {
    const registry = fresh();

    await registry.createSession({ id: "s-1", title: null }, 1_000);

    expect((await registry.getSession("s-1"))?.workspace).toBe(DEFAULT_WORKSPACE);
    expect(await registry.listWorkspaces()).toEqual([
      { slug: DEFAULT_WORKSPACE, createdAt: 1_000 },
    ]);
  });

  it("opens a Registry written before Sessions had Workspaces, binding its Sessions to the default", async () => {
    await runInDurableObject(fresh(), (_instance: TestRegistry, state) => {
      const { sql } = state.storage;

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

      const store = openRegistryStore(sql);

      expect(store.getSession("old")).toMatchObject({ id: "old", workspace: DEFAULT_WORKSPACE });
      // Opening again changes nothing, and the new column is writable.
      expect(
        openRegistryStore(sql).createSession({ id: "new", title: null, workspace: "a" }, 2),
      ).toMatchObject({
        workspace: "a",
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
    expect(await registry.listWorkspaces()).toEqual([{ slug: "cloudpid", createdAt: 1_000 }]);
  });
});
