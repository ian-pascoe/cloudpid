// Agent changes over real Durable Object SQLite (docs/architecture/agent-changes.md): applied as the owner's save is,
// recorded, listed newest first, kept to the last 200 per Environment, and reverted unless changed since.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { runInDurableObject } from "cloudflare:test";
import {
  DEFAULT_ENVIRONMENT,
  GLOBAL_SCOPE,
  MAX_AGENT_CHANGES,
  variableField,
} from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  type AgentChangeAuthor,
  changeEnvironment,
  changeGlobal,
  type ContainerFieldChange,
  openAgentChanges,
  revertAgentChange,
} from "./agent-changes.ts";
import { globalVariablesOf, readGlobal } from "./global.ts";
import { noSkills, type TestRegistry } from "./store.fixture.ts";
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
    readonly changeAtGlobal: (
      change: ContainerFieldChange,
      at?: number,
    ) => ReturnType<typeof changeGlobal>;
    readonly revert: (
      id: number,
      at?: number,
      environment?: string,
    ) => ReturnType<typeof revertAgentChange>;
    readonly changes: ReturnType<typeof openAgentChanges>;
    readonly store: ReturnType<typeof openRegistryStore>;
    readonly storage: DurableObjectStorage;
  }) => A,
) =>
  runInDurableObject(env.REGISTRIES.get(env.REGISTRIES.newUniqueId()), (_: TestRegistry, state) => {
    const store = openRegistryStore(state.storage);
    const changes = openAgentChanges(state.storage);

    return body({
      store,
      storage: state.storage,
      changes,
      change: (change, at = 1_000, environment = DEFAULT_ENVIRONMENT) =>
        changeEnvironment(state.storage, store, changes, { environment, change, author }, at),
      changeAtGlobal: (change, at = 1_000) =>
        changeGlobal(state.storage, store, changes, { change, author }, at),
      revert: (id, at = 2_000, environment = DEFAULT_ENVIRONMENT) =>
        revertAgentChange(
          state.storage,
          store,
          changes,
          { environment, id },
          at,
          noSkills(state.storage),
        ),
    });
  });

const setVariable = (name: string, value: string | null): ContainerFieldChange => ({
  field: variableField(name),
  value,
});

describe("an Agent change the owner approved", () => {
  const approved: AgentChangeAuthor = {
    session: "s-1",
    conversation: 1,
    tool: "environment_container_size_limit_set",
    reason: "The build needs more memory",
    approved: true,
  };

  it("is made while the field has the value the owner saw, and recorded as approved", async () => {
    const [outcome, listed] = await inRegistry(({ store, storage, changes }) => [
      changeEnvironment(
        storage,
        store,
        changes,
        {
          environment: DEFAULT_ENVIRONMENT,
          change: { field: "maxInstance", value: "cpu-3" },
          expected: { value: "cpu-2" },
          author: approved,
        },
        1_000,
      ),
      changes.list(DEFAULT_ENVIRONMENT),
    ]);

    expect(outcome).toMatchObject({
      status: "changed",
      change: { field: "maxInstance", before: "cpu-2", after: "cpu-3", approved: true },
    });
    expect(listed).toMatchObject([{ field: "maxInstance", approved: true }]);
  });

  it("is not made when the field changed since the owner was asked, saying what it is now", async () => {
    const [outcome, saved, listed] = await inRegistry(({ store, storage, changes }) => {
      // The owner set the limit on the Environments page meanwhile.
      store.putEnvironmentSettings(DEFAULT_ENVIRONMENT, { maxInstance: "standard-4" });

      return [
        changeEnvironment(
          storage,
          store,
          changes,
          {
            environment: DEFAULT_ENVIRONMENT,
            change: { field: "maxInstance", value: "cpu-3" },
            expected: { value: "cpu-2" },
            author: approved,
          },
          1_000,
        ),
        store.getEnvironmentSettings(DEFAULT_ENVIRONMENT),
        changes.list(DEFAULT_ENVIRONMENT),
      ];
    });

    expect(outcome).toEqual({ status: "changed-since", current: "standard-4" });
    expect(saved).toEqual({ maxInstance: "standard-4" });
    expect(listed).toEqual([]);
  });

  it("is made when it was asked for before the sizes were renamed, under the old names", async () => {
    const [outcome, saved] = await inRegistry(({ store, storage, changes }) => [
      changeEnvironment(
        storage,
        store,
        changes,
        {
          environment: DEFAULT_ENVIRONMENT,
          change: { field: "maxInstance", value: "custom-3" },
          expected: { value: "custom-2" },
          author: approved,
        },
        1_000,
      ),
      store.getEnvironmentSettings(DEFAULT_ENVIRONMENT),
    ]);

    expect(outcome).toMatchObject({
      status: "changed",
      change: { field: "maxInstance", before: "cpu-2", after: "cpu-3" },
    });
    expect(saved).toEqual({ maxInstance: "cpu-3" });
  });
});

