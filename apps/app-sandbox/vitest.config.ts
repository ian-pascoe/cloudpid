import { cloudflareTest } from "@cloudflare/vitest-plugin";
import config, { testTimeout } from "@cloudpid/config/vitest";
import { configDefaults, defineConfig, defineProject, mergeConfig } from "vite-plus";

const workerd = "src/**/*.workerd.test.ts";

/**
 * Node tests use the shared base; `*.workerd.test.ts` run the Worker's real entry inside workerd, with the base's timeout
 * rather than Vitest's 5 s default, which a loaded CI runner can pass (#632).
 */
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
            miniflare: { compatibilityDate: "2026-08-31" },
          }),
        ],
        test: { name: "workerd", testTimeout, include: [workerd] },
      }),
    ],
  },
});
