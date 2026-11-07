// The tools the `environment`, `settings`, `settings_mcp` and `approval-tools` extensions register, and what the five
// read-only ones (`environment_list`, `environment_get`, `settings_get`, `settings_mcp_list`, `settings_mcp_get`) answer
// over fixed fixtures, kept in `__snapshots__/harness-session.json` (#686 S1a; `docs/architecture/mcp-endpoint.md` →
// Environment and Settings tools). The snapshot is what the in-session tools give today. The tools are later split into
// cores shared with the MCP endpoint and thin Session wrappers, and the split must leave this file unchanged.
//
// Every fixture value is pinned here, so a change of a default elsewhere does not move the snapshot. The test compares
// the file structurally (`JSON.parse`), so how it is formatted does not matter. To keep the file small, a string over
// `LONG_STRING` characters in an answer is kept as its length, its SHA-256 and its start, so a changed character still
// shows. The registrations (descriptions, parameters, structured output schemas) are kept whole, so a diff shows what
// moved. Run with `UPDATE_SNAPSHOT=1` to write the file again; a missing file is written too, except in CI.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off strictEffectProvide:off globalJsonInEffect:off missedPipeableOpportunity:off globalDate:off nodeBuiltinImport:off processEnv:off
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContainerSettings, McpExposure, McpResolvedServer, Settings } from "@cloudpid/config";
import type { SettingsMcpServer, SettingsMcpView } from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Extension,
  type JsonObject,
  ROOT_CONVERSATION_ID,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { ApprovalTools, EnvironmentRemoval } from "./approval-tools.ts";
import { Approvals } from "./approvals.ts";
import { unusedApprovals } from "./approvals.fixture.ts";
import {
  AgentChangeLog,
  DeployCredentials,
  type EnvironmentDetails,
  Environments,
  EnvironmentsError,
  type EnvironmentsService,
  EnvironmentTools,
} from "./environment.ts";
import { unusedLifecycle } from "./environment-lifecycle.fixture.ts";
import { unusedSecretMarks } from "./environment-secret-marks.fixture.ts";
import { unusedSkills } from "./environment-skills.fixture.ts";
import { fakeMcpHost } from "./mcp.testing.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";
import {
  GLOBAL_SETTINGS_SCOPE,
  SettingsAccess,
  SettingsAccessError,
  type SettingsAccessService,
  SettingsReload,
  SettingsTools,
  type SettingsView,
} from "./settings.ts";
import { SettingsMcpAccess, type SettingsMcpAccessService } from "./settings-mcp-access.ts";
import { SettingsMcpTools } from "./settings-mcp.ts";

const SNAPSHOT = join(import.meta.dirname, "__snapshots__", "harness-session.json");

/** The extensions whose tools the snapshot holds, in the order it lists them. */
const EXTENSIONS = ["environment", "settings", "settings_mcp", "approval-tools"] as const;

/** A string longer than this is kept in the snapshot as its length, its SHA-256 and its start. */
const LONG_STRING = 2_000;

/** The start of a long string the snapshot keeps. */
const HEAD = 80;

/** The most `environment_get` lists of the variables, in stored bytes (`MAX_VARIABLES_BYTES`). */
const VARIABLES_BYTES = 160 * 1024;

/** The longest value `environment_variable_set` takes, and the most variables an Environment has. */
const VARIABLE_VALUE = 4_096;

/** What a stand-in service says of something the snapshot never does. */
const nothing = (what: string) => Effect.die(`The snapshot ${what} nothing`);

/** The refusal of an id that names no Environment, as the Registry's stand-ins say it. */
const noEnvironment = (id: string) =>
  `No Environment has the id ${JSON.stringify(id)}. Call environment_list for the Environments and their ids.`;

// --- Container settings and the Environments -------------------------------------------------------------------

const GLOBAL_VARIABLES = { SHARED: "all", NODE_ENV: "prod" };

/** The Container settings at Global, every field spelled. */
const GLOBAL_CONTAINER: ContainerSettings = {
  instance: "cpu-1",
  maxInstance: "cpu-2",
  idleMinutes: 2,
  ignore: ["node_modules"],
  variables: GLOBAL_VARIABLES,
  setupScript: "bun install",
  startScript: "",
  toolchains: "",
  spareWorkspace: true,
};

/** Many variables, each as long as one may be: together more than `environment_get` lists. */
const MANY_VARIABLES: Readonly<Record<string, string>> = Object.fromEntries(
  Arr.makeBy(46, (index) => {
    const name = `VAR_${String(index + 1).padStart(2, "0")}`;

    return [name, `${name}=`.padEnd(VARIABLE_VALUE, "v")];
  }),
);

