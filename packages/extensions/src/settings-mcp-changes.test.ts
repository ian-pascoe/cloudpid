// The `settings_mcp` tools that change servers without the owner's Approval (`docs/architecture/mcp-configuration.md` → The
// agent's changes → The tools, Scopes and layers, Records and revert, Results): `settings_mcp_disable`, the narrowing
// `settings_mcp_exposure_set` and `settings_mcp_tool_exposure_set`, and `settings_reset` of an adjustment's key. The Settings
// at two Scopes are the fixture's (`./settings.fixture.ts`, the Registry's rules over plain JSON), the set is resolved by the
// owner's resolver (`resolveMcpServerSet`) and the widening check is the real `checkMcpWidening`, so what the tools find is
// what the Registry would; the hosts are the in-memory fake.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off globalDate:off
import type { FakeMcpServer } from "./mcp.testing.ts";
import * as Arr from "effect/Array";
import { describe, expect, it } from "vitest";
import { GLOBAL_SETTINGS_SCOPE } from "./settings.ts";
import { nextToolKeys } from "./settings-mcp-changes.ts";
import {
  DEFAULT,
  DOCS,
  FILES,
  REASON,
  STAGING,
  failure,
  field,
  reset,
  run,
  setup,
  text,
} from "./settings-mcp.fixture.ts";

describe("the changing tools' properties", () => {
  it("are four: disable runs alone and is not replayed, enable and the exposure tools run alone and are replayed safely (they may wait for an Approval)", async () => {
    const { tool } = await setup();

    const names = [
      "settings_mcp_disable",
      "settings_mcp_enable",
      "settings_mcp_exposure_set",
      "settings_mcp_tool_exposure_set",
    ];

    expect(Arr.map(names, (name) => tool(name).executionMode)).toEqual([
      "sequential",
      "sequential",
      "sequential",
      "sequential",
    ]);

    expect(Arr.map(names, (name) => tool(name).replay)).toEqual(["unsafe", "safe", "safe", "safe"]);

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

  it("asks the user to take a hidden server out of hidden, and writes what they approve, recorded as approved", async () => {
    const { tool, recorded, asked, world, changeCalls } = await setup({
      global: { mcp: { servers: { files: { ...FILES, exposure: "hidden" } } } },
    });

    const result = await run(tool("settings_mcp_exposure_set"), {
      scope: GLOBAL_SETTINGS_SCOPE,
      name: "files",
      exposure: "direct",
      reason: REASON,
    });

    expect(result.isError).not.toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ tool: "settings_mcp_exposure_set", reason: REASON });
    expect(asked[0]?.notes?.join("\n")).toContain("takes the server out of hidden");
    expect(world.global).toEqual({ mcp: { servers: { files: { ...FILES, exposure: "direct" } } } });
    expect(recorded).toHaveLength(1);
    expect(changeCalls).toMatchObject([{ approved: true }]);
    expect(text(result)).toContain("approved");
  });

  it("changes nothing when the user declines, and says their reason", async () => {
    const { tool, recorded, events, world } = await setup({
      global: { mcp: { servers: { files: { ...FILES, exposure: "hidden" } } } },
      answers: [{ approve: false, reason: "Keep it hidden" }],
    });

    const result = await run(tool("settings_mcp_exposure_set"), {
      scope: GLOBAL_SETTINGS_SCOPE,
      name: "files",
      exposure: "direct",
      reason: REASON,
    });

    expect(text(result)).toContain("The user declined");
    expect(text(result)).toContain("Keep it hidden");
    expect(recorded).toEqual([]);
    expect(events).toEqual([]);
    expect(world.global).toEqual({ mcp: { servers: { files: { ...FILES, exposure: "hidden" } } } });
  });

  it("makes a narrowing change at once, asking nobody", async () => {
    const { tool, asked, recorded } = await setup({
      global: { mcp: { servers: { files: FILES } } },
    });

    await run(tool("settings_mcp_exposure_set"), {
      scope: DEFAULT,
      name: "files",
      exposure: "hidden",
      reason: REASON,
    });

    expect(asked).toEqual([]);
    expect(recorded).toHaveLength(1);
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

  it("asks to remove a hidden key, to loosen one and to put a non-hidden key ahead of one, saying why in the card's notes", async () => {
    const { tool, recorded, asked, world } = await setup({
      global: { mcp: { servers: { docs: DOCS } } },
      answers: [{ approve: false }, { approve: false }, { approve: false }],
    });

    await run(tool("settings_mcp_tool_exposure_set"), {
      scope: DEFAULT,
      name: "docs",
      tool: "delete_*",
      exposure: null,
      reason: REASON,
    });

    await run(tool("settings_mcp_tool_exposure_set"), {
      scope: DEFAULT,
      name: "docs",
      tool: "delete_*",
      exposure: "direct",
      reason: REASON,
    });

    await run(tool("settings_mcp_tool_exposure_set"), {
      scope: DEFAULT,
      name: "docs",
      tool: "get_*",
      exposure: "direct",
      before: "delete_*",
      reason: REASON,
    });

    const notes = Arr.map(asked, (each) => (each.notes ?? []).join("\n"));

    expect(notes[0]).toContain('removes the hidden toolExposure key "delete_*"');
    expect(notes[1]).toContain("loosens the hidden toolExposure key");
    expect(notes[2]).toContain("ahead of the hidden key");
    // Declined: nothing is written or recorded.
    expect(recorded).toEqual([]);
    expect(world.global).toEqual({ mcp: { servers: { docs: DOCS } } });
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
    expect(done.text).toContain("settings_mcp_remove");
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

  it("asks before a reset that falls back to a switched-on server, and makes it once approved", async () => {
    const { changes, recorded, asked, world, changeCalls } = await setup({
      global: { mcp: { servers: { files: FILES } } },
      overrides: { [DEFAULT]: { mcp: { servers: { files: { enabled: false } } } } },
    });

    const done = await reset(changes, DEFAULT, field("enabled"));

    expect(done.ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ tool: "settings_reset" });
    expect(asked[0]?.notes?.join("\n")).toContain("switches the server on");
    expect(recorded).toHaveLength(1);
    expect(changeCalls).toMatchObject([{ approved: true }]);
    expect(world.environments[DEFAULT]?.overrides).toEqual({});
  });

  it("changes nothing when the user declines that reset", async () => {
    const { changes, recorded, world } = await setup({
      global: { mcp: { servers: { files: FILES } } },
      overrides: { [DEFAULT]: { mcp: { servers: { files: { enabled: false } } } } },
      answers: [{ approve: false }],
    });

    const done = await reset(changes, DEFAULT, field("enabled"));

    expect(done.ok).toBe(true);
    expect(done.text).toContain("The user declined");
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
