// The tools the `environment`, `settings`, `settings_mcp` and `approval-tools` extensions register, and what the five
// read-only ones (`environment_list`, `environment_get`, `settings_get`, `settings_mcp_list`, `settings_mcp_get`) answer
// over fixed fixtures, written to `__snapshots__/harness-session.json` (#686 S1a; `docs/architecture/mcp-endpoint.md` →
// Environment and Settings tools). The snapshot is what the in-session tools give today. The tools are later split into
// cores shared with the MCP endpoint and thin Session wrappers, and the split must leave this file unchanged.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off strictEffectProvide:off globalJsonInEffect:off missedPipeableOpportunity:off
import {
  DEFAULT_CONTAINER_SETTINGS,
  type McpExposure,
  type McpResolvedServer,
  overridesFrom,
  resolveEnvironmentContainerSettings,
  resolveOverridesLeniently,
} from "@cloudpid/config";
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
import { resolvedGlobal } from "./settings.fixture.ts";

const SNAPSHOT = "./__snapshots__/harness-session.json";

/** The extensions whose tools the snapshot holds, in the order it lists them. */
const EXTENSIONS = ["environment", "settings", "settings_mcp", "approval-tools"] as const;

/** The most `environment_get` lists of the variables kept, in stored bytes (`MAX_VARIABLES_BYTES`). */
const VARIABLES_BYTES = 160 * 1024;

const DEFAULT: EnvironmentDetails = {
  id: "default",
  name: "Default",
  repos: [{ name: "app", url: "https://github.com/o/app.git" }],
  build: { status: "ready", at: Date.UTC(2026, 9, 20) },
  overrides: {
    variables: {
      NODE_ENV: "test",
      // One more than fits: the variables are cut after the first (`variables_truncated`).
      NOTES: "n".repeat(VARIABLES_BYTES),
    },
  },
  settings: DEFAULT_CONTAINER_SETTINGS,
  global: DEFAULT_CONTAINER_SETTINGS,
  secrets: [
    { name: "API_KEY", scope: "environment", build: true },
    { name: "NPM_TOKEN", scope: "every", build: false },
  ],
  skills: [],
  globalSkills: [],
};

const OTHER: EnvironmentDetails = {
  id: "0000abcd",
  name: "Other",
  repos: [],
  build: { status: "failed", reason: "npm ERR! missing script: build", at: 0, lastGoodAt: null },
  overrides: {},
  settings: DEFAULT_CONTAINER_SETTINGS,
  global: DEFAULT_CONTAINER_SETTINGS,
  secrets: [],
  skills: [],
  globalSkills: [],
};

const GLOBAL_VARIABLES = { SHARED: "all", NODE_ENV: "prod" };

/** An Environment as `get` shows it: its Overrides resolved over Global's settings. */
const detailed = (each: EnvironmentDetails): EnvironmentDetails => {
  const global = { ...DEFAULT_CONTAINER_SETTINGS, variables: GLOBAL_VARIABLES };

  return {
    ...each,
    global,
    settings: resolveEnvironmentContainerSettings(global, each.overrides),
  };
};

const environments: EnvironmentsService = {
  ...unusedLifecycle,
  ...unusedSecretMarks,
  ...unusedSkills,
  current: Effect.succeed("default"),
  list: Effect.succeed(
    Arr.map([DEFAULT, OTHER], ({ id, name, repos, build }) => ({ id, name, repos, build })),
  ),
  get: (id) =>
    Effect.succeed(
      Option.getOrNull(
        Option.map(
          Arr.findFirst([DEFAULT, OTHER], (each) => each.id === id),
          detailed,
        ),
      ),
    ),
  global: Effect.succeed({
    settings: { ...DEFAULT_CONTAINER_SETTINGS, variables: GLOBAL_VARIABLES },
    overriddenIn: { "variables.NODE_ENV": [{ id: "default", name: "Default" }] },
    secrets: [{ name: "NPM_TOKEN", scope: "every" as const, build: false }],
    skills: [],
  }),
  change: () => Effect.die("The snapshot changes nothing"),
};

const GLOBAL_OVERRIDES = { spendLimit: { perSession: 5 }, instructions: "Prefer small commits." };
const ENVIRONMENT_OVERRIDES = { spendLimit: { perSession: 2 } };

