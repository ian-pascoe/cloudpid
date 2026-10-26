// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { DEFAULT_ENVIRONMENT, MAX_ENVIRONMENT_SECRETS, SPARE_BRANCH } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import {
  EVERY_ENVIRONMENT_DOCUMENT,
  readEveryEnvironment,
  writeEveryEnvironment,
} from "./every-environment.ts";
import { MIGRATIONS, migrate, openRegistryStore, type StoredWorkspaceChoice } from "./store.ts";
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

/** A new Workspace of `environment` for a Session to be created in. */
const newWorkspace = (
  id: string,
  branch = `cloudpid/${id}`,
  environment = DEFAULT_ENVIRONMENT,
  base: string | null = null,
): StoredWorkspaceChoice => ({ kind: "new", id, environment, branch, base });

/** A Workspace that exists, for a Session to be created in. */
const existing = (id: string): StoredWorkspaceChoice => ({ kind: "existing", id });

/** The Registry's Sessions' IDs, newest first. */
const sessionIds = async (registry: DurableObjectStub<TestRegistry>) =>
  Arr.map(await registry.listSessions(), (session) => session.id);

/** Make an Environment named `name` with the given id and add `repos` to it. */
const environmentWith = async (
  registry: DurableObjectStub<TestRegistry>,
  id: string,
  name: string,
  repos: ReadonlyArray<string> = [],
) => {
  await registry.createEnvironment(id, name, 1_000);

  for (const repo of repos) {
    await registry.addRepo(id, { name: repo, url: `https://github.com/o/${repo}.git` });
  }
};

