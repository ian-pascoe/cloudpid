// The `settings_mcp` tools that change servers without the owner's Approval (`docs/architecture/mcp-configuration.md` → The
// agent's changes → The tools, Scopes and layers, Records and revert, Results): `settings_mcp_disable`, the narrowing
// `settings_mcp_exposure_set` and `settings_mcp_tool_exposure_set`, and `settings_reset` of an adjustment's key. The Settings
// at two Scopes are the fixture's (`./settings.fixture.ts`, the Registry's rules over plain JSON), the set is resolved by the
// owner's resolver (`resolveMcpServerSet`) and the widening check is the real `checkMcpWidening`, so what the tools find is
// what the Registry would; the hosts are the in-memory fake.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off globalDate:off
import {
  checkMcpWidening,
  type McpResolvedServer,
  overridesFrom,
  resolveMcpServerSet,
  resolveOverridesLeniently,
} from "@cloudpid/config";
import type {
  AgentChange,
  SettingsMcpChangeCheck,
  SettingsMcpServer,
  SettingsMcpView,
} from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { describe, expect, it } from "vitest";
import { AgentChangeLog, DeployCredentials } from "./environment.ts";
import { type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";
import {
  GLOBAL_SETTINGS_SCOPE,
  SettingsAccess,
  SettingsAccessError,
  type SettingsAccessService,
  SettingsReload,
  type SettingsView,
} from "./settings.ts";
import {
  changeGlobalSettings,
  changeSettingsOverrides,
  resolvedGlobal,
} from "./settings.fixture.ts";
import type { RecordedField } from "./settings.fixture.ts";
import { SettingsMcpAccess, type SettingsMcpAccessService } from "./settings-mcp-access.ts";
import {
  McpChangeTools,
  McpChanges,
  nextToolKeys,
  refuseWidening,
} from "./settings-mcp-changes.ts";

const DEFAULT = "default";
const STAGING = "staging";

const FILES = { command: "node", args: ["files.js"] };
const DOCS = { url: "https://docs.example/mcp", toolExposure: { "delete_*": "hidden" } };

const field = (key: string, name = "files") => `mcp.servers.${name}.${key}`;

type World = {
  global: Schema.Json;
  environments: Record<string, { name: string; overrides: Schema.Json }>;
};

/** The world as a test sets it up, with the tools over fakes of the Registry's reads, writes and check. */
const setup = async (
  start: {
    readonly global?: Schema.Json;
    readonly overrides?: Readonly<Record<string, Schema.Json>>;
    readonly own?: string;
    readonly hostServers?: ReadonlyArray<FakeMcpServer>;
    readonly offered?: ReadonlyArray<string>;
  } = {},
) => {
  const world: World = {
    global: start.global ?? {},
    environments: {
      [DEFAULT]: { name: "Default", overrides: start.overrides?.[DEFAULT] ?? {} },
      [STAGING]: { name: "Staging", overrides: start.overrides?.[STAGING] ?? {} },
    },
  };

  const own = start.own ?? DEFAULT;
  const recorded: AgentChange[] = [];
  const logged: Array<{ tool: string; field: string }> = [];
  const events: string[] = [];
  const host = fakeMcpHost(start.hostServers ?? []);

  const record = (
    made: Omit<AgentChange, "id" | "at" | "actor" | "session" | "reverts" | "revertedBy">,
  ): AgentChange => {
    const change: AgentChange = {
      id: recorded.length + 1,
      at: 1_000,
      actor: "agent",
      session: "s-1",
      reverts: null,
      revertedBy: null,
      ...made,
    };

    recorded.push(change);

    return change;
  };

  const dummy = (made: RecordedField): AgentChange => ({
    id: 0,
    at: 0,
    actor: "agent",
    session: null,
    conversation: null,
    tool: null,
    reason: "",
    reverts: null,
    revertedBy: null,
    ...made,
  });

  const setOf = (environment: string | undefined, global = world.global, overrides?: Schema.Json) =>
    resolveMcpServerSet(
      global,
      environment === undefined
        ? {}
        : (overrides ?? world.environments[environment]?.overrides ?? {}),
      [],
    );

  const missing = (id: string) =>
    SettingsAccessError.make({ message: `No Environment has the id ${JSON.stringify(id)}.` });

  const settings: SettingsAccessService = {
    get: (scope) =>
      Effect.suspend((): Effect.Effect<SettingsView, SettingsAccessError> => {
        if (scope === GLOBAL_SETTINGS_SCOPE) {
          const resolved = resolvedGlobal(world.global);

          return Effect.succeed({
            scope: GLOBAL_SETTINGS_SCOPE,
            settings: resolved,
            overrides: overridesFrom(resolved),
            overriddenIn: {},
          });
        }

        const environment = world.environments[scope];

        if (environment === undefined) return Effect.fail(missing(scope));

        const lenient = resolveOverridesLeniently(world.global, environment.overrides);

        return Effect.succeed({
          scope,
          name: environment.name,
          settings: lenient.settings,
          overrides: lenient.overrides,
          global: lenient.global,
          instructions: "",
        });
      }),
    own: Effect.succeed(own),
    change: ({ scope, changes, author: { conversation, tool, reason } }) =>
      Effect.suspend(() => {
        events.push(
          `change ${scope} ${Arr.join(
            Arr.map(changes, (each) => each.field),
            ",",
          )}`,
        );

        if (scope === GLOBAL_SETTINGS_SCOPE) {
          const changed = changeGlobalSettings(world.global, changes, (made) =>
            record({ ...made, conversation, tool, reason }),
          );

          world.global = changed.global;

          return Effect.succeed(changed.answer);
        }

        const environment = world.environments[scope];

        if (environment === undefined) return Effect.fail(missing(scope));

        const changed = changeSettingsOverrides(
          world.global,
          environment.overrides,
          scope,
          changes,
          (made) => record({ ...made, conversation, tool, reason }),
        );

        environment.overrides = changed.overrides;

        return Effect.succeed(changed.answer);
      }),
  };

  const serverOf = (resolved: McpResolvedServer): SettingsMcpServer => ({
    server: resolved,
    origins: { enabled: "default", exposure: "default", toolExposure: "default" },
    reads: [],
    resetFields: [],
    signIn: null,
    hints: [],
    problems: [],
  });

  const access: SettingsMcpAccessService = {
    view: ({ scope, name }) =>
      Effect.suspend(() => {
        const global = scope === GLOBAL_SETTINGS_SCOPE;
        const environment = world.environments[scope];

        if (!global && environment === undefined) return Effect.fail(missing(scope));

        const set = setOf(global ? undefined : scope);
        const shown = Arr.filter(set.servers, (each) => name === undefined || each.name === name);

        const definedIn =
          global && name !== undefined && shown.length === 0
            ? Arr.filterMap(Record.toEntries(world.environments), ([id, each]) =>
                Arr.some(setOf(id).servers, (server) => server.name === name)
                  ? Result.succeed({ id, name: each.name })
                  : Result.failVoid,
              )
            : undefined;

        const view: Mutable<SettingsMcpView> = {
          scope,
          name: global ? "Global" : (environment?.name ?? scope),
          servers: Arr.map(shown, serverOf),
          names: Arr.map(set.servers, (each) => each.name),
          layers: null,
          repos: [],
          orphans: set.orphans,
          problems: set.problems,
          offered: start.offered ?? [],
          warnings: [],
        };

        if (definedIn !== undefined) view.definedIn = definedIn;

        return Effect.succeed(view);
      }),
    own: Effect.succeed(own),
    check: ({ scope, name, changes }) =>
      Effect.sync((): SettingsMcpChangeCheck => {
        const ids = scope === GLOBAL_SETTINGS_SCOPE ? Record.keys(world.environments) : [scope];

        return {
          environments: Arr.filterMap(ids, (id) => {
            const before = Arr.findFirst(setOf(id).servers, (each) => each.name === name);
            const environment = world.environments[id];
            let afterSet = setOf(id);

            if (scope === GLOBAL_SETTINGS_SCOPE) {
              const changed = changeGlobalSettings(world.global, changes, dummy);

              afterSet = setOf(id, changed.global);
            } else if (environment !== undefined) {
              const changed = changeSettingsOverrides(
                world.global,
                environment.overrides,
                id,
                changes,
                dummy,
              );

              afterSet = setOf(id, world.global, changed.overrides);
            }

            const after = Arr.findFirst(afterSet.servers, (each) => each.name === name);

            if (Option.isNone(before) && Option.isNone(after)) return Result.failVoid;

            return Result.succeed({
              environment: { id, name: environment?.name ?? id },
              reached:
                JSON.stringify(Option.getOrUndefined(before)?.server) !==
                JSON.stringify(Option.getOrUndefined(after)?.server),
              widening: checkMcpWidening(
                Option.getOrUndefined(before),
                Option.getOrUndefined(after),
              ),
            });
          }),
        };
      }),
    reload: () => Effect.die("unused"),
    pushes: (environment) =>
      Effect.sync(() => {
        events.push(`pushes ${environment}`);

        return [{ kind: "set" as const, hash: `hash-${environment}`, revision: 7, entries: [] }];
      }),
    pushed: ({ environment }) =>
      Effect.sync(() => {
        events.push(`pushed ${environment}`);
      }),
    host: () => host.client,
  };

  const secrets: Pick<SecretsService, "refresh" | "redact"> = {
    refresh: Effect.void,
    redact: (value) => value,
  };

  const provided = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | SettingsMcpAccess
      | SettingsAccess
      | SettingsReload
      | AgentChangeLog
      | DeployCredentials
      | Secrets
    >,
  ) =>
    effect.pipe(
      Effect.provideService(SettingsMcpAccess, access),
      Effect.provideService(SettingsAccess, settings),
      Effect.provideService(SettingsReload, {
        apply: Effect.succeed({ picked: { model: false, thinkingLevel: false } }),
      }),
      Effect.provideService(AgentChangeLog, {
        record: (change) =>
          Effect.sync(() => {
            logged.push({ tool: change.tool, field: change.field });
          }),
      }),
      Effect.provideService(DeployCredentials, { values: [] }),
      // SAFETY: the tools use only `refresh` and `redact`.
      Effect.provideService(Secrets, secrets as SecretsService),
    );

  const extension = await Effect.runPromise(McpChangeTools.pipe(provided));
  const changes = await Effect.runPromise(McpChanges.pipe(provided));

  const tool = (name: string): ToolRegistration =>
    Option.getOrThrowWith(
      Arr.findFirst(extension, (each) => each.name === name),
      () => new Error(`no tool ${name}`),
    );

  return { world, recorded, logged, events, host, tool, changes };
};

