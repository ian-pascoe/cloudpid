import { cloudflareTest } from "@cloudflare/vitest-plugin";
import config from "@cloudpid/config/vitest";
import { configDefaults, defineConfig, defineProject, mergeConfig } from "vitest/config";

const workerd = "src/**/*.workerd.test.ts";

/** Node tests use the shared base; `*.workerd.test.ts` run inside workerd, against the Worker's real entry. */
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
            main: "./src/worker.ts",
            miniflare: {
              compatibilityDate: "2026-08-31",
              modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
              durableObjects: {
                CODEMODE_SANDBOX: { className: "CodemodeSandbox", useSQLite: true },
              },
            },
          }),
        ],
        test: { name: "workerd", include: [workerd] },
      }),
    ],
  },
});