/** The Settings at Global and at Environment `default`, which has its own Instructions. */
const settings: SettingsAccessService = {
  get: (scope) =>
    Effect.suspend((): Effect.Effect<SettingsView, SettingsAccessError> => {
      if (scope === GLOBAL_SETTINGS_SCOPE) {
        const global = resolvedGlobal(GLOBAL_OVERRIDES);

        return Effect.succeed({
          scope: GLOBAL_SETTINGS_SCOPE,
          settings: global,
          overrides: overridesFrom(global),
          overriddenIn: { "spendLimit.perSession": [{ id: "default", name: "Default" }] },
          problem: undefined,
          mcpServers: 1,
        });
      }

      if (scope !== "default") {
        return Effect.fail(
          SettingsAccessError.make({
            message: `No Environment has the id ${JSON.stringify(scope)}.`,
          }),
        );
      }

      const lenient = resolveOverridesLeniently(GLOBAL_OVERRIDES, ENVIRONMENT_OVERRIDES);

      return Effect.succeed({
        scope,
        name: "Default",
        settings: lenient.settings,
        overrides: lenient.overrides,
        global: lenient.global,
        problem: undefined,
        instructions: "Run the tests with bun.",
        mcpServers: 2,
      });
    }),
  own: Effect.succeed("default"),
  change: () => Effect.die("The snapshot changes nothing"),
};