describe("an Agent change recorded before the sizes were renamed", () => {
  it("lists its sizes under their new names, and is reverted to the size it named", async () => {
    const [listed, outcome, saved] = await inRegistry(({ store, changes, revert }) => {
      // What a release before the rename saved and recorded: a size limit raised from custom-2 to custom-3.
      store.putEnvironmentSettings(DEFAULT_ENVIRONMENT, { maxInstance: "custom-3" });

      const recorded = changes.record({
        scope: DEFAULT_ENVIRONMENT,
        at: 1_000,
        actor: "agent",
        session: "s-1",
        conversation: 1,
        tool: "environment_container_size_limit_set",
        reason: "The build needs more memory",
        field: "maxInstance",
        before: "custom-2",
        after: "custom-3",
        reverts: null,
      });

      return [
        changes.list(DEFAULT_ENVIRONMENT),
        revert(recorded.id),
        store.getEnvironmentSettings(DEFAULT_ENVIRONMENT),
      ];
    });

    expect(listed).toMatchObject([{ field: "maxInstance", before: "cpu-2", after: "cpu-3" }]);
    expect(outcome).toMatchObject({
      status: "reverted",
      change: { field: "maxInstance", before: "cpu-3", after: "cpu-2" },
    });
    // cpu-2 is the default limit, so nothing is kept for it.
    expect(saved).toEqual({});
  });
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

const manyVariables = (count: number, prefix = "V") =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`${prefix}${index}`, "x"]));

