// @effect-diagnostics preferEffectArray:off preferEffectRecord:off -- expected lists of a test are native arrays.

// The MCP servers section's pure parts: the rows at each Scope, the form's entry, the import's preview, and the changes
// the owner's actions write.

import {
  McpNoEnvironment,
  type McpRepoFileView,
  type McpServerView,
  McpServersList,
  McpUnavailable,
  type OverridingEnvironment,
} from "@cloudpid/protocol";
import { MCP_ADJUSTMENT_OVER, resolveOverridesLeniently } from "@cloudpid/config";
import type * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import {
  checkMcpEntry,
  EMPTY_MCP_OAUTH,
  emptyMcpFields,
  entryOfFields,
  entryOfJson,
  fieldsOfEntry,
  mcpNameProblem,
} from "./mcp-form.ts";
import { mcpImportWrites, previewMcpImport } from "./mcp-import.ts";
import {
  droppedMcpProblems,
  mcpProblemText,
  mcpMissingReferences,
  mcpReferencesOf,
  mcpRepoLayersOf,
  mcpScopeView,
  mcpStatusChip,
  mcpStatuses,
} from "./mcp-model.ts";
import { mcpGlobalDocument, mcpOverridesPatch } from "./mcp-write.ts";

const WORK: OverridingEnvironment = { id: "work", name: "Work" };

const GLOBAL_DOCUMENT: Schema.Json = {
  mcp: {
    servers: {
      linear: {
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer ${LINEAR_TOKEN}" },
        description: "Issues",
      },
      files: { command: "npx", args: ["-y", "@mcp/files"], enabled: false },
      search: {
        url: "https://search.example.com/mcp",
        exposure: "direct",
        toolExposure: { "delete_*": "hidden" },
      },
    },
  },
};

const OVERRIDES: Schema.Json = {
  mcp: {
    servers: {
      linear: { enabled: false },
      search: { url: "https://search.work.example.com/mcp" },
      notes: { command: "notes-mcp" },
      gone: { exposure: "hidden" },
    },
  },
};

const OFFERED = ["read", "codemode", "tool_search"];

const atGlobal = (offered = OFFERED) =>
  mcpScopeView({
    scope: "*",
    global: GLOBAL_DOCUMENT,
    globalProblem: undefined,
    overrides: null,
    overridesProblem: undefined,
    offered,
    overriddenIn: {
      "mcp.servers.linear.enabled": [WORK],
      "mcp.servers.linear.toolExposure": [WORK, { id: "home", name: "Home" }],
      "mcp.servers.search": [WORK],
    },
  });

const atWork = (overrides: Schema.Json = OVERRIDES, offered = OFFERED) =>
  mcpScopeView({
    scope: "work",
    global: GLOBAL_DOCUMENT,
    globalProblem: undefined,
    overrides,
    overridesProblem: undefined,
    offered,
    overriddenIn: {},
  });

const row = (view: ReturnType<typeof atGlobal>, name: string) => {
  const found = view.rows.find((held) => held.name === name);

  if (found === undefined) throw new Error(`no row ${name}`);

  return found;
};

describe("the rows at Global", () => {
  it("list Global's servers by name, each its own", () => {
    const view = atGlobal();

    expect(view.rows.map(({ name, kind }) => [name, kind])).toEqual([
      ["files", "global"],
      ["linear", "global"],
      ["search", "global"],
    ]);
  });

  it("carry the entry in force, with its defaults", () => {
    const linear = row(atGlobal(), "linear").server;

    expect(linear).toMatchObject({
      type: "http",
      enabled: true,
      exposure: "codemode",
      sampling: "ask",
      timeout: 60,
    });
  });

  it("name the Environments that override a server by its entry or any adjustment key, once each", () => {
    expect(row(atGlobal(), "linear").overriddenIn).toEqual([WORK, { id: "home", name: "Home" }]);
    expect(row(atGlobal(), "search").overriddenIn).toEqual([WORK]);
    expect(row(atGlobal(), "files").overriddenIn).toEqual([]);
  });
});