// SAFETY: the tools read only the calling conversation from the invocation's API.
const api = { conversationId: ROOT_CONVERSATION_ID } as ToolExecutionApi;

type Outcome = Awaited<ReturnType<ToolRegistration["execute"]>>;

const run = (tool: ToolRegistration, args: Readonly<Record<string, unknown>>): Promise<Outcome> =>
  // SAFETY: the arguments are the tool's JSON parameters.
  tool.execute(args as never, api, BACKGROUND_CONTEXT);

const text = (result: Outcome): string =>
  Arr.join(
    Arr.map(result.output ?? [], (part) => (part.type === "text" ? part.text : "")),
    "",
  );

const failure = async (call: Promise<Outcome>) => {
  const result = await call;

  expect(result.isError).toBe(true);

  return text(result);
};

const REASON = "Not used by this project";

/** What `settings_reset` does for an MCP field, as `McpChanges.resetField` runs it. */
const reset = (
  changes: Awaited<ReturnType<typeof setup>>["changes"],
  scope: string,
  fieldName: string,
) =>
  Effect.runPromise(
    changes
      .resetField({ scope, field: fieldName, reason: REASON, conversation: ROOT_CONVERSATION_ID })
      .pipe(
        // SAFETY: `resetField` yields the tool's outcome, whose shape `Outcome` names.
        Effect.map((result) => ({ ok: true as const, text: text(result as Outcome) })),
        Effect.catch((error: SettingsAccessError) =>
          Effect.succeed({ ok: false as const, text: error.message }),
        ),
      ),
  );

