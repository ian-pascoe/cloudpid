// @effect-diagnostics asyncFunction:off -- Vitest's config and rolldown's API are Promise-based.
import { fileURLToPath } from "node:url";
import cloudflare from "@alchemy.run/cloudflare-runtime/rolldown";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { testTimeout } from "@cloudpid/config/vitest";
import { rolldown } from "rolldown";
import { defineConfig } from "vitest/config";

const COMPATIBILITY_DATE = "2026-08-31";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url).href);

/**
 * `entry` bundled as alchemy bundles a Worker at deploy (rolldown with its Cloudflare plugins), to `out`. The engine's
 * own bundle is what its tests run, so they run it as it deploys: without `nodejs_compat`.
 */
const bundle = async (entry: string, out: string, flags: ReadonlyArray<string>) => {
  const build = await rolldown({
    input: here(entry),
    cwd: here("."),
    external: ["lightningcss", "fsevents"],
    plugins: [
      cloudflare({ compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: [...flags] }),
    ],
    checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
  });

  await build.write({ file: here(out), format: "esm", codeSplitting: false });
  await build.close();

  return here(out);
};

/**
 * The engine's tests run in workerd: the test Worker (`src/workerd.fixture.ts`, which `@cloudflare/vitest-plugin`
 * needs with `nodejs_compat`) calls `McpWorker`, an auxiliary Worker bundled as it deploys, without `nodejs_compat`,
 * whose every outbound `fetch` goes to the fake MCP servers, another auxiliary Worker (`src/fakes.fixture.ts`). The
 * package's few plain tests (`src/budget.test.ts`) run in the same project, in the test Worker.
 */
export default defineConfig(async () => {
  const engine = await bundle("./src/worker.ts", "./node_modules/.cache/workerd/mcp-worker.js", []);

  const fakes = await bundle("./src/fakes.fixture.ts", "./node_modules/.cache/workerd/fakes.js", [
    "nodejs_compat",
  ]);

  return {
    plugins: [
      cloudflareTest({
        main: "./src/workerd.fixture.ts",
        miniflare: {
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: { CALLERS: { className: "Caller", useSQLite: true } },
          serviceBindings: {
            MCP_ENGINE: { name: "mcp-worker", entrypoint: "McpEngine" },
            MCP_WORKER: "mcp-worker",
            FAKES: "fakes",
          },
          workers: [
            {
              name: "mcp-worker",
              modules: true,
              scriptPath: engine,
              compatibilityDate: COMPATIBILITY_DATE,
              outboundService: "fakes",
            },
            {
              name: "fakes",
              modules: true,
              scriptPath: fakes,
              compatibilityDate: COMPATIBILITY_DATE,
              compatibilityFlags: ["nodejs_compat"],
            },
          ],
        },
      }),
    ],
    test: { name: "workerd", testTimeout, include: ["src/**/*.test.ts"] },
  };
});
