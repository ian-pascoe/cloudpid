// The `settings_mcp` extension's read-only tools (`docs/architecture/mcp-configuration.md` → The agent's changes → The tools,
// Results, Lists, Testing), over an in-memory `McpHostClient` (`./mcp.testing.ts`) and a fake of the Registry's MCP read.
// What they prove is the ticket's acceptance: nothing connects to a server or starts a Container (a stdio server of a
// Workspace that is not running is listed and shown from the host's rows alone, with no Workspace named and no wait),
// and no resolved `${NAME}` value, no set hash and no entry hash is in a result.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import type { McpExposure, McpResolvedServer, McpSource } from "@cloudpid/config";
import type {
  SettingsMcpEnvironment,
  SettingsMcpReload,
  SettingsMcpServer,
  SettingsMcpView,
} from "@cloudpid/protocol";
import { HostUnsupported } from "@cloudpid/mcp/types";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type Extension,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { McpHostClient, type McpHostClientService } from "./mcp/client.ts";
import { type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";
import { runSized } from "./program.fixture.ts";
import { GLOBAL_SETTINGS_SCOPE, SettingsAccessError } from "./settings.ts";
import {
  MAX_GET_INSTRUCTIONS_BYTES,
  SETTINGS_MCP_READ_TOOLS,
  SettingsMcpAccess,
  type SettingsMcpAccessService,
  SettingsMcpTools,
} from "./settings-mcp.ts";
import { DEFAULT_TOOLSETS } from "./subagents.ts";
import { resolveTools } from "./subagents/toolsets.ts";

/** A value no result may show: what `${GH_TOKEN}` resolves to for the server, as a Secret's value. */
const SECRET_VALUE = "ghp_Zq81LmNx0aSecretValueOfGhToken7731";

/** A hash as the Registry gives a set, and as the host keeps an entry's; neither may be in a result. */
const SET_HASH = "5e3f0c9d1b7a4e62aa0f13c8d9e2b4716f0a5c3d8e1b2970f4a6c8d0e2b4f6a8";

const ENV = "env-a";
const OTHER = "env-b";

const repoSource = {
  kind: "repo",
  directory: "app",
  slug: "acme/app",
  path: ".pi/mcp.json",
} as const satisfies McpSource;

/** A server as the Registry resolves it: an entry in force, `${NAME}` unresolved. */
const resolved = (
  name: string,
  server: Partial<McpResolvedServer["server"]> & { readonly type?: "stdio" | "http" } = {},
  source: McpSource = { kind: "environment" },
): McpResolvedServer => {
  const exposure: McpExposure = "codemode";

  const common = {
    enabled: true,
    exposure,
    toolExposure: {},
    timeout: 60,
    sampling: "ask" as const,
  };

  const stdio = {
    ...common,
    command: "npx",
    args: ["-y", "@acme/files"],
    env: { TOKEN: "${GH_TOKEN}" },
    ...server,
  };

  const http = {
    ...common,
    type: "http",
    url: `https://${name}.example.test/mcp`,
    headers: {},
    ...server,
  };

  // SAFETY: each is an entry as the set resolves it, its overrides the entry's own keys.
  const entry = (server.type === "stdio" ? stdio : http) as McpResolvedServer["server"];

  return {
    name,
    source,
    server: entry,
    replacesGlobal: false,
    shadowed: [],
    resolvesSecrets: source.kind !== "repo",
  };
};

/** One server of a view, with what the Registry knows beside its entry. */
const served = (
  server: McpResolvedServer,
  more: Partial<Omit<SettingsMcpServer, "server">> = {},
): SettingsMcpServer => ({
  server,
  origins: { enabled: "default", exposure: "default", toolExposure: "default" },
  reads: [],
  resetFields: [],
  signIn: null,
  hints: [],
  problems: [],
  ...more,
});

const viewOf = (
  servers: ReadonlyArray<SettingsMcpServer>,
  more: Partial<SettingsMcpView> = {},
): SettingsMcpView => ({
  scope: ENV,
  name: "A",
  servers,
  names: Arr.map(servers, (each) => each.server.name),
  layers: null,
  repos: [],
  orphans: [],
  problems: [],
  offered: [],
  warnings: [],
  ...more,
});

const reloadOf = (more: Partial<SettingsMcpReload> = {}): SettingsMcpReload => ({
  scope: ENV,
  name: "A",
  repos: [
    {
      directory: "app",
      slug: "acme/app",
      path: ".pi/mcp.json",
      outcome: "changed",
      blob: "b1",
      readAt: 5,
      error: null,
      errorSince: null,
      keptCopy: true,
      problem: null,
    },
  ],
  set: {
    added: ["files"],
    removed: [],
    changed: [],
    problemsAdded: [],
    problemsCleared: [],
  },
  servers: 1,
  ...more,
});

/** The Registry's side, as the Session reaches it: what it was asked, in order, and its answers as a test sets them. */
const fakeAccess = (
  init: {
    readonly views?: Readonly<Record<string, SettingsMcpView>>;
    readonly own?: string | null;
    readonly reloads?: Readonly<Record<string, SettingsMcpReload>>;
    readonly pushes?: ReadonlyArray<unknown>;
  } = {},
) => {
  const events: Array<string> = [];
  const { views = {}, own = ENV, reloads = {}, pushes = [] } = init;

  const missing = (id: string) =>
    SettingsAccessError.make({ message: `No Environment has the id ${JSON.stringify(id)}.` });

  const service: SettingsMcpAccessService = {
    view: ({ scope, name }) =>
      Effect.suspend(() => {
        events.push(`view ${scope}${name === undefined ? "" : ` ${name}`}`);

        const view = views[scope];

        if (view === undefined) return Effect.fail(missing(scope));

        return Effect.succeed(
          name === undefined
            ? view
            : {
                ...view,
                servers: Arr.filter(view.servers, (each) => each.server.name === name),
                layers: Arr.some(view.servers, (each) => each.server.name === name)
                  ? { global: null, environment: { kind: "entry", value: {} }, repos: [] }
                  : null,
              },
        );
      }),
    own: Effect.sync(() => {
      events.push("own");

      return own;
    }),
    reload: (environment) =>
      Effect.suspend(() => {
        events.push(`reload ${environment}`);

        const report = reloads[environment];

        return report === undefined ? Effect.fail(missing(environment)) : Effect.succeed(report);
      }),
    pushes: (environment) =>
      Effect.sync(() => {
        events.push(`pushes ${environment}`);

        // SAFETY: the sets are the ones a test builds: plain `McpApplySet` data.
        return pushes as ReturnType<SettingsMcpAccessService["pushes"]> extends Effect.Effect<
          infer A
        >
          ? A
          : never;
      }),
    pushed: (input) =>
      Effect.sync(() => {
        events.push(`pushed ${input.environment} ${input.revision}`);
      }),
  };

  return { service, events };
};

/** A set a push hands the host. */
const SET = { kind: "set", hash: SET_HASH, revision: 3, entries: [] } as const;

const toolsOver = async (
  access: SettingsMcpAccessService,
  host: McpHostClientService,
): Promise<((name: string) => ToolRegistration) & { extension: Extension }> => {
  const extension = await Effect.runPromise(
    SettingsMcpTools.pipe(
      Effect.provideService(SettingsMcpAccess, access),
      Effect.provideService(McpHostClient, host),
    ),
  );

  const lookup = (name: string): ToolRegistration =>
    Option.getOrThrowWith(
      Arr.findFirst(extension.tools ?? [], (tool) => tool.name === name),
      () => new Error(`no tool ${name}`),
    );

  return Object.assign(lookup, { extension });
};

// SAFETY: the tools read only the calling conversation from the invocation's API.
const api = { conversationId: ROOT_CONVERSATION_ID } as ToolExecutionApi;

type Outcome = Awaited<ReturnType<ToolRegistration["execute"]>>;

const run = (
  tool: ToolRegistration,
  args: Readonly<Record<string, Schema.Json>>,
): Promise<Outcome> =>
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

/** Everything a result shows a program or the model, as one string. */
const everything = (result: Outcome): string =>
  `${text(result)}\n${JSON.stringify(result.structuredOutput)}`;

/** Each key of a result's value, however deep. */
const keysOf = (output: Outcome["structuredOutput"]): ReadonlyArray<string> => {
  const keys: Array<string> = [];

  JSON.parse(JSON.stringify(output ?? null), (key: string, value: Schema.Json) => {
    keys.push(key);

    return value;
  });

  return keys;
};

/** Nothing in a result may be, or name, a hash or a connection. */
const expectNoHashes = (result: Outcome) => {
  const shown = everything(result);

  expect(shown).not.toContain(SET_HASH);
  expect(shown).not.toContain("conn-");
  // The fake host's version of its inventory, as the host's content hashes are.
  expect(shown).not.toMatch(/\bv-[0-9a-f]{4,}/);

  for (const key of keysOf(result.structuredOutput)) {
    expect(key).not.toMatch(/hash|conn|digest|etag/i);
  }
};

/** A stdio server of a Workspace whose Container is not running: the host has never discovered it. */
const IDLE_STDIO: FakeMcpServer = {
  name: "files",
  tools: [],
  state: "not_discovered",
  entry: { type: "stdio", env: { TOKEN: SECRET_VALUE } },
};

/** The calls a result made to the host, as the method and, for an `apply`, its kind. */
const calledOf = (host: ReturnType<typeof fakeMcpHost>) =>
  Arr.map(host.calls, (call) =>
    call.method === "apply" ? `apply ${call.input.kind}` : call.method,
  );

const stdioView = (more: Partial<SettingsMcpServer> = {}) =>
  viewOf([
    served(resolved("files", { type: "stdio" }), {
      reads: [{ name: "GH_TOKEN", kind: "secret", where: ["env.TOKEN"] }],
      ...more,
    }),
  ]);

describe("the settings_mcp read tools", () => {
  it("are three, each of which only reads, and a rerun after an eviction may run them again", async () => {
    const host = fakeMcpHost();
    const tool = await toolsOver(fakeAccess().service, host.client);

    expect(SETTINGS_MCP_READ_TOOLS).toEqual([
      "settings_mcp_list",
      "settings_mcp_get",
      "settings_mcp_reload",
    ]);
    expect(Arr.map(SETTINGS_MCP_READ_TOOLS, (name) => tool(name).replay)).toEqual([
      "safe",
      "safe",
      "safe",
    ]);
  });

  it("each require a scope, which has no default", async () => {
    const host = fakeMcpHost();
    const tool = await toolsOver(fakeAccess().service, host.client);

    for (const name of SETTINGS_MCP_READ_TOOLS) {
      expect(tool(name).parameters).toMatchObject({ required: expect.arrayContaining(["scope"]) });
    }

    expect(tool("settings_mcp_get").parameters).toMatchObject({
      required: expect.arrayContaining(["scope", "name"]),
    });
  });

  it("are not granted to a subagent, inherited or by name", () => {
    const ceiling = ["bash", ...SETTINGS_MCP_READ_TOOLS];

    expect(resolveTools(undefined, ceiling, DEFAULT_TOOLSETS)).toMatchObject({
      success: { tools: ["bash"] },
    });
    expect(resolveTools(["settings_mcp_list"], ceiling, DEFAULT_TOOLSETS)).toMatchObject({
      failure: expect.stringContaining(
        "settings_mcp_list is unknown or outside your capability ceiling",
      ),
    });
  });
});

describe("settings_mcp_list", () => {
  it("lists a stdio server whose Workspace is not running from the host's rows alone, and wakes nothing", async () => {
    const access = fakeAccess({ views: { [ENV]: stdioView() } });
    const host = fakeMcpHost([IDLE_STDIO]);
    const tool = await toolsOver(access.service, host.client);

    const result = await run(tool("settings_mcp_list"), { scope: ENV });
    const shown = text(result);

    expect(result.isError).toBeFalsy();
    expect(result.structuredOutput).toMatchObject({
      is_own: true,
      inventory: "read",
      servers: [
        {
          name: "files",
          transport: "stdio",
          inventory: { state: "not_discovered", tools: 0, discovered_at: null },
        },
      ],
    });
    expect(shown).toContain("State: not_discovered");
    expect(shown).toContain("never discovered");

    // One read of what the host holds: no Workspace named (so no Container), no wait for a discovery, no request.
    expect(host.calls).toEqual([{ method: "servers", input: { parts: ["tools"] } }]);
    expect(calledOf(host)).not.toContain("requestStart");
    expect(calledOf(host)).not.toContain("request");
    expect(access.events).toEqual([`view ${ENV}`, "own"]);
  });

  it("says a server the host does not hold yet is not discovered, or disabled when its entry is off", async () => {
    const access = fakeAccess({
      views: {
        [ENV]: viewOf([
          served(resolved("new", { type: "stdio" })),
          served(resolved("off", { enabled: false })),
        ]),
      },
    });

    const host = fakeMcpHost([]);
    const tool = await toolsOver(access.service, host.client);

    const result = await run(tool("settings_mcp_list"), { scope: ENV });

    expect(result.structuredOutput).toMatchObject({
      servers: [
        { name: "new", inventory: { state: "not_discovered" } },
        { name: "off", inventory: { state: "disabled" } },
      ],
    });
  });

  it("shows each ${NAME} an entry reads as a Secret, never the value, and the entry as written", async () => {
    const access = fakeAccess({
      views: {
        [ENV]: viewOf([
          served(
            resolved("files", {
              type: "stdio",
              env: { TOKEN: "${GH_TOKEN}", REGION: "${REGION}" },
            }),
            {
              reads: [
                { name: "GH_TOKEN", kind: "secret", where: ["env.TOKEN"] },
                { name: "REGION", kind: "variable", where: ["env.REGION"] },
              ],
            },
          ),
          served(resolved("api", { headers: { Authorization: "Bearer ${NOPE}" } }), {
            reads: [{ name: "NOPE", kind: "missing", where: ["headers.Authorization"] }],
          }),
        ]),
      },
    });

    // The host holds the entry resolved, as it does for its own connection: a result never gives it.
    const host = fakeMcpHost([
      { ...IDLE_STDIO, entry: { type: "stdio", env: { TOKEN: SECRET_VALUE } } },
      { name: "api", tools: [{ name: "search" }] },
    ]);

    const tool = await toolsOver(access.service, host.client);
    const list = await run(tool("settings_mcp_list"), { scope: ENV });
    const get = await run(tool("settings_mcp_get"), { scope: ENV, name: "files" });

    for (const result of [list, get]) {
      expect(everything(result)).not.toContain(SECRET_VALUE);
      expect(everything(result)).not.toContain("ghp_");
    }

    expect(text(list)).toContain("${GH_TOKEN} is a Secret (env.TOKEN)");
    expect(text(list)).toContain("${REGION} is a Variable (env.REGION)");
    expect(text(list)).toContain("${NOPE} is missing (headers.Authorization)");
    expect(list.structuredOutput).toMatchObject({
      servers: [
        {
          reads: [
            { name: "GH_TOKEN", kind: "secret" },
            { name: "REGION", kind: "variable" },
          ],
        },
        { reads: [{ name: "NOPE", kind: "missing" }] },
      ],
    });
    // The entry in force is the one as written.
    expect(text(get)).toContain("${GH_TOKEN}");
  });

  it("gives no set hash, no entry hash and no connection, whatever the host holds", async () => {
    const access = fakeAccess({ views: { [ENV]: stdioView() } });

    const host = fakeMcpHost([
      {
        name: "files",
        tools: [{ name: "read", annotations: { readOnlyHint: true } }],
        protocolVersion: "2025-06-18",
        prompts: ["review"],
        instructions: "Use read first.",
        entry: { type: "stdio", env: { TOKEN: SECRET_VALUE } },
      },
    ]);

    const tool = await toolsOver(access.service, host.client);
    const list = await run(tool("settings_mcp_list"), { scope: ENV });
    const get = await run(tool("settings_mcp_get"), { scope: ENV, name: "files" });

    expectNoHashes(list);
    expectNoHashes(get);
    expect(everything(list)).not.toContain("inputSchema");
    expect(list.structuredOutput).toMatchObject({
      servers: [{ inventory: { state: "connected", tools: 1, direct: 0, prompts: 1 } }],
    });
  });

  it("gives Global's own entries and no inventory, and never asks the host", async () => {
    const access = fakeAccess({
      views: {
        "*": viewOf([served(resolved("shared", {}, { kind: "global" }))], {
          scope: "*",
          name: "Global",
        }),
      },
    });

    const host = fakeMcpHost([{ name: "shared", tools: [] }]);
    const tool = await toolsOver(access.service, host.client);
    const result = await run(tool("settings_mcp_list"), { scope: "*" });

    expect(result.structuredOutput).toMatchObject({
      inventory: "global",
      is_own: false,
      servers: [{ name: "shared", inventory: null }],
    });
    expect(text(result)).toContain("Global has no MCP host");
    expect(host.calls).toEqual([]);
  });

  it("gives no inventory for another Environment, whose host this Session does not reach or wake", async () => {
    const access = fakeAccess({
      views: { [OTHER]: viewOf([served(resolved("files"))], { scope: OTHER, name: "B" }) },
    });

    const host = fakeMcpHost([{ name: "files", tools: [] }]);
    const tool = await toolsOver(access.service, host.client);
    const result = await run(tool("settings_mcp_list"), { scope: OTHER });

    expect(result.structuredOutput).toMatchObject({
      inventory: "other_environment",
      is_own: false,
      servers: [{ inventory: null }],
    });
    expect(host.calls).toEqual([]);
  });

  it("asks no host for an Environment without servers, and still lists its Repos", async () => {
    const access = fakeAccess({
      views: {
        [ENV]: viewOf([], {
          repos: [
            {
              repo: "app",
              slug: "acme/app",
              path: ".pi/mcp.json",
              state: "absent",
              lookedAt: 9,
            },
          ],
        }),
      },
    });

    const host = fakeMcpHost([]);
    const tool = await toolsOver(access.service, host.client);
    const result = await run(tool("settings_mcp_list"), { scope: ENV });

    expect(result.structuredOutput).toMatchObject({
      inventory: "no_servers",
      servers: [],
      repos: [{ directory: "app", slug: "acme/app", state: "absent", looked_at: 9 }],
    });
    expect(host.calls).toEqual([]);
  });

  it("still lists the configuration when the host does not answer", async () => {
    const access = fakeAccess({ views: { [ENV]: stdioView() } });
    const host = fakeMcpHost([IDLE_STDIO]);

    host.fail(true);

    const tool = await toolsOver(access.service, host.client);
    const result = await run(tool("settings_mcp_list"), { scope: ENV });

    expect(result.isError).toBeFalsy();
    expect(result.structuredOutput).toMatchObject({
      inventory: "host_unavailable",
      servers: [{ name: "files", inventory: null }],
    });
    expect(text(result)).toContain("did not answer");
  });

  it("shows where each key is written, the Repo entries a server shadows, its sign-in and its problems", async () => {
    const access = fakeAccess({
      views: {
        [ENV]: viewOf(
          [
            served(
              {
                ...resolved("docs", { exposure: "direct", enabled: false }),
                replacesGlobal: true,
                shadowed: [{ source: repoSource, name: "Docs", differs: true }],
              },
              {
                origins: {
                  enabled: "environment_adjustment",
                  exposure: "environment",
                  toolExposure: "default",
                },
                resetFields: ["mcp.adjustments.docs.enabled"],
                signIn: {
                  status: "required",
                  issuerHost: "auth.example.test",
                  scopes: "read write",
                  clientKind: "registered",
                },
                problems: [
                  {
                    source: { kind: "environment" },
                    name: "docs",
                    message: "timeout: Expected a positive number",
                  },
                ],
              },
            ),
          ],
          {
            orphans: [{ source: { kind: "environment" }, name: "ghost", keys: ["enabled"] }],
            problems: [
              {
                source: { kind: "environment" },
                name: "docs",
                message: "timeout: Expected a positive number",
              },
              { source: repoSource, name: null, message: "is not valid JSON" },
            ],
          },
        ),
      },
    });

    const host = fakeMcpHost([{ name: "docs", tools: [], state: "sign_in" }]);
    const tool = await toolsOver(access.service, host.client);
    const result = await run(tool("settings_mcp_list"), { scope: ENV });

    expect(result.structuredOutput).toMatchObject({
      servers: [
        {
          name: "docs",
          replaces_global: true,
          enabled: { value: false, from: "environment_adjustment" },
          exposure: { value: "direct", from: "environment" },
          shadowed: [{ name: "Docs", differs: true, source: { kind: "repo", directory: "app" } }],
          reset_fields: ["mcp.adjustments.docs.enabled"],
          sign_in: {
            status: "required",
            issuer_host: "auth.example.test",
            scopes: ["read", "write"],
            client_kind: "registered",
          },
          inventory: { state: "needs_sign_in" },
        },
      ],
      orphans: [{ server: "ghost", keys: ["enabled"] }],
    });
    expect(text(result)).toContain("MCP sign-in: required, issuer auth.example.test");
    expect(text(result)).toContain("Problem (Repo app (.pi/mcp.json)): is not valid JSON");
  });

  it("fails for an id no Environment has, saying how to name a Scope", async () => {
    const tool = await toolsOver(fakeAccess().service, fakeMcpHost().client);

    expect(await failure(run(tool("settings_mcp_list"), { scope: "nope" }))).toContain(
      "No Environment has the id",
    );
  });

  it("fits a nested call's result for a Scope with very many servers, with the cut said so", async () => {
    const many = Arr.makeBy(1500, (index) =>
      served(
        resolved(`server-${index}`, {
          description: "x".repeat(600),
          env: {},
          headers: { A: "y".repeat(300) },
        }),
      ),
    );

    const access = fakeAccess({ views: { [ENV]: viewOf(many) } });
    const tool = await toolsOver(access.service, fakeMcpHost([]).client);

    const [sized] = await runSized([tool.extension], [["settings_mcp_list", { scope: ENV }]]);

    expect(sized?.isError).toBe(false);
    expect(sized?.bytes).toBeLessThan(1024 * 1024);
    expect(sized?.truncated).toMatchObject({ servers_truncated: true });
  });
});

describe("settings_mcp_get", () => {
  const files: FakeMcpServer = {
    name: "files",
    tools: [
      { name: "search", title: "Search", annotations: { readOnlyHint: true } },
      { name: "danger_delete", annotations: { destructiveHint: true } },
      { name: "plain" },
    ],
    protocolVersion: "2025-06-18",
    prompts: ["review", "explain"],
    instructions: "Call search before anything else.",
    exposure: "codemode",
    toolExposure: { search: "direct", "danger_*": "hidden", "gone_*": "direct" },
  };

  const filesView = (offered: ReadonlyArray<string> = []) =>
    viewOf(
      [
        served(
          resolved("files", {
            exposure: "codemode",
            toolExposure: { search: "direct", "danger_*": "hidden", "gone_*": "direct" },
            sampling: "allow",
          }),
          {
            origins: {
              enabled: "default",
              exposure: "environment",
              toolExposure: "environment_adjustment",
            },
          },
        ),
      ],
      { offered },
    );

  it("shows the tools with the Exposure each gets and what decided it, the protocol version and sampling", async () => {
    const access = fakeAccess({ views: { [ENV]: filesView() } });
    const host = fakeMcpHost([files]);
    const tool = await toolsOver(access.service, host.client);
    const result = await run(tool("settings_mcp_get"), { scope: ENV, name: "files" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredOutput).toMatchObject({
      server: {
        name: "files",
        sampling: "allow",
        inventory: { protocol_version: "2025-06-18", state: "connected", tools: 3, prompts: 2 },
      },
      tool_count: 3,
      tools: [
        {
          name: "search",
          title: "Search",
          exposure: "direct",
          decided_by: { kind: "tool", key: "search" },
          hints: { read_only: true, destructive: null },
        },
        {
          name: "danger_delete",
          exposure: "hidden",
          decided_by: { kind: "pattern", key: "danger_*" },
          hints: { destructive: true },
        },
        { name: "plain", exposure: "codemode", decided_by: { kind: "server", key: null } },
      ],
      unmatched_tool_exposure: ["gone_*"],
      prompts: ["review", "explain"],
      instructions: { text: "Call search before anything else.", truncated: false },
    });

    const shown = text(result);

    expect(shown).toContain("protocol 2025-06-18");
    expect(shown).toContain("sampling allow (the server may use the user's models without asking)");
    expect(shown).toContain("toolExposure keys that match no tool: gone_*");
    expect(shown).toContain('toolExposure pattern "danger_*"');
    expect(everything(result)).not.toContain("inputSchema");
    expectNoHashes(result);
  });

  it("reads one server, with its parts and no Workspace, so nothing is started", async () => {
    const access = fakeAccess({ views: { [ENV]: filesView() } });
    const host = fakeMcpHost([files, { name: "other", tools: [] }]);
    const tool = await toolsOver(access.service, host.client);

    await run(tool("settings_mcp_get"), { scope: ENV, name: "files" });

    expect(host.calls).toEqual([
      {
        method: "servers",
        input: { names: ["files"], parts: ["tools", "prompts", "instructions", "status"] },
      },
    ]);
  });

  it("shows a stdio server whose Workspace is not running: its layers, no tools, and no wake", async () => {
    const access = fakeAccess({ views: { [ENV]: stdioView() } });
    const host = fakeMcpHost([IDLE_STDIO]);
    const tool = await toolsOver(access.service, host.client);

    const result = await run(tool("settings_mcp_get"), { scope: ENV, name: "files" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredOutput).toMatchObject({
      server: { transport: "stdio", inventory: { state: "not_discovered" } },
      tool_count: 0,
      tools: [],
      // Its tools are not known, so no key is called unmatched.
      unmatched_tool_exposure: null,
    });
    expect(host.calls).toEqual([
      {
        method: "servers",
        input: { names: ["files"], parts: ["tools", "prompts", "instructions", "status"] },
      },
    ]);
    expect(everything(result)).not.toContain(SECRET_VALUE);
    expectNoHashes(result);
  });

  it("lets tools.offered lift a tool, and says it decided", async () => {
    const access = fakeAccess({ views: { [ENV]: filesView(["mcp__files__plain"]) } });
    const tool = await toolsOver(access.service, fakeMcpHost([files]).client);
    const result = await run(tool("settings_mcp_get"), { scope: ENV, name: "files" });

    expect(result.structuredOutput).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({
          name: "plain",
          exposure: "direct",
          decided_by: { kind: "offered", key: "mcp__files__plain" },
        }),
      ]),
    });
  });

  it("cuts the server's own instructions, saying so", async () => {
    const access = fakeAccess({ views: { [ENV]: filesView() } });

    const long = "Always be careful. ".repeat(1000);

    const tool = await toolsOver(
      access.service,
      fakeMcpHost([{ ...files, instructions: long }]).client,
    );

    const result = await run(tool("settings_mcp_get"), { scope: ENV, name: "files" });

    // SAFETY: the value the tool declares for `structuredOutputSchema`; only its instructions are read.
    const out = result.structuredOutput as { instructions: { text: string; truncated: boolean } };

    expect(out.instructions.truncated).toBe(true);
    expect(new TextEncoder().encode(out.instructions.text).length).toBeLessThanOrEqual(
      MAX_GET_INSTRUCTIONS_BYTES,
    );
  });

  it("lists the servers of the Scope for a name that is none's", async () => {
    const access = fakeAccess({ views: { [ENV]: filesView() } });
    const tool = await toolsOver(access.service, fakeMcpHost([files]).client);

    expect(await failure(run(tool("settings_mcp_get"), { scope: ENV, name: "nope" }))).toContain(
      'No MCP server "nope"',
    );
    expect(await failure(run(tool("settings_mcp_get"), { scope: ENV, name: "nope" }))).toContain(
      "Its servers: files",
    );
  });

  it("gives no inventory at Global or at another Environment", async () => {
    const access = fakeAccess({
      views: {
        "*": viewOf([served(resolved("files", {}, { kind: "global" }))], {
          scope: "*",
          name: "Global",
        }),
      },
    });

    const host = fakeMcpHost([files]);
    const tool = await toolsOver(access.service, host.client);
    const result = await run(tool("settings_mcp_get"), { scope: "*", name: "files" });

    expect(result.structuredOutput).toMatchObject({
      inventory: "global",
      server: { inventory: null },
      tools: [],
      unmatched_tool_exposure: null,
    });
    expect(text(result)).toContain("Tools: not given");
    expect(host.calls).toEqual([]);
  });
});

