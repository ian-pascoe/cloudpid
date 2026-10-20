import { cloudflareTest } from "@cloudflare/vitest-plugin";
import config from "@cloudpid/config/vitest";
import { configDefaults, defineConfig, defineProject, mergeConfig } from "vitest/config";

const workerd = "src/**/*.workerd.test.ts";

/** Workspace DO tests run in their own test Worker, which hosts the Workspace DO and the Worker Shell's loader. */
const workspace = "src/workspace/**/*.workerd.test.ts";

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
                REGISTRIES: { className: "TestRegistry", useSQLite: true },
              },
            },
          }),
        ],
        test: {
          name: "workerd",
          include: [workerd],
          exclude: [...configDefaults.exclude, workspace],
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
                WORKSPACE_SESSIONS: { className: "TestWorkspaceSession", useSQLite: true },
              },
              workerLoaders: { LOADER: {} },
            },
          }),
        ],
        test: { name: "workerd-workspace", include: [workspace] },
      }),
    ],
  },
});
