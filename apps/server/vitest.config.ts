import { cloudflareTest } from "@cloudflare/vitest-plugin";
import config from "@cloudpid/config/vitest";
import { configDefaults, defineConfig, defineProject, mergeConfig } from "vitest/config";

const workerd = "src/**/*.workerd.test.ts";

/**
 * Workspace DO tests run in their own test Worker, which hosts the Workspace DO and the Worker Shell's loader.
 *
 * `bash.workerd.test.ts` needs only that. It lives here, not in `workerd-session`, because there it reproducibly crashed
 * another file's worker in CI (a workerd websocket close, 1009 "Message too large"), which never happens locally and which
 * nothing explains yet: https://github.com/ian-pascoe/cloudpid/issues/64. Move it when that is fixed.
 */
const workspaceOnly = ["src/workspace/env.workerd.test.ts", "src/workspace/bash.workerd.test.ts"];

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
            },
          }),
        ],
        test: { name: "workerd-workspace", include: workspaceOnly },
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
              workerLoaders: { LOADER: {} },
              // pi-codemode's QuickJS engine is a `.wasm` import, which Wrangler compiles by default.
              modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
            },
          }),
        ],
        test: {
          name: "workerd-session",
          include: [onWorkspace],
          exclude: [...configDefaults.exclude, ...workspaceOnly],
        },
      }),
    ],
  },
});
