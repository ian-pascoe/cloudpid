// Agent changes over real Durable Object SQLite (docs/spec.md → Agent changes): applied as the owner's save is,
// recorded, listed newest first, kept to the last 200 per Environment, and reverted unless changed since.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { runInDurableObject } from "cloudflare:test";
import { DEFAULT_ENVIRONMENT, MAX_AGENT_CHANGES, variableField } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type AgentChangeAuthor,
  changeEnvironment,
  type ContainerFieldChange,
  openAgentChanges,
  revertAgentChange,
} from "./agent-changes.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

const author: AgentChangeAuthor = {
  session: "s-1",
  conversation: 1,
  tool: "environment_variable_set",
  reason: "The tests need the API's address",
};

/** Run `body` over a fresh Registry's store and Agent changes. */
const inRegistry = <A>(
  body: (registry: {
    readonly change: (
      change: ContainerFieldChange,
      at?: number,
      environment?: string,
    ) => ReturnType<typeof changeEnvironment>;
    readonly revert: (
      id: number,
      at?: number,
      environment?: string,
    ) => ReturnType<typeof revertAgentChange>;
    readonly changes: ReturnType<typeof openAgentChanges>;
    readonly store: ReturnType<typeof openRegistryStore>;
  }) => A,
) =>
  runInDurableObject(env.REGISTRIES.get(env.REGISTRIES.newUniqueId()), (_: TestRegistry, state) => {
    const store = openRegistryStore(state.storage);
    const changes = openAgentChanges(state.storage);

    return body({
      store,
      changes,
      change: (change, at = 1_000, environment = DEFAULT_ENVIRONMENT) =>
        changeEnvironment(state.storage, store, changes, { environment, change, author }, at),
      revert: (id, at = 2_000, environment = DEFAULT_ENVIRONMENT) =>
        revertAgentChange(state.storage, store, changes, { environment, id }, at),
    });
  });

const setVariable = (name: string, value: string | null): ContainerFieldChange => ({
  field: variableField(name),
  value,
});

describe("an Agent change to an Environment", () => {
  it("saves a variable and records who changed it, why, and the values before and after", async () => {
    const [outcome, saved, listed] = await inRegistry(({ change, store, changes }) => [
      change(setVariable("API_URL", "https://api.test")),
      store.getEnvironmentSettings(DEFAULT_ENVIRONMENT),
      changes.list(DEFAULT_ENVIRONMENT),
    ]);

    expect(outcome).toMatchObject({
      status: "changed",
      environment: { id: DEFAULT_ENVIRONMENT, name: "Default" },
      previous: { variables: {} },
      state: { settings: { variables: { API_URL: "https://api.test" } } },
    });
    expect(saved).toEqual({ variables: { API_URL: "https://api.test" } });
    expect(listed).toEqual([
      {
        id: 1,
        scope: DEFAULT_ENVIRONMENT,
        at: 1_000,
        actor: "agent",
        session: "s-1",
        conversation: 1,
        tool: "environment_variable_set",
        reason: "The tests need the API's address",
        field: "variables.API_URL",
        before: null,
        after: "https://api.test",
        reverts: null,
        revertedBy: null,
      },
    ]);
  });

  it("keeps the other settings as they were, and records a replaced value's old one", async () => {
    const [listed, saved] = await inRegistry(({ change, store, changes }) => {
      store.putEnvironmentSettings(DEFAULT_ENVIRONMENT, {
        idleMinutes: 10,
        variables: { A: "1", B: "2" },
      });
      change(setVariable("A", "one"));
      change(setVariable("B", null), 1_500);

      return [changes.list(DEFAULT_ENVIRONMENT), store.getEnvironmentSettings(DEFAULT_ENVIRONMENT)];
    });

    expect(saved).toEqual({ idleMinutes: 10, variables: { A: "one" } });
    // Newest first.
    expect(listed.map(({ field, before, after, at }) => ({ field, before, after, at }))).toEqual([
      { field: "variables.B", before: "2", after: null, at: 1_500 },
      { field: "variables.A", before: "1", after: "one", at: 1_000 },
    ]);
  });

  it("records nothing for a variable unset that was not set, or set to the value it has", async () => {
    const [unset, same, listed] = await inRegistry(({ change, store, changes }) => {
      store.putEnvironmentSettings(DEFAULT_ENVIRONMENT, { variables: { A: "1" } });

      return [
        change(setVariable("GHOST", null)),
        change(setVariable("A", "1")),
        changes.list(DEFAULT_ENVIRONMENT),
      ];
    });

    expect(unset).toMatchObject({ status: "unchanged", value: null });
    expect(same).toMatchObject({ status: "unchanged", value: "1" });
    expect(listed).toEqual([]);
  });

  it("refuses what the owner's save refuses, saying why, and saves and records nothing", async () => {
    const [reserved, long, missing, listed, saved] = await inRegistry(
      ({ change, store, changes }) => [
        change(setVariable("PATH", "/bin")),
        change(setVariable("LONG", "x".repeat(4097))),
        change(setVariable("A", "1"), 1_000, "0000beef"),
        changes.list(DEFAULT_ENVIRONMENT),
        store.getEnvironmentSettings(DEFAULT_ENVIRONMENT),
      ],
    );

    expect(reserved).toEqual({
      status: "rejected",
      message: expect.stringContaining('"PATH" is reserved'),
    });
    expect(long).toMatchObject({ status: "rejected" });
    expect(missing).toEqual({ status: "missing" });
    expect(listed).toEqual([]);
    expect(saved).toEqual({});
  });

  it("refuses the 51st variable, as the owner's save does", async () => {
    const outcome = await inRegistry(({ change, store }) => {
      store.putEnvironmentSettings(DEFAULT_ENVIRONMENT, {
        variables: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`V${index}`, "x"])),
      });

      return change(setVariable("ONE_MORE", "x"));
    });

    expect(outcome).toMatchObject({ status: "rejected" });
  });

  it("keeps each Environment's last 200 changes", async () => {
    const [ids, others] = await inRegistry(({ change, changes, store }) => {
      store.createEnvironment("0000abcd", "Other", 1_000);
      change(setVariable("OTHER", "kept"), 1_000, "0000abcd");

      for (let n = 0; n <= MAX_AGENT_CHANGES; n++) change(setVariable("N", String(n)), 1_000 + n);

      return [
        changes.list(DEFAULT_ENVIRONMENT).map((each) => each.after),
        changes.list("0000abcd"),
      ];
    });

    expect(ids).toHaveLength(MAX_AGENT_CHANGES);
    expect(ids[0]).toBe(String(MAX_AGENT_CHANGES));
    expect(ids.at(-1)).toBe("1");
    expect(others).toHaveLength(1);
  });

  it("forgets an Environment's changes with it", async () => {
    const listed = await inRegistry(({ change, changes, store }) => {
      store.createEnvironment("0000abcd", "Other", 1_000);
      change(setVariable("A", "1"), 1_000, "0000abcd");
      store.deleteEnvironment("0000abcd");

      return changes.list("0000abcd");
    });

    expect(listed).toEqual([]);
  });
});