describe("an Agent change to the variables kept Global", () => {
  it("sets and unsets a variable, recorded under the scope * with the values before and after", async () => {
    const [set, unset, kept, listed] = await inRegistry(({ changeAtGlobal, store, changes }) => [
      changeAtGlobal(setVariable("EMAIL", "me@test")),
      changeAtGlobal(setVariable("EMAIL", null), 2_000),
      readGlobal(store),
      changes.list(GLOBAL_SCOPE),
    ]);

    expect(set).toMatchObject({
      status: "changed",
      name: "EMAIL",
      previous: {},
      variables: { EMAIL: "me@test" },
      change: {
        scope: "*",
        actor: "agent",
        session: "s-1",
        tool: "environment_variable_set",
        field: "variables.EMAIL",
        before: null,
        after: "me@test",
      },
    });
    expect(unset).toMatchObject({
      status: "changed",
      previous: { EMAIL: "me@test" },
      variables: {},
      change: { before: "me@test", after: null },
    });
    expect(kept).toEqual({ settings: { variables: {} }, overrides: {} });
    expect(listed.map(({ id, field }) => ({ id, field }))).toEqual([
      { id: 2, field: "variables.EMAIL" },
      { id: 1, field: "variables.EMAIL" },
    ]);
  });

  it("records nothing for a variable unset that was not set, or set to the value it has", async () => {
    const [unset, same, listed] = await inRegistry(({ changeAtGlobal, changes }) => {
      const first = changeAtGlobal(setVariable("GONE", null));

      changeAtGlobal(setVariable("A", "1"));

      return [first, changeAtGlobal(setVariable("A", "1")), changes.list(GLOBAL_SCOPE)];
    });

    expect(unset).toEqual({ status: "unchanged", value: null });
    expect(same).toEqual({ status: "unchanged", value: "1" });
    expect(listed).toHaveLength(1);
  });

  it("refuses a field that is not a variable, and what the owner's save refuses, saving and recording nothing", async () => {
    const [setting, reserved, listed, kept] = await inRegistry(
      ({ changeAtGlobal, changes, store }) => [
        changeAtGlobal({ field: "idleMinutes", value: 5 }),
        changeAtGlobal(setVariable("PATH", "/bin")),
        changes.list(GLOBAL_SCOPE),
        readGlobal(store),
      ],
    );

    expect(setting).toEqual({
      status: "rejected",
      message: "idleMinutes: only variables are kept Global",
    });
    expect(reserved).toEqual({
      status: "rejected",
      message: expect.stringContaining('"PATH" is reserved'),
    });
    expect(listed).toEqual([]);
    expect(kept.overrides).toEqual({});
  });

  it("is refused when some Environment would be left with more than 50 variables, naming it", async () => {
    const [refused, listed, kept] = await inRegistry(({ changeAtGlobal, changes, store }) => {
      store.createEnvironment("0000abcd", "Web", 1_000);
      store.putEnvironmentSettings("0000abcd", { variables: manyVariables(50) });

      return [
        changeAtGlobal(setVariable("ONE_MORE", "x")),
        changes.list(GLOBAL_SCOPE),
        readGlobal(store),
      ];
    });

    expect(refused).toEqual({
      status: "rejected",
      message:
        'variables: environment "Web" (0000abcd) with the 1 variable at Global it does not override, it would have 51: at most 50; unset some there or here',
    });
    expect(listed).toEqual([]);
    expect(kept.overrides).toEqual({});
  });

  it("does not count a name the Environment overrides", async () => {
    const outcome = await inRegistry(({ changeAtGlobal, store }) => {
      store.putEnvironmentSettings(DEFAULT_ENVIRONMENT, { variables: manyVariables(50) });

      return changeAtGlobal(setVariable("V0", "shared"));
    });

    expect(outcome).toMatchObject({ status: "changed" });
  });

  it("refuses an Environment's own change that, with the variables kept Global, would pass 50", async () => {
    const [refused, saved] = await inRegistry(({ change, changeAtGlobal, store }) => {
      store.putEnvironmentSettings(DEFAULT_ENVIRONMENT, { variables: manyVariables(49) });
      changeAtGlobal(setVariable("E1", "x"));

      return [change(setVariable("MORE", "x")), store.getEnvironmentSettings(DEFAULT_ENVIRONMENT)];
    });

    expect(refused).toEqual({
      status: "rejected",
      message:
        "variables: with the 1 variable at Global it does not override, it would have 51: at most 50",
    });
    expect(saved).toEqual({ variables: manyVariables(49) });
  });

  it("stays when an Environment is deleted, as the Secrets' history does", async () => {
    const [listed, kept] = await inRegistry(({ changeAtGlobal, changes, store }) => {
      store.createEnvironment("0000abcd", "Other", 1_000);
      changeAtGlobal(setVariable("A", "1"));
      store.deleteEnvironment("0000abcd");

      return [changes.list(GLOBAL_SCOPE), globalVariablesOf(store)];
    });

    expect(listed).toHaveLength(1);
    expect(kept).toEqual({ A: "1" });
  });
});