const DEFAULT: EnvironmentDetails = {
  id: "default",
  name: "Default",
  repos: [{ name: "app", url: "https://github.com/o/app.git" }],
  build: { status: "ready", at: Date.UTC(2026, 9, 20) },
  overrides: { variables: { NODE_ENV: "test", ...MANY_VARIABLES } },
  settings: {
    ...GLOBAL_CONTAINER,
    variables: { ...GLOBAL_VARIABLES, NODE_ENV: "test", ...MANY_VARIABLES },
  },
  global: GLOBAL_CONTAINER,
  secrets: [
    { name: "API_KEY", scope: "environment", build: true },
    { name: "NPM_TOKEN", scope: "every", build: false },
  ],
  skills: [],
  globalSkills: [],
};

/** An Environment that is not this Session's, whose saved settings partly no longer apply. */
const OTHER: EnvironmentDetails = {
  id: "0000abcd",
  name: "Other",
  repos: [],
  build: { status: "failed", reason: "npm ERR! missing script: build", at: 0, lastGoodAt: null },
  overrides: { idleMinutes: 10 },
  settings: { ...GLOBAL_CONTAINER, idleMinutes: 10 },
  global: GLOBAL_CONTAINER,
  problem: "maxInstance: no longer a size the Containers have",
  secrets: [],
  skills: [],
  globalSkills: [],
};

const ENVIRONMENTS: ReadonlyArray<EnvironmentDetails> = [DEFAULT, OTHER];

const environmentsOf = (list: EnvironmentsService["list"]): EnvironmentsService => ({
  ...unusedLifecycle,
  ...unusedSecretMarks,
  ...unusedSkills,
  current: Effect.succeed("default"),
  list,
  get: (id) =>
    Effect.succeed(
      Option.getOrNull(
        Arr.findFirst(ENVIRONMENTS, (each) => each.id === id),
      ) satisfies EnvironmentDetails | null,
    ),
  global: Effect.succeed({
    settings: GLOBAL_CONTAINER,
    overriddenIn: {
      "variables.NODE_ENV": [{ id: "default", name: "Default" }],
      idleMinutes: [{ id: "0000abcd", name: "Other" }],
    },
    secrets: [{ name: "NPM_TOKEN", scope: "every", build: false }],
    skills: [],
  }),
  change: () => nothing("changes"),
});

const environments = environmentsOf(
  Effect.succeed(
    Arr.map(ENVIRONMENTS, ({ id, name, repos, build }) => ({ id, name, repos, build })),
  ),
);

/** Environments whose list cannot be read. */
const unlistable = environmentsOf(
  Effect.fail(EnvironmentsError.make({ message: "The Registry did not answer." })),
);

// --- Settings ----------------------------------------------------------------------------------------------------

/** The Settings at Global, every field spelled. */
const GLOBAL_SETTINGS: Settings = {
  model: "anthropic/claude-opus-5-5",
  thinkingLevel: "high",
  roles: {
    small: { model: "anthropic/claude-haiku-5-5", hint: "Cheap and fast." },
    medium: { model: "anthropic/claude-sonnet-5-5", hint: "The workhorse." },
    large: { model: "anthropic/claude-opus-5-5", hint: "Planning and review." },
    xlarge: { model: "anthropic/claude-fable-5-1", hint: "Only when large has failed." },
  },
  compaction: {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    backgroundTokens: 32_768,
  },
  tools: { offered: ["read", "write", "edit", "bash", "tool_search", "context_rollover"] },
  spendLimit: { perSession: 5 },
  branchSummary: { skipPrompt: false },
  instructions: "Prefer small commits.",
  mcp: { servers: {} },
  extensions: { subagents: { maxSubagentDepth: 1, maxSubagentWorkspaces: 3 } },
};

/** What Global saved: the fields that are not the defaults. */
const GLOBAL_OVERRIDES = {
  spendLimit: { perSession: 5 },
  instructions: "Prefer small commits.",
  extensions: { subagents: { maxSubagentDepth: 1, maxSubagentWorkspaces: 3 } },
} satisfies Schema.Json;

/** An Environment's settings as the Registry shows them: what it overrides, over Global's. */
type FakeEnvironment = {
  readonly name: string;
  readonly settings: Settings;
  readonly overrides: Schema.Json;
  readonly instructions: string;
  readonly mcpServers: number;
};

/** A setting too long to show (`MAX_VALUE_BYTES`, 32 KiB), and Instructions too long for a result (128 KiB). */
const OVER_VALUE = "b".repeat(40_000);
const OVER_INSTRUCTIONS = "Keep functions small.\n".repeat(7_000);