describe("the rows at an Environment", () => {
  const view = atWork();

  it("follow a Global server it does not touch: inherited", () => {
    expect(row(view, "files")).toMatchObject({ kind: "inherited", adjusted: [] });
  });

  it("mark a Global server it adjusts, naming the keys, and apply them", () => {
    expect(row(view, "linear")).toMatchObject({ kind: "adjusted", adjusted: ["enabled"] });
    expect(row(view, "linear").server.enabled).toBe(false);
  });

  it("show its own server, and one that replaces Global's of the same name", () => {
    expect(row(view, "notes")).toMatchObject({ kind: "own", source: { kind: "environment" } });
    expect(row(view, "search")).toMatchObject({ kind: "replaces" });
    expect(row(view, "search").server).toMatchObject({
      url: "https://search.work.example.com/mcp",
    });
  });

  it("keep the entry as written where it is defined", () => {
    expect(row(view, "notes").written).toEqual({ command: "notes-mcp" });
    expect(row(view, "files").written).toEqual({
      command: "npx",
      args: ["-y", "@mcp/files"],
      enabled: false,
    });
  });

  it("report an adjustment with no server as a problem naming its source, with its Reset", () => {
    expect(view.problems).toEqual([
      {
        name: "gone",
        source: "this environment",
        message: "adjusts a server that no layer defines any more: reset it",
        reset: ["mcp.servers.gone.exposure"],
      },
    ]);
  });

  it("put the problems that name a server on its row, with the source", () => {
    const stale = mcpScopeView({
      scope: "work",
      global: GLOBAL_DOCUMENT,
      globalProblem: undefined,
      overrides: OVERRIDES,
      overridesProblem:
        "These saved Overrides no longer apply and are ignored, so their fields inherit Global:\nmcp.servers.linear.exposure: Expected one of codemode",
      offered: OFFERED,
      overriddenIn: {},
    });

    expect(row(stale, "linear").problems.map(mcpProblemText)).toEqual([
      "this environment: is not used and is forgotten by the next save: exposure: Expected one of codemode",
    ]);
    expect(stale.problems.map(({ name }) => name)).toEqual(["gone"]);
  });

  it("read the structured problems of an up-to-date Registry, not the text, where it gives them", () => {
    const view = mcpScopeView({
      scope: "work",
      global: GLOBAL_DOCUMENT,
      globalProblem: undefined,
      // The text says a different story: only the structured field is read.
      overridesProblem: "mcp.servers.linear.exposure: from the text",
      overridesMcpProblems: [
        {
          source: "environment",
          name: "files",
          keys: ["toolExposure"],
          message: MCP_ADJUSTMENT_OVER,
          reset: ["mcp.servers.files.toolExposure"],
        },
      ],
      overrides: OVERRIDES,
      offered: OFFERED,
      overriddenIn: {},
    });

    expect(row(view, "linear").problems).toEqual([]);
    expect(row(view, "files").problems).toEqual([
      {
        name: "files",
        source: "this environment",
        message: `is not used and is forgotten by the next save: toolExposure: ${MCP_ADJUSTMENT_OVER}`,
        reset: ["mcp.servers.files.toolExposure"],
      },
    ]);
  });

  it("read the text only where the Registry gives no structured problems: an empty list is none", () => {
    const text =
      "These saved Overrides no longer apply:\nmcp.servers.linear.exposure: from the text";

    const input = {
      scope: "work",
      global: GLOBAL_DOCUMENT,
      globalProblem: undefined,
      overrides: OVERRIDES,
      overridesProblem: text,
      offered: OFFERED,
      overriddenIn: {},
    };

    expect(row(mcpScopeView({ ...input, overridesMcpProblems: [] }), "linear").problems).toEqual(
      [],
    );
    expect(row(mcpScopeView(input), "linear").problems).toHaveLength(1);
  });

  it("show a problem in a layer a later build adds as that layer names itself, never as Global's", () => {
    const view = mcpScopeView({
      scope: "work",
      global: GLOBAL_DOCUMENT,
      globalProblem: undefined,
      overridesProblem: undefined,
      overridesMcpProblems: [
        { source: "repo", name: "linear", keys: [], message: "is skipped", reset: [] },
      ],
      overrides: OVERRIDES,
      offered: OFFERED,
      overriddenIn: {},
    });

    expect(row(view, "linear").problems.map(mcpProblemText)).toEqual(["repo: is skipped"]);
  });

  it("show an adjustment held over the entry bound on its server's row with its Reset, as the Registry reads it", () => {
    const global: Schema.Json = {
      mcp: {
        servers: {
          a: {
            command: "x",
            args: Array.from({ length: 120 }, (_, i) => `${"a".repeat(96)}${i}`),
          },
        },
      },
    };

    const saved: Schema.Json = {
      mcp: {
        servers: {
          a: {
            enabled: false,
            toolExposure: Object.fromEntries(
              Array.from({ length: 150 }, (_, i) => [`${"p".repeat(20)}_${i}_*`, "hidden"]),
            ),
          },
        },
      },
    };

    const lenient = resolveOverridesLeniently(global, saved);

    const view = mcpScopeView({
      scope: "work",
      global,
      globalProblem: undefined,
      overrides: lenient.overrides,
      overridesProblem: lenient.dropped.join("\n"),
      overridesMcpProblems: lenient.mcpProblems,
      offered: OFFERED,
      overriddenIn: {},
    });

    expect(row(view, "a").kind).toBe("adjusted");
    expect(row(view, "a").problems).toEqual([
      {
        name: "a",
        source: "this environment",
        message: `is not used and is forgotten by the next save: toolExposure: ${MCP_ADJUSTMENT_OVER}`,
        reset: ["mcp.servers.a.toolExposure"],
      },
    ]);
  });

  it("do not show a Global server left out for an Environment's twin name as this environment's forgotten Override", () => {
    const global: Schema.Json = { mcp: { servers: { linear: { url: "https://a.example.com" } } } };
    const saved: Schema.Json = { mcp: { servers: { Linear: { url: "https://b.example.com" } } } };
    const lenient = resolveOverridesLeniently(global, saved);

    const view = mcpScopeView({
      scope: "work",
      global,
      globalProblem: undefined,
      overrides: lenient.overrides,
      overridesProblem: lenient.dropped.join("\n"),
      overridesMcpProblems: lenient.mcpProblems,
      offered: OFFERED,
      overriddenIn: {},
    });

    const lines = [...view.problems, ...view.rows.flatMap(({ problems }) => problems)].map(
      mcpProblemText,
    );

    expect(lines.filter((line) => line.startsWith("Global: is left out"))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("this environment: is not used"))).toEqual([]);

    // An older Registry, which only gives the text, has it read from there: it cannot tell whose layer a line is in.
    const older = mcpScopeView({
      scope: "work",
      global,
      globalProblem: undefined,
      overrides: lenient.overrides,
      overridesProblem: `These saved Overrides no longer apply:\n${lenient.dropped.join("\n")}`,
      offered: OFFERED,
      overriddenIn: {},
    });

    expect(older.problems.map(mcpProblemText)).toContainEqual(
      expect.stringMatching(/^this environment: is not used and is forgotten/),
    );
  });
});

