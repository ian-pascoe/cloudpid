// A stand-in Registry and McpHost for the management tools' reads (`./services.ts`, `./dispatch.ts`, and `/mcp`'s
// `endpoint.test.ts`): one Environment, "Default", and Global, with the answers the five read tools ask for. The Registry
// is cut down to the methods the reads use; each call is noted, and the Registry is the only thing the reads are given.
import { DEFAULT_CONTAINER_SETTINGS, DEFAULT_SETTINGS } from "@cloudpid/config";
import type { SettingsMcpServer, SettingsMcpView } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import type { HarnessDeps, HarnessRegistry } from "./services.ts";

/** The Environment the stand-in Registry lists. */
export const DEFAULT = {
  id: "default",
  name: "Default",
  repos: [{ name: "app", url: "https://github.com/o/app.git" }],
  createdAt: 0,
};

/** The setup script of the Environment: long enough to need a second page of 40,000 characters. */
export const LONG_SCRIPT = `${"echo setup\n".repeat(4_000)}echo done\n`;

/** The Instructions kept Global, and the Environment's own. */
export const GLOBAL_INSTRUCTIONS = "Prefer small commits.";

export const ENVIRONMENT_INSTRUCTIONS = "Run the tests.";

const GLOBAL_CONTAINER = { ...DEFAULT_CONTAINER_SETTINGS, variables: { SHARED: "all" } };

const ENVIRONMENT_CONTAINER = {
  ...GLOBAL_CONTAINER,
  setupScript: LONG_SCRIPT,
  variables: { SHARED: "all", TOKEN_URL: "https://example.test/token" },
};

const server: SettingsMcpServer = {
  server: {
    name: "docs",
    source: { kind: "environment" },
    server: {
      enabled: true,
      exposure: "codemode",
      toolExposure: {},
      timeout: 60,
      sampling: "ask",
      type: "http",
      url: "https://docs.example.test/mcp",
      headers: {},
      description: "",
    },
    replacesGlobal: false,
    shadowed: [],
    resolvesSecrets: false,
  },
  origins: { enabled: "default", exposure: "default", toolExposure: "default" },
  reads: [],
  resetFields: [],
  signIn: null,
  hints: [],
  problems: [],
};

/** The MCP view of Environment `default`: its one server `docs`, with its layers as written when `name` names it. */
const view = (name: string | undefined): SettingsMcpView => ({
  scope: "default",
  name: DEFAULT.name,
  servers: name === undefined || name === "docs" ? [server] : [],
  names: ["docs"],
  layers:
    name === "docs" ? { global: null, environment: { kind: "entry", value: {} }, repos: [] } : null,
  repos: [],
  orphans: [],
  problems: [],
  offered: [],
  warnings: [],
});

/** What the Registry was asked, by method: a test that expects no call to the Registry reads it. */
export type RegistryCalls = Array<string>;

/** The stand-in Registry, with the Registry calls noted in `calls`. */
export const harnessRegistry = (calls: RegistryCalls = []): HarnessRegistry => {
  const noted =
    <A, Args extends ReadonlyArray<unknown>>(method: string, answer: (...args: Args) => A) =>
    (...args: Args) =>
      Effect.sync(() => {
        calls.push(method);

        return answer(...args);
      });

  // SAFETY: the five read tools ask these methods only; each answers what the real Registry's would for one Environment.
  return {
    listEnvironments: noted("listEnvironments", () => [DEFAULT]),
    listBuilds: noted("listBuilds", () => [
      { environment: "default", build: { status: "ready" as const, at: 5 } },
    ]),
    getEnvironment: noted("getEnvironment", ({ id }: { readonly id: string }) =>
      id === "default" ? DEFAULT : null,
    ),
    getEnvironmentSettings: noted(
      "getEnvironmentSettings",
      ({ environment }: { readonly environment: string }) =>
        environment === "default"
          ? {
              settings: ENVIRONMENT_CONTAINER,
              global: GLOBAL_CONTAINER,
              overrides: { setupScript: LONG_SCRIPT, variables: ENVIRONMENT_CONTAINER.variables },
            }
          : null,
    ),
    listEnvironmentSecrets: noted("listEnvironmentSecrets", () => []),
    listSkills: noted("listSkills", () => []),
    getGlobalContainerSettings: noted("getGlobalContainerSettings", () => ({
      settings: GLOBAL_CONTAINER,
      overrides: { variables: GLOBAL_CONTAINER.variables },
      overriddenIn: { setupScript: [{ id: "default", name: "Default" }] },
    })),
    getSettings: noted("getSettings", () => ({
      settings: { ...DEFAULT_SETTINGS, instructions: GLOBAL_INSTRUCTIONS },
      overrides: {},
      problem: undefined,
      overriddenIn: {},
    })),
    getSettingsOverrides: noted(
      "getSettingsOverrides",
      ({ environment }: { readonly environment: string }) =>
        environment === "default"
          ? {
              settings: { ...DEFAULT_SETTINGS, instructions: GLOBAL_INSTRUCTIONS },
              overrides: {},
              global: { ...DEFAULT_SETTINGS, instructions: GLOBAL_INSTRUCTIONS },
              problem: undefined,
              instructions: ENVIRONMENT_INSTRUCTIONS,
            }
          : null,
    ),
    mcpServerNames: noted("mcpServerNames", () => ["docs"]),
    mcpSettingsView: noted(
      "mcpSettingsView",
      ({ environment, name }: { readonly environment?: string; readonly name?: string }) =>
        environment === "default" ? view(name) : null,
    ),
  } as never;
};

/** What the McpHost stand-in was asked: the Environment's host by its object name, and the method. */
export type HostCalls = Array<{ readonly host: string; readonly method: string }>;

/** The McpHost namespace's stand-in: each Environment's host answers `servers` with `docs` and one tool, and notes the call. */
export const harnessHosts = (calls: HostCalls = []): HarnessDeps["mcpHosts"] => ({
  getByName: (host: string) =>
    // SAFETY: the reads ask a host for `servers` only; the answer is what a host holding one connected server gives.
    ({
      servers: () =>
        Effect.sync(() => {
          calls.push({ host, method: "servers" });

          return {
            version: "v1",
            promptsVersion: "p1",
            servers: [
              {
                name: "docs",
                source: { kind: "environment" },
                server: { type: "http", url: "https://docs.example.test/mcp" },
                conn: "conn-docs",
                state: "connected",
                toolsHash: "t1",
                promptsHash: "p1",
                counts: { tools: 1, prompts: 0 },
                resources: false,
                problems: [],
                tools: [{ name: "search", description: "Search the docs.", inputSchema: {} }],
              },
            ],
          };
        }),
    }) as never,
});