const SETTINGS_ENVIRONMENTS = new Map<string, FakeEnvironment>([
  [
    "default",
    {
      name: "Default",
      settings: { ...GLOBAL_SETTINGS, spendLimit: { perSession: 2 } },
      overrides: { spendLimit: { perSession: 2 } },
      instructions: "Run the tests with bun.",
      mcpServers: 2,
    },
  ],
  [
    "big",
    {
      name: "Big",
      settings: {
        ...GLOBAL_SETTINGS,
        extensions: { ...GLOBAL_SETTINGS.extensions, big: { blob: OVER_VALUE } },
      },
      overrides: { extensions: { big: { blob: OVER_VALUE } } },
      instructions: OVER_INSTRUCTIONS,
      mcpServers: 0,
    },
  ],
]);

const unknownScope = (scope: string) => SettingsAccessError.make({ message: noEnvironment(scope) });

/** The Settings at Global and at two Environments, one of them with values and Instructions too long to show. */
const settings: SettingsAccessService = {
  get: (scope) =>
    Effect.suspend((): Effect.Effect<SettingsView, SettingsAccessError> => {
      if (scope === GLOBAL_SETTINGS_SCOPE) {
        return Effect.succeed({
          scope: GLOBAL_SETTINGS_SCOPE,
          settings: GLOBAL_SETTINGS,
          overrides: GLOBAL_OVERRIDES,
          overriddenIn: { "spendLimit.perSession": [{ id: "default", name: "Default" }] },
          problem: undefined,
          mcpServers: 1,
        });
      }

      const environment = SETTINGS_ENVIRONMENTS.get(scope);

      if (environment === undefined) return Effect.fail(unknownScope(scope));

      return Effect.succeed({
        scope,
        name: environment.name,
        settings: environment.settings,
        overrides: environment.overrides,
        global: GLOBAL_SETTINGS,
        problem: undefined,
        instructions: environment.instructions,
        mcpServers: environment.mcpServers,
      });
    }),
  own: Effect.succeed("default"),
  change: () => nothing("changes"),
};

// --- MCP servers -------------------------------------------------------------------------------------------------

/** A server as the Registry resolves it: an HTTP entry in force, `${NAME}` unresolved. */
const resolved = (name: string, source: McpResolvedServer["source"]): McpResolvedServer => {
  const exposure: McpExposure = "codemode";

  return {
    name,
    source,
    server: {
      enabled: true,
      exposure,
      toolExposure: {},
      timeout: 60,
      sampling: "ask",
      type: "http",
      url: `https://${name}.example.test/mcp`,
      headers: { Authorization: "Bearer ${API_TOKEN}" },
    },
    replacesGlobal: false,
    shadowed: [],
    resolvesSecrets: true,
  };
};

const server = (name: string, source: McpResolvedServer["source"]): SettingsMcpServer => ({
  server: resolved(name, source),
  origins: { enabled: "default", exposure: "default", toolExposure: "default" },
  reads: [{ name: "API_TOKEN", kind: "secret", where: ["headers.Authorization"] }],
  resetFields: [],
  signIn: null,
  hints: [],
  problems: [],
});

const SHARED = server("shared", { kind: "global" });
const DOCS = server("docs", { kind: "environment" });

/** The MCP servers of the Scopes: Global's own entry, and an Environment's whole set. */
const MCP_SCOPES = new Map<
  string,
  { readonly name: string; readonly servers: ReadonlyArray<SettingsMcpServer> }
>([
  [GLOBAL_SETTINGS_SCOPE, { name: "Global", servers: [SHARED] }],
  ["default", { name: "Default", servers: [SHARED, DOCS] }],
]);

const mcpView = (scope: string, name: string | undefined): SettingsMcpView | null => {
  const found = MCP_SCOPES.get(scope);

  if (found === undefined) return null;

  const chosen = Arr.filter(
    found.servers,
    (each) => name === undefined || each.server.name === name,
  );

  return {
    scope,
    name: found.name,
    servers: chosen,
    names: Arr.map(found.servers, (each) => each.server.name),
    layers:
      name === undefined || chosen.length === 0
        ? null
        : {
            global: scope === GLOBAL_SETTINGS_SCOPE ? { kind: "entry", value: {} } : null,
            environment: scope === GLOBAL_SETTINGS_SCOPE ? null : { kind: "entry", value: {} },
            repos: [],
          },
    repos: [],
    orphans: [],
    problems: [],
    offered: [],
    warnings: [],
  };
};

