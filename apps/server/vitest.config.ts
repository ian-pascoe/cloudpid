import { cloudflareTest } from "@cloudflare/vitest-plugin";
import config, { testTimeout } from "@cloudpid/config/vitest";
import { configDefaults, defineConfig, defineProject, mergeConfig } from "vitest/config";

const workerd = "src/**/*.workerd.test.ts";

/**
 * Workspace DO tests run in their own test Worker, which hosts the Workspace DO and the Worker Shell's loader: the
 * environment conformance cases and the Changes (over repos real git made, `changes.setup.ts`).
 */
const workspaceEnv = [
  "src/workspace/env.workerd.test.ts",
  "src/workspace/changes*.workerd.test.ts",
];

/** Every other Workspace test (Sessions and tools on a Workspace) runs in a test Worker that also hosts a Session host. */
const onWorkspace = "src/workspace/**/*.workerd.test.ts";

/** Node tests use the shared base; `*.workerd.test.ts` run inside workerd, against real Durable Object storage and alarms. */
export default defineConfig({
  test: {
    projects: [
      mergeConfig(
        config,
        defineProject({ test: { name: "node", exclude: [...configDefaults.exclude, workerd] } }),
      ),
      defineProject({
        plugins: [
          cloudflareTest({
            main: "./src/workerd.fixture.ts",
            miniflare: {
              compatibilityDate: "2026-08-31",
              compatibilityFlags: ["nodejs_compat"],
              durableObjects: {
                SESSIONS: { className: "TestSession", useSQLite: true },
                SUBAGENT_SESSIONS: { className: "TestSubagentSession", useSQLite: true },
                REGISTRIES: { className: "TestRegistry", useSQLite: true },
              },
            },
          }),
        ],
        test: {
          name: "workerd",
          testTimeout,
          include: [workerd],
          exclude: [...configDefaults.exclude, "src/workspace/**"],
        },
      }),
      defineProject({
        plugins: [
          cloudflareTest({
            main: "./src/workspace/workerd.fixture.ts",
            miniflare: {
              compatibilityDate: "2026-08-31",
              compatibilityFlags: ["nodejs_compat"],
              durableObjects: {
                WORKSPACES: { className: "TestWorkspace", useSQLite: true },
              },
              workerLoaders: { LOADER: {} },
              // The key the Workspace DO seals its copy of the Environment's Secrets under.
              bindings: { SECRETS_ENCRYPTION_KEY: "test-master-key-0123456789abcdef0123456789" },
            },
          }),
        ],
        test: {
          name: "workerd-workspace",
          include: workspaceEnv,
          testTimeout,
          // Real git makes the repos the Changes tests read, in Node (`inject("changesRepos")`).
          globalSetup: ["./src/workspace/changes.setup.ts"],
        },
      }),
      defineProject({
        plugins: [
          cloudflareTest({
            main: "./src/workspace/session.workerd.fixture.ts",
            miniflare: {
              compatibilityDate: "2026-08-31",
              compatibilityFlags: ["nodejs_compat"],
              durableObjects: {
                WORKSPACES: { className: "TestWorkspace", useSQLite: true },
                WORKSPACE_SESSIONS: { className: "TestWorkspaceSession", useSQLite: true },
                CODEMODE_SESSIONS: { className: "TestCodemodeSession", useSQLite: true },
                CODEMODE_SANDBOX: { className: "CodemodeSandbox", useSQLite: true },
              },
              // The Session's `read` prepares images with it; miniflare emulates it with sharp.
              images: { binding: "IMAGES" },
              workerLoaders: { LOADER: {} },
              // pi-codemode's QuickJS engine is a `.wasm` import, which Wrangler compiles by default.
              modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
            },
          }),
        ],
        test: {
          name: "workerd-session",
          testTimeout,
          include: [onWorkspace],
          exclude: [...configDefaults.exclude, ...workspaceEnv],
        },
      }),
    ],
  },
});