describe("the ${NAME}s of a server", () => {
  it("are read from env and headers values, and oauth's two secrets, once per place", () => {
    expect(
      mcpReferencesOf({
        env: { A: "${X}-${X}", B: "plain" },
        headers: { Authorization: "Bearer ${Y}" },
        oauth: { clientSecret: "${Z}" },
      }),
    ).toEqual([
      { name: "X", where: "env.A" },
      { name: "Y", where: "headers.Authorization" },
      { name: "Z", where: "oauth.clientSecret" },
    ]);
  });

  it("are missing when the Scope has neither a Secret nor a Variable of the name", () => {
    expect(
      mcpMissingReferences(
        [
          { name: "S", where: "env.A" },
          { name: "V", where: "env.B" },
          { name: "M", where: "env.C" },
        ],
        { secrets: ["S"], variables: ["V"] },
      ),
    ).toEqual([{ name: "M", where: "env.C" }]);
  });

  it("are listed on the row of the server that reads them", () => {
    expect(row(atGlobal(), "linear").references).toEqual([
      { name: "LINEAR_TOKEN", where: "headers.Authorization" },
    ]);
  });
});

describe("the warning that codemode is not offered", () => {
  it("names the enabled servers with codemode Exposure when the offered tools lack codemode", () => {
    expect(atGlobal(["read"]).warnings).toEqual([
      { kind: "codemode-not-offered", servers: ["linear"] },
    ]);
  });

  it("is quiet when codemode, or a pattern that matches it, is offered", () => {
    expect(atGlobal(["codemode"]).warnings).toEqual([]);
    expect(atGlobal(["code*"]).warnings).toEqual([]);
  });

  it("is quiet when no enabled server has codemode Exposure", () => {
    const view = mcpScopeView({
      scope: "*",
      global: { mcp: { servers: { a: { url: "https://a.example.com", exposure: "direct" } } } },
      globalProblem: undefined,
      overrides: null,
      overridesProblem: undefined,
      offered: [],
      overriddenIn: {},
    });

    expect(view.warnings).toEqual([]);
  });
});