describe("the changing tools' properties", () => {
  it("are three: disable runs alone and is not replayed, the exposure tools run alone and are replayed safely", async () => {
    const { tool } = await setup();

    const names = [
      "settings_mcp_disable",
      "settings_mcp_exposure_set",
      "settings_mcp_tool_exposure_set",
    ];

    expect(Arr.map(names, (name) => tool(name).executionMode)).toEqual([
      "sequential",
      "sequential",
      "sequential",
    ]);

    expect(Arr.map(names, (name) => tool(name).replay)).toEqual(["unsafe", "safe", "safe"]);

    for (const name of names) {
      expect(tool(name).parameters).toMatchObject({
        required: expect.arrayContaining(["scope", "name", "reason"]),
      });
    }
  });
});

describe("settings_mcp_disable", () => {
  it("at an Environment writes an adjustment of Global's server, recorded inherited before, and pushes the set to its host", async () => {
    const { tool, recorded, world, events, host, logged } = await setup({
      global: { mcp: { servers: { files: FILES } } },
    });

    const result = await run(tool("settings_mcp_disable"), {
      scope: DEFAULT,
      name: "files",
      reason: REASON,
    });

    expect(result.isError).not.toBe(true);
    expect(world.environments[DEFAULT]?.overrides).toEqual({
      mcp: { servers: { files: { enabled: false } } },
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      scope: DEFAULT,
      field: field("enabled"),
      before: null,
      after: false,
      beforeInherited: true,
      reason: REASON,
    });

    expect(logged).toEqual([{ tool: "settings_mcp_disable", field: field("enabled") }]);
    expect(events).toContain("pushes default");
    expect(events).toContain("pushed default");
    expect(host.calls.filter((call) => call.method === "apply")).toHaveLength(1);

    const shown = text(result);

    expect(shown).toContain("it was on (inherited), and is off (set here) now");
    expect(shown).toContain('Environment "Default" (default)');
    expect(shown).toContain("This Session's Environment is one of them");
  });

  it("at an Environment other than this Session's says it does not reach it, and pushes to that host only", async () => {
    const { tool, events } = await setup({
      global: { mcp: { servers: { files: FILES } } },
      own: DEFAULT,
    });

    const result = await run(tool("settings_mcp_disable"), {
      scope: STAGING,
      name: "files",
      reason: REASON,
    });

    expect(text(result)).toContain("does not reach this Session");
    expect(events).toContain("pushes staging");
    expect(events).not.toContain("pushes default");
  });

  it("at Global writes the key in Global's entry and names the Environments whose own entry overrides it", async () => {
    const { tool, recorded, world, events } = await setup({
      global: { mcp: { servers: { files: FILES } } },
      overrides: { [STAGING]: { mcp: { servers: { files: { command: "mine" } } } } },
    });

    const result = await run(tool("settings_mcp_disable"), {
      scope: GLOBAL_SETTINGS_SCOPE,
      name: "files",
      reason: REASON,
    });

    expect(world.global).toEqual({ mcp: { servers: { files: { ...FILES, enabled: false } } } });
    expect(recorded[0]).toMatchObject({ scope: "settings", before: null, after: false });
    expect(recorded[0]?.beforeInherited).toBeUndefined();

    expect(text(result)).toContain(
      'It reaches Environment "Default" (default); not Environment "Staging" (staging)',
    );

    expect(events).toContain("pushes default");
    expect(events).not.toContain("pushes staging");
  });

  it("writes the key inside the Environment's own entry for its own server, not inherited", async () => {
    const { tool, recorded, world } = await setup({
      overrides: { [DEFAULT]: { mcp: { servers: { files: FILES } } } },
    });

    await run(tool("settings_mcp_disable"), { scope: DEFAULT, name: "files", reason: REASON });

    expect(world.environments[DEFAULT]?.overrides).toEqual({
      mcp: { servers: { files: { ...FILES, enabled: false } } },
    });

    expect(recorded[0]?.beforeInherited).not.toBe(true);
  });

  it("says a server that is off already is, and records, pushes and writes nothing", async () => {
    const { tool, recorded, events } = await setup({
      global: { mcp: { servers: { files: { ...FILES, enabled: false } } } },
    });

    const result = await run(tool("settings_mcp_disable"), {
      scope: DEFAULT,
      name: "files",
      reason: REASON,
    });

    expect(text(result)).toContain("switched off");
    expect(text(result)).toContain("already");
    expect(recorded).toEqual([]);
    expect(events).toEqual([]);
  });

  it("refuses a name only Environments define at Global, naming them", async () => {
    const { tool, recorded } = await setup({
      overrides: { [STAGING]: { mcp: { servers: { files: FILES } } } },
    });

    const shown = await failure(
      run(tool("settings_mcp_disable"), {
        scope: GLOBAL_SETTINGS_SCOPE,
        name: "files",
        reason: REASON,
      }),
    );

    expect(shown).toContain('Environment "Staging" (staging)');
    expect(shown).toContain("Give the id of one of them");
    expect(recorded).toEqual([]);
  });

  it("refuses an orphaned adjustment, pointing to settings_reset", async () => {
    const { tool, recorded } = await setup({
      overrides: { [DEFAULT]: { mcp: { servers: { gone: { enabled: false } } } } },
    });

    const shown = await failure(
      run(tool("settings_mcp_disable"), { scope: DEFAULT, name: "gone", reason: REASON }),
    );

    expect(shown).toContain("settings_reset");
    expect(shown).toContain(field("enabled", "gone"));
    expect(recorded).toEqual([]);
  });

  it("refuses an unknown server, listing the Scope's, and an unknown Environment", async () => {
    const { tool } = await setup({ global: { mcp: { servers: { files: FILES } } } });

    expect(
      await failure(
        run(tool("settings_mcp_disable"), { scope: DEFAULT, name: "nope", reason: REASON }),
      ),
    ).toContain("Its servers: files");

    expect(
      await failure(
        run(tool("settings_mcp_disable"), { scope: "zzz", name: "files", reason: REASON }),
      ),
    ).toContain("zzz");
  });

  it("refuses a reason that holds a Secret Reference, saving nothing", async () => {
    const { tool, recorded } = await setup({ global: { mcp: { servers: { files: FILES } } } });

    await failure(
      run(tool("settings_mcp_disable"), {
        scope: DEFAULT,
        name: "files",
        // A placeholder, written in two parts so that nothing here is one.
        reason: `uses ${"{{"}secret:ABC${"}}"}`,
      }),
    );

    expect(recorded).toEqual([]);
  });
});

