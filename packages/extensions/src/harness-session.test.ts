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
// moved. Run with `UPDATE_SNAPSHOT=1` to write the file again; a missing file fails the test.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off strictEffectProvide:off globalJsonInEffect:off missedPipeableOpportunity:off globalDate:off nodeBuiltinImport:off processEnv:off
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContainerSettings, McpExposure, McpResolvedServer, Settings } from "@cloudpid/config";
import type { McpApplySet } from "@cloudpid/mcp/types";
import type {
  AgentChange,
  SettingsMcpChangeCheck,
  SettingsMcpReload,
  SettingsMcpServer,
  SettingsMcpView,
} from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Extension,
  type JsonObject,
  ROOT_CONVERSATION_ID,
  type TaskId,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { GLOBAL_SETTINGS_SCOPE } from "@cloudpid/protocol/harness-tools";
import { recordedChange } from "./agent-change.fixture.ts";
import { ApprovalTools, EnvironmentRemoval } from "./approval-tools.ts";
import { type ApprovalAsk, Approvals, type ApprovalsService } from "./approvals.ts";
import { unusedApprovals } from "./approvals.fixture.ts";
import {
  AgentChangeLog,
  type AppliedChange,
  DeployCredentials,
  type EnvironmentDetails,
  Environments,
  EnvironmentsError,
  type EnvironmentsService,
  EnvironmentTools,
  type RunChange,
} from "./environment.ts";
import { unusedLifecycle } from "./environment-lifecycle.fixture.ts";
import { unusedSecretMarks } from "./environment-secret-marks.fixture.ts";
import { unusedSkills } from "./environment-skills.fixture.ts";
import { fakeMcpHost } from "./mcp.testing.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";
import {
  type AppliedSettingsChange,
  SettingsAccess,
  SettingsAccessError,
  type SettingsAccessService,
  type SettingsApplied,
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

const environmentsOf = (
  list: EnvironmentsService["list"],
  held: ReadonlyArray<EnvironmentDetails> = ENVIRONMENTS,
): EnvironmentsService => ({
  ...unusedLifecycle,
  ...unusedSecretMarks,
  ...unusedSkills,
  current: Effect.succeed("default"),
  list,
  get: (id) =>
    Effect.succeed(
      Option.getOrNull(
        Arr.findFirst(held, (each) => each.id === id),
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

/** The services a scenario of a tool that waits for the owner's Approval stands in for. */
type Standins = {
  readonly settings?: SettingsAccessService;
  readonly mcp?: SettingsMcpAccessService;
  readonly approvals?: ApprovalsService;
  readonly log?: { readonly record: (change: RunChange) => Effect.Effect<void> };
  readonly reload?: { readonly apply: Effect.Effect<SettingsApplied> };
};

/** The four extensions over the stand-in services, by name. */
const extensionsOver = (over: EnvironmentsService, standins: Standins = {}) =>
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
    Effect.provideService(SettingsAccess, standins.settings ?? settings),
    Effect.provideService(SettingsMcpAccess, standins.mcp ?? mcp),
    Effect.provideService(SettingsReload, standins.reload ?? { apply: nothing("reloads") }),
    Effect.provideService(AgentChangeLog, standins.log ?? { record: () => nothing("logs") }),
    Effect.provideService(DeployCredentials, { values: [] }),
    Effect.provideService(Secrets, secrets),
    Effect.provideService(Approvals, standins.approvals ?? unusedApprovals),
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

/**
 * What a call answered, as it is: whether it failed, each part of its output, its structured output and its details.
 * `fails` says whether the call is meant to be refused: a call that is not, or one that is, fails the test.
 */
const answer = (
  tool: ToolRegistration,
  args: JsonObject,
  fails: boolean | "unchecked" = false,
  calling: ToolExecutionApi = api,
) =>
  Effect.promise(() =>
    // SAFETY: the arguments are the tool's JSON parameters.
    tool.execute(args as never, calling, BACKGROUND_CONTEXT),
  ).pipe(
    Effect.map((result) => {
      if (fails !== "unchecked") expect(result.isError === true).toBe(fails);

      return result;
    }),
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

/** Compare `actual` with the file, or, with `UPDATE_SNAPSHOT=1`, write it. */
const settle = (actual: {
  readonly tools: Schema.Json;
  readonly reads: Schema.Json;
  readonly approvals: Schema.Json;
  readonly changes: Schema.Json;
}) => {
  if (process.env.UPDATE_SNAPSHOT === "1") {
    mkdirSync(dirname(SNAPSHOT), { recursive: true });
    writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);

    return;
  }

  if (!existsSync(SNAPSHOT)) {
    throw new Error(`${SNAPSHOT} is missing: run this test with UPDATE_SNAPSHOT=1 to create it`);
  }

  // SAFETY: the file holds the three parts this test wrote.
  const recorded = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as typeof actual;

  // Compared as text with the keys in order, as the model sees them, whatever the file's formatting.
  const text = (value: Schema.Json) => JSON.stringify(value, null, 2);

  expect(text(actual.tools)).toBe(text(recorded.tools));
  expect(text(actual.reads)).toBe(text(recorded.reads));
  expect(text(actual.approvals)).toBe(text(recorded.approvals));
  expect(text(actual.changes)).toBe(text(recorded.changes));
};

// --- The tools that wait for the owner's Approval ----------------------------------------------------------------

/** One call of a tool that waits for the owner's Approval: what the owner answers and what the Registry's stand-in says. */
type Scenario = {
  readonly tool: string;
  readonly args: JsonObject;
  /** The owner's answer to the card; Approve by default. */
  readonly owner?: { readonly approve: boolean; readonly reason?: string };
  /** What the Settings change answers, once the owner approved. */
  readonly settings?: AppliedSettingsChange;
  /** What the Environment change answers, once the owner approved. */
  readonly environment?: AppliedChange;
  /** The Environments, where a scenario needs others than the default pair. */
  readonly over?: EnvironmentsService;
  /** Whether the call is meant to be refused. */
  readonly fails?: boolean;
  /** What the Session's reload says it picked of its own, of the model and the thinking level. */
  readonly picked?: SettingsApplied["picked"];
  /** The MCP tools' world: the Registry's check of what a change reaches, the sets it has to push, and a reload's report. */
  readonly check?: SettingsMcpChangeCheck;
  readonly pushes?: ReadonlyArray<McpApplySet> | "fail";
  readonly reloaded?: SettingsMcpReload;
};

const asking: Pick<ToolExecutionApi, "taskId" | "conversationId"> = {
  // SAFETY: a task's id is a number pi-durable brands.
  taskId: 11 as TaskId,
  conversationId: ROOT_CONVERSATION_ID,
};

// SAFETY: the tools read only the call's task and conversation from the invocation's API.
const waitingApi = asking as ToolExecutionApi;

/**
 * One call of a tool that waits for the owner: the cards the owner was shown, the changes asked of the Settings and of
 * the Environments, what the Run's Notification and the reload were told, and the call's answer.
 */
const attempt = ({
  tool,
  args,
  owner = { approve: true },
  settings: madeSettings = { status: "unchanged" },
  environment: madeEnvironment = { status: "missing" },
  over = environments,
  picked = { model: false, thinkingLevel: false },
  check,
  pushes = [],
  reloaded,
}: Scenario) =>
  Effect.gen(function* () {
    const pushed: string[] = [];
    const asked: ApprovalAsk[] = [];
    const settingsCalls: unknown[] = [];
    const environmentCalls: unknown[] = [];
    const logged: RunChange[] = [];
    let reloads = 0;

    const approvals: ApprovalsService = {
      ...unusedApprovals,
      ask: (request) =>
        Effect.sync(() => {
          asked.push(request);

          return owner.approve
            ? { approved: true as const, expected: request.expected }
            : { approved: false as const, reason: owner.reason, expected: request.expected };
        }),
      settle: () => Effect.void,
    };

    const built = yield* extensionsOver(
      {
        ...over,
        change: (input) => {
          environmentCalls.push(input);

          return Effect.succeed(madeEnvironment);
        },
      },
      {
        settings: {
          ...settings,
          change: (input) => {
            settingsCalls.push(input);

            return Effect.succeed(madeSettings);
          },
        },
        approvals,
        mcp: {
          ...mcp,
          check: () => (check === undefined ? nothing("changes") : Effect.succeed(check)),
          reload: () => (reloaded === undefined ? nothing("reloads") : Effect.succeed(reloaded)),
          pushes: (environment) => {
            pushed.push(`pushes ${environment}`);

            return pushes === "fail"
              ? SettingsAccessError.make({ message: "The Registry did not answer." })
              : Effect.succeed(pushes);
          },
          pushed: ({ environment, revision }) =>
            Effect.sync(() => {
              pushed.push(`pushed ${environment} ${revision}`);
            }),
        },
        log: {
          record: (change) =>
            Effect.sync(() => {
              logged.push(change);
            }),
        },
        reload: {
          apply: Effect.sync(() => {
            reloads += 1;

            return { picked };
          }),
        },
      },
    );

    const result = yield* answer(toolOf(built, tool), args, "unchecked", waitingApi);

    return { asked, settingsCalls, environmentCalls, logged, reloads, pushed, result };
  });

/** A size that no Environment's size is above, an Environment sized cpu-3 inheriting Global's limit, and its list. */
const BIG_ENVIRONMENT: EnvironmentDetails = {
  ...DEFAULT,
  id: "00bb00bb",
  name: "Large",
  overrides: { instance: "cpu-3" },
  settings: { ...GLOBAL_CONTAINER, instance: "cpu-3" },
};

const sizedEnvironments = environmentsOf(
  Effect.succeed(
    Arr.map([OTHER, BIG_ENVIRONMENT], ({ id, name, repos, build }) => ({ id, name, repos, build })),
  ),
  [OTHER, BIG_ENVIRONMENT],
);

const REASON = "The reason.";

/** A Secret Reference, which these tools do not resolve. */
const PLACEHOLDER = `${"{{"}secret:API_KEY${"}}"}`;

const GLOBAL_CHANGED: AppliedChange = {
  status: "changed",
  environment: { id: "*", name: "Global" },
  change: recordedChange("environment_container_size_limit_set", {
    scope: "*",
    field: "maxInstance",
    before: "cpu-2",
    after: "cpu-3",
  }),
  newBuild: false,
  global: {
    overriddenIn: [{ id: "0000abcd", name: "Other" }],
    newBuilds: [{ id: "default", name: "Default" }],
    own: true,
  },
};

const OWN_CHANGED: AppliedChange = {
  status: "changed",
  environment: { id: "default", name: "Default" },
  change: recordedChange("environment_container_size_limit_set", {
    scope: "default",
    field: "maxInstance",
    before: "cpu-2",
    after: "cpu-3",
    beforeInherited: true,
  }),
  newBuild: true,
};

const OTHER_CHANGED: AppliedChange = {
  ...OWN_CHANGED,
  environment: { id: "0000abcd", name: "Other" },
  newBuild: false,
};

/** A Settings change made, one record for each field. */
const settingsChanged = (
  tool: string,
  field: string,
  before: Schema.Json | null,
  after: Schema.Json | null,
  more: Partial<AgentChange> = {},
): AppliedSettingsChange => ({
  status: "changed",
  changes: [recordedChange(tool, { field, before, after, ...more })],
});

const approvalScenarios = {
  spend_limit_global: {
    tool: "settings_spend_limit_set",
    args: { scope: "*", per_session: 8, reason: REASON },
    settings: settingsChanged("settings_spend_limit_set", "spendLimit.perSession", 5, 8),
  },
  spend_limit_global_off: {
    tool: "settings_spend_limit_set",
    args: { scope: "*", per_session: null, reason: REASON },
    settings: settingsChanged("settings_spend_limit_set", "spendLimit.perSession", 5, null),
  },
  spend_limit_environment: {
    tool: "settings_spend_limit_set",
    args: { scope: "default", per_session: 3.5, reason: REASON },
    settings: settingsChanged("settings_spend_limit_set", "spendLimit.perSession", 2, 3.5, {
      scope: "default",
      beforeInherited: false,
      afterInherited: false,
    }),
  },
  spend_limit_declined: {
    tool: "settings_spend_limit_set",
    args: { scope: "*", per_session: 8, reason: REASON },
    owner: { approve: false, reason: "Too much." },
  },
  spend_limit_declined_silently: {
    tool: "settings_spend_limit_set",
    args: { scope: "default", per_session: 9, reason: REASON },
    owner: { approve: false },
  },
  spend_limit_same: {
    tool: "settings_spend_limit_set",
    args: { scope: "*", per_session: 5, reason: REASON },
  },
  spend_limit_same_as_override: {
    tool: "settings_spend_limit_set",
    args: { scope: "default", per_session: 2, reason: REASON },
  },
  spend_limit_approved_but_same: {
    tool: "settings_spend_limit_set",
    args: { scope: "*", per_session: 8, reason: REASON },
    settings: { status: "unchanged" },
  },
  spend_limit_changed_since: {
    tool: "settings_spend_limit_set",
    args: { scope: "*", per_session: 8, reason: REASON },
    settings: { status: "changed-since", field: "spendLimit.perSession", current: 6 },
    fails: true,
  },
  spend_limit_changed_since_environment: {
    tool: "settings_spend_limit_set",
    args: { scope: "default", per_session: 8, reason: REASON },
    settings: {
      status: "changed-since",
      field: "spendLimit.perSession",
      current: 4,
      inherited: true,
    },
    fails: true,
  },
  spend_limit_rejected: {
    tool: "settings_spend_limit_set",
    args: { scope: "*", per_session: 8, reason: REASON },
    settings: { status: "rejected", message: "spendLimit: not a limit" },
    fails: true,
  },
  spend_limit_unknown_scope: {
    tool: "settings_spend_limit_set",
    args: { scope: "nope", per_session: 8, reason: REASON },
    fails: true,
  },
  spend_limit_reason_with_reference: {
    tool: "settings_spend_limit_set",
    args: { scope: "*", per_session: 8, reason: `Uses ${PLACEHOLDER} for it.` },
    fails: true,
  },
  subagent_depth_global: {
    tool: "settings_subagent_depth_set",
    args: { scope: "*", depth: 2, reason: REASON },
    settings: settingsChanged(
      "settings_subagent_depth_set",
      "extensions.subagents.maxSubagentDepth",
      1,
      2,
    ),
  },
  subagent_depth_environment: {
    tool: "settings_subagent_depth_set",
    args: { scope: "default", depth: 1, reason: REASON },
    settings: settingsChanged(
      "settings_subagent_depth_set",
      "extensions.subagents.maxSubagentDepth",
      1,
      1,
      { scope: "default", beforeInherited: true, afterInherited: false },
    ),
  },
  subagent_depth_same: {
    tool: "settings_subagent_depth_set",
    args: { scope: "*", depth: 1, reason: REASON },
  },
  subagent_workspaces_global: {
    tool: "settings_subagent_workspaces_set",
    args: { scope: "*", limit: 0, reason: REASON },
    settings: settingsChanged(
      "settings_subagent_workspaces_set",
      "extensions.subagents.maxSubagentWorkspaces",
      3,
      0,
    ),
  },
  subagent_workspaces_declined: {
    tool: "settings_subagent_workspaces_set",
    args: { scope: "default", limit: 6, reason: REASON },
    owner: { approve: false, reason: "Costly." },
  },
  subagent_workspaces_same: {
    tool: "settings_subagent_workspaces_set",
    args: { scope: "*", limit: 3, reason: REASON },
  },
  reset_limit_environment: {
    tool: "settings_reset",
    args: { scope: "default", field: "spendLimit.perSession", reason: REASON },
    settings: settingsChanged("settings_reset", "spendLimit.perSession", 2, 5, {
      scope: "default",
      beforeInherited: false,
      afterInherited: true,
    }),
  },
  reset_limit_environment_declined: {
    tool: "settings_reset",
    args: { scope: "default", field: "spendLimit.perSession", reason: REASON },
    owner: { approve: false, reason: "No." },
  },
  reset_limit_environment_inherited: {
    tool: "settings_reset",
    args: { scope: "big", field: "spendLimit.perSession", reason: REASON },
  },
  reset_limit_global: {
    tool: "settings_reset",
    args: { scope: "*", field: "extensions.subagents.maxSubagentDepth", reason: REASON },
    settings: settingsChanged("settings_reset", "extensions.subagents.maxSubagentDepth", 1, 2),
  },
  reset_limit_global_changed_since: {
    tool: "settings_reset",
    args: { scope: "*", field: "extensions.subagents.maxSubagentWorkspaces", reason: REASON },
    settings: {
      status: "changed-since",
      field: "extensions.subagents.maxSubagentWorkspaces",
      current: 7,
    },
    fails: true,
  },
  instructions_global: {
    tool: "settings_instructions_set",
    args: { scope: "*", text: "Prefer rebasing.", reason: REASON },
    settings: settingsChanged(
      "settings_instructions_set",
      "instructions",
      "Prefer small commits.",
      "Prefer rebasing.",
    ),
  },
  instructions_global_removed: {
    tool: "settings_instructions_set",
    args: { scope: "*", text: "", reason: REASON },
    settings: settingsChanged(
      "settings_instructions_set",
      "instructions",
      "Prefer small commits.",
      "",
    ),
  },
  instructions_environment: {
    tool: "settings_instructions_set",
    args: { scope: "default", text: "Run the tests with vitest.", reason: REASON },
    settings: settingsChanged(
      "settings_instructions_set",
      "instructions",
      "Run the tests with bun.",
      "Run the tests with vitest.",
      { scope: "default" },
    ),
  },
  instructions_environment_removed: {
    tool: "settings_instructions_set",
    args: { scope: "default", text: "", reason: REASON },
    settings: settingsChanged(
      "settings_instructions_set",
      "instructions",
      "Run the tests with bun.",
      "",
      {
        scope: "default",
      },
    ),
  },
  instructions_declined: {
    tool: "settings_instructions_set",
    args: { scope: "*", text: "Prefer rebasing.", reason: REASON },
    owner: { approve: false, reason: "Not now." },
  },
  instructions_removal_declined: {
    tool: "settings_instructions_set",
    args: { scope: "default", text: "", reason: REASON },
    owner: { approve: false },
  },
  instructions_same: {
    tool: "settings_instructions_set",
    args: { scope: "*", text: "Prefer small commits.", reason: REASON },
  },
  instructions_approved_but_same: {
    tool: "settings_instructions_set",
    args: { scope: "*", text: "Prefer rebasing.", reason: REASON },
    settings: { status: "unchanged" },
  },
  instructions_changed_since: {
    tool: "settings_instructions_set",
    args: { scope: "*", text: "Prefer rebasing.", reason: REASON },
    settings: { status: "changed-since", field: "instructions", current: "Something else." },
    fails: true,
  },
  instructions_changed_since_none: {
    tool: "settings_instructions_set",
    args: { scope: "default", text: "Prefer rebasing.", reason: REASON },
    settings: { status: "changed-since", field: "instructions", current: "" },
    fails: true,
  },
  instructions_rejected: {
    tool: "settings_instructions_set",
    args: { scope: "*", text: "Prefer rebasing.", reason: REASON },
    settings: { status: "rejected", message: "instructions: too long" },
    fails: true,
  },
  instructions_too_long: {
    tool: "settings_instructions_set",
    args: { scope: "*", text: "x".repeat(70_000), reason: REASON },
    fails: true,
  },
  instructions_with_reference: {
    tool: "settings_instructions_set",
    args: { scope: "*", text: `Use ${PLACEHOLDER}.`, reason: REASON },
    fails: true,
  },
  size_limit_environment: {
    tool: "environment_container_size_limit_set",
    args: { id: "default", size: "cpu-3", reason: REASON },
    environment: OWN_CHANGED,
  },
  size_limit_other_environment: {
    tool: "environment_container_size_limit_set",
    args: { id: "0000abcd", size: "cpu-3", reason: REASON },
    environment: OTHER_CHANGED,
  },
  size_limit_global: {
    tool: "environment_container_size_limit_set",
    args: { id: "*", size: "cpu-3", reason: REASON },
    environment: GLOBAL_CHANGED,
  },
  size_limit_declined: {
    tool: "environment_container_size_limit_set",
    args: { id: "default", size: "cpu-3", reason: REASON },
    owner: { approve: false, reason: "No more." },
  },
  size_limit_same_as_global: {
    tool: "environment_container_size_limit_set",
    args: { id: "*", size: "cpu-2", reason: REASON },
  },
  size_limit_approved_but_same: {
    tool: "environment_container_size_limit_set",
    args: { id: "default", size: "cpu-3", reason: REASON },
    environment: {
      status: "unchanged",
      environment: { id: "default", name: "Default" },
      value: "cpu-3",
    },
  },
  size_limit_changed_since: {
    tool: "environment_container_size_limit_set",
    args: { id: "default", size: "cpu-3", reason: REASON },
    environment: { status: "changed-since", current: "cpu-1" },
    fails: true,
  },
  size_limit_rejected: {
    tool: "environment_container_size_limit_set",
    args: { id: "default", size: "cpu-3", reason: REASON },
    environment: { status: "rejected", message: "maxInstance: no longer a size" },
    fails: true,
  },
  size_limit_missing: {
    tool: "environment_container_size_limit_set",
    args: { id: "default", size: "cpu-3", reason: REASON },
    environment: { status: "missing" },
    fails: true,
  },
  size_limit_unknown_environment: {
    tool: "environment_container_size_limit_set",
    args: { id: "nope", size: "cpu-3", reason: REASON },
    fails: true,
  },
  size_limit_below_size: {
    tool: "environment_container_size_limit_set",
    args: { id: "00bb00bb", size: "cpu-2", reason: REASON },
    over: sizedEnvironments,
    fails: true,
  },
  size_limit_below_inheriting_size: {
    tool: "environment_container_size_limit_set",
    args: { id: "*", size: "cpu-1", reason: REASON },
    over: sizedEnvironments,
    fails: true,
  },
  size_limit_reason_with_reference: {
    tool: "environment_container_size_limit_set",
    args: { id: "default", size: "cpu-3", reason: `Uses ${PLACEHOLDER}.` },
    fails: true,
  },
  reset_size_limit: {
    tool: "environment_setting_reset",
    args: { id: "00bb00bb", setting: "maxInstance", reason: REASON },
    over: environmentsOf(Effect.succeed([]), [
      {
        ...DEFAULT,
        id: "00bb00bb",
        name: "Large",
        overrides: { maxInstance: "cpu-3" },
        settings: { ...GLOBAL_CONTAINER, maxInstance: "cpu-3" },
      },
    ]),
    environment: {
      status: "changed",
      environment: { id: "00bb00bb", name: "Large" },
      change: recordedChange("environment_setting_reset", {
        scope: "00bb00bb",
        field: "maxInstance",
        before: "cpu-3",
        after: "cpu-2",
        afterInherited: true,
      }),
      newBuild: true,
    },
  },
  reset_size_limit_own: {
    tool: "environment_setting_reset",
    args: { id: "default", setting: "maxInstance", reason: REASON },
    over: environmentsOf(Effect.succeed([]), [
      {
        ...DEFAULT,
        overrides: { maxInstance: "cpu-3" },
        settings: { ...GLOBAL_CONTAINER, maxInstance: "cpu-3" },
      },
    ]),
    environment: {
      status: "changed",
      environment: { id: "default", name: "Default" },
      change: recordedChange("environment_setting_reset", {
        scope: "default",
        field: "maxInstance",
        before: "cpu-3",
        after: "cpu-2",
        afterInherited: true,
      }),
      newBuild: false,
    },
  },
  reset_size_limit_declined: {
    tool: "environment_setting_reset",
    args: { id: "00bb00bb", setting: "maxInstance", reason: REASON },
    over: environmentsOf(Effect.succeed([]), [
      {
        ...DEFAULT,
        id: "00bb00bb",
        name: "Large",
        overrides: { maxInstance: "cpu-3" },
        settings: { ...GLOBAL_CONTAINER, maxInstance: "cpu-3" },
      },
    ]),
    owner: { approve: false, reason: "Keep it." },
  },
  reset_size_limit_inherited: {
    tool: "environment_setting_reset",
    args: { id: "default", setting: "maxInstance", reason: REASON },
  },
  reset_size_limit_below_size: {
    tool: "environment_setting_reset",
    args: { id: "00bb00bb", setting: "maxInstance", reason: REASON },
    over: environmentsOf(Effect.succeed([]), [
      {
        ...DEFAULT,
        id: "00bb00bb",
        name: "Large",
        overrides: { instance: "cpu-3", maxInstance: "cpu-3" },
        settings: { ...GLOBAL_CONTAINER, instance: "cpu-3", maxInstance: "cpu-3" },
      },
    ]),
    fails: true,
  },
  reset_size_limit_approved_but_inherited: {
    tool: "environment_setting_reset",
    args: { id: "00bb00bb", setting: "maxInstance", reason: REASON },
    over: environmentsOf(Effect.succeed([]), [
      {
        ...DEFAULT,
        id: "00bb00bb",
        name: "Large",
        overrides: { maxInstance: "cpu-3" },
        settings: { ...GLOBAL_CONTAINER, maxInstance: "cpu-3" },
      },
    ]),
    environment: {
      status: "unchanged",
      environment: { id: "00bb00bb", name: "Large" },
      value: "cpu-2",
    },
  },
  reset_size_limit_changed_since: {
    tool: "environment_setting_reset",
    args: { id: "00bb00bb", setting: "maxInstance", reason: REASON },
    over: environmentsOf(Effect.succeed([]), [
      {
        ...DEFAULT,
        id: "00bb00bb",
        name: "Large",
        overrides: { maxInstance: "cpu-3" },
        settings: { ...GLOBAL_CONTAINER, maxInstance: "cpu-3" },
      },
    ]),
    environment: { status: "changed-since", current: "cpu-1" },
    fails: true,
  },
} satisfies Record<string, Scenario>;

/** What a change reaches in the MCP scenarios: Default's Sessions, narrowed. */
const NARROWING: SettingsMcpChangeCheck = {
  environments: [{ environment: { id: "default", name: "Default" }, reached: true, widening: [] }],
};

/** A set the Registry has yet to hand Default's host. */
const PENDING_SET: McpApplySet = { kind: "set", hash: "hash-default", revision: 7, entries: [] };

const RELOADED: SettingsMcpReload = {
  scope: "default",
  name: "Default",
  repos: [
    {
      directory: "app",
      slug: "o/app",
      path: ".pi/mcp.json",
      outcome: "changed",
      blob: "abc123",
      readAt: 1_000,
      error: null,
      errorSince: null,
      keptCopy: false,
      problem: null,
    },
  ],
  set: {
    added: ["docs"],
    removed: [],
    changed: [],
    problemsAdded: [],
    problemsCleared: [],
  },
  servers: 2,
};

/** The Settings' and MCP servers' changing tools, which make a change at once: what they asked of the Registry and said. */
const changeScenarios = {
  model_global: {
    tool: "settings_model_set",
    args: {
      scope: "*",
      model: "anthropic/claude-sonnet-5-5",
      thinking_level: "low",
      reason: REASON,
    },
    settings: {
      status: "changed",
      changes: [
        recordedChange("settings_model_set", {
          field: "model",
          before: "anthropic/claude-opus-5-5",
          after: "anthropic/claude-sonnet-5-5",
        }),
        recordedChange("settings_model_set", {
          id: 8,
          field: "thinkingLevel",
          before: "high",
          after: "low",
        }),
      ],
    },
  },
  model_environment_picked: {
    tool: "settings_model_set",
    args: { scope: "default", model: "anthropic/claude-sonnet-5-5", reason: REASON },
    settings: settingsChanged(
      "settings_model_set",
      "model",
      "anthropic/claude-opus-5-5",
      "anthropic/claude-sonnet-5-5",
      { scope: "default", beforeInherited: true, afterInherited: false },
    ),
    picked: { model: true, thinkingLevel: false },
  },
  model_other_environment: {
    tool: "settings_model_set",
    args: { scope: "big", thinking_level: "off", reason: REASON },
    settings: settingsChanged("settings_model_set", "thinkingLevel", "high", "off", {
      scope: "big",
      beforeInherited: true,
      afterInherited: false,
    }),
  },
  model_nothing_given: {
    tool: "settings_model_set",
    args: { scope: "*", reason: REASON },
    fails: true,
  },
  model_unchanged: {
    tool: "settings_model_set",
    args: { scope: "*", model: "anthropic/claude-opus-5-5", reason: REASON },
    settings: { status: "unchanged" },
  },
  model_rejected: {
    tool: "settings_model_set",
    args: { scope: "*", model: "anthropic/claude-sonnet-5-5", reason: REASON },
    settings: { status: "rejected", message: "model: not a model" },
    fails: true,
  },
  model_unknown_scope: {
    tool: "settings_model_set",
    args: { scope: "nope", model: "anthropic/claude-sonnet-5-5", reason: REASON },
    fails: true,
  },
  model_reason_with_reference: {
    tool: "settings_model_set",
    args: { scope: "*", model: "anthropic/claude-sonnet-5-5", reason: `Uses ${PLACEHOLDER}.` },
    fails: true,
  },
  role_global_with_hint: {
    tool: "settings_role_set",
    args: {
      scope: "*",
      role: "small",
      model: "anthropic/claude-sonnet-5-5",
      hint: "Quick edits.",
      reason: REASON,
    },
    settings: settingsChanged(
      "settings_role_set",
      "roles.small",
      { model: "anthropic/claude-haiku-5-5", hint: "Cheap and fast." },
      { model: "anthropic/claude-sonnet-5-5", hint: "Quick edits." },
    ),
  },
  role_environment_keeps_hint: {
    tool: "settings_role_set",
    args: { scope: "default", role: "large", model: "anthropic/claude-fable-5-1", reason: REASON },
    settings: settingsChanged(
      "settings_role_set",
      "roles.large",
      { model: "anthropic/claude-opus-5-5", hint: "Planning and review." },
      { model: "anthropic/claude-fable-5-1", hint: "Planning and review." },
      { scope: "default", beforeInherited: true, afterInherited: false },
    ),
  },
  tool_offer_global: {
    tool: "settings_tool_offer",
    args: { scope: "*", pattern: "web_fetch", reason: REASON },
    settings: settingsChanged(
      "settings_tool_offer",
      "tools.offered",
      ["read", "write", "edit", "bash", "tool_search", "context_rollover"],
      ["read", "write", "edit", "bash", "tool_search", "context_rollover", "web_fetch"],
    ),
  },
  tool_offer_already: {
    tool: "settings_tool_offer",
    args: { scope: "*", pattern: "bash", reason: REASON },
  },
  tool_defer_global: {
    tool: "settings_tool_defer",
    args: { scope: "*", pattern: "edit", reason: REASON },
    settings: settingsChanged(
      "settings_tool_defer",
      "tools.offered",
      ["read", "write", "edit", "bash", "tool_search", "context_rollover"],
      ["read", "write", "bash", "tool_search", "context_rollover"],
    ),
  },
  tool_defer_always_offered: {
    tool: "settings_tool_defer",
    args: { scope: "*", pattern: "tool_search", reason: REASON },
    settings: settingsChanged(
      "settings_tool_defer",
      "tools.offered",
      ["read", "write", "edit", "bash", "tool_search", "context_rollover"],
      ["read", "write", "edit", "bash", "context_rollover"],
    ),
  },
  tool_defer_absent: {
    tool: "settings_tool_defer",
    args: { scope: "*", pattern: "web_fetch", reason: REASON },
  },
  compaction_global: {
    tool: "settings_compaction_set",
    args: { scope: "*", enabled: false, reserve_tokens: 8_192, reason: REASON },
    settings: {
      status: "changed",
      changes: [
        recordedChange("settings_compaction_set", {
          field: "compaction.enabled",
          before: true,
          after: false,
        }),
        recordedChange("settings_compaction_set", {
          id: 8,
          field: "compaction.reserveTokens",
          before: 16_384,
          after: 8_192,
        }),
      ],
    },
  },
  compaction_nothing_given: {
    tool: "settings_compaction_set",
    args: { scope: "default", reason: REASON },
    fails: true,
  },
  compaction_unchanged: {
    tool: "settings_compaction_set",
    args: { scope: "default", background_tokens: 32_768, reason: REASON },
    settings: { status: "unchanged" },
  },
  branch_summary_environment: {
    tool: "settings_branch_summary_set",
    args: { scope: "default", skip_prompt: true, reason: REASON },
    settings: settingsChanged(
      "settings_branch_summary_set",
      "branchSummary.skipPrompt",
      false,
      true,
      {
        scope: "default",
        beforeInherited: true,
        afterInherited: false,
      },
    ),
  },
  extension_global: {
    tool: "settings_extension_set",
    args: {
      scope: "*",
      extension: "subagents",
      key: "readToolset",
      value: ["read", "grep"],
      reason: REASON,
    },
    settings: settingsChanged("settings_extension_set", "extensions.subagents.readToolset", null, [
      "read",
      "grep",
    ]),
  },
  extension_other: {
    tool: "settings_extension_set",
    args: { scope: "*", extension: "notes", key: "limit", value: 3, reason: REASON },
    settings: settingsChanged("settings_extension_set", "extensions.notes.limit", null, 3),
  },
  extension_environment_removed: {
    tool: "settings_extension_set",
    args: { scope: "default", extension: "notes", key: "limit", value: null, reason: REASON },
    settings: settingsChanged("settings_extension_set", "extensions.notes.limit", 3, null, {
      scope: "default",
      beforeInherited: false,
      afterInherited: true,
    }),
  },
  extension_unchanged: {
    tool: "settings_extension_set",
    args: { scope: "*", extension: "notes", key: "limit", value: null, reason: REASON },
    settings: { status: "unchanged" },
  },
  extension_mcp: {
    tool: "settings_extension_set",
    args: { scope: "*", extension: "mcp", key: "x", value: 1, reason: REASON },
    fails: true,
  },
  extension_depth_limit: {
    tool: "settings_extension_set",
    args: { scope: "*", extension: "subagents", key: "maxSubagentDepth", value: 2, reason: REASON },
    fails: true,
  },
  extension_workspaces_limit: {
    tool: "settings_extension_set",
    args: {
      scope: "*",
      extension: "subagents",
      key: "maxSubagentWorkspaces",
      value: 2,
      reason: REASON,
    },
    fails: true,
  },
  extension_not_a_list: {
    tool: "settings_extension_set",
    args: { scope: "*", extension: "subagents", key: "readToolset", value: 4, reason: REASON },
    fails: true,
  },
  extension_value_with_reference: {
    tool: "settings_extension_set",
    args: { scope: "*", extension: "notes", key: "limit", value: PLACEHOLDER, reason: REASON },
    fails: true,
  },
  reset_environment_field: {
    tool: "settings_reset",
    args: { scope: "default", field: "roles.small", reason: REASON },
  },
  reset_environment_override: {
    tool: "settings_reset",
    args: { scope: "default", field: "thinkingLevel", reason: REASON },
    settings: settingsChanged("settings_reset", "thinkingLevel", "low", "high", {
      scope: "default",
      beforeInherited: false,
      afterInherited: true,
    }),
  },
  reset_global_field: {
    tool: "settings_reset",
    args: { scope: "*", field: "compaction.reserveTokens", reason: REASON },
    settings: settingsChanged("settings_reset", "compaction.reserveTokens", 8_192, 16_384),
  },
  reset_instructions: {
    tool: "settings_reset",
    args: { scope: "*", field: "instructions", reason: REASON },
    fails: true,
  },
  reset_unknown_field: {
    tool: "settings_reset",
    args: { scope: "*", field: "nonsense", reason: REASON },
    fails: true,
  },
  reset_unknown_scope: {
    tool: "settings_reset",
    args: { scope: "nope", field: "model", reason: REASON },
    fails: true,
  },
  mcp_disable_global: {
    tool: "settings_mcp_disable",
    args: { scope: "*", name: "shared", reason: REASON },
    check: NARROWING,
    settings: settingsChanged("settings_mcp_disable", "mcp.servers.shared.enabled", true, false),
  },
  mcp_disable_pushed: {
    tool: "settings_mcp_disable",
    args: { scope: "default", name: "docs", reason: REASON },
    check: NARROWING,
    pushes: [PENDING_SET],
    settings: settingsChanged("settings_mcp_disable", "mcp.servers.docs.enabled", true, false, {
      scope: "default",
      beforeInherited: false,
      afterInherited: false,
    }),
  },
  mcp_disable_push_failed: {
    tool: "settings_mcp_disable",
    args: { scope: "default", name: "docs", reason: REASON },
    check: NARROWING,
    pushes: "fail",
    settings: settingsChanged("settings_mcp_disable", "mcp.servers.docs.enabled", true, false, {
      scope: "default",
      beforeInherited: false,
      afterInherited: false,
    }),
  },
  mcp_disable_unknown_server: {
    tool: "settings_mcp_disable",
    args: { scope: "default", name: "ghost", reason: REASON },
    fails: true,
  },
  mcp_disable_reason_with_reference: {
    tool: "settings_mcp_disable",
    args: { scope: "*", name: "shared", reason: `Uses ${PLACEHOLDER}.` },
    fails: true,
  },
  mcp_exposure_global: {
    tool: "settings_mcp_exposure_set",
    args: { scope: "*", name: "shared", exposure: "deferred", reason: REASON },
    check: NARROWING,
    settings: settingsChanged(
      "settings_mcp_exposure_set",
      "mcp.servers.shared.exposure",
      "codemode",
      "deferred",
    ),
  },
  mcp_exposure_already: {
    tool: "settings_mcp_exposure_set",
    args: { scope: "default", name: "docs", exposure: "codemode", reason: REASON },
    check: NARROWING,
  },
  mcp_tool_exposure_hidden: {
    tool: "settings_mcp_tool_exposure_set",
    args: { scope: "default", name: "docs", tool: "publish", exposure: "hidden", reason: REASON },
    check: NARROWING,
    settings: settingsChanged(
      "settings_mcp_tool_exposure_set",
      "mcp.servers.docs.toolExposure",
      {},
      { publish: "hidden" },
      { scope: "default", beforeInherited: false, afterInherited: false },
    ),
  },
  mcp_tool_exposure_pattern: {
    tool: "settings_mcp_tool_exposure_set",
    args: { scope: "*", name: "shared", tool: "look*", exposure: "direct", reason: REASON },
    check: NARROWING,
    settings: settingsChanged(
      "settings_mcp_tool_exposure_set",
      "mcp.servers.shared.toolExposure",
      {},
      { "look*": "direct" },
    ),
  },
  mcp_tool_exposure_absent_key_removed: {
    tool: "settings_mcp_tool_exposure_set",
    args: { scope: "*", name: "shared", tool: "look*", exposure: null, reason: REASON },
    check: NARROWING,
  },
  mcp_remove_environment: {
    tool: "settings_mcp_remove",
    args: { scope: "default", name: "docs", reason: REASON },
    check: NARROWING,
    settings: settingsChanged(
      "settings_mcp_remove",
      "mcp.servers.docs",
      { url: "https://docs.example.test/mcp" },
      null,
      {
        scope: "default",
        beforeInherited: false,
        afterInherited: false,
      },
    ),
  },
  mcp_remove_global_server_at_environment: {
    tool: "settings_mcp_remove",
    args: { scope: "default", name: "shared", reason: REASON },
    fails: true,
  },
  mcp_reload_environment: {
    tool: "settings_mcp_reload",
    args: { scope: "default" },
    reloaded: RELOADED,
    pushes: [PENDING_SET],
  },
  mcp_reload_global: {
    tool: "settings_mcp_reload",
    args: { scope: "*" },
    fails: true,
  },
} satisfies Record<string, Scenario>;

describe("the Session's Environment and Settings tools", () => {
  it("registers the tools and answers the reads exactly as the snapshot records", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const built = yield* extensionsOver(environments);
        const failing = yield* extensionsOver(unlistable);
        const tool = (name: string) => toolOf(built, name);

        const reads = {
          environment_list: yield* answer(tool("environment_list"), {}),
          environment_list_unreadable: yield* answer(toolOf(failing, "environment_list"), {}, true),
          // This Session's own Environment, with variables cut.
          environment_get_own: yield* answer(tool("environment_get"), { id: "default" }),
          // Another Environment, with a problem and a failed Build.
          environment_get_other: yield* answer(tool("environment_get"), { id: "0000abcd" }),
          environment_get_global: yield* answer(tool("environment_get"), { id: "*" }),
          environment_get_unknown: yield* answer(tool("environment_get"), { id: "nope" }, true),
          settings_get_global: yield* answer(tool("settings_get"), { scope: "*" }),
          settings_get_environment: yield* answer(tool("settings_get"), { scope: "default" }),
          // A setting over `MAX_VALUE_BYTES` and Instructions over the result's limit.
          settings_get_too_long: yield* answer(tool("settings_get"), { scope: "big" }),
          settings_get_unknown: yield* answer(tool("settings_get"), { scope: "nope" }, true),
          settings_mcp_list_global: yield* answer(tool("settings_mcp_list"), { scope: "*" }),
          settings_mcp_list_environment: yield* answer(tool("settings_mcp_list"), {
            scope: "default",
          }),
          settings_mcp_list_unknown: yield* answer(
            tool("settings_mcp_list"),
            { scope: "nope" },
            true,
          ),
          settings_mcp_get_global: yield* answer(tool("settings_mcp_get"), {
            scope: "*",
            name: "shared",
          }),
          settings_mcp_get_environment: yield* answer(tool("settings_mcp_get"), {
            scope: "default",
            name: "docs",
          }),
          settings_mcp_get_unknown_scope: yield* answer(
            tool("settings_mcp_get"),
            {
              scope: "nope",
              name: "docs",
            },
            true,
          ),
          settings_mcp_get_unknown_server: yield* answer(
            tool("settings_mcp_get"),
            {
              scope: "default",
              name: "ghost",
            },
            true,
          ),
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

        expect(VARIABLES_BYTES).toBeLessThan(
          Object.values(MANY_VARIABLES).reduce((total, value) => total + value.length, 0),
        );

        const approvals = yield* Effect.forEach(
          Object.entries(approvalScenarios),
          ([name, each]) => {
            const scenario: Scenario = each;

            return Effect.map(attempt(scenario), (outcome) => {
              const refused: boolean = scenario.fails === true;

              expect(outcome.result.isError, name).toBe(refused);

              return [name, outcome] as const;
            });
          },
        );

        const changes = yield* Effect.forEach(Object.entries(changeScenarios), ([name, each]) => {
          const scenario: Scenario = each;

          return Effect.map(attempt(scenario), (outcome) => {
            const refused: boolean = scenario.fails === true;

            expect(outcome.result.isError, name).toBe(refused);

            // Nothing here waits for the owner.
            expect(outcome.asked, name).toEqual([]);

            return [name, outcome] as const;
          });
        });

        // SAFETY: the registrations and the answers are JSON; undefined keys are left out by the round trip.
        const whole = JSON.parse(
          JSON.stringify({
            tools: registered,
            reads,
            approvals: Object.fromEntries(approvals),
            changes: Object.fromEntries(changes),
          }),
        ) as {
          readonly tools: Schema.Json;
          readonly reads: Schema.Json;
          readonly approvals: Schema.Json;
          readonly changes: Schema.Json;
        };

        // The registrations are kept whole, so a change to one shows; the answers' long strings are shortened.
        settle({
          tools: whole.tools,
          reads: shortened(whole.reads),
          approvals: shortened(whole.approvals),
          changes: shortened(whole.changes),
        });
      }),
    ));
});
