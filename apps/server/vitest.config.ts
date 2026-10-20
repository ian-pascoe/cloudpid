import { cloudflareTest } from "@cloudflare/vitest-plugin";
import config from "@cloudpid/config/vitest";
import { configDefaults, defineConfig, defineProject, mergeConfig } from "vitest/config";

const workerd = "src/**/*.workerd.test.ts";

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
            main: "./src/session/host.fixture.ts",
            miniflare: {
              compatibilityDate: "2026-08-31",
              compatibilityFlags: ["nodejs_compat"],
              durableObjects: { SESSIONS: { className: "TestSession", useSQLite: true } },
            },
          }),
        ],
        test: { name: "workerd", include: [workerd] },
      }),
    ],
  },
});