describe("what a saved problem line says", () => {
  it("is read from the lines about MCP servers only", () => {
    expect(
      droppedMcpProblems(
        "These saved overrides no longer apply and are ignored:\nmodel: nope\nmcp.servers.a.oauth.clientSecret: must be one ${NAME}\nmcp.servers.b: has both a command and a url",
        "Global",
      ).map(({ name, message }) => [name, message]),
    ).toEqual([
      [
        "a",
        "is not used and is forgotten by the next save: oauth.clientSecret: must be one ${NAME}",
      ],
      ["b", "is not used and is forgotten by the next save: has both a command and a url"],
    ]);
  });
});

describe("the status chips", () => {
  const server = (state: string, more: Partial<McpServerView> = {}): McpServerView => ({
    name: "a",
    source: { kind: "global" },
    state,
    counts: { tools: 12, prompts: 0 },
    resources: false,
    problems: [],
    tools: [{ name: "search", exposure: "codemode" }],
    prompts: [],
    ...more,
  });

  it.each([
    ["connected", "Connected · 12 tools", false],
    ["connecting", "Connecting", false],
    ["sign_in", "Needs sign-in", true],
    ["rejected", "Sign-in rejected", true],
    ["failed", "Failed", true],
    ["not_discovered", "Not checked", false],
    ["a state a later build adds", "Unknown state", true],
  ])("read %s as %s", (state, label, problem) => {
    expect(mcpStatusChip(server(state))).toMatchObject({ label, problem });
  });

  it("carry a failure's message", () => {
    expect(mcpStatusChip(server("failed", { error: "ECONNREFUSED" })).label).toBe(
      "Failed: ECONNREFUSED",
    );
  });

  it("are kept by name, with the tools discovered, from a list; a host that did not answer says so", () => {
    expect(
      mcpStatuses(McpServersList.make({ version: "1", servers: [server("connected")] })),
    ).toEqual({
      chips: { a: { state: "connected", label: "Connected · 12 tools", problem: false } },
      unavailable: null,
      tools: { a: ["search"] },
    });
    expect(mcpStatuses(McpUnavailable.make({ message: "no host" })).unavailable).toBe("no host");
    expect(mcpStatuses(McpNoEnvironment.make({}))).toEqual({
      chips: {},
      unavailable: null,
      tools: {},
    });
  });
});