describe("settings_mcp_exposure_set", () => {
  it("narrows to hidden at an Environment and records the key as an inherited adjustment", async () => {
    const { tool, recorded, world } = await setup({
      global: { mcp: { servers: { files: FILES } } },
    });

    const result = await run(tool("settings_mcp_exposure_set"), {
      scope: DEFAULT,
      name: "files",
      exposure: "hidden",
      reason: REASON,
    });

    expect(world.environments[DEFAULT]?.overrides).toEqual({
      mcp: { servers: { files: { exposure: "hidden" } } },
    });

    expect(recorded[0]).toMatchObject({
      field: field("exposure"),
      before: null,
      after: "hidden",
      beforeInherited: true,
    });

    expect(text(result)).toContain("it was codemode (inherited), and is hidden (set here) now");
  });

  it("allows a move among codemode, deferred and direct, and writes the default as no key in an entry", async () => {
    const { tool, world } = await setup({
      global: { mcp: { servers: { files: { ...FILES, exposure: "direct" } } } },
    });

    await run(tool("settings_mcp_exposure_set"), {
      scope: GLOBAL_SETTINGS_SCOPE,
      name: "files",
      exposure: "codemode",
      reason: REASON,
    });

    expect(world.global).toEqual({ mcp: { servers: { files: FILES } } });
  });

  it("refuses to take a hidden server out of hidden, asking nobody and saving nothing", async () => {
    const { tool, recorded, events } = await setup({
      global: { mcp: { servers: { files: { ...FILES, exposure: "hidden" } } } },
    });

    const shown = await failure(
      run(tool("settings_mcp_exposure_set"), {
        scope: GLOBAL_SETTINGS_SCOPE,
        name: "files",
        exposure: "direct",
        reason: REASON,
      }),
    );

    expect(shown).toContain("needs the user's Approval");
    expect(shown).toContain("takes the server out of hidden");
    expect(recorded).toEqual([]);
    expect(events).toEqual([]);
  });

  it("says an exposure in force already is, and names the tools.offered pattern that lifts a tool to direct", async () => {
    const { tool, recorded } = await setup({
      global: { mcp: { servers: { files: FILES } } },
      offered: ["mcp__files__*"],
    });

    const same = await run(tool("settings_mcp_exposure_set"), {
      scope: DEFAULT,
      name: "files",
      exposure: "codemode",
      reason: REASON,
    });

    expect(text(same)).toContain("already");
    expect(recorded).toEqual([]);

    const result = await run(tool("settings_mcp_exposure_set"), {
      scope: DEFAULT,
      name: "files",
      exposure: "deferred",
      reason: REASON,
    });

    expect(text(result)).toContain("mcp__files__*");
    expect(text(result)).toContain("lifts a matching tool to direct");
  });
});