/** A server as the Registry resolves it: an HTTP entry in force, `${NAME}` unresolved. */
const resolved = (name: string): McpResolvedServer => {
  const exposure: McpExposure = "codemode";

  return {
    name,
    source: { kind: "environment" },
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

const SERVERS: ReadonlyArray<SettingsMcpServer> = [
  {
    server: resolved("docs"),
    origins: { enabled: "default", exposure: "default", toolExposure: "default" },
    reads: [{ name: "API_TOKEN", kind: "secret", where: ["headers.Authorization"] }],
    resetFields: [],
    signIn: null,
    hints: [],
    problems: [],
  },
];

const mcpView = (name: string | undefined): SettingsMcpView => ({
  scope: "default",
  name: "Default",
  servers: SERVERS,
  names: Arr.map(SERVERS, (each) => each.server.name),
  layers:
    name === undefined
      ? null
      : { global: null, environment: { kind: "entry", value: {} }, repos: [] },
  repos: [],
  orphans: [],
  problems: [],
  offered: [],
  warnings: [],
});

/** The host of every Environment: one connected server with two tools. */
const host = fakeMcpHost([
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
  view: ({ scope, name }) =>
    scope === "default"
      ? Effect.succeed(mcpView(name))
      : Effect.fail(
          SettingsAccessError.make({
            message: `No Environment has the id ${JSON.stringify(scope)}.`,
          }),
        ),
  own: Effect.succeed("default"),
  check: () => Effect.die("The snapshot changes nothing"),
  reload: () => Effect.die("The snapshot reloads nothing"),
  pushes: () => Effect.die("The snapshot pushes nothing"),
  pushed: () => Effect.die("The snapshot pushes nothing"),
  host: () => host.client,
};

// SAFETY: the tools use only `refresh` and `redact` of the Secrets.
const secrets = { refresh: Effect.void, redact: (value: string) => value } as SecretsService;

/** The four extensions over the stand-in services, by name. */
const extensionsOver = Effect.gen(function* () {
  const built: Record<(typeof EXTENSIONS)[number], Extension> = {
    environment: yield* EnvironmentTools,
    settings: yield* SettingsTools,
    settings_mcp: yield* SettingsMcpTools,
    "approval-tools": yield* ApprovalTools,
  };

  return built;
}).pipe(
  Effect.provideService(Environments, environments),
  Effect.provideService(EnvironmentRemoval, {
    footprint: () => Effect.die("The snapshot deletes nothing"),
    deleteEnvironment: () => Effect.die("The snapshot deletes nothing"),
    keptSecrets: () => Effect.die("The snapshot deletes nothing"),
    deleteSecret: () => Effect.die("The snapshot deletes nothing"),
  }),
  Effect.provideService(SettingsAccess, settings),
  Effect.provideService(SettingsMcpAccess, mcp),
  Effect.provideService(SettingsReload, { apply: Effect.die("The snapshot reloads nothing") }),
  Effect.provideService(AgentChangeLog, { record: () => Effect.die("The snapshot logs nothing") }),
  Effect.provideService(DeployCredentials, { values: [] }),
  Effect.provideService(Secrets, secrets),
  Effect.provideService(Approvals, unusedApprovals),
);

// SAFETY: the tools read only the calling conversation from the invocation's API.
const api = { conversationId: ROOT_CONVERSATION_ID } as ToolExecutionApi;

/** The widest line oxfmt leaves a list on. */
const PRINT_WIDTH = 100;

/**
 * `value` as JSON as `oxfmt` lays it out, so the snapshot passes `format:check` as written: objects and the lists that
 * hold them one entry a line, and a list of plain values on one line when it fits. `trailing` is the width of what
 * follows the value on its line.
 */
const formatted = (value: Schema.Json, indent: number, trailing = 0, head = 0): string => {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 2);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";

    const flat = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
    const plain = value.every((item) => !Predicate.isObject(item));

    if (plain && indent + head + flat.length + trailing <= PRINT_WIDTH) return flat;

    const items = value.map(
      (item, index) => `${inner}${formatted(item, indent + 2, index < value.length - 1 ? 1 : 0)}`,
    );

    return `[\n${items.join(",\n")}\n${pad}]`;
  }

  if (Predicate.isObject(value)) {
    // SAFETY: an object of a JSON value holds JSON values.
    const entries = Object.entries(value as { readonly [key: string]: Schema.Json }).filter(
      ([, item]) => item !== undefined,
    );

    if (entries.length === 0) return "{}";

    const lines = entries.map(([key, item], index) => {
      const name = `${JSON.stringify(key)}: `;
      const trailing = index < entries.length - 1 ? 1 : 0;

      return `${inner}${name}${formatted(item, indent + 2, trailing, name.length)}`;
    });

    return `{\n${lines.join(",\n")}\n${pad}}`;
  }

  return JSON.stringify(value);
};

/** What a read answered: its text, its structured output and its details. */
const read = (tool: ToolRegistration, args: JsonObject) =>
  Effect.promise(() =>
    // SAFETY: the arguments are the tool's JSON parameters.
    tool.execute(args as never, api, BACKGROUND_CONTEXT),
  ).pipe(
    Effect.map((result) => {
      expect(result.isError).not.toBe(true);

      return {
        text: Arr.join(
          Arr.map(result.output ?? [], (part) => (part.type === "text" ? part.text : "")),
          "",
        ),
        structured: result.structuredOutput ?? null,
        details: result.details ?? null,
      };
    }),
  );

describe("the Session's Environment and Settings tools", () => {
  it("are the ones the snapshot lists, with the answers of the five reads", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const built = yield* extensionsOver;

        const tools = Arr.flatMap(EXTENSIONS, (extension) =>
          Arr.map(built[extension].tools ?? [], (tool) => ({ extension, tool })),
        );

        const named = (name: string): ToolRegistration =>
          Option.getOrThrowWith(
            Arr.findFirst(tools, (each) => each.tool.name === name),
            () => new Error(`no tool ${name}`),
          ).tool;

        const reads = {
          environment_list: yield* read(named("environment_list"), {}),
          environment_get: yield* read(named("environment_get"), { id: "default" }),
          settings_get_global: yield* read(named("settings_get"), { scope: "*" }),
          settings_get_environment: yield* read(named("settings_get"), { scope: "default" }),
          settings_mcp_list: yield* read(named("settings_mcp_list"), { scope: "default" }),
          settings_mcp_get: yield* read(named("settings_mcp_get"), {
            scope: "default",
            name: "docs",
          }),
        };

        const registered = Arr.map(tools, ({ extension, tool }) => ({
          extension,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          structuredOutputSchema: tool.structuredOutputSchema ?? null,
          replay: tool.replay ?? null,
          executionMode: tool.executionMode ?? null,
        }));

        // SAFETY: the registrations and the answers are JSON; undefined keys are left out by the writer.
        const snapshot = { tools: registered, reads } as Schema.Json;

        // The variables are cut: the one that fits is listed, and the one that does not is not.
        expect(reads.environment_get.structured).toMatchObject({
          variables_truncated: true,
        });

        yield* Effect.promise(() =>
          expect(`${formatted(snapshot, 0)}\n`).toMatchFileSnapshot(SNAPSHOT),
        );
      }),
    ));
});