describe("the form's entry", () => {
  const stdio = {
    ...emptyMcpFields("stdio"),
    name: "files",
    command: "npx",
    args: ["-y", "@mcp/files"],
    env: [{ key: "ROOT", value: "/workspace" }],
  };

  it("is written without a default: enabled, Exposure codemode and sampling ask are left out", () => {
    expect(entryOfFields(stdio)).toEqual({
      command: "npx",
      args: ["-y", "@mcp/files"],
      env: { ROOT: "/workspace" },
    });
  });

  it("holds Model use, Exposure, toolExposure in the order of its rows, and the switch only when off", () => {
    expect(
      entryOfFields({
        ...emptyMcpFields("http"),
        url: "https://a.example.com/mcp",
        headers: [{ key: "X-Team", value: "core" }],
        timeout: "30",
        description: "Docs",
        enabled: false,
        exposure: "deferred",
        sampling: "allow",
        toolExposure: [
          { pattern: "delete_*", exposure: "hidden" },
          { pattern: "*", exposure: "direct" },
        ],
      }),
    ).toEqual({
      url: "https://a.example.com/mcp",
      headers: { "X-Team": "core" },
      timeout: 30,
      description: "Docs",
      enabled: false,
      exposure: "deferred",
      sampling: "allow",
      toolExposure: { "delete_*": "hidden", "*": "direct" },
    });
  });

  it("leaves out the other transport's keys and blank rows", () => {
    expect(
      entryOfFields({
        ...stdio,
        url: "https://stale.example.com",
        headers: [{ key: "A", value: "b" }],
        env: [{ key: "", value: "" }],
      }),
    ).toEqual({ command: "npx", args: ["-y", "@mcp/files"] });
  });

  it("goes round through the form and back, keeping oauth and type as written", () => {
    const written = {
      type: "streamable-http",
      url: "https://a.example.com/mcp",
      oauth: { clientId: "abc", clientSecret: "${SECRET}" },
      sampling: "off",
      toolExposure: { "get_*": "direct" },
    } satisfies Schema.JsonObject;

    expect(entryOfFields(fieldsOfEntry("a", written))).toEqual(written);
  });

  it("writes the oauth fields in the order of the spec, with no default and none the grant type does not use", () => {
    const http = emptyMcpFields("http");

    expect(
      entryOfFields({
        ...http,
        url: "https://a.example.com/mcp",
        oauth: {
          ...EMPTY_MCP_OAUTH,
          clientId: "abc",
          clientSecret: "${SECRET}",
          scope: "read",
          clientName: "mine",
          clientRegistration: "dcr",
          // Typed, then hidden by choosing client credentials: not written.
          grantType: "client_credentials",
          keyId: "k1",
          issuer: "https://auth.example.com",
        },
      }),
    ).toEqual({
      url: "https://a.example.com/mcp",
      oauth: {
        clientId: "abc",
        clientSecret: "${SECRET}",
        keyId: "k1",
        scope: "read",
        issuer: "https://auth.example.com",
        grantType: "client_credentials",
      },
    });
    expect(
      entryOfFields({
        ...http,
        url: "https://a.example.com/mcp",
        oauth: { ...EMPTY_MCP_OAUTH, clientName: "mine", keyId: "k1", clientRegistration: "dcr" },
      }),
    ).toEqual({
      url: "https://a.example.com/mcp",
      oauth: { clientName: "mine", clientRegistration: "dcr" },
    });
    expect(entryOfFields({ ...http, url: "https://a.example.com/mcp" })).toEqual({
      url: "https://a.example.com/mcp",
    });
  });

  it("drops oauth from a stdio server", () => {
    expect(
      entryOfFields({ ...stdio, oauth: { ...EMPTY_MCP_OAUTH, clientId: "abc" } }),
    ).not.toHaveProperty("oauth");
  });

  it("goes round through the form and back with every oauth field and the keys it ignores", () => {
    const written = {
      url: "https://a.example.com/mcp",
      oauth: {
        clientId: "abc",
        clientSecret: "${SECRET}",
        scope: "read write",
        clientName: "mine",
        clientRegistration: "dcr",
        authServerMetadataUrl: "https://a.example.com/.well-known/oauth-authorization-server",
        callbackPort: 8080,
      },
    } satisfies Schema.JsonObject;

    const fields = fieldsOfEntry("a", written);

    expect(fields.oauth.clientId).toBe("abc");
    expect(fields.oauth.clientRegistration).toBe("dcr");
    expect(fields.oauth.kept).toEqual({ callbackPort: 8080 });
    expect(entryOfFields(fields)).toEqual(written);
  });

  it("is read from the JSON tab, or refused with why", () => {
    expect(Result.getOrUndefined(entryOfJson('{"url": "https://a.example.com"}'))).toEqual({
      url: "https://a.example.com",
    });
    expect(Result.getFailure(entryOfJson("[1]"))._tag).toBe("Some");
    expect(Result.isFailure(entryOfJson("{"))).toBe(true);
  });
});