/** The host of every Environment: both servers connected, with their tools. */
const host = fakeMcpHost([
  {
    name: "shared",
    tools: [{ name: "lookup", description: "Look a name up", annotations: { readOnlyHint: true } }],
    protocolVersion: "2025-06-18",
  },
  {
    name: "docs",
    tools: [
      { name: "search", description: "Search the docs", annotations: { readOnlyHint: true } },
      { name: "publish", description: "Publish a page" },
    ],
    protocolVersion: "2025-06-18",
    instructions: "Search before you publish.",
  },
]);

const mcp: SettingsMcpAccessService = {
  view: ({ scope, name }) => {
    const view = mcpView(scope, name);

    return view === null ? Effect.fail(unknownScope(scope)) : Effect.succeed(view);
  },
  own: Effect.succeed("default"),
  check: () => nothing("changes"),
  reload: () => nothing("reloads"),
  pushes: () => nothing("pushes"),
  pushed: () => nothing("pushes"),
  host: () => host.client,
};

// --- The extensions ----------------------------------------------------------------------------------------------

// SAFETY: the tools use only `refresh` and `redact` of the Secrets.
const secrets = { refresh: Effect.void, redact: (value: string) => value } as SecretsService;

/** The four extensions over the stand-in services, by name. */
const extensionsOver = (over: EnvironmentsService) =>
  Effect.gen(function* () {
    const built: Record<(typeof EXTENSIONS)[number], Extension> = {
      environment: yield* EnvironmentTools,
      settings: yield* SettingsTools,
      settings_mcp: yield* SettingsMcpTools,
      "approval-tools": yield* ApprovalTools,
    };

    return built;
  }).pipe(
    Effect.provideService(Environments, over),
    Effect.provideService(EnvironmentRemoval, {
      footprint: () => nothing("deletes"),
      deleteEnvironment: () => nothing("deletes"),
      keptSecrets: () => nothing("deletes"),
      deleteSecret: () => nothing("deletes"),
    }),
    Effect.provideService(SettingsAccess, settings),
    Effect.provideService(SettingsMcpAccess, mcp),
    Effect.provideService(SettingsReload, { apply: nothing("reloads") }),
    Effect.provideService(AgentChangeLog, { record: () => nothing("logs") }),
    Effect.provideService(DeployCredentials, { values: [] }),
    Effect.provideService(Secrets, secrets),
    Effect.provideService(Approvals, unusedApprovals),
  );

const toolOf = (built: Record<(typeof EXTENSIONS)[number], Extension>, name: string) =>
  Option.getOrThrowWith(
    Arr.findFirst(
      Arr.flatMap(EXTENSIONS, (extension) => built[extension].tools ?? []),
      (tool) => tool.name === name,
    ),
    () => new Error(`no tool ${name}`),
  );

// SAFETY: the tools read only the calling conversation from the invocation's API.
const api = { conversationId: ROOT_CONVERSATION_ID } as ToolExecutionApi;

/** What a call answered, as it is: whether it failed, each part of its output, its structured output and its details. */
const answer = (tool: ToolRegistration, args: JsonObject) =>
  Effect.promise(() =>
    // SAFETY: the arguments are the tool's JSON parameters.
    tool.execute(args as never, api, BACKGROUND_CONTEXT),
  ).pipe(
    Effect.map((result) => ({
      isError: result.isError === true,
      output: result.output ?? [],
      structured: result.structuredOutput ?? null,
      details: result.details ?? null,
    })),
  );

// --- The snapshot ------------------------------------------------------------------------------------------------

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** `text` as the snapshot keeps a long one of an answer, on one line: its length, its SHA-256 and its start. */
const marked = (text: string): string =>
  `<${text.length} characters, sha256 ${sha256(text)}, starting ${JSON.stringify(text.slice(0, HEAD))}>`;

/** `value` with each string over `LONG_STRING` characters as its length, its SHA-256 and its start. */
const shortened = (value: Schema.Json): Schema.Json => {
  if (Predicate.isString(value)) {
    return value.length <= LONG_STRING ? value : marked(value);
  }

  if (Arr.isArray(value)) {
    // SAFETY: an array of a JSON value holds JSON values.
    const items = value as ReadonlyArray<Schema.Json>;

    return Arr.map(items, shortened);
  }

  if (Predicate.isObject(value)) {
    // SAFETY: an object of a JSON value holds JSON values.
    const entries = Object.entries(value as { readonly [key: string]: Schema.Json });

    return Object.fromEntries(Arr.map(entries, ([key, item]) => [key, shortened(item)]));
  }

  return value;
};

