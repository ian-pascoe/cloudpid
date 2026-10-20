import { cloudflareTest } from "@cloudflare/vitest-plugin";
import config from "@cloudpid/config/vitest";
import { configDefaults, defineConfig, defineProject, mergeConfig } from "vitest/config";

const workerd = "src/**/*.workerd.test.ts";

/** Workspace DO tests run in their own test Worker, which hosts the Workspace DO and the Worker Shell's loader. */
const workspace = "src/workspace/env.workerd.test.ts";

/** Tests of Sessions and tools on a Workspace run in a test Worker that also hosts a Session host. */
const onWorkspace = [
  "src/workspace/session.workerd.test.ts",
  "src/workspace/files.workerd.test.ts",
];

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
        test: { name: "workerd-workspace", include: [workspace] },
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
              },
              workerLoaders: { LOADER: {} },
            },
          }),
        ],
        test: { name: "workerd-session", include: onWorkspace },
      }),
    ],
  },
});