describe("the checks of a form", () => {
  const names = { global: ["linear"], own: ["notes"], adjusted: ["files"] };
  const globalRules = { names, atGlobal: true, editing: null };
  const workRules = { names, atGlobal: false, editing: null };

  it("name the server: not empty, a name, none Global or the Environment has, no twin", () => {
    expect(mcpNameProblem("", globalRules)).toBe("Name the server.");
    expect(mcpNameProblem("a b", globalRules)).toContain("letters, digits");
    expect(mcpNameProblem("linear", globalRules)).toBe(
      "Global has a server of that name: edit it.",
    );
    expect(mcpNameProblem("Linear", globalRules)).toContain('Clashes with "linear"');
    expect(mcpNameProblem("notes", workRules)).toBe(
      "This environment has its own server of that name: edit it.",
    );
    expect(mcpNameProblem("no-tes", workRules)).toBeNull();
    expect(mcpNameProblem("Files", workRules)).toContain('Clashes with "files"');
    expect(mcpNameProblem("notes", { ...workRules, editing: "notes" })).toBeNull();
  });

  it("allow an Environment's own entry the name of Global's server: it replaces it", () => {
    expect(mcpNameProblem("linear", workRules)).toBeNull();
  });

  it("refuse an entry the Registry would, with its problems at the key", () => {
    const check = checkMcpEntry({
      name: "a",
      entry: { command: "~/bin/x", env: { A: "!echo" } },
      rules: globalRules,
      references: null,
    });

    expect(check.entry).toBeNull();
    expect(check.problems.join("\n")).toContain("command: starts with ~");
    expect(check.problems.join("\n")).toContain("env.A: starts with !");
  });

  it("warn of a credential-shaped literal without refusing the entry", () => {
    const check = checkMcpEntry({
      name: "a",
      entry: { url: "https://a.example.com", headers: { Authorization: "Bearer abc" } },
      rules: globalRules,
      references: null,
    });

    expect(check.problems).toEqual([]);
    expect(check.warnings.map(({ key }) => key)).toEqual(["Authorization"]);
  });

  it("hint at Global, and refuse at an Environment, a ${NAME} that is neither a Secret nor a Variable", () => {
    const entry = { url: "https://a.example.com", headers: { Authorization: "Bearer ${NOPE}" } };
    const references = { secrets: ["OTHER"], variables: [] };
    const global = checkMcpEntry({ name: "a", entry, rules: globalRules, references });
    const work = checkMcpEntry({ name: "a", entry, rules: workRules, references });

    expect(global.problems).toEqual([]);
    expect(global.hints).toHaveLength(1);
    expect(work.problems).toEqual([
      "headers.Authorization reads ${NOPE}, which this environment has neither as a Secret nor as a Variable",
    ]);
  });
});

describe("the import", () => {
  const names = { global: ["linear"], own: [], adjusted: [] };
  const rules = { names, atGlobal: true };

  const text = JSON.stringify({
    autoEnableCodemode: true,
    mcpServers: {
      linear: { url: "https://mcp.linear.app/mcp" },
      fresh: { command: "fresh-mcp" },
      bad: { command: "x", url: "https://x.example.com" },
      leaky: { url: "https://l.example.com", headers: { "X-API-Key": "abc" } },
    },
  });

  it("lists each entry with its problems before anything is saved", () => {
    const preview = previewMcpImport(text, rules, null);

    expect(
      preview.entries.map(({ name, conflict, problems }) => [name, conflict, problems.length]),
    ).toEqual([
      ["linear", true, 0],
      ["fresh", false, 0],
      ["bad", false, 1],
      ["leaky", false, 0],
    ]);
    expect(preview.entries[2]?.problems[0]).toContain("both a command and a url");
    expect(preview.entries[3]?.warnings).toHaveLength(1);
  });

  it("ignores autoEnableCodemode with a hint", () => {
    expect(previewMcpImport(text, rules, null).hints[0]).toEqual({
      text: expect.stringContaining("autoEnableCodemode is ignored"),
      link: "tools",
    });
  });

  it("asks Replace or Skip for a name the Scope has: it is skipped until Replace is chosen", () => {
    const preview = previewMcpImport(text, rules, null);

    expect(mcpImportWrites(preview, {}).map(({ name }) => name)).toEqual(["fresh", "leaky"]);
    expect(mcpImportWrites(preview, { linear: "skip" }).map(({ name }) => name)).toEqual([
      "fresh",
      "leaky",
    ]);
    expect(mcpImportWrites(preview, { linear: "replace" }).map(({ name }) => name)).toEqual([
      "linear",
      "fresh",
      "leaky",
    ]);
  });

  it("never writes an entry with a problem, even where Replace is chosen", () => {
    const preview = previewMcpImport(
      JSON.stringify({ mcpServers: { linear: { command: "x", url: "https://x.example.com" } } }),
      rules,
      null,
    );

    expect(mcpImportWrites(preview, { linear: "replace" })).toEqual([]);
  });

  it("is a conflict at an Environment only for its own names; Global's is a replacement", () => {
    const preview = previewMcpImport(
      text,
      { names: { global: ["linear"], own: ["fresh"], adjusted: [] }, atGlobal: false },
      null,
    );

    expect(
      preview.entries.map(({ name, conflict, replacesGlobal }) => [name, conflict, replacesGlobal]),
    ).toEqual([
      ["linear", false, true],
      ["fresh", true, false],
      ["bad", false, false],
      ["leaky", false, false],
    ]);
  });

  it("counts the servers a Scope may have: the 51st is a problem", () => {
    const held = Array.from({ length: 50 }, (_, index) => `s${index}`);

    const preview = previewMcpImport(
      JSON.stringify({ mcpServers: { extra: { command: "x" }, s1: { command: "y" } } }),
      { names: { global: held, own: [], adjusted: [] }, atGlobal: true },
      null,
    );

    expect(preview.entries[0]?.problems).toEqual(["is over the 50 servers a Scope may have"]);
    expect(preview.entries[1]?.problems).toEqual([]);
  });

  it("says why text that is not pi's JSON cannot be read, and shows nothing for empty text", () => {
    expect(previewMcpImport("{", rules, null).problem).toContain("Not JSON");
    expect(previewMcpImport("[]", rules, null).problem).toContain("mcpServers");
    expect(previewMcpImport("", rules, null)).toEqual({ problem: null, entries: [], hints: [] });
  });
});