describe("the Registry store", () => {
  it("lists a created Session as idle with its title, Environment, Workspace and timestamps", async () => {
    const registry = fresh();

    const created = await registry.createSession(
      { id: "s-1", title: "Fix the build", workspace: newWorkspace("1a2b3c4d") },
      1_000,
    );

    expect(created).toEqual({
      id: "s-1",
      title: "Fix the build",
      titleSource: "owner",
      environment: DEFAULT_ENVIRONMENT,
      workspace: "1a2b3c4d",
      status: "idle",
      createdAt: 1_000,
      updatedAt: 1_000,
      archivedAt: null,
    });
    expect(await registry.listSessions()).toEqual([created]);
  });

  it("finds a registered Session by its ID, and nothing for an unknown one", async () => {
    const registry = fresh();

    const created = await registry.createSession(
      { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d") },
      1_000,
    );

    expect(await registry.getSession("s-1")).toEqual(created);
    expect(await registry.getSession("s-2")).toBeNull();
  });

  it("lists Sessions newest first", async () => {
    const registry = fresh();

    await registry.createSession(
      { id: "old", title: null, workspace: newWorkspace("00000001") },
      1_000,
    );
    await registry.createSession(
      { id: "new", title: null, workspace: newWorkspace("00000002") },
      2_000,
    );

    expect(await sessionIds(registry)).toEqual(["new", "old"]);
  });

  it("tracks a Session going running and back to idle", async () => {
    const registry = fresh();

    await registry.createSession(
      { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d") },
      1_000,
    );
    await registry.setSessionStatus("s-1", "running", 2_000);
    expect(await registry.listSessions()).toMatchObject([{ status: "running", updatedAt: 2_000 }]);

    await registry.setSessionStatus("s-1", "idle", 3_000);
    expect(await registry.listSessions()).toMatchObject([{ status: "idle", updatedAt: 3_000 }]);
  });

  it("leaves updatedAt alone when a report repeats the current status", async () => {
    const registry = fresh();

    await registry.createSession(
      { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d") },
      1_000,
    );
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

    await registry.createSession(
      { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d") },
      1_000,
    );
    // Inside the object, so the throw is caught here instead of surfacing as an uncaught exception.
    await runInDurableObject(registry, (instance: TestRegistry, state) => {
      // @ts-expect-error -- a status outside the union, as a caller that skipped the type might send
      expect(() => instance.setSessionStatus("s-1", "exploded", 2_000)).toThrow(/Unknown/);
      state.storage.sql.exec("UPDATE sessions SET status = 'exploded'");
      expect(() => instance.listSessions()).toThrow(/Unknown/);
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

  it("keeps the variables for every Environment in a document, across an eviction, with no migration of its own", async () => {
    const registry = fresh();

    await runInDurableObject(registry, (_: TestRegistry, state) => {
      const store = openRegistryStore(state.storage);

      Result.getOrThrow(writeEveryEnvironment(store, { variables: { EMAIL: "me@test" } }, 1_000));
    });
    await evictDurableObject(registry);

    await runInDurableObject(registry, (_: TestRegistry, state) => {
      const store = openRegistryStore(state.storage);

      expect(readEveryEnvironment(store)).toEqual({
        settings: { variables: { EMAIL: "me@test" } },
        overrides: { variables: { EMAIL: "me@test" } },
      });
      expect(store.getDocument(EVERY_ENVIRONMENT_DOCUMENT)).toBe(
        '{"variables":{"EMAIL":"me@test"}}',
      );
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

  it("has no title source for a Session created without a title", async () => {
    const registry = fresh();

    expect(
      await registry.createSession(
        { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d") },
        1_000,
      ),
    ).toMatchObject({ title: null, titleSource: null });
  });

  it("sets a generated title once, on a Session that has none", async () => {
    const registry = fresh();

    await registry.createSession(
      { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d") },
      1_000,
    );

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
    const choice = newWorkspace("1a2b3c4d");

    await registry.createSession({ id: "named", title: "Mine", workspace: choice }, 1_000);
    await registry.createSession(
      { id: "renamed", title: null, workspace: existing("1a2b3c4d") },
      1_000,
    );
    await registry.createSession(
      { id: "regenerated", title: null, workspace: existing("1a2b3c4d") },
      1_000,
    );

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

    await registry.createSession(
      { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d") },
      1_000,
    );
    await registry.setSessionStatus("s-1", "running", 2_000);

    expect(await registry.renameSession("s-1", "Fix the build")).toEqual({
      id: "s-1",
      title: "Fix the build",
      titleSource: "owner",
      environment: DEFAULT_ENVIRONMENT,
      workspace: "1a2b3c4d",
      status: "running",
      createdAt: 1_000,
      updatedAt: 2_000,
      archivedAt: null,
    });
    expect(await registry.renameSession("ghost", "Nope")).toBeNull();
    expect(await registry.listSessions()).toHaveLength(1);
  });

  it("archives a Session, keeping it whole and listed, and unarchives it", async () => {
    const registry = fresh();

    const created = await registry.createSession(
      { id: "s-1", title: "Keep me", workspace: newWorkspace("1a2b3c4d") },
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

  it("deletes a Session, and only that one, leaving its Workspace", async () => {
    const registry = fresh();

    await registry.createSession(
      { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d") },
      1_000,
    );
    await registry.createSession(
      { id: "s-2", title: null, workspace: existing("1a2b3c4d") },
      2_000,
    );

    expect(await registry.deleteSession("s-1")).toBe(true);
    expect(await registry.getSession("s-1")).toBeNull();
    expect(await registry.listSessions()).toMatchObject([{ id: "s-2" }]);
    expect(await registry.deleteSession("s-1")).toBe(false);
    expect(await registry.getWorkspace("1a2b3c4d")).not.toBeNull();
  });

  it("records the Session a Fork or Clone was made from, and keeps it once that one is deleted", async () => {
    const registry = fresh();

    await registry.createSession(
      { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d") },
      1_000,
    );

    const forked = await registry.createSession(
      {
        id: "s-2",
        title: "Fix (fork)",
        workspace: existing("1a2b3c4d"),
        origin: { session: "s-1", kind: "fork" },
      },
      2_000,
    );

    expect(forked).toMatchObject({ id: "s-2", origin: { session: "s-1", kind: "fork" } });
    expect(await registry.getSession("s-2")).toEqual(forked);

    await registry.deleteSession("s-1");

    expect(await registry.listSessions()).toEqual([forked]);
    // A Session started afresh has none.
    expect(
      await registry.createSession(
        { id: "s-3", title: null, workspace: existing("1a2b3c4d") },
        3_000,
      ),
    ).not.toHaveProperty("origin");
  });

  it("lists the default Environment before anything is created", async () => {
    expect(await fresh().listEnvironments()).toEqual([
      expect.objectContaining({ id: DEFAULT_ENVIRONMENT, name: "Default", repos: [] }),
    ]);
  });

  it("creates an Environment with no Repos, and lists the newest first", async () => {
    const registry = fresh();
    // The default Environment was made at the real time.
    const future = 4_000_000_000_000;

    const named = await registry.createEnvironment("0000abcd", "Cloudpid", future);

    expect(named).toEqual({
      status: "named",
      environment: { id: "0000abcd", name: "Cloudpid", repos: [], createdAt: future },
    });
    expect(await registry.getEnvironment("0000abcd")).toEqual(
      expect.objectContaining({ name: "Cloudpid" }),
    );
    expect(await registry.getEnvironment("ghost")).toBeNull();
    expect(Arr.map(await registry.listEnvironments(), (item) => item.id)).toEqual([
      "0000abcd",
      DEFAULT_ENVIRONMENT,
    ]);
  });

  it("refuses an Environment name another has in any case, and an id that is taken", async () => {
    const registry = fresh();

    await registry.createEnvironment("0000abcd", "Cloudpid", 1_000);

    expect(await registry.createEnvironment("0000abce", "CLOUDPID", 2_000)).toEqual({
      status: "taken",
    });
    expect(await registry.createEnvironment("0000abce", "default", 2_000)).toEqual({
      status: "taken",
    });
    expect(await registry.createEnvironment("0000abcd", "Other", 2_000)).toEqual({
      status: "taken",
    });
    expect(await registry.listEnvironments()).toHaveLength(2);
  });

  it("refuses an Environment name another has in any case, beyond ASCII", async () => {
    const registry = fresh();

    await registry.createEnvironment("0000abcd", "Äpfel", 1_000);

    expect(await registry.createEnvironment("0000abce", "äPFEL", 2_000)).toEqual({
      status: "taken",
    });
  });

  it("renames an Environment, keeping its id, and refuses a name another has in any case", async () => {
    const registry = fresh();

    await registry.createEnvironment("0000abcd", "Cloudpid", 1_000);
    await registry.createEnvironment("0000abce", "Pi", 2_000);

    expect(await registry.renameEnvironment("0000abcd", "Pi on Cloudflare")).toEqual({
      status: "named",
      environment: { id: "0000abcd", name: "Pi on Cloudflare", repos: [], createdAt: 1_000 },
    });
    expect(await registry.renameEnvironment("0000abce", "PI ON CLOUDFLARE")).toEqual({
      status: "taken",
    });
    // An Environment may change the case of its own name.
    expect(await registry.renameEnvironment("0000abcd", "pi on cloudflare")).toMatchObject({
      status: "named",
    });
    expect(await registry.renameEnvironment("ghost", "Anything")).toEqual({ status: "missing" });
    expect(await registry.getEnvironment("0000abce")).toMatchObject({ name: "Pi" });
  });

  it("deletes an Environment only while no Workspace is made from it", async () => {
    const registry = fresh();

    await registry.createEnvironment("0000abcd", "Cloudpid", 1_000);
    await registry.createSession(
      { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d", "b", "0000abcd") },
      2_000,
    );

    expect(await registry.deleteEnvironment("0000abcd")).toBe("in-use");
    expect(await registry.getEnvironment("0000abcd")).not.toBeNull();

    // A Workspace outlives its Sessions; only its own record releases the Environment.
    await registry.deleteSession("s-1");
    expect(await registry.deleteEnvironment("0000abcd")).toBe("in-use");
    expect(await registry.deleteWorkspace("1a2b3c4d")).toBe("deleted");

    expect(await registry.deleteEnvironment("0000abcd")).toBe("deleted");
    expect(await registry.getEnvironment("0000abcd")).toBeNull();
    expect(await registry.deleteEnvironment("0000abcd")).toBe("missing");
  });

  it("refuses to delete the default Environment, which a new Session always has to start in", async () => {
    const registry = fresh();

    expect(await registry.deleteEnvironment(DEFAULT_ENVIRONMENT)).toBe("refused");
    expect(await registry.getEnvironment(DEFAULT_ENVIRONMENT)).toMatchObject({ name: "Default" });
  });

  it("adds Repos to an Environment in order, refusing a directory name it has", async () => {
    const registry = fresh();

    await registry.createEnvironment("0000abcd", "Cloudpid", 1_000);

    expect(
      await registry.addRepo("0000abcd", { name: "app", url: "https://github.com/o/app.git" }),
    ).toBe("changed");
    expect(
      await registry.addRepo("0000abcd", { name: "pi", url: "https://github.com/o/pi.git" }),
    ).toBe("changed");
    expect(
      await registry.addRepo("0000abcd", { name: "app", url: "https://github.com/o/other.git" }),
    ).toBe("taken");
    expect(
      await registry.addRepo("ghost", { name: "app", url: "https://github.com/o/app.git" }),
    ).toBe("missing");
    expect((await registry.getEnvironment("0000abcd"))?.repos).toEqual([
      { name: "app", url: "https://github.com/o/app.git" },
      { name: "pi", url: "https://github.com/o/pi.git" },
    ]);
  });

  it("removes a Repo from an Environment", async () => {
    const registry = fresh();

    await environmentWith(registry, "0000abcd", "Cloudpid", ["app", "pi"]);

    expect(await registry.removeRepo("0000abcd", "app")).toBe("changed");
    expect(await registry.removeRepo("0000abcd", "app")).toBe("absent");
    expect(await registry.removeRepo("ghost", "app")).toBe("missing");
    expect(
      Arr.map((await registry.getEnvironment("0000abcd"))?.repos ?? [], (repo) => repo.name),
    ).toEqual(["pi"]);
  });

  it("keeps an Environment's Container settings overrides, none until put", async () => {
    const registry = fresh();

    await registry.createEnvironment("0000abcd", "Cloudpid", 1_000);

    expect(await registry.getEnvironmentSettings("0000abcd")).toEqual({});
    expect(await registry.getEnvironmentSettings("ghost")).toBeNull();

    expect(await registry.putEnvironmentSettings("0000abcd", { idle: "5m" })).toBe(true);
    expect(await registry.putEnvironmentSettings("ghost", { idle: "5m" })).toBe(false);

    expect(await registry.getEnvironmentSettings("0000abcd")).toEqual({ idle: "5m" });
    // Another Environment's are its own.
    expect(await registry.getEnvironmentSettings(DEFAULT_ENVIRONMENT)).toEqual({});
  });

  it("reads overrides that are not JSON as none", async () => {
    await runInDurableObject(fresh(), (instance: TestRegistry, state) => {
      state.storage.sql.exec("UPDATE environments SET settings = 'not json'");

      expect(instance.getEnvironmentSettings(DEFAULT_ENVIRONMENT)).toEqual({});
    });
  });

  it("creates a Session in a new Workspace, recording its Repos as the Environment has them and its directory", async () => {
    const registry = fresh();

    await environmentWith(registry, "0000abcd", "Cloudpid", ["app"]);

    const created = await registry.createSession(
      {
        id: "s-1",
        title: null,
        workspace: newWorkspace("1a2b3c4d", "feature", "0000abcd", "main"),
      },
      2_000,
    );

    expect(created).toMatchObject({ environment: "0000abcd", workspace: "1a2b3c4d" });
    expect(await registry.getSession("s-1")).toEqual(created);
    expect(await registry.listWorkspaces()).toEqual([
      {
        id: "1a2b3c4d",
        environment: "0000abcd",
        branch: "feature",
        base: "main",
        repos: ["app"],
        directory: "/workspace/app",
        createdAt: 2_000,
      },
    ]);

    // Repos added later are for the Workspaces made later.
    await registry.addRepo("0000abcd", { name: "pi", url: "https://github.com/o/pi.git" });
    expect((await registry.getWorkspace("1a2b3c4d"))?.repos).toEqual(["app"]);
  });

  it("works at /workspace in a Workspace of no Repos or several", async () => {
    const registry = fresh();

    await environmentWith(registry, "0000abcd", "Two", ["app", "pi"]);
    await registry.createSession(
      { id: "s-1", title: null, workspace: newWorkspace("00000001") },
      1_000,
    );
    await registry.createSession(
      { id: "s-2", title: null, workspace: newWorkspace("00000002", "b", "0000abcd") },
      2_000,
    );

    expect(await registry.getWorkspace("00000001")).toMatchObject({
      repos: [],
      directory: "/workspace",
    });
    expect(await registry.getWorkspace("00000002")).toMatchObject({
      repos: ["app", "pi"],
      directory: "/workspace",
    });
  });

  it("binds a Session to a Workspace that exists, and to its Environment", async () => {
    const registry = fresh();

    await registry.createEnvironment("0000abcd", "Cloudpid", 1_000);
    await registry.createSession(
      { id: "first", title: null, workspace: newWorkspace("1a2b3c4d", "feature", "0000abcd") },
      2_000,
    );

    expect(
      await registry.createSession(
        { id: "second", title: "Again", workspace: existing("1a2b3c4d") },
        3_000,
      ),
    ).toMatchObject({ environment: "0000abcd", workspace: "1a2b3c4d", createdAt: 3_000 });
    expect(await registry.listWorkspaces()).toHaveLength(1);
  });

  it("refuses a Session in an Environment that is not there, registering nothing", async () => {
    const registry = fresh();

    expect(
      await registry.createSession(
        { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d", "b", "ghost") },
        1_000,
      ),
    ).toEqual({ refused: "no-environment" });
    expect(await registry.listSessions()).toEqual([]);
    expect(await registry.listWorkspaces()).toEqual([]);
  });

  it("refuses a Session in a Workspace that is not there, registering nothing", async () => {
    const registry = fresh();

    expect(
      await registry.createSession(
        { id: "s-1", title: null, workspace: existing("deadbeef") },
        1_000,
      ),
    ).toEqual({ refused: "no-workspace" });
    expect(await registry.listSessions()).toEqual([]);
  });

  it("refuses a second Workspace of an Environment on a branch one is on, naming that one", async () => {
    const registry = fresh();

    await registry.createSession(
      { id: "first", title: null, workspace: newWorkspace("1a2b3c4d", "feature") },
      1_000,
    );

    expect(
      await registry.createSession(
        { id: "second", title: null, workspace: newWorkspace("5e6f7a8b", "feature") },
        2_000,
      ),
    ).toEqual({ refused: "branch-taken", workspace: "1a2b3c4d" });
    expect(await registry.getSession("second")).toBeNull();
    expect(await registry.listWorkspaces()).toHaveLength(1);

    // Another Environment's Workspace may be on it.
    await registry.createEnvironment("0000abcd", "Other", 3_000);
    expect(
      await registry.createSession(
        { id: "third", title: null, workspace: newWorkspace("9c0d1e2f", "feature", "0000abcd") },
        3_000,
      ),
    ).toMatchObject({ workspace: "9c0d1e2f" });
    expect(await registry.listWorkspaces()).toHaveLength(2);
  });

  it("writes nothing when it refuses, not even the Workspace", async () => {
    await runInDurableObject(fresh(), (instance: TestRegistry, state) => {
      const { sql } = state.storage;

      const rows = () => ({
        sessions: sql.exec("SELECT COUNT(*) AS n FROM sessions").one().n,
        workspaces: sql.exec("SELECT COUNT(*) AS n FROM workspaces").one().n,
      });

      instance.createSession(
        { id: "first", title: null, workspace: newWorkspace("1a2b3c4d", "b") },
        1,
      );

      const before = rows();

      instance.createSession({ id: "a", title: null, workspace: newWorkspace("00000001", "b") }, 2);
      instance.createSession(
        { id: "b", title: null, workspace: newWorkspace("00000002", "x", "ghost") },
        2,
      );
      instance.createSession({ id: "c", title: null, workspace: existing("deadbeef") }, 2);

      expect(rows()).toEqual(before);
    });
  });

  it("answers what a Workspace sets itself up with: the Repos it was made with, its branch and base", async () => {
    const registry = fresh();

    await environmentWith(registry, "0000abcd", "Cloudpid", ["app", "pi"]);
    await registry.createSession(
      { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d", "feature", "0000abcd", "dev") },
      2_000,
    );
    await registry.removeRepo("0000abcd", "pi");

    expect(await registry.getWorkspaceSetup("1a2b3c4d")).toEqual({
      id: "1a2b3c4d",
      environment: "0000abcd",
      branch: "feature",
      base: "dev",
      repos: [
        { name: "app", url: "https://github.com/o/app.git" },
        { name: "pi", url: "https://github.com/o/pi.git" },
      ],
    });
    expect(await registry.getWorkspaceSetup("deadbeef")).toBeNull();
  });

  it("deletes a Workspace's record only once no Session is bound to it", async () => {
    const registry = fresh();

    await registry.createSession(
      { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d", "b") },
      1_000,
    );
    await registry.createSession(
      { id: "s-2", title: null, workspace: existing("1a2b3c4d") },
      2_000,
    );

    expect(await registry.deleteWorkspace("1a2b3c4d")).toBe("in-use");

    await registry.deleteSession("s-1");
    expect(await registry.deleteWorkspace("1a2b3c4d")).toBe("in-use");

    await registry.deleteSession("s-2");

    expect(await registry.deleteWorkspace("1a2b3c4d")).toBe("deleted");
    expect(await registry.getWorkspace("1a2b3c4d")).toBeNull();
    expect(await registry.deleteWorkspace("1a2b3c4d")).toBe("missing");
  });

  it("lists Workspaces newest first", async () => {
    const registry = fresh();

    await registry.createSession(
      { id: "s-1", title: null, workspace: newWorkspace("00000001") },
      1_000,
    );
    await registry.createSession(
      { id: "s-2", title: null, workspace: newWorkspace("00000002") },
      2_000,
    );

    expect(Arr.map(await registry.listWorkspaces(), (workspace) => workspace.id)).toEqual([
      "00000002",
      "00000001",
    ]);
  });

  describe("Builds", () => {
    const good = {
      key: "k1",
      snapshot: { id: "snap-1", size: 2e9 },
      image: "img-1",
      ignore: ["**/node_modules"],
      commits: { app: "abc", empty: null },
      finishedAt: 5_000,
    };

    it("has none for an Environment until its Build object's answer is kept, and keeps the last one", async () => {
      const registry = fresh();

      await environmentWith(registry, "0000abcd", "Cloudpid", ["app"]);

      expect(await registry.getBuild("0000abcd")).toEqual({ build: null, status: null });

      const building = { status: "building" as const, key: "k1", startedAt: 4_000 };

      expect(await registry.putBuild("0000abcd", { build: null, status: building })).toBe(true);
      expect(await registry.getBuild("0000abcd")).toEqual({ build: null, status: building });

      expect(await registry.putBuild("0000abcd", { build: good, status: null })).toBe(true);
      expect(await registry.getBuild("0000abcd")).toEqual({ build: good, status: null });

      const failed = { status: "failed" as const, key: "k2", reason: "exit 1", at: 6_000 };

      await registry.putBuild("0000abcd", { build: good, status: failed });

      // Newest first: the default Environment was made by the migration, at the real time.
      expect(await registry.listBuilds()).toEqual([
        { environment: DEFAULT_ENVIRONMENT, build: null, status: null },
        { environment: "0000abcd", build: good, status: failed },
      ]);
    });

    it("keeps nothing for an Environment that is not registered", async () => {
      const registry = fresh();

      expect(await registry.putBuild("0000abcd", { build: good, status: null })).toBe(false);
      expect(await registry.getBuild("0000abcd")).toBeNull();
    });

    it("gives every Environment stored before migration 13 no Build yet", async () => {
      const registry = fresh();

      await runInDurableObject(registry, (_instance, state) => {
        const { storage } = state;
        const { sql } = storage;

        for (const { name } of sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
          )
          .toArray()) {
          sql.exec(`DROP TABLE "${name}"`);
        }

        migrate(storage, MIGRATIONS.slice(0, 12));
        sql.exec(
          "INSERT INTO environments (id, name, repos, settings, created_at) VALUES ('0000abcd', 'Old', '[]', '{}', 5)",
        );

        const store = openRegistryStore(storage);

        expect(store.getBuild("0000abcd")).toEqual({ build: null, status: null });
        expect(store.getEnvironment("0000abcd")).toMatchObject({ name: "Old" });
      });
    });
  });

  describe("spare Workspaces", () => {
    it("makes one spare per Environment on the placeholder branch, with its Repos, and lists it nowhere", async () => {
      const registry = fresh();

      await environmentWith(registry, "0000abcd", "Cloudpid", ["app"]);

      expect(await registry.upkeepSpares(["0000abcd"], ["5a5a5a5a"], 1_000)).toEqual({
        stale: [],
        made: [
          {
            id: "5a5a5a5a",
            environment: "0000abcd",
            branch: SPARE_BRANCH,
            base: null,
            repos: [{ name: "app", url: "https://github.com/o/app.git" }],
            build: null,
          },
        ],
      });
      // An Environment that has its spare gets no other.
      expect(await registry.upkeepSpares(["0000abcd"], ["6b6b6b6b"], 2_000)).toEqual({
        stale: [],
        made: [],
      });
      expect(await registry.getSpare("0000abcd")).toBe("5a5a5a5a");
      expect(await registry.listWorkspaces()).toEqual([]);
      expect(await registry.getWorkspace("5a5a5a5a")).toBeNull();
      // No Session can name it.
      expect(
        await registry.createSession(
          { id: "s-1", title: null, workspace: existing("5a5a5a5a") },
          3_000,
        ),
      ).toEqual({ refused: "no-workspace" });
    });

    it("keeps every Environment's spare when none is named, and draws again an id that is taken", async () => {
      const registry = fresh();

      await registry.createEnvironment("0000abcd", "Cloudpid", 1_000);
      await registry.createSession(
        { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d") },
        1_000,
      );

      const work = await registry.upkeepSpares(
        undefined,
        ["1a2b3c4d", "00000001", "00000002"],
        2_000,
      );

      // Newest first: the default Environment was made by the migration, at the real time.
      expect(Arr.map(work.made, (made) => [made.environment, made.id])).toEqual([
        [DEFAULT_ENVIRONMENT, "00000001"],
        ["0000abcd", "00000002"],
      ]);
      // An Environment that is not there gets none.
      expect(await registry.upkeepSpares(["ghost"], ["00000003"], 3_000)).toEqual({
        stale: [],
        made: [],
      });
    });

    it("gives a new Workspace the Environment's spare, on cloudpid/<its id> or the owner's branch, from the base", async () => {
      const registry = fresh();

      await environmentWith(registry, "0000abcd", "Cloudpid", ["app"]);
      await registry.upkeepSpares(["0000abcd"], ["5a5a5a5a"], 1_000);

      const created = await registry.createSession(
        {
          id: "s-1",
          title: null,
          workspace: {
            kind: "new",
            id: "1a2b3c4d",
            environment: "0000abcd",
            branch: null,
            base: "dev",
          },
        },
        2_000,
      );

      expect(created).toMatchObject({ workspace: "5a5a5a5a", environment: "0000abcd" });
      expect(await registry.listWorkspaces()).toEqual([
        {
          id: "5a5a5a5a",
          environment: "0000abcd",
          branch: "cloudpid/5a5a5a5a",
          base: "dev",
          repos: ["app"],
          directory: "/workspace/app",
          createdAt: 2_000,
        },
      ]);
      expect(await registry.getSpare("0000abcd")).toBeNull();

      // The next spare is taken on the branch the owner names.
      await registry.upkeepSpares(["0000abcd"], ["6b6b6b6b"], 3_000);
      expect(
        await registry.createSession(
          { id: "s-2", title: null, workspace: newWorkspace("2b3c4d5e", "feature", "0000abcd") },
          4_000,
        ),
      ).toMatchObject({ workspace: "6b6b6b6b" });
      expect(await registry.getWorkspace("6b6b6b6b")).toMatchObject({ branch: "feature" });
    });

    it("gives a Subagent Workspace the spare of its Session's Environment, recorded as the Session's", async () => {
      const registry = fresh();

      await environmentWith(registry, "0000abcd", "Cloudpid", ["app"]);
      await registry.createSession(
        { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d", "feature", "0000abcd") },
        1_000,
      );
      await registry.upkeepSpares(["0000abcd"], ["5a5a5a5a"], 2_000);

      const made = await registry.createSubagentWorkspace(
        {
          id: "2b3c4d5e",
          session: "s-1",
          agent: "agent-1",
          branch: null,
          base: "feature",
          limit: 3,
        },
        3_000,
      );

      expect(made).toEqual({
        id: "5a5a5a5a",
        environment: "0000abcd",
        branch: "cloudpid/5a5a5a5a",
        base: "feature",
        repos: ["app"],
        directory: "/workspace/app",
        createdAt: 3_000,
        subagent: { session: "s-1", agent: "agent-1" },
      });
      expect(await registry.getSpare("0000abcd")).toBeNull();
      expect(await registry.getWorkspace("5a5a5a5a")).toEqual(made);
      expect(await registry.listSubagentWorkspaces("s-1")).toEqual([made]);
      // The Session's own Workspace is no Subagent Workspace.
      expect(await registry.getWorkspace("1a2b3c4d")).not.toHaveProperty("subagent");
    });

    it("answers the Subagent Workspace a subagent has again, and refuses one past the limit or for a Session not listed", async () => {
      const registry = fresh();

      await registry.createSession(
        { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d") },
        1_000,
      );

      const ask = (id: string, agent: string, limit = 2) =>
        registry.createSubagentWorkspace(
          { id, session: "s-1", agent, branch: null, base: null, limit },
          2_000,
        );

      const first = await ask("00000001", "agent-1");

      expect(first).toMatchObject({ id: "00000001", branch: "cloudpid/00000001" });
      // Asked again (a spawn rerun after an eviction): the same Workspace, and no other made.
      expect(await ask("00000009", "agent-1")).toEqual(first);
      expect(await ask("00000002", "agent-2")).toMatchObject({ id: "00000002" });
      expect(await ask("00000003", "agent-3")).toEqual({ refused: "limit", count: 2 });
      expect(
        await registry.createSubagentWorkspace(
          {
            id: "00000004",
            session: "ghost",
            agent: "agent-1",
            branch: null,
            base: null,
            limit: 3,
          },
          2_000,
        ),
      ).toEqual({ refused: "no-session" });
      expect(await ask("00000005", "agent-5", 9)).toMatchObject({ id: "00000005" });
      // A branch another Workspace of the Environment is on is refused, naming it.
      expect(
        await registry.createSubagentWorkspace(
          {
            id: "00000006",
            session: "s-1",
            agent: "agent-6",
            branch: "cloudpid/1a2b3c4d",
            base: null,
            limit: 9,
          },
          2_000,
        ),
      ).toEqual({ refused: "branch-taken", workspace: "1a2b3c4d" });
      expect(await registry.listSubagentWorkspaces("s-1")).toHaveLength(3);

      // Deleted with no Session bound to it.
      expect(await registry.deleteWorkspace("00000001")).toBe("deleted");
      expect(await registry.listSubagentWorkspaces("s-1")).toHaveLength(2);
    });

    it("makes a new Workspace on cloudpid/<its id> when there is no spare", async () => {
      const registry = fresh();

      await registry.createSession(
        {
          id: "s-1",
          title: null,
          workspace: {
            kind: "new",
            id: "1a2b3c4d",
            environment: DEFAULT_ENVIRONMENT,
            branch: null,
            base: null,
          },
        },
        1_000,
      );

      expect(await registry.getWorkspace("1a2b3c4d")).toMatchObject({
        branch: "cloudpid/1a2b3c4d",
      });
    });

    it("keeps the spare when the branch asked for is another Workspace's", async () => {
      const registry = fresh();

      await registry.createSession(
        { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d", "feature") },
        1_000,
      );
      await registry.upkeepSpares([DEFAULT_ENVIRONMENT], ["5a5a5a5a"], 2_000);

      expect(
        await registry.createSession(
          { id: "s-2", title: null, workspace: newWorkspace("2b3c4d5e", "feature") },
          3_000,
        ),
      ).toEqual({ refused: "branch-taken", workspace: "1a2b3c4d" });
      expect(await registry.getSpare(DEFAULT_ENVIRONMENT)).toBe("5a5a5a5a");
    });

    it("does not take a spare whose Repos are no longer the Environment's, and reports it stale until it is forgotten", async () => {
      const registry = fresh();

      await environmentWith(registry, "0000abcd", "Cloudpid", ["app"]);
      await registry.upkeepSpares(["0000abcd"], ["5a5a5a5a"], 1_000);
      await registry.addRepo("0000abcd", { name: "api", url: "https://github.com/o/api.git" });

      expect(
        await registry.createSession(
          { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d", "b", "0000abcd") },
          2_000,
        ),
      ).toMatchObject({ workspace: "1a2b3c4d" });
      expect(await registry.upkeepSpares(["0000abcd"], ["6b6b6b6b"], 3_000)).toEqual({
        stale: ["5a5a5a5a"],
        made: [],
      });

      expect(await registry.forgetSpare("5a5a5a5a")).toBe(true);
      // A Workspace that is no spare is not forgotten so.
      expect(await registry.forgetSpare("1a2b3c4d")).toBe(false);
      expect(await registry.getWorkspace("1a2b3c4d")).not.toBeNull();

      const again = await registry.upkeepSpares(["0000abcd"], ["6b6b6b6b"], 4_000);

      expect(Arr.map(again.made, (made) => Arr.map(made.repos, (repo) => repo.name))).toEqual([
        ["app", "api"],
      ]);
    });

    it("takes a spare whose Repos are the Environment's in another order", async () => {
      const registry = fresh();

      await environmentWith(registry, "0000abcd", "Cloudpid", ["app", "api"]);
      await registry.upkeepSpares(["0000abcd"], ["5a5a5a5a"], 1_000);
      await registry.removeRepo("0000abcd", "app");
      await registry.addRepo("0000abcd", { name: "app", url: "https://github.com/o/app.git" });

      expect(
        await registry.createSession(
          { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d", "b", "0000abcd") },
          2_000,
        ),
      ).toMatchObject({ workspace: "5a5a5a5a" });
    });

    it("makes a spare from the Environment's last good Build, and reports it stale once there is another", async () => {
      const registry = fresh();

      const build = (id: string) => ({
        key: "k1",
        snapshot: { id, size: 1 },
        image: "img-1",
        ignore: null,
        commits: {},
        finishedAt: 5_000,
      });

      await environmentWith(registry, "0000abcd", "Cloudpid", ["app"]);
      await registry.putBuild("0000abcd", { build: build("snap-1"), status: null });

      const work = await registry.upkeepSpares(["0000abcd"], ["5a5a5a5a"], 1_000);

      expect(Arr.map(work.made, (made) => made.build)).toEqual([build("snap-1")]);

      // A Build under way leaves it current; a new good one makes it stale.
      await registry.putBuild("0000abcd", {
        build: build("snap-1"),
        status: { status: "building", key: "k2", startedAt: 6_000 },
      });
      expect(await registry.upkeepSpares(["0000abcd"], ["6b6b6b6b"], 2_000)).toEqual({
        stale: [],
        made: [],
      });
      await registry.putBuild("0000abcd", { build: build("snap-2"), status: null });
      expect(await registry.upkeepSpares(["0000abcd"], ["6b6b6b6b"], 3_000)).toEqual({
        stale: ["5a5a5a5a"],
        made: [],
      });

      // Still a spare a Session may take meanwhile: its Repos are the Environment's.
      expect(
        await registry.createSession(
          { id: "s-1", title: null, workspace: newWorkspace("1a2b3c4d", "b", "0000abcd") },
          4_000,
        ),
      ).toMatchObject({ workspace: "5a5a5a5a" });
      expect(await registry.forgetSpare("5a5a5a5a")).toBe(false);
    });

    it("reports a spare stored before migration 15 stale once its Environment has a Build", async () => {
      const registry = fresh();

      await runInDurableObject(registry, (_instance, state) => {
        const { storage } = state;
        const { sql } = storage;

        for (const { name } of sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
          )
          .toArray()) {
          sql.exec(`DROP TABLE "${name}"`);
        }

        migrate(storage, MIGRATIONS.slice(0, 14));
        sql.exec(
          "INSERT INTO environments (id, name, repos, settings, created_at) VALUES ('0000abcd', 'Old', '[]', '{}', 5)",
        );
        sql.exec(
          "INSERT INTO workspaces (id, environment, branch, base, repos, created_at, spare) VALUES ('5a5a5a5a', '0000abcd', ?, NULL, '[]', 5, 1)",
          SPARE_BRANCH,
        );

        const store = openRegistryStore(storage);

        expect(store.upkeepSpares(["0000abcd"], () => "6b6b6b6b", 6)).toEqual({
          stale: [],
          made: [],
        });

        store.putBuild("0000abcd", {
          build: {
            key: "k1",
            snapshot: { id: "snap-1", size: 1 },
            image: "img-1",
            ignore: null,
            commits: {},
            finishedAt: 7,
          },
          status: null,
        });

        expect(store.upkeepSpares(["0000abcd"], () => "6b6b6b6b", 8)).toEqual({
          stale: ["5a5a5a5a"],
          made: [],
        });
      });
    });

    it("keeps an Environment with a spare from being deleted until the spare is forgotten", async () => {
      const registry = fresh();

      await registry.createEnvironment("0000abcd", "Cloudpid", 1_000);
      await registry.upkeepSpares(["0000abcd"], ["5a5a5a5a"], 1_000);

      expect(await registry.deleteEnvironment("0000abcd")).toBe("in-use");
      await registry.forgetSpare("5a5a5a5a");
      expect(await registry.deleteEnvironment("0000abcd")).toBe("deleted");
    });
  });

  it("leases legacy objects to one caller at a time, Sessions before Machines", async () => {
    await runInDurableObject(fresh(), (instance: TestRegistry, state) => {
      const { sql } = state.storage;

      sql.exec(
        "INSERT INTO legacy (kind, id) VALUES ('machine', 'cloudpid'), ('session', 'old-1'), ('session', 'old-2')",
      );

      // The default Machine is there from migration 3 on.
      expect(instance.takeLegacy(2, 1_000, 100)).toEqual([
        { kind: "session", id: "old-1" },
        { kind: "session", id: "old-2" },
      ]);
      expect(instance.takeLegacy(10, 1_050, 100)).toEqual([
        { kind: "machine", id: "cloudpid" },
        { kind: "machine", id: "default" },
      ]);
      // Nothing is free while the leases hold.
      expect(instance.takeLegacy(10, 1_060, 100)).toEqual([]);
      // The first lease has run out; the second has not.
      expect(instance.takeLegacy(10, 1_100, 100)).toEqual([
        { kind: "session", id: "old-1" },
        { kind: "session", id: "old-2" },
      ]);
    });
  });

  it("forgets a legacy object once it is wiped, and ignores one it does not hold", async () => {
    await runInDurableObject(fresh(), (instance: TestRegistry, state) => {
      state.storage.sql.exec("INSERT INTO legacy (kind, id) VALUES ('session', 'old-1')");

      instance.forgetLegacy({ kind: "session", id: "old-1" });
      instance.forgetLegacy({ kind: "session", id: "ghost" });
      // A session and a machine of one name are two objects.
      instance.forgetLegacy({ kind: "machine", id: "old-1" });

      expect(instance.takeLegacy(10, 1_000, 100)).toEqual([{ kind: "machine", id: "default" }]);

      instance.forgetLegacy({ kind: "machine", id: "default" });

      expect(instance.takeLegacy(10, 9_000, 100)).toEqual([]);
    });
  });

  describe("kept Secrets", () => {
    const MASTER = "test-master-key-0123456789abcdef0123456789";
    const VALUE = "sk-live-0123456789abcdef";

    it("keeps each value sealed in SQLite, and lists names, scopes, flags and times only", async () => {
      const registry = fresh();

      await environmentWith(registry, "0000abcd", "Cloudpid");
      expect(
        await registry.keepSecret(
          MASTER,
          { environment: "0000abcd", name: "API_KEY", value: VALUE },
          5,
        ),
      ).toMatchObject({ status: "saved" });
      await registry.keepSecret(
        MASTER,
        { environment: null, name: "NPM_TOKEN", value: "npm_0123456789", build: true },
        6,
      );

      expect(await registry.listEnvironmentSecrets()).toEqual([
        { environment: null, name: "NPM_TOKEN", build: true, updatedAt: 6 },
        { environment: "0000abcd", name: "API_KEY", build: false, updatedAt: 5 },
      ]);
      expect(await registry.openSecrets(MASTER, "0000abcd")).toEqual([
        { name: "API_KEY", value: VALUE, scope: "environment", build: false },
        { name: "NPM_TOKEN", value: "npm_0123456789", scope: "every", build: true },
      ]);

      await runInDurableObject(registry, (_instance: TestRegistry, state) => {
        const rows = JSON.stringify(
          state.storage.sql.exec("SELECT * FROM environment_secrets").toArray(),
        );

        expect(rows).not.toContain(VALUE);
        expect(rows).not.toContain("npm_0123456789");
      });
    });

    it("does not open a row moved to another scope or name", async () => {
      const registry = fresh();

      await environmentWith(registry, "0000abcd", "Cloudpid");
      await environmentWith(registry, "0000beef", "Other");
      await registry.keepSecret(
        MASTER,
        { environment: "0000abcd", name: "API_KEY", value: VALUE },
        5,
      );

      await runInDurableObject(registry, (_instance: TestRegistry, state) => {
        state.storage.sql.exec(
          "UPDATE environment_secrets SET scope = '0000beef', name = 'OTHER_KEY'",
        );
      });

      expect(await registry.listEnvironmentSecrets()).toEqual([
        { environment: "0000beef", name: "OTHER_KEY", build: false, updatedAt: 5 },
      ]);
      expect(await registry.openSecrets(MASTER, "0000beef")).toEqual([]);
    });

    it("replaces a value keeping its flag, sets the flag, and deletes", async () => {
      const registry = fresh();

      await environmentWith(registry, "0000abcd", "Cloudpid");
      await registry.keepSecret(
        MASTER,
        { environment: "0000abcd", name: "API_KEY", value: VALUE, build: true },
        5,
      );
      await registry.keepSecret(
        MASTER,
        { environment: "0000abcd", name: "API_KEY", value: "sk-live-rotated-0123" },
        7,
      );

      expect(await registry.openSecrets(MASTER, "0000abcd")).toEqual([
        { name: "API_KEY", value: "sk-live-rotated-0123", scope: "environment", build: true },
      ]);
      expect(await registry.setEnvironmentSecretBuild("0000abcd", "API_KEY", false, 8)).toEqual({
        environment: "0000abcd",
        name: "API_KEY",
        build: false,
        updatedAt: 8,
      });
      expect(await registry.setEnvironmentSecretBuild(null, "API_KEY", true, 9)).toBeNull();
      expect(await registry.deleteEnvironmentSecret(null, "API_KEY")).toBe(false);
      expect(await registry.deleteEnvironmentSecret("0000abcd", "API_KEY")).toBe(true);
      expect(await registry.listEnvironmentSecrets()).toEqual([]);
    });

    it("refuses an Environment that does not exist, and a scope that is full", async () => {
      const registry = fresh();
      const sealed = { version: 1 as const, iv: "aXY=", ciphertext: "Y2lwaGVy" };

      expect(
        await registry.putEnvironmentSecret({ environment: "0000dead", name: "A", sealed }, 1),
      ).toBe("missing");

      for (let index = 0; index < MAX_ENVIRONMENT_SECRETS; index++) {
        await registry.putEnvironmentSecret({ environment: null, name: `S${index}`, sealed }, 1);
      }

      expect(
        await registry.putEnvironmentSecret({ environment: null, name: "ONE_MORE", sealed }, 1),
      ).toBe("full");
      // Replacing one that is kept is not adding one.
      expect(
        await registry.putEnvironmentSecret({ environment: null, name: "S0", sealed }, 2),
      ).toMatchObject({ name: "S0", updatedAt: 2 });
    });

    it("deletes an Environment's Secrets with it, and keeps those for every Environment", async () => {
      const registry = fresh();

      await environmentWith(registry, "0000abcd", "Cloudpid");
      await registry.keepSecret(
        MASTER,
        { environment: "0000abcd", name: "API_KEY", value: VALUE },
        5,
      );
      await registry.keepSecret(MASTER, { environment: null, name: "SHARED", value: VALUE }, 5);

      expect(await registry.deleteEnvironment("0000abcd")).toBe("deleted");
      expect(await registry.listEnvironmentSecrets()).toEqual([
        { environment: null, name: "SHARED", build: false, updatedAt: 5 },
      ]);
    });
  });

  it("resets a Registry at version 10: the old rows go, are listed as legacy, and the default Environment exists", async () => {
    await runInDurableObject(fresh(), (_instance: TestRegistry, state) => {
      const { storage } = state;
      const { sql } = storage;

      // Start over from the release before Environments: every table gone, the schema at version 10.
      for (const { name } of sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
        )
        .toArray()) {
        sql.exec(`DROP TABLE "${name}"`);
      }

      migrate(storage, MIGRATIONS.slice(0, 10));
      sql.exec(
        "INSERT INTO workspaces (slug, created_at, name) VALUES ('cloudpid', 5, 'Cloudpid')",
      );
      sql.exec(
        "INSERT INTO sessions (id, title, status, created_at, updated_at, workspace, repo, title_source, archived_at, worktree) VALUES ('old-1', 'Mine', 'idle', 1, 1, 'cloudpid', 'app', 'owner', NULL, 'abc'), ('old-2', NULL, 'running', 2, 2, 'default', NULL, NULL, 9, NULL)",
      );
      sql.exec(
        "INSERT INTO worktrees (id, machine, repo, branch, created_at) VALUES ('abc', 'cloudpid', 'app', 'feature', 3)",
      );
      sql.exec("INSERT INTO documents (name, body, updated_at) VALUES ('settings', '{}', 4)");
      sql.exec(
        "INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES ('https://push.example/a', 'k', 'a', 5)",
      );

      const store = openRegistryStore(storage);

      expect(store.listSessions()).toEqual([]);
      expect(store.listWorkspaces()).toEqual([]);
      expect(Arr.map(store.listEnvironments(), (item) => item.id)).toEqual([DEFAULT_ENVIRONMENT]);
      expect(store.takeLegacy(10, 1_000, 100)).toEqual([
        { kind: "session", id: "old-1" },
        { kind: "session", id: "old-2" },
        { kind: "machine", id: "cloudpid" },
        { kind: "machine", id: "default" },
      ]);
      expect(sql.exec("SELECT MAX(version) AS version FROM schema_version").one()).toEqual({
        version: MIGRATIONS.length,
      });
      // What is not the Machines' stays.
      expect(store.getDocument("settings")).toBe("{}");
      expect(store.hasPushSubscription("https://push.example/a")).toBe(true);
      // And the new tables work.
      expect(
        store.createSession({ id: "new", title: null, workspace: newWorkspace("1a2b3c4d") }, 6),
      ).toMatchObject({ id: "new" });
      // Opening again changes nothing.
      expect(openRegistryStore(storage).listSessions()).toHaveLength(1);
    });
  });

  it("keeps the Workspaces of a Registry at version 11 as Sessions' Workspaces, none of them spare", async () => {
    await runInDurableObject(fresh(), (_instance: TestRegistry, state) => {
      const { storage } = state;
      const { sql } = storage;

      // Start over at version 11, the release before spares.
      for (const { name } of sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
        )
        .toArray()) {
        sql.exec(`DROP TABLE "${name}"`);
      }

      migrate(storage, MIGRATIONS.slice(0, 11));
      sql.exec(
        "INSERT INTO workspaces (id, environment, branch, base, repos, created_at) VALUES ('1a2b3c4d', 'default', 'feature', NULL, '[]', 5)",
      );

      const store = openRegistryStore(storage);

      expect(Arr.map(store.listWorkspaces(), (workspace) => workspace.id)).toEqual(["1a2b3c4d"]);
      expect(store.getSpare(DEFAULT_ENVIRONMENT)).toBeNull();
    });
  });

  it("keeps its Sessions and Environments across an eviction", async () => {
    const registry = fresh();

    await registry.createEnvironment("0000abcd", "Cloudpid", 500);
    await registry.createSession(
      { id: "s-1", title: "Survivor", workspace: newWorkspace("1a2b3c4d", "b", "0000abcd") },
      1_000,
    );
    await registry.setSessionStatus("s-1", "running", 2_000);

    await evictDurableObject(registry);

    // A new instance reopens the same storage.
    expect(await registry.listSessions()).toMatchObject([
      {
        id: "s-1",
        title: "Survivor",
        environment: "0000abcd",
        status: "running",
        updatedAt: 2_000,
      },
    ]);
    expect(await registry.getEnvironment("0000abcd")).toMatchObject({ name: "Cloudpid" });
    expect(await registry.getWorkspace("1a2b3c4d")).toMatchObject({ environment: "0000abcd" });
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