describe("refuseWidening", () => {
  it("words a widening kind it does not know as a plain widening, since the kinds cross the RPC", async () => {
    const check = {
      environments: [
        {
          environment: { id: "default", name: "Default" },
          reached: true,
          // A kind a later Registry adds.
          widening: [JSON.parse('{"kind":"from_a_later_registry"}')],
        },
      ],
    };

    const refused = await Effect.runPromise(refuseWidening(check, "this change").pipe(Effect.flip));

    expect(refused.message).toContain("it makes something reachable that was not");
  });
});

describe("nextToolKeys", () => {
  const keys = [
    ["a_*", "hidden"],
    ["b_*", "direct"],
  ] as const;

  it("puts a new pattern last, keeps an existing key in place, and moves one ahead of `before`", () => {
    expect(nextToolKeys(keys, "c_*", "hidden", undefined)).toEqual({
      keys: [...keys, ["c_*", "hidden"]],
    });

    expect(nextToolKeys(keys, "a_*", "deferred", undefined)).toEqual({
      keys: [
        ["a_*", "deferred"],
        ["b_*", "direct"],
      ],
    });

    expect(nextToolKeys(keys, "c_*", "hidden", "a_*")).toEqual({
      keys: [["c_*", "hidden"], ...keys],
    });

    expect(nextToolKeys(keys, "b_*", "direct", "a_*")).toEqual({
      keys: [
        ["b_*", "direct"],
        ["a_*", "hidden"],
      ],
    });
  });

  it("ignores `before` for an exact name, removes a key with null, and refuses a `before` that is no key", () => {
    expect(nextToolKeys(keys, "exact", "hidden", "a_*")).toEqual({
      keys: [...keys, ["exact", "hidden"]],
    });

    expect(nextToolKeys(keys, "a_*", null, undefined)).toEqual({ keys: [["b_*", "direct"]] });
    expect(nextToolKeys(keys, "zzz", null, undefined)).toEqual({ keys });
    expect(nextToolKeys(keys, "c_*", "hidden", "nope_*")).toMatchObject({
      problem: expect.stringContaining('before "nope_*" is no key'),
    });
  });
});