describe("the owner's revert of an Agent change", () => {
  it("writes the value before back, recorded as the owner's change", async () => {
    const [reverted, saved, listed] = await inRegistry(({ change, revert, store, changes }) => {
      store.putEnvironmentSettings(DEFAULT_ENVIRONMENT, { variables: { A: "1" } });
      change(setVariable("A", "2"));

      return [
        revert(1),
        store.getEnvironmentSettings(DEFAULT_ENVIRONMENT),
        changes.list(DEFAULT_ENVIRONMENT),
      ];
    });

    expect(reverted).toMatchObject({
      status: "reverted",
      change: {
        id: 2,
        actor: "owner",
        session: null,
        tool: null,
        field: "variables.A",
        before: "2",
        after: "1",
        reverts: 1,
      },
    });
    expect(saved).toEqual({ variables: { A: "1" } });
    expect(listed.map(({ id, revertedBy }) => ({ id, revertedBy }))).toEqual([
      { id: 2, revertedBy: null },
      { id: 1, revertedBy: 2 },
    ]);
  });

  it("unsets a variable the change set, and sets one it unset", async () => {
    const saved = await inRegistry(({ change, revert, store }) => {
      store.putEnvironmentSettings(DEFAULT_ENVIRONMENT, { variables: { GONE: "was" } });
      change(setVariable("NEW", "x"));
      change(setVariable("GONE", null));
      revert(1);
      revert(2);

      return store.getEnvironmentSettings(DEFAULT_ENVIRONMENT);
    });

    expect(saved).toEqual({ variables: { GONE: "was" } });
  });

  it("is refused, showing the value now, when the variable has changed since", async () => {
    const [refused, saved] = await inRegistry(({ change, revert, store }) => {
      change(setVariable("A", "1"));
      change(setVariable("A", "2"));

      return [revert(1), store.getEnvironmentSettings(DEFAULT_ENVIRONMENT)];
    });

    expect(refused).toEqual({ status: "changed-since", field: "variables.A", current: "2" });
    expect(saved).toEqual({ variables: { A: "2" } });
  });

  it("does not undo a revert, and knows no change of another Environment", async () => {
    const [again, elsewhere] = await inRegistry(({ change, revert, store }) => {
      store.createEnvironment("0000abcd", "Other", 1_000);
      change(setVariable("A", "1"));
      revert(1);

      return [revert(2), revert(1, 2_000, "0000abcd")];
    });

    expect(again).toMatchObject({ status: "refused" });
    expect(elsewhere).toEqual({ status: "missing" });
  });

  it("is refused once reverted, even after the agent gives the variable that value again", async () => {
    const [twice, listed] = await inRegistry(({ change, revert, changes }) => {
      change(setVariable("A", "2"));
      revert(1);
      change(setVariable("A", "2"));

      return [revert(1), changes.list(DEFAULT_ENVIRONMENT)];
    });

    expect(twice).toEqual({
      status: "refused",
      message: "Change 1 was reverted already, by change 2",
    });
    expect(listed.map(({ id }) => id)).toEqual([3, 2, 1]);
  });
});