describe("the owner's revert of an Agent change to a variable kept Global", () => {
  it("writes the value before back, recorded as the owner's change under the scope *", async () => {
    const [reverted, kept, listed] = await inRegistry(
      ({ changeAtGlobal, revert, store, changes }) => {
        changeAtGlobal(setVariable("A", "1"));
        changeAtGlobal(setVariable("A", "2"));

        return [
          revert(2, 3_000, GLOBAL_SCOPE),
          globalVariablesOf(store),
          changes.list(GLOBAL_SCOPE),
        ];
      },
    );

    expect(reverted).toMatchObject({
      status: "reverted",
      change: {
        id: 3,
        scope: "*",
        actor: "owner",
        field: "variables.A",
        before: "2",
        after: "1",
        reverts: 2,
      },
    });
    expect(kept).toEqual({ A: "1" });
    expect(listed.map(({ id, revertedBy }) => ({ id, revertedBy }))).toEqual([
      { id: 3, revertedBy: null },
      { id: 2, revertedBy: 3 },
      { id: 1, revertedBy: null },
    ]);
  });

  it("unsets a variable the change set", async () => {
    const kept = await inRegistry(({ changeAtGlobal, revert, store }) => {
      changeAtGlobal(setVariable("NEW", "x"));
      revert(1, 2_000, GLOBAL_SCOPE);

      return readGlobal(store);
    });

    expect(kept).toEqual({ settings: { variables: {} }, overrides: {} });
  });

  it("is refused, showing the value now, when the variable has changed since, and a second time", async () => {
    const [moved, once, again] = await inRegistry(({ changeAtGlobal, revert }) => {
      changeAtGlobal(setVariable("A", "1"));
      changeAtGlobal(setVariable("A", "2"));

      const moved = revert(1, 3_000, GLOBAL_SCOPE);
      const once = revert(2, 3_000, GLOBAL_SCOPE);

      return [moved, once, revert(2, 4_000, GLOBAL_SCOPE)];
    });

    expect(moved).toEqual({ status: "changed-since", field: "variables.A", current: "2" });
    expect(once).toMatchObject({ status: "reverted" });
    expect(again).toEqual({
      status: "refused",
      message: "Change 2 was reverted already, by change 3",
    });
  });

  it("is refused when writing the value back would leave an Environment with more than 50 variables", async () => {
    const [refused, kept] = await inRegistry(({ changeAtGlobal, revert, store }) => {
      changeAtGlobal(setVariable("GONE", "was"));
      changeAtGlobal(setVariable("GONE", null));
      store.putEnvironmentSettings(DEFAULT_ENVIRONMENT, { variables: manyVariables(50) });

      return [revert(2, 3_000, GLOBAL_SCOPE), globalVariablesOf(store)];
    });

    expect(refused).toMatchObject({
      status: "refused",
      message: expect.stringContaining("would have 51"),
    });
    expect(kept).toEqual({});
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

describe("an Agent change to each of the other Container settings", () => {
  const SCRIPT = "set -eu\napt-get install -y jq\n";

  const cases: ReadonlyArray<{
    readonly field: string;
    readonly before: Schema.Json;
    readonly after: Schema.Json;
    readonly saved: Schema.Json;
  }> = [
    { field: "instance", before: "cpu-1", after: "cpu-2", saved: { instance: "cpu-2" } },
    { field: "idleMinutes", before: 2, after: 30, saved: { idleMinutes: 30 } },
    { field: "setupScript", before: "", after: SCRIPT, saved: { setupScript: SCRIPT } },
    { field: "startScript", before: "", after: SCRIPT, saved: { startScript: SCRIPT } },
    {
      field: "toolchains",
      before: "",
      after: '[tools]\nnode = "22"\n',
      saved: { toolchains: '[tools]\nnode = "22"\n' },
    },
    {
      field: "ignore",
      before: [],
      after: ["/data", "**/.big"],
      saved: { ignore: ["/data", "**/.big"] },
    },
  ];

  it.each(cases)("saves, records and reverts $field", async ({ field, before, after, saved }) => {
    const [changed, stored, reverted, restored, listed] = await inRegistry(
      ({ change, revert, store, changes }) => {
        const first = change({ field, value: after });
        const afterChange = store.getEnvironmentSettings(DEFAULT_ENVIRONMENT);
        const second = revert(1);

        return [
          first,
          afterChange,
          second,
          store.getEnvironmentSettings(DEFAULT_ENVIRONMENT),
          changes.list(DEFAULT_ENVIRONMENT),
        ];
      },
    );

    expect(changed).toMatchObject({ status: "changed", change: { field, before, after } });
    expect(stored).toEqual(saved);
    expect(reverted).toMatchObject({
      status: "reverted",
      change: { field, before: after, after: before },
    });
    // Back at the defaults, nothing of the field is kept.
    expect(restored).toEqual({});
    expect(listed.map(({ actor }) => actor)).toEqual(["owner", "agent"]);
  });

  it("refuses a size above the size limit, naming both, and saves and records nothing", async () => {
    const [outcome, listed] = await inRegistry(({ change, changes }) => [
      change({ field: "instance", value: "standard-3" }),
      changes.list(DEFAULT_ENVIRONMENT),
    ]);

    expect(outcome).toEqual({
      status: "rejected",
      message: expect.stringContaining("size limit cpu-2"),
    });
    expect(listed).toEqual([]);
  });

  it("takes a size up to a raised size limit", async () => {
    const outcome = await inRegistry(({ change, store }) => {
      store.putEnvironmentSettings(DEFAULT_ENVIRONMENT, { maxInstance: "standard-4" });

      return change({ field: "instance", value: "standard-3" });
    });

    expect(outcome).toMatchObject({ status: "changed" });
  });

  it.each([
    { field: "idleMinutes", value: 0 },
    { field: "idleMinutes", value: 1441 },
    { field: "setupScript", value: "x".repeat(64 * 1024 + 1) },
    { field: "startScript", value: "a\u0000b" },
    { field: "toolchains", value: "x".repeat(16 * 1024 + 1) },
    { field: "ignore", value: ["data"] },
    { field: "ignore", value: Array.from({ length: 51 }, (_, index) => `/d${index}`) },
  ])("refuses $field of $value as the owner's save does, and records nothing", async (invalid) => {
    const [outcome, listed, stored] = await inRegistry(({ change, changes, store }) => [
      change(invalid),
      changes.list(DEFAULT_ENVIRONMENT),
      store.getEnvironmentSettings(DEFAULT_ENVIRONMENT),
    ]);

    expect(outcome).toMatchObject({ status: "rejected" });
    expect(listed).toEqual([]);
    expect(stored).toEqual({});
  });

  it("records nothing for the value a setting has", async () => {
    const outcome = await inRegistry(({ change }) => change({ field: "idleMinutes", value: 2 }));

    expect(outcome).toMatchObject({ status: "unchanged", value: 2 });
  });
});

describe("the owner's dismissal of an Agent change", () => {
  it("takes it out of the list, leaving what it changed and the change itself", async () => {
    const [dismissed, again, listed, kept, stored] = await inRegistry(
      ({ change, changes, store }) => {
        change(setVariable("A", "1"));
        change(setVariable("B", "2"));

        return [
          changes.dismiss(DEFAULT_ENVIRONMENT, 1),
          changes.dismiss(DEFAULT_ENVIRONMENT, 1),
          changes.list(DEFAULT_ENVIRONMENT).map(({ id }) => id),
          changes.get(DEFAULT_ENVIRONMENT, 1),
          store.getEnvironmentSettings(DEFAULT_ENVIRONMENT),
        ];
      },
    );

    expect(dismissed).toBe(true);
    // A second dismissal changes nothing, and is not refused.
    expect(again).toBe(true);
    expect(listed).toEqual([2]);
    expect(kept).toMatchObject({ id: 1, field: "variables.A", after: "1" });
    expect(stored).toEqual({ variables: { A: "1", B: "2" } });
  });

  it("answers false for a change the scope does not have", async () => {
    const [unknown, otherScope] = await inRegistry(({ change, changes }) => {
      change(setVariable("A", "1"));

      return [changes.dismiss(DEFAULT_ENVIRONMENT, 9), changes.dismiss(GLOBAL_SCOPE, 1)];
    });

    expect(unknown).toBe(false);
    expect(otherScope).toBe(false);
  });
});