describe("settings_mcp_tool_exposure_set", () => {
  const server: FakeMcpServer = {
    name: "docs",
    tools: [{ name: "get_page" }, { name: "delete_page" }, { name: "delete_space" }],
  };

  const GLOBAL_DOCS = { mcp: { servers: { docs: { url: "https://docs.example/mcp" } } } };

  it("adds a hidden pattern last at an Environment, recording the whole map and saying which tools it decides", async () => {
    const { tool, recorded, world } = await setup({ global: GLOBAL_DOCS, hostServers: [server] });

    const result = await run(tool("settings_mcp_tool_exposure_set"), {
      scope: DEFAULT,
      name: "docs",
      tool: "delete_*",
      exposure: "hidden",
      reason: REASON,
    });

    expect(result.isError).not.toBe(true);
    expect(world.environments[DEFAULT]?.overrides).toEqual({
      mcp: { servers: { docs: { toolExposure: { "delete_*": "hidden" } } } },
    });

    expect(recorded[0]).toMatchObject({
      field: field("toolExposure", "docs"),
      before: null,
      after: { "delete_*": "hidden" },
      beforeInherited: true,
    });

    expect(text(result)).toContain("It decides delete_page (hidden), delete_space (hidden)");
  });

  it("maps a model-facing name back through the discovered tools, and refuses one that maps to none", async () => {
    const { tool, recorded } = await setup({ global: GLOBAL_DOCS, hostServers: [server] });

    await run(tool("settings_mcp_tool_exposure_set"), {
      scope: DEFAULT,
      name: "docs",
      tool: "mcp__docs__delete_page",
      exposure: "hidden",
      reason: REASON,
    });

    expect(recorded[0]?.after).toEqual({ delete_page: "hidden" });

    expect(
      await failure(
        run(tool("settings_mcp_tool_exposure_set"), {
          scope: DEFAULT,
          name: "docs",
          tool: "mcp__docs__nothing",
          exposure: "hidden",
          reason: REASON,
        }),
      ),
    ).toContain("model-facing name of none");

    expect(
      await failure(
        run(tool("settings_mcp_tool_exposure_set"), {
          scope: GLOBAL_SETTINGS_SCOPE,
          name: "docs",
          tool: "mcp__docs__delete_page",
          exposure: "hidden",
          reason: REASON,
        }),
      ),
    ).toContain("Global has no host");
  });

  it("says the tools are not checked for a server that is not discovered, and warns of a hidden key that matches none", async () => {
    const undiscovered = await setup({ global: GLOBAL_DOCS });

    const unchecked = await run(undiscovered.tool("settings_mcp_tool_exposure_set"), {
      scope: DEFAULT,
      name: "docs",
      tool: "delete_*",
      exposure: "hidden",
      reason: REASON,
    });

    expect(text(unchecked)).toContain("not checked");

    const discovered = await setup({ global: GLOBAL_DOCS, hostServers: [server] });

    const none = await run(discovered.tool("settings_mcp_tool_exposure_set"), {
      scope: DEFAULT,
      name: "docs",
      tool: "purge_*",
      exposure: "hidden",
      reason: REASON,
    });

    expect(text(none)).toContain("it hides nothing yet");
  });

  it("says a key is shadowed by an earlier one, with the fix", async () => {
    const { tool } = await setup({
      global: {
        mcp: {
          servers: {
            docs: { url: "https://docs.example/mcp", toolExposure: { "*_page": "direct" } },
          },
        },
      },
      hostServers: [server],
    });

    const result = await run(tool("settings_mcp_tool_exposure_set"), {
      scope: DEFAULT,
      name: "docs",
      tool: "delete_*",
      exposure: "hidden",
      reason: REASON,
    });

    expect(text(result)).toContain("shadowed for delete_page");
    expect(text(result)).toContain('before: "*_page"');
  });

  it("moves a key with before, and refuses a before that names no key", async () => {
    const { tool, recorded } = await setup({
      global: {
        mcp: {
          servers: {
            docs: {
              url: "https://docs.example/mcp",
              toolExposure: { "a_*": "hidden", "b_*": "hidden" },
            },
          },
        },
      },
    });

    expect(
      await failure(
        run(tool("settings_mcp_tool_exposure_set"), {
          scope: DEFAULT,
          name: "docs",
          tool: "c_*",
          exposure: "hidden",
          before: "x_*",
          reason: REASON,
        }),
      ),
    ).toContain('before "x_*" is no key');

    await run(tool("settings_mcp_tool_exposure_set"), {
      scope: DEFAULT,
      name: "docs",
      tool: "c_*",
      exposure: "hidden",
      before: "a_*",
      reason: REASON,
    });

    expect(Object.keys(recorded[0]?.after ?? {})).toEqual(["c_*", "a_*", "b_*"]);
  });

  it("refuses removing a hidden key, loosening one, and putting a non-hidden key ahead of one", async () => {
    const { tool, recorded } = await setup({ global: { mcp: { servers: { docs: DOCS } } } });

    const removed = await failure(
      run(tool("settings_mcp_tool_exposure_set"), {
        scope: DEFAULT,
        name: "docs",
        tool: "delete_*",
        exposure: null,
        reason: REASON,
      }),
    );

    expect(removed).toContain('removes the hidden toolExposure key "delete_*"');

    expect(
      await failure(
        run(tool("settings_mcp_tool_exposure_set"), {
          scope: DEFAULT,
          name: "docs",
          tool: "delete_*",
          exposure: "direct",
          reason: REASON,
        }),
      ),
    ).toContain("loosens the hidden toolExposure key");

    expect(
      await failure(
        run(tool("settings_mcp_tool_exposure_set"), {
          scope: DEFAULT,
          name: "docs",
          tool: "get_*",
          exposure: "direct",
          before: "delete_*",
          reason: REASON,
        }),
      ),
    ).toContain("ahead of the hidden key");

    expect(recorded).toEqual([]);
  });

  it("removes a key that is not hidden and says a key already so changes nothing", async () => {
    const { tool, recorded, world } = await setup({
      global: {
        mcp: {
          servers: {
            docs: { url: "https://docs.example/mcp", toolExposure: { "get_*": "direct" } },
          },
        },
      },
    });

    await run(tool("settings_mcp_tool_exposure_set"), {
      scope: GLOBAL_SETTINGS_SCOPE,
      name: "docs",
      tool: "get_*",
      exposure: null,
      reason: REASON,
    });

    // The empty map is no key in Global's entry.
    expect(world.global).toEqual(GLOBAL_DOCS);
    expect(recorded[0]).toMatchObject({ before: { "get_*": "direct" }, after: null });

    const again = await run(tool("settings_mcp_tool_exposure_set"), {
      scope: GLOBAL_SETTINGS_SCOPE,
      name: "docs",
      tool: "get_*",
      exposure: null,
      reason: REASON,
    });

    expect(text(again)).toContain("has no toolExposure key");
    expect(recorded).toHaveLength(1);
  });
});

