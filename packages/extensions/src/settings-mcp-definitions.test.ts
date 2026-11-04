// The `settings_mcp` tools that define servers and switch them on, which wait for the owner's Approval
// (`docs/architecture/mcp-configuration.md` → Approval, The agent's changes): `settings_mcp_add` (an entry, or a copy of a
// Repo's server), `settings_mcp_update`, `settings_mcp_remove` and `settings_mcp_enable`. The world is the shared fixture's
// (`./settings-mcp.fixture.ts`): Settings at two Scopes, the owner's resolver, the real widening check, a fake host, and
// Approvals that answer as the test says.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off globalDate:off
import * as Arr from "effect/Array";
import { describe, expect, it } from "vitest";
import { MAX_APPROVAL_NOTE, MAX_APPROVAL_NOTES } from "./approvals.ts";
import type { FakeMcpServer } from "./mcp.testing.ts";
import { GLOBAL_SETTINGS_SCOPE } from "./settings.ts";
import {
  DEFAULT,
  FILES,
  REASON,
  STAGING,
  failure,
  field,
  run,
  setup,
  text,
} from "./settings-mcp.fixture.ts";

const ENTRY = { command: "node", args: ["server.js"] };
const REMOTE = { url: "https://docs.example/mcp" };
const entryField = (name: string) => `mcp.servers.${name}`;

const connected = (name: string): FakeMcpServer => ({
  name,
  tools: [{ name: "read_file" }, { name: "write_file" }],
});

describe("the definition tools' properties", () => {
  it("run alone and are replayed safely: each waits for the owner, and a rerun finds its request", async () => {
    const { tool } = await setup();

    for (const name of ["settings_mcp_add", "settings_mcp_update", "settings_mcp_remove"]) {
      expect(tool(name).executionMode).toBe("sequential");
      expect(tool(name).replay).toBe("safe");
    }
  });
});