describe("what a change writes", () => {
  /** The names of the Global servers the Registry holds when the owner acts. */
  const GLOBAL_SERVERS = ["linear", "files", "search"];

  const entry = { command: "x" };

  it("sets a key of Global's entry, leaving the rest of the document as it was", () => {
    const next = mcpGlobalDocument(
      {
        mcp: { servers: { a: { command: "x" }, b: { url: "https://b.example.com" } } },
        model: "m",
      },
      { kind: "enabled", name: "a", target: "own", enabled: false },
    );

    expect(Result.getOrUndefined(next)).toEqual({
      model: "m",
      mcp: {
        servers: { a: { command: "x", enabled: false }, b: { url: "https://b.example.com" } },
      },
    });
  });

  it("fails for a server Global no longer has", () => {
    expect(
      Result.isFailure(
        mcpGlobalDocument({}, { kind: "exposure", name: "a", target: "own", exposure: "hidden" }),
      ),
    ).toBe(true);
  });

  it("puts, removes and imports Global's entries, dropping an empty mcp root", () => {
    const put = mcpGlobalDocument({}, { kind: "put", name: "a", entry });

    expect(Result.getOrUndefined(put)).toEqual({ mcp: { servers: { a: entry } } });
    expect(
      Result.getOrUndefined(
        mcpGlobalDocument(Result.getOrThrow(put), { kind: "remove", name: "a" }),
      ),
    ).toEqual({});
    expect(
      Result.getOrUndefined(
        mcpGlobalDocument(
          {},
          {
            kind: "import",
            entries: [
              { name: "a", entry },
              { name: "b", entry },
            ],
          },
        ),
      ),
    ).toEqual({ mcp: { servers: { a: entry, b: entry } } });
  });

  it("writes an Environment's switch on a Global server as an adjustment, never a copy of the entry", () => {
    expect(
      mcpOverridesPatch(
        {},
        { kind: "enabled", name: "linear", target: "adjustment", enabled: false },
        GLOBAL_SERVERS,
      ),
    ).toEqual(Result.succeed({ set: { mcp: { servers: { linear: { enabled: false } } } } }));
    expect(
      mcpOverridesPatch(
        { mcp: { servers: { linear: { exposure: "hidden" } } } },
        { kind: "exposure", name: "linear", target: "adjustment", exposure: "direct" },
        GLOBAL_SERVERS,
      ),
    ).toEqual(Result.succeed({ set: { mcp: { servers: { linear: { exposure: "direct" } } } } }));
    expect(
      mcpOverridesPatch(
        {},
        {
          kind: "toolExposure",
          name: "linear",
          target: "adjustment",
          toolExposure: { "delete_*": "hidden" },
        },
        GLOBAL_SERVERS,
      ),
    ).toEqual(
      Result.succeed({
        set: { mcp: { servers: { linear: { toolExposure: { "delete_*": "hidden" } } } } },
      }),
    );
  });

  it("writes the switch of an Environment's own server inside its entry", () => {
    expect(
      mcpOverridesPatch(
        { mcp: { servers: { notes: { command: "notes-mcp", args: ["a"] } } } },
        { kind: "enabled", name: "notes", target: "own", enabled: false },
        GLOBAL_SERVERS,
      ),
    ).toEqual(
      Result.succeed({
        set: { mcp: { servers: { notes: { command: "notes-mcp", args: ["a"], enabled: false } } } },
      }),
    );
  });

  it("writes nothing when the own entry a switch was made on is gone, instead of adjusting Global's of the name", () => {
    const gone = mcpOverridesPatch(
      { mcp: { servers: { other: { command: "x" } } } },
      { kind: "enabled", name: "notes", target: "own", enabled: false },
      GLOBAL_SERVERS,
    );

    expect(Result.isFailure(gone)).toBe(true);
    expect(Result.isFailure(gone) && gone.failure).toContain("changed since the page read it");
  });

  it("writes nothing when an adjustment's row now has an own entry of the name", () => {
    expect(
      Result.isFailure(
        mcpOverridesPatch(
          { mcp: { servers: { linear: { url: "https://own.example.com" } } } },
          { kind: "enabled", name: "linear", target: "adjustment", enabled: false },
          GLOBAL_SERVERS,
        ),
      ),
    ).toBe(true);
  });

  it("writes nothing when the Global server an adjustment is of is gone since the row was shown", () => {
    const orphan = mcpOverridesPatch(
      {},
      { kind: "enabled", name: "vanished", target: "adjustment", enabled: false },
      GLOBAL_SERVERS,
    );

    expect(Result.isFailure(orphan)).toBe(true);
    expect(Result.isFailure(orphan) && orphan.failure).toContain("vanished");
  });

  it("fails an own switch at Global for an entry it no longer holds, and for an adjustment target", () => {
    expect(
      Result.isFailure(
        mcpGlobalDocument(
          { mcp: { servers: { a: { command: "x" } } } },
          { kind: "enabled", name: "a", target: "adjustment", enabled: false },
        ),
      ),
    ).toBe(true);
  });

  it("resets adjustment keys by their Override field", () => {
    expect(
      mcpOverridesPatch(
        {},
        { kind: "reset", fields: ["mcp.servers.linear.enabled"] },
        GLOBAL_SERVERS,
      ),
    ).toEqual(Result.succeed({ reset: ["mcp.servers.linear.enabled"] }));
  });

  it("writes an Environment's own entry as one Override, and takes it away by resetting it", () => {
    expect(mcpOverridesPatch({}, { kind: "put", name: "notes", entry }, GLOBAL_SERVERS)).toEqual(
      Result.succeed({ set: { mcp: { servers: { notes: entry } } } }),
    );
    expect(mcpOverridesPatch({}, { kind: "remove", name: "notes" }, GLOBAL_SERVERS)).toEqual(
      Result.succeed({ reset: ["mcp.servers.notes"] }),
    );
  });
});

describe("a Repo's file", () => {
  const TEXT = '{"mcpServers":{"db":{"command":"db"}}}';
  const bare = { repo: "api", slug: "acme/api", path: ".pi/mcp.json" };

  const held = (state: string, repo = "api"): McpRepoFileView => ({
    ...bare,
    repo,
    state,
    text: TEXT,
  });

  it("is a Repo layer when its copy is held, whether read or kept after a failed look", () => {
    expect(mcpRepoLayersOf([held("read"), held("unreadable", "web")])).toEqual([
      { directory: "api", slug: "acme/api", path: ".pi/mcp.json", text: TEXT },
      { directory: "web", slug: "acme/api", path: ".pi/mcp.json", text: TEXT },
    ]);
  });

  it("is no layer when it has no copy, is absent, oversize or not on GitHub, or a state this build does not know", () => {
    expect(
      mcpRepoLayersOf([
        { ...bare, state: "absent" },
        { ...bare, state: "oversize" },
        { repo: "api", path: ".pi/mcp.json", state: "not_github" },
        { ...bare, state: "unreadable" },
        { ...bare, state: "never" },
        held("somethingnew"),
      ]),
    ).toEqual([]);
  });
});