describe("settings_reset of an MCP field", () => {
  it("removes an adjustment of Global's server and says it inherits again", async () => {
    const { changes, recorded, world, events } = await setup({
      global: { mcp: { servers: { files: FILES } } },
      overrides: { [DEFAULT]: { mcp: { servers: { files: { exposure: "direct" } } } } },
    });

    const done = await reset(changes, DEFAULT, field("exposure"));

    expect(done.ok).toBe(true);
    expect(world.environments[DEFAULT]?.overrides).toEqual({});
    expect(recorded[0]).toMatchObject({ before: "direct", after: null, afterInherited: true });
    expect(done.text).toContain("it was direct (set here), and is codemode (inherited) now");
    // Whether the change reaches this Session, and when, as the other tools say it.
    expect(done.text).toContain('It reaches Environment "Default" (default).');
    expect(done.text).toContain("This Session's Environment is one of them");
    expect(done.text).toContain(
      "The new set was handed to the MCP host of each Environment it reaches",
    );
    expect(events).toContain("pushes default");
  });

  it("refuses at Global, naming the tools to use", async () => {
    const { changes, recorded } = await setup({ global: { mcp: { servers: { files: FILES } } } });

    const done = await reset(changes, GLOBAL_SETTINGS_SCOPE, field("enabled"));

    expect(done.ok).toBe(false);
    expect(done.text).toContain('no MCP field at "*"');
    expect(done.text).toContain("settings_mcp_disable");
    expect(recorded).toEqual([]);
  });

  it("refuses a whole server, pointing to the Settings page", async () => {
    const { changes } = await setup({ global: { mcp: { servers: { files: FILES } } } });

    const done = await reset(changes, DEFAULT, "mcp.servers.files");

    expect(done.ok).toBe(false);
    expect(done.text).toContain("Settings page");
  });

  it("refuses a key of the Environment's own entry, pointing to the disable and exposure tools", async () => {
    const { changes, recorded } = await setup({
      overrides: { [DEFAULT]: { mcp: { servers: { files: { ...FILES, enabled: false } } } } },
    });

    const done = await reset(changes, DEFAULT, field("enabled"));

    expect(done.ok).toBe(false);
    expect(done.text).toContain("own entry");
    expect(done.text).toContain("settings_mcp_disable");
    expect(recorded).toEqual([]);
  });

  it("refuses a reset that falls back to a switched-on server, which needs the user's Approval", async () => {
    const { changes, recorded, world } = await setup({
      global: { mcp: { servers: { files: FILES } } },
      overrides: { [DEFAULT]: { mcp: { servers: { files: { enabled: false } } } } },
    });

    const done = await reset(changes, DEFAULT, field("enabled"));

    expect(done.ok).toBe(false);
    expect(done.text).toContain("needs the user's Approval");
    expect(done.text).toContain("switches the server on");
    expect(recorded).toEqual([]);
    expect(world.environments[DEFAULT]?.overrides).toEqual({
      mcp: { servers: { files: { enabled: false } } },
    });
  });

  it("removes an orphaned adjustment, which no server is reached by", async () => {
    const { changes, world } = await setup({
      overrides: { [DEFAULT]: { mcp: { servers: { gone: { enabled: false } } } } },
    });

    const done = await reset(changes, DEFAULT, field("enabled", "gone"));

    expect(done.ok).toBe(true);
    expect(world.environments[DEFAULT]?.overrides).toEqual({});
  });

  it("says a key that is inherited already is, changing and recording nothing", async () => {
    const { changes, recorded } = await setup({ global: { mcp: { servers: { files: FILES } } } });

    const done = await reset(changes, DEFAULT, field("exposure"));

    expect(done.ok).toBe(true);
    expect(done.text).toContain("inherits already");
    expect(recorded).toEqual([]);
  });
});