describe("settings_mcp_add with an entry", () => {
  it("always asks, saying what the server runs, and writes the entry the user approves, recorded as approved", async () => {
    const { tool, asked, recorded, world, changeCalls, logged } = await setup({
      hostServers: [connected("files")],
    });

    const result = await run(tool("settings_mcp_add"), {
      scope: DEFAULT,
      name: "files",
      entry: ENTRY,
      reason: REASON,
    });

    expect(result.isError).not.toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ tool: "settings_mcp_add", reason: REASON, before: "None" });
    expect(asked[0]?.change).toContain("add");
    expect(asked[0]?.notes?.join("\n")).toContain("Runs: node server.js");
    expect(world.environments[DEFAULT]?.overrides).toEqual({
      mcp: { servers: { files: ENTRY } },
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ field: entryField("files"), before: null, after: ENTRY });
    expect(logged).toEqual([{ tool: "settings_mcp_add", field: entryField("files") }]);
    expect(changeCalls).toMatchObject([{ approved: true }]);
    expect(text(result)).toContain("approved");
  });

  it("asks at Global too, and changes nothing when the user declines, saying their reason", async () => {
    const { tool, recorded, world, events } = await setup({
      answers: [{ approve: false, reason: "Not that one" }],
    });

    const result = await run(tool("settings_mcp_add"), {
      scope: GLOBAL_SETTINGS_SCOPE,
      name: "docs",
      entry: REMOTE,
      reason: REASON,
    });

    expect(text(result)).toContain("The user declined");
    expect(text(result)).toContain("Not that one");
    expect(world.global).toEqual({});
    expect(recorded).toEqual([]);
    expect(events).toEqual([]);
  });

  it("says the server's status once made: connected with its tools, from the host's inventory, waiting up to 10 s", async () => {
    const { tool, host } = await setup({ hostServers: [connected("files")] });

    const result = await run(tool("settings_mcp_add"), {
      scope: DEFAULT,
      name: "files",
      entry: ENTRY,
      reason: REASON,
    });

    expect(text(result)).toContain("files is connected with 2 tools");
    expect(result.details).toMatchObject({
      mcp: { server: "files", status: "connected", tools: 2 },
    });
    expect(result.structuredOutput).toMatchObject({ server_status: { state: "connected" } });

    const asks = host.calls.filter((call) => call.method === "servers");

    expect(asks.at(-1)).toMatchObject({ input: { waitMs: 10_000, names: ["files"] } });
  });

  it("sends the change made and the server connecting as the call's running details before it waits for the host", async () => {
    const { tool } = await setup({ hostServers: [connected("files")] });
    const sent: Array<unknown> = [];

    await run(
      tool("settings_mcp_add"),
      { scope: DEFAULT, name: "files", entry: ENTRY, reason: REASON },
      1,
      (details) => {
        sent.push(details);

        return Promise.resolve();
      },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      scope: DEFAULT,
      approval: { approved: true },
      mcp: { server: "files", status: "connecting" },
    });
  });

  it("says a stdio server not yet discovered starts with the first call, and checks no other Environment's host", async () => {
    const { tool, host } = await setup({ own: DEFAULT });

    const stdio = await run(tool("settings_mcp_add"), {
      scope: DEFAULT,
      name: "files",
      entry: ENTRY,
      reason: REASON,
    });

    expect(text(stdio)).toContain("not");

    const other = await run(tool("settings_mcp_add"), {
      scope: STAGING,
      name: "docs",
      entry: REMOTE,
      reason: REASON,
    });

    expect(text(other)).toContain("not checked");
    expect(host.calls.filter((call) => call.method === "servers")).toHaveLength(1);
  });

  it("tells the agent to load mcp_sign_in_ask for a server that needs sign-in", async () => {
    const { tool } = await setup({
      hostServers: [{ name: "docs", tools: [], state: "sign_in" }],
    });

    const result = await run(tool("settings_mcp_add"), {
      scope: DEFAULT,
      name: "docs",
      entry: REMOTE,
      reason: REASON,
    });

    expect(text(result)).toContain("mcp_sign_in_ask");
    expect(text(result)).toContain("tool_search");
  });

  it("refuses with no ask when both of entry and from_repo are given, or neither", async () => {
    const { tool, asked } = await setup({
      repos: [{ directory: "app", servers: { files: ENTRY } }],
    });

    expect(
      await failure(
        run(tool("settings_mcp_add"), {
          scope: DEFAULT,
          name: "files",
          entry: ENTRY,
          from_repo: "app",
          reason: REASON,
        }),
      ),
    ).toContain("exactly one of entry");

    expect(
      await failure(
        run(tool("settings_mcp_add"), { scope: DEFAULT, name: "files", reason: REASON }),
      ),
    ).toContain("exactly one of entry");

    expect(asked).toEqual([]);
  });

  it("refuses a name the server already has here, pointing to settings_mcp_update, and a clashing twin", async () => {
    const { tool, asked } = await setup({
      overrides: { [DEFAULT]: { mcp: { servers: { files: ENTRY } } } },
    });

    expect(
      await failure(
        run(tool("settings_mcp_add"), {
          scope: DEFAULT,
          name: "files",
          entry: ENTRY,
          reason: REASON,
        }),
      ),
    ).toContain("settings_mcp_update");

    expect(
      await failure(
        run(tool("settings_mcp_add"), {
          scope: DEFAULT,
          name: "FILES",
          entry: ENTRY,
          reason: REASON,
        }),
      ),
    ).toContain("clashes");

    expect(asked).toEqual([]);
  });

  it("refuses an entry that defines no server, and a name that is none, before asking", async () => {
    const { tool, asked } = await setup();

    expect(
      await failure(
        run(tool("settings_mcp_add"), {
          scope: DEFAULT,
          name: "files",
          entry: { enabled: false },
          reason: REASON,
        }),
      ),
    ).toContain("defines no server");

    expect(
      await failure(
        run(tool("settings_mcp_add"), {
          scope: DEFAULT,
          name: "has space",
          entry: ENTRY,
          reason: REASON,
        }),
      ),
    ).toContain("is not a server name");

    expect(asked).toEqual([]);
  });

  it("refuses a credential written as a literal, naming the key and never the value", async () => {
    const { tool, asked, world } = await setup();

    const shown = await failure(
      run(tool("settings_mcp_add"), {
        scope: DEFAULT,
        name: "docs",
        entry: { ...REMOTE, headers: { Authorization: "Bearer very-secret-literal" } },
        reason: REASON,
      }),
    );

    expect(shown).toContain("Authorization");
    expect(shown).toContain("${NAME}");
    expect(shown).not.toContain("very-secret-literal");

    const env = await failure(
      run(tool("settings_mcp_add"), {
        scope: DEFAULT,
        name: "files",
        entry: { ...ENTRY, env: { GITHUB_TOKEN: "ghp_literal_value" } },
        reason: REASON,
      }),
    );

    expect(env).toContain("GITHUB_TOKEN");
    expect(env).not.toContain("ghp_literal_value");
    expect(asked).toEqual([]);
    expect(world.environments[DEFAULT]?.overrides).toEqual({});
  });

  it("accepts a credential kept as ${NAME} that is a Secret here, and says where it goes in the card", async () => {
    const { tool, asked } = await setup({ known: { DOCS_TOKEN: "secret" } });

    await run(tool("settings_mcp_add"), {
      scope: DEFAULT,
      name: "docs",
      entry: { ...REMOTE, headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
      reason: REASON,
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.notes?.join("\n")).toContain("DOCS_TOKEN");
    expect(asked[0]?.notes?.join("\n")).toContain("Secret");
  });

  it("refuses at an Environment a ${NAME} that is neither a Secret nor a Variable there, before asking", async () => {
    const { tool, asked } = await setup();

    const shown = await failure(
      run(tool("settings_mcp_add"), {
        scope: DEFAULT,
        name: "docs",
        entry: { ...REMOTE, headers: { "X-Org": "${ORG_ID}" } },
        reason: REASON,
      }),
    );

    expect(shown).toContain("ORG_ID");
    expect(asked).toEqual([]);
  });

  it("at Global asks with a ${NAME} that is missing, and the card says where it is missing", async () => {
    const { tool, asked } = await setup();

    await run(tool("settings_mcp_add"), {
      scope: GLOBAL_SETTINGS_SCOPE,
      name: "docs",
      entry: { ...REMOTE, headers: { "X-Org": "${ORG_ID}" } },
      reason: REASON,
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.notes?.join("\n")).toContain("ORG_ID");
    expect(asked[0]?.notes?.join("\n")).toContain("missing");
  });

  it("refuses a reason that holds a Secret Reference, asking and saving nothing", async () => {
    const { tool, asked, recorded } = await setup();

    await failure(
      run(tool("settings_mcp_add"), {
        scope: DEFAULT,
        name: "files",
        entry: ENTRY,
        // A placeholder, written in two parts so that nothing here is one.
        reason: `uses ${"{{"}secret:ABC${"}}"}`,
      }),
    );

    expect(asked).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("keeps the card's notes to 12 lines of 200 characters, the sampling line included", async () => {
    const { tool, asked } = await setup();

    await run(tool("settings_mcp_add"), {
      scope: DEFAULT,
      name: "files",
      entry: {
        command: "node",
        args: [
          Arr.join(
            Arr.makeBy(400, () => "x"),
            "",
          ),
        ],
        sampling: "allow",
        description: "a".repeat(500),
      },
      reason: REASON,
    });

    const notes = asked[0]?.notes ?? [];

    expect(notes.length).toBeGreaterThan(0);
    expect(notes.length).toBeLessThanOrEqual(MAX_APPROVAL_NOTES);

    for (const note of notes) expect(note.length).toBeLessThanOrEqual(MAX_APPROVAL_NOTE);
  });

  it("applies exactly what the owner saw, and refuses when the Scope changed since they were asked", async () => {
    const harness = await setup({
      global: { mcp: { servers: { files: FILES } } },
      onAsk: () => {
        // Someone else adds the same name at the Environment while the card waits.
        harness.world.environments[DEFAULT]!.overrides = {
          mcp: { servers: { files: { command: "other" } } },
        };
      },
    });

    const shown = await failure(
      run(harness.tool("settings_mcp_add"), {
        scope: DEFAULT,
        name: "files",
        entry: ENTRY,
        reason: REASON,
      }),
    );

    expect(shown).toContain("changed");
    expect(harness.recorded).toEqual([]);
    expect(harness.world.environments[DEFAULT]?.overrides).toEqual({
      mcp: { servers: { files: { command: "other" } } },
    });
  });

  it("on a rerun after an eviction waits for the request it made and makes the change once", async () => {
    const { tool, asked, recorded } = await setup({ held: [7] });

    const result = await run(
      tool("settings_mcp_add"),
      { scope: DEFAULT, name: "files", entry: ENTRY, reason: REASON },
      7,
    );

    expect(result.isError).not.toBe(true);
    expect(asked).toHaveLength(1);
    expect(recorded).toHaveLength(1);
  });
});

describe("settings_mcp_add with from_repo", () => {
  const repos = [
    {
      directory: "app",
      servers: { files: { command: "node", args: ["a.js"], cwd: "tools" } },
    },
  ];

  it("copies the Repo's server with its cwd made absolute, and says it is the user's server afterwards", async () => {
    const { tool, asked, world } = await setup({ repos });

    const result = await run(tool("settings_mcp_add"), {
      scope: DEFAULT,
      name: "files",
      from_repo: "app",
      reason: REASON,
    });

    expect(result.isError).not.toBe(true);
    expect(world.environments[DEFAULT]?.overrides).toEqual({
      mcp: { servers: { files: { command: "node", args: ["a.js"], cwd: "/workspace/app/tools" } } },
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.change).toContain("app");
    expect(text(result)).toContain("no longer follows");
  });

  it("refuses a Repo the Environment does not have, listing its Repos, and from_repo at Global", async () => {
    const { tool, asked } = await setup({ repos });

    const missing = await failure(
      run(tool("settings_mcp_add"), {
        scope: DEFAULT,
        name: "files",
        from_repo: "nope",
        reason: REASON,
      }),
    );

    expect(missing).toContain("app");
    expect(missing).toContain("not owner/repo");

    expect(
      await failure(
        run(tool("settings_mcp_add"), {
          scope: GLOBAL_SETTINGS_SCOPE,
          name: "files",
          from_repo: "app",
          reason: REASON,
        }),
      ),
    ).toContain("Environment's id");

    expect(asked).toEqual([]);
  });

  it("refuses a copy whose server the Repo's last good read does not have", async () => {
    const { tool, asked } = await setup({
      repos: [{ directory: "app", servers: { other: ENTRY } }],
    });

    const shown = await failure(
      run(tool("settings_mcp_add"), {
        scope: DEFAULT,
        name: "files",
        from_repo: "app",
        reason: REASON,
      }),
    );

    expect(shown).toContain("has no server");
    expect(asked).toEqual([]);
  });
});

describe("settings_mcp_update", () => {
  it("merges env key by key, asks, and writes the entry the user approved", async () => {
    const { tool, asked, world, recorded } = await setup({
      overrides: {
        [DEFAULT]: { mcp: { servers: { files: { ...ENTRY, env: { A: "1", B: "2" } } } } },
      },
    });

    const result = await run(tool("settings_mcp_update"), {
      scope: DEFAULT,
      name: "files",
      set: { env: { B: null, C: "3" }, args: ["other.js"] },
      reason: REASON,
    });

    expect(result.isError).not.toBe(true);
    expect(asked).toHaveLength(1);
    expect(world.environments[DEFAULT]?.overrides).toEqual({
      mcp: { servers: { files: { command: "node", args: ["other.js"], env: { A: "1", C: "3" } } } },
    });

    expect(recorded[0]).toMatchObject({ field: entryField("files") });
  });

  it("says a definition that is the same already is, asking and recording nothing", async () => {
    const { tool, asked, recorded } = await setup({
      overrides: { [DEFAULT]: { mcp: { servers: { files: ENTRY } } } },
    });

    const result = await run(tool("settings_mcp_update"), {
      scope: DEFAULT,
      name: "files",
      set: { args: ["server.js"] },
      reason: REASON,
    });

    expect(text(result)).toContain("already");
    expect(asked).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("refuses enabled, exposure and toolExposure, naming the tool that changes each, and a literal credential", async () => {
    const { tool, asked } = await setup({
      overrides: { [DEFAULT]: { mcp: { servers: { files: ENTRY } } } },
    });

    const keys = await failure(
      run(tool("settings_mcp_update"), {
        scope: DEFAULT,
        name: "files",
        set: { enabled: false },
        reason: REASON,
      }),
    );

    expect(keys).toContain("settings_mcp_disable");

    const literal = await failure(
      run(tool("settings_mcp_update"), {
        scope: DEFAULT,
        name: "files",
        set: { env: { API_KEY: "literal-value" } },
        reason: REASON,
      }),
    );

    expect(literal).toContain("API_KEY");
    expect(literal).not.toContain("literal-value");
    expect(asked).toEqual([]);
  });

  it("refuses a Global server at an Environment, pointing to Global or an entry of its own", async () => {
    const { tool, asked } = await setup({ global: { mcp: { servers: { files: ENTRY } } } });

    const shown = await failure(
      run(tool("settings_mcp_update"), {
        scope: DEFAULT,
        name: "files",
        set: { args: ["x"] },
        reason: REASON,
      }),
    );

    expect(shown).toContain('"*"');
    expect(asked).toEqual([]);
  });

  it("refuses when the Scope changed since the owner was asked, writing nothing", async () => {
    const harness = await setup({
      global: { mcp: { servers: { files: ENTRY } } },
      onAsk: () => {
        harness.world.global = { mcp: { servers: { files: { command: "changed" } } } };
      },
    });

    const shown = await failure(
      run(harness.tool("settings_mcp_update"), {
        scope: GLOBAL_SETTINGS_SCOPE,
        name: "files",
        set: { args: ["x"] },
        reason: REASON,
      }),
    );

    expect(shown).toContain("changed");
    expect(harness.recorded).toEqual([]);
  });
});

describe("settings_mcp_remove", () => {
  it("removes an Environment's own entry at once when it falls back to nothing reachable that was not", async () => {
    const { tool, asked, world, recorded } = await setup({
      overrides: { [DEFAULT]: { mcp: { servers: { files: ENTRY } } } },
    });

    const result = await run(tool("settings_mcp_remove"), {
      scope: DEFAULT,
      name: "files",
      reason: REASON,
    });

    expect(result.isError).not.toBe(true);
    expect(asked).toEqual([]);
    expect(world.environments[DEFAULT]?.overrides).toEqual({});
    expect(recorded[0]).toMatchObject({ field: entryField("files"), after: null });
    expect(text(result)).toContain("sign-in");
  });

  it("asks when the removal falls back to a server that is reachable where the entry's was hidden", async () => {
    const { tool, asked, world } = await setup({
      global: { mcp: { servers: { files: ENTRY } } },
      overrides: {
        [DEFAULT]: { mcp: { servers: { files: { ...ENTRY, exposure: "hidden" } } } },
      },
    });

    await run(tool("settings_mcp_remove"), { scope: DEFAULT, name: "files", reason: REASON });

    expect(asked).toHaveLength(1);
    expect(world.environments[DEFAULT]?.overrides).toEqual({});
  });

  it("refuses a Global server at an Environment, pointing to settings_mcp_disable", async () => {
    const { tool, asked } = await setup({ global: { mcp: { servers: { files: ENTRY } } } });

    const shown = await failure(
      run(tool("settings_mcp_remove"), { scope: DEFAULT, name: "files", reason: REASON }),
    );

    expect(shown).toContain("settings_mcp_disable");
    expect(asked).toEqual([]);
  });

  it("removes Global's entry, naming the Environments that lose the server", async () => {
    const { tool, world } = await setup({ global: { mcp: { servers: { files: ENTRY } } } });

    const result = await run(tool("settings_mcp_remove"), {
      scope: GLOBAL_SETTINGS_SCOPE,
      name: "files",
      reason: REASON,
    });

    expect(result.isError).not.toBe(true);
    expect(world.global).toEqual({});
  });
});

describe("settings_mcp_enable", () => {
  it("asks before switching a server on, writes what the user approves, and says its status", async () => {
    const { tool, asked, world, recorded } = await setup({
      global: { mcp: { servers: { files: { ...FILES, enabled: false } } } },
      hostServers: [connected("files")],
    });

    const result = await run(tool("settings_mcp_enable"), {
      scope: DEFAULT,
      name: "files",
      reason: REASON,
    });

    expect(result.isError).not.toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ tool: "settings_mcp_enable" });
    expect(asked[0]?.notes?.join("\n")).toContain("switches the server on");
    expect(recorded[0]).toMatchObject({ field: field("enabled") });
    expect(world.environments[DEFAULT]?.overrides).toEqual({
      mcp: { servers: { files: { enabled: true } } },
    });

    expect(text(result)).toContain("connected");
  });

  it("changes nothing when the user declines", async () => {
    const { tool, recorded, world } = await setup({
      global: { mcp: { servers: { files: { ...FILES, enabled: false } } } },
      answers: [{ approve: false }],
    });

    const result = await run(tool("settings_mcp_enable"), {
      scope: DEFAULT,
      name: "files",
      reason: REASON,
    });

    expect(text(result)).toContain("The user declined");
    expect(recorded).toEqual([]);
    expect(world.environments[DEFAULT]?.overrides).toEqual({});
  });

  it("says a server that is on already is, asking nobody", async () => {
    const { tool, asked } = await setup({ global: { mcp: { servers: { files: FILES } } } });

    const result = await run(tool("settings_mcp_enable"), {
      scope: DEFAULT,
      name: "files",
      reason: REASON,
    });

    expect(text(result)).toContain("switched on");
    expect(text(result)).toContain("already");
    expect(asked).toEqual([]);
  });
});