describe("settings_mcp_reload", () => {
  const ownView = () => ({ [ENV]: viewOf([served(resolved("files"))]) });

  /** A host that records, in the order of the Session's own record, what it was told. */
  const ordered = (
    events: Array<string>,
    host: ReturnType<typeof fakeMcpHost>,
  ): McpHostClientService => ({
    ...host.client,
    apply: (input) =>
      Effect.suspend(() => {
        events.push(`host ${input.kind}`);

        return host.client.apply(input);
      }),
  });

  it("refuses scope *, which has no Repos and no host", async () => {
    const access = fakeAccess();
    const host = fakeMcpHost([]);
    const tool = await toolsOver(access.service, host.client);

    expect(await failure(run(tool("settings_mcp_reload"), { scope: "*" }))).toContain(
      "takes an Environment's id",
    );
    expect(access.events).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  it("looks again, sends the new set, then has the host reload, in that order", async () => {
    const access = fakeAccess({
      views: ownView(),
      reloads: { [ENV]: reloadOf() },
      pushes: [SET],
    });

    const host = fakeMcpHost([{ name: "files", tools: [] }]);
    const tool = await toolsOver(access.service, ordered(access.events, host));

    const result = await run(tool("settings_mcp_reload"), { scope: ENV });

    expect(result.isError).toBeFalsy();
    expect(access.events).toEqual([
      "own",
      `reload ${ENV}`,
      `pushes ${ENV}`,
      "host set",
      `pushed ${ENV} 3`,
      "host reload",
    ]);
    expect(host.calls).toEqual([
      { method: "apply", input: SET },
      { method: "apply", input: { kind: "reload" } },
    ]);
    expect(result.structuredOutput).toMatchObject({
      push: "pushed",
      host: { status: "reloaded", servers: ["files"] },
      set: { servers: 1, added: ["files"], removed: [], changed: [] },
      repos: [
        {
          directory: "app",
          slug: "acme/app",
          outcome: "changed",
          blob: "b1",
          read_at: 5,
          kept_copy: true,
        },
      ],
    });
    // Nothing is connected or started to reload.
    expect(calledOf(host)).not.toContain("requestStart");
    expect(calledOf(host)).not.toContain("request");
    expectNoHashes(result);
    expect(text(result)).toContain("no Agent change");
  });

  it("does not send a set the host has, and does not wake it for a set without servers", async () => {
    const access = fakeAccess({
      views: ownView(),
      reloads: { [ENV]: reloadOf({ servers: 0, set: { ...reloadOf().set, added: [] } }) },
    });

    const host = fakeMcpHost([]);
    const tool = await toolsOver(access.service, host.client);
    const result = await run(tool("settings_mcp_reload"), { scope: ENV });

    expect(result.structuredOutput).toMatchObject({
      push: "not_needed",
      host: { status: "not_reached", note: "the set has no servers" },
    });
    expect(host.calls).toEqual([]);
  });

  it("looks only, for another Environment, whose host this Session does not reach", async () => {
    const access = fakeAccess({
      views: ownView(),
      reloads: { [OTHER]: reloadOf({ scope: OTHER, name: "B" }) },
      pushes: [SET],
    });

    const host = fakeMcpHost([{ name: "files", tools: [] }]);
    const tool = await toolsOver(access.service, host.client);
    const result = await run(tool("settings_mcp_reload"), { scope: OTHER });

    expect(result.structuredOutput).toMatchObject({
      push: "not_attempted",
      host: { status: "not_reached" },
    });
    expect(access.events).toEqual(["own", `reload ${OTHER}`]);
    expect(host.calls).toEqual([]);
    expect(text(result)).toContain("only its own Environment's MCP host");
  });

  it("says each Repo's outcome, an unreadable Repo's kept copy among them", async () => {
    const access = fakeAccess({
      views: ownView(),
      reloads: {
        [ENV]: reloadOf({
          repos: [
            {
              directory: "web",
              slug: "acme/web",
              path: ".pi/mcp.json",
              outcome: "unreadable",
              blob: "b2",
              readAt: 4,
              error: "GitHub answered 502",
              errorSince: 8,
              keptCopy: true,
              problem: null,
            },
            {
              directory: "api",
              slug: "acme/api",
              path: ".pi/mcp.json",
              outcome: "recent",
              blob: null,
              readAt: null,
              error: null,
              errorSince: null,
              keptCopy: false,
              problem: null,
            },
            {
              directory: "docs",
              slug: null,
              path: ".pi/mcp.json",
              outcome: "not_github",
              blob: null,
              readAt: null,
              error: null,
              errorSince: null,
              keptCopy: false,
              problem: null,
            },
          ],
          set: {
            added: [],
            removed: ["old"],
            changed: ["files"],
            problemsAdded: ["Repo web: files timeout: bad"],
            problemsCleared: [],
          },
        }),
      },
    });

    const host = fakeMcpHost([{ name: "files", tools: [] }]);
    const tool = await toolsOver(access.service, host.client);
    const shown = text(await run(tool("settings_mcp_reload"), { scope: ENV }));

    expect(shown).toContain("could not be read (GitHub answered 502");
    expect(shown).toContain("its last good copy is kept, so its servers still stand");
    expect(shown).toContain("was looked at in the last 30 s, so it was not read again");
    expect(shown).toContain("is not on GitHub");
    expect(shown).toContain("removed old; changed files");
    expect(shown).toContain("New problem: Repo web: files timeout: bad");
  });

  it("says when the host is an older build or does not answer, and still reports the look", async () => {
    const access = fakeAccess({ views: ownView(), reloads: { [ENV]: reloadOf() } });

    const old = fakeMcpHost([{ name: "files", tools: [] }]);

    old.applyAnswer((input) => HostUnsupported.make({ message: "no", op: input.kind }));

    const unsupported = await run(
      (await toolsOver(access.service, old.client))("settings_mcp_reload"),
      { scope: ENV },
    );

    expect(unsupported.isError).toBeFalsy();
    expect(unsupported.structuredOutput).toMatchObject({ host: { status: "unsupported" } });

    const down = fakeMcpHost([{ name: "files", tools: [] }]);

    down.fail(true);

    const failed = await run(
      (await toolsOver(access.service, down.client))("settings_mcp_reload"),
      {
        scope: ENV,
      },
    );

    expect(failed.isError).toBeFalsy();
    expect(failed.structuredOutput).toMatchObject({ host: { status: "failed" } });
  });

  it("fails for an id no Environment has", async () => {
    const tool = await toolsOver(fakeAccess().service, fakeMcpHost().client);

    expect(await failure(run(tool("settings_mcp_reload"), { scope: "nope" }))).toContain(
      "No Environment has the id",
    );
  });
});

describe("the Scope names", () => {
  it("use * for Global as settings_get does", () => {
    expect(GLOBAL_SETTINGS_SCOPE).toBe("*");
  });

  it("are Environments by id and name", () => {
    const environment: SettingsMcpEnvironment = { id: ENV, name: "A" };

    expect(environment.id).toBe(ENV);
  });
});