/** Whether the file is to be written: asked for, or missing outside CI (where a missing file is a failure). */
const writing = (): boolean => {
  if (process.env.UPDATE_SNAPSHOT === "1") return true;

  if (existsSync(SNAPSHOT)) return false;

  if (process.env.CI !== undefined) throw new Error(`${SNAPSHOT} is missing`);

  return true;
};

/** Compare `actual` with the file, or write it. */
const settle = (actual: Schema.Json) => {
  if (writing()) {
    mkdirSync(dirname(SNAPSHOT), { recursive: true });
    writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);

    return;
  }

  // SAFETY: the file is what this test wrote, then `oxfmt` laid out.
  const recorded = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as {
    readonly tools: Schema.Json;
    readonly reads: Schema.Json;
  };

  // SAFETY: the snapshot is an object of its two parts.
  const { tools, reads } = actual as { readonly tools: Schema.Json; readonly reads: Schema.Json };

  expect(tools).toEqual(recorded.tools);
  expect(reads).toEqual(recorded.reads);
};

describe("the Session's Environment and Settings tools", () => {
  it("register as, and the five reads answer as, __snapshots__/harness-session.json records", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const built = yield* extensionsOver(environments);
        const failing = yield* extensionsOver(unlistable);
        const tool = (name: string) => toolOf(built, name);

        const reads = {
          environment_list: yield* answer(tool("environment_list"), {}),
          environment_list_unreadable: yield* answer(toolOf(failing, "environment_list"), {}),
          // This Session's own Environment, with variables cut.
          environment_get_own: yield* answer(tool("environment_get"), { id: "default" }),
          // Another Environment, with a problem and a failed Build.
          environment_get_other: yield* answer(tool("environment_get"), { id: "0000abcd" }),
          environment_get_global: yield* answer(tool("environment_get"), { id: "*" }),
          environment_get_unknown: yield* answer(tool("environment_get"), { id: "nope" }),
          settings_get_global: yield* answer(tool("settings_get"), { scope: "*" }),
          settings_get_environment: yield* answer(tool("settings_get"), { scope: "default" }),
          // A setting over `MAX_VALUE_BYTES` and Instructions over the result's limit.
          settings_get_too_long: yield* answer(tool("settings_get"), { scope: "big" }),
          settings_get_unknown: yield* answer(tool("settings_get"), { scope: "nope" }),
          settings_mcp_list_global: yield* answer(tool("settings_mcp_list"), { scope: "*" }),
          settings_mcp_list_environment: yield* answer(tool("settings_mcp_list"), {
            scope: "default",
          }),
          settings_mcp_list_unknown: yield* answer(tool("settings_mcp_list"), { scope: "nope" }),
          settings_mcp_get_global: yield* answer(tool("settings_mcp_get"), {
            scope: "*",
            name: "shared",
          }),
          settings_mcp_get_environment: yield* answer(tool("settings_mcp_get"), {
            scope: "default",
            name: "docs",
          }),
          settings_mcp_get_unknown_scope: yield* answer(tool("settings_mcp_get"), {
            scope: "nope",
            name: "docs",
          }),
          settings_mcp_get_unknown_server: yield* answer(tool("settings_mcp_get"), {
            scope: "default",
            name: "ghost",
          }),
        };

        const registered = Arr.flatMap(EXTENSIONS, (extension) =>
          Arr.map(built[extension].tools ?? [], (each) => ({
            extension,
            name: each.name,
            description: each.description,
            parameters: each.parameters,
            structuredOutputSchema: each.structuredOutputSchema ?? null,
            replay: each.replay ?? null,
            executionMode: each.executionMode ?? null,
          })),
        );

        // The Environment's variables are cut after the ones that fit.
        expect(reads.environment_get_own.structured).toMatchObject({ variables_truncated: true });
        expect(reads.environment_get_other.structured).toMatchObject({ current: false });

        for (const [name, each] of Object.entries(reads)) {
          expect(each.isError, name).toBe(/unknown|unreadable/.test(name));
        }

        expect(VARIABLES_BYTES).toBeLessThan(
          Object.values(MANY_VARIABLES).reduce((total, value) => total + value.length, 0),
        );

        // SAFETY: the registrations and the answers are JSON; undefined keys are left out by the round trip.
        const whole = JSON.parse(JSON.stringify({ tools: registered, reads })) as {
          readonly tools: Schema.Json;
          readonly reads: Schema.Json;
        };

        // The registrations are kept whole, so a change to one shows; the answers' long strings are shortened.
        settle({ tools: whole.tools, reads: shortened(whole.reads) });
      }),
    ));
});
