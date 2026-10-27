// The agent's changes to an Environment's own record over real Durable Object SQLite (docs/spec.md → Agent changes):
// making one, renaming it, adding and removing Repos, asking for a Build, and the owner's revert of each.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { runInDurableObject } from "cloudflare:test";
import { DEFAULT_ENVIRONMENT } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type AgentChangeAuthor, openAgentChanges, revertAgentChange } from "./agent-changes.ts";
import {
  addRepoAs,
  createEnvironmentAs,
  recordRebuildAs,
  removeRepoAs,
  renameEnvironmentAs,
} from "./environment-lifecycle.ts";
import { noSkills, type TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

const author: AgentChangeAuthor = {
  session: "s-1",
  conversation: 1,
  tool: "environment_repo_add",
  reason: "The work needs it",
};

const APP = { name: "app", url: "https://github.com/o/app.git" };
const LIB = { name: "lib", url: "https://github.com/o/lib.git" };

/** Run `body` over a fresh Registry's store and Agent changes. */
const inRegistry = <A>(
  body: (registry: {
    readonly create: (
      name: string,
      repos?: ReadonlyArray<typeof APP>,
      id?: string,
    ) => ReturnType<typeof createEnvironmentAs>;
    readonly rename: (environment: string, name: string) => ReturnType<typeof renameEnvironmentAs>;
    readonly add: (environment: string, repo: typeof APP) => ReturnType<typeof addRepoAs>;
    readonly remove: (environment: string, name: string) => ReturnType<typeof removeRepoAs>;
    readonly rebuild: (environment: string) => ReturnType<typeof recordRebuildAs>;
    readonly revert: (environment: string, id: number) => ReturnType<typeof revertAgentChange>;
    readonly changes: ReturnType<typeof openAgentChanges>;
    readonly store: ReturnType<typeof openRegistryStore>;
  }) => A,
) =>
  runInDurableObject(env.REGISTRIES.get(env.REGISTRIES.newUniqueId()), (_: TestRegistry, state) => {
    const store = openRegistryStore(state.storage);
    const changes = openAgentChanges(state.storage);
    const at = 1_000;

    return body({
      store,
      changes,
      create: (name, repos = [], id = "0000abcd") =>
        createEnvironmentAs(state.storage, store, changes, { id, name, repos, author }, at),
      rename: (environment, name) =>
        renameEnvironmentAs(state.storage, store, changes, { environment, name, author }, at),
      add: (environment, repo) =>
        addRepoAs(state.storage, store, changes, { environment, repo, author }, at),
      remove: (environment, name) =>
        removeRepoAs(state.storage, store, changes, { environment, name, author }, at),
      rebuild: (environment) =>
        recordRebuildAs(state.storage, store, changes, { environment, author }, at),
      revert: (environment, id) =>
        revertAgentChange(
          state.storage,
          store,
          changes,
          { environment, id },
          2_000,
          noSkills(state.storage),
        ),
    });
  });

describe("the agent making an Environment", () => {
  it("registers it with its Repos and no settings overrides, and records the creation in its own history", async () => {
    const [made, stored, settings, listed] = await inRegistry(({ create, store, changes }) => [
      create("  Billing ", [APP, LIB]),
      store.getEnvironment("0000abcd"),
      store.getEnvironmentSettings("0000abcd"),
      changes.list("0000abcd"),
    ]);

    expect(made).toMatchObject({
      status: "created",
      environment: { id: "0000abcd", name: "Billing", repos: [APP, LIB] },
    });
    expect(stored).toMatchObject({ name: "Billing", repos: [APP, LIB] });
    expect(settings).toEqual({});
    expect(listed).toMatchObject([
      {
        scope: "0000abcd",
        actor: "agent",
        tool: "environment_repo_add",
        field: "environment",
        before: null,
        after: { name: "Billing", repos: [APP, LIB] },
      },
    ]);
  });

  it("refuses a name another Environment has in any case, as the owner's create does, and makes nothing", async () => {
    const [refused, others] = await inRegistry(({ create, store }) => [
      create("DEFAULT"),
      store.listEnvironments().length,
    ]);

    expect(refused).toEqual({
      status: "rejected",
      message: 'Another environment is already named "DEFAULT"',
    });
    expect(others).toBe(1);
  });

  it("refuses an empty name, one over 80 characters, and two Repos in one directory", async () => {
    const [empty, long, twice, count] = await inRegistry(({ create, store }) => [
      create("  "),
      create("x".repeat(81)),
      create("Twice", [APP, { name: "app", url: "https://github.com/p/app.git" }]),
      store.listEnvironments().length,
    ]);

    expect(empty).toEqual({ status: "rejected", message: "Give the environment a name" });
    expect(long).toEqual({ status: "rejected", message: "Use at most 80 characters" });
    expect(twice).toMatchObject({ status: "rejected", message: expect.stringContaining("app") });
    expect(count).toBe(1);
  });

  it("has no revert: deleting it needs the owner's approval", async () => {
    const [refused, still] = await inRegistry(({ create, revert, store }) => {
      create("Billing");

      return [revert("0000abcd", 1), store.getEnvironment("0000abcd")];
    });

    expect(refused).toMatchObject({
      status: "refused",
      message: expect.stringContaining("not reverted"),
    });
    expect(still).not.toBeNull();
  });
});

describe("the agent renaming an Environment", () => {
  it("renames it and records the names before and after", async () => {
    const [renamed, listed] = await inRegistry(({ rename, changes }) => [
      rename(DEFAULT_ENVIRONMENT, " Main "),
      changes.list(DEFAULT_ENVIRONMENT),
    ]);

    expect(renamed).toMatchObject({ status: "changed", environment: { name: "Main" } });
    expect(listed).toMatchObject([{ field: "name", before: "Default", after: "Main" }]);
  });

  it("refuses a name another Environment has, whatever the case, and one it has already changes nothing", async () => {
    const [taken, same, listed] = await inRegistry(({ create, rename, changes }) => {
      create("Other");

      return [
        rename(DEFAULT_ENVIRONMENT, "OTHER"),
        rename(DEFAULT_ENVIRONMENT, "Default"),
        changes.list(DEFAULT_ENVIRONMENT),
      ];
    });

    expect(taken).toEqual({
      status: "rejected",
      message: 'Another environment is already named "OTHER"',
    });
    expect(same).toMatchObject({ status: "unchanged" });
    expect(listed).toEqual([]);
  });

  it("can change only its case, and knows no Environment it does not have", async () => {
    const [cased, ghost] = await inRegistry(({ rename }) => [
      rename(DEFAULT_ENVIRONMENT, "default"),
      rename("ghost", "x"),
    ]);

    expect(cased).toMatchObject({ status: "changed", environment: { name: "default" } });
    expect(ghost).toEqual({ status: "missing" });
  });

  it("is reverted by putting the old name back, unless it has changed since or another Environment took it", async () => {
    const [reverted, name, changedSince] = await inRegistry(({ rename, revert, store }) => {
      rename(DEFAULT_ENVIRONMENT, "Main");

      const first = revert(DEFAULT_ENVIRONMENT, 1);
      const named = store.getEnvironment(DEFAULT_ENVIRONMENT)?.name;

      rename(DEFAULT_ENVIRONMENT, "Second");
      rename(DEFAULT_ENVIRONMENT, "Third");

      return [first, named, revert(DEFAULT_ENVIRONMENT, 3)];
    });

    expect(reverted).toMatchObject({
      status: "reverted",
      change: { actor: "owner", field: "name", before: "Main", after: "Default", reverts: 1 },
    });
    expect(name).toBe("Default");
    expect(changedSince).toEqual({ status: "changed-since", field: "name", current: "Third" });
  });

  it("is refused when another Environment took the old name meanwhile", async () => {
    const [taken, name] = await inRegistry(({ create, rename, revert, store }) => {
      rename(DEFAULT_ENVIRONMENT, "Main");
      create("default");

      return [revert(DEFAULT_ENVIRONMENT, 1), store.getEnvironment(DEFAULT_ENVIRONMENT)?.name];
    });

    expect(taken).toEqual({
      status: "refused",
      message: 'Another environment is already named "Default"',
    });
    expect(name).toBe("Main");
  });
});

describe("the agent adding and removing Repos", () => {
  it("adds one and records its address, and leaves one it has alone", async () => {
    const [added, repos, again, clash, listed] = await inRegistry(({ add, store, changes }) => [
      add(DEFAULT_ENVIRONMENT, APP),
      store.getEnvironment(DEFAULT_ENVIRONMENT)?.repos,
      add(DEFAULT_ENVIRONMENT, APP),
      add(DEFAULT_ENVIRONMENT, { name: "app", url: "https://github.com/p/app.git" }),
      changes.list(DEFAULT_ENVIRONMENT),
    ]);

    expect(added).toMatchObject({ status: "changed" });
    expect(repos).toEqual([APP]);
    expect(again).toMatchObject({ status: "unchanged" });
    expect(clash).toEqual({
      status: "rejected",
      message: "The environment already has a repo in app: name this one",
    });
    expect(listed).toMatchObject([{ field: "repos.app", before: null, after: APP.url }]);
  });

  it("removes one and records its address, and refuses one it does not have", async () => {
    const [removed, repos, ghost, listed] = await inRegistry(({ add, remove, store, changes }) => {
      add(DEFAULT_ENVIRONMENT, APP);
      add(DEFAULT_ENVIRONMENT, LIB);

      return [
        remove(DEFAULT_ENVIRONMENT, "app"),
        store.getEnvironment(DEFAULT_ENVIRONMENT)?.repos,
        remove(DEFAULT_ENVIRONMENT, "ghost"),
        changes.list(DEFAULT_ENVIRONMENT),
      ];
    });

    expect(removed).toMatchObject({ status: "changed" });
    expect(repos).toEqual([LIB]);
    expect(ghost).toEqual({ status: "rejected", message: 'The environment has no repo "ghost"' });
    expect(listed[0]).toMatchObject({ field: "repos.app", before: APP.url, after: null });
  });

  it("are reverted by the opposite", async () => {
    const [outAgain, backAgain, repos, finalRepos] = await inRegistry(
      ({ add, remove, revert, store }) => {
        add(DEFAULT_ENVIRONMENT, APP); // change 1
        remove(DEFAULT_ENVIRONMENT, "app"); // change 2

        const back = revert(DEFAULT_ENVIRONMENT, 2); // puts app back (change 3)
        const held = store.getEnvironment(DEFAULT_ENVIRONMENT)?.repos;

        const out = revert(DEFAULT_ENVIRONMENT, 1); // takes app out (change 4)

        remove(DEFAULT_ENVIRONMENT, "app"); // nothing: already out

        return [out, back, held, store.getEnvironment(DEFAULT_ENVIRONMENT)?.repos];
      },
    );

    expect(backAgain).toMatchObject({
      status: "reverted",
      change: { field: "repos.app", before: null, after: APP.url, reverts: 2 },
    });
    expect(repos).toEqual([APP]);
    expect(outAgain).toMatchObject({
      status: "reverted",
      change: { field: "repos.app", before: APP.url, after: null, reverts: 1 },
    });
    expect(finalRepos).toEqual([]);
  });

  it("refuse the revert of an add when the Repo was removed and added at another address", async () => {
    const refused = await inRegistry(({ add, remove, revert }) => {
      add(DEFAULT_ENVIRONMENT, APP); // 1
      remove(DEFAULT_ENVIRONMENT, "app"); // 2
      add(DEFAULT_ENVIRONMENT, { name: "app", url: "https://github.com/p/app.git" }); // 3

      return revert(DEFAULT_ENVIRONMENT, 1);
    });

    expect(refused).toEqual({
      status: "changed-since",
      field: "repos.app",
      current: "https://github.com/p/app.git",
    });
  });
});

describe("the agent asking for a Build", () => {
  it("is recorded, with no revert", async () => {
    const [recorded, listed, refused] = await inRegistry(({ rebuild, revert, changes }) => [
      rebuild(DEFAULT_ENVIRONMENT),
      changes.list(DEFAULT_ENVIRONMENT),
      revert(DEFAULT_ENVIRONMENT, 1),
    ]);

    expect(recorded).toMatchObject({ status: "changed" });
    expect(listed).toMatchObject([{ field: "build", before: null, after: "asked for" }]);
    expect(refused).toMatchObject({ status: "refused" });
  });

  it("knows no Environment it does not have", async () => {
    expect(await inRegistry(({ rebuild }) => rebuild("ghost"))).toEqual({ status: "missing" });
  });
});
