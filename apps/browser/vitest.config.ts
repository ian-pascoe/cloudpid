import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** The Worker's tests run inside workerd, against its real entry and Durable Object. */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-31",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          BROWSER_HOST: { className: "BrowserHost", useSQLite: true },
          // Facet classes are exposed through `ctx.exports` only when the config knows them.
          CODEMODE_RUNTIME: { className: "CodemodeRuntime", useSQLite: true },
        },
        workerLoaders: { LOADER: {} },
        // Browser Run is not simulated: the binding answers every request that reaches it with a failure.
        serviceBindings: { BROWSER: () => new Response("no browser in tests", { status: 503 }) },
      },
    }),
  ],
  test: { include: ["src/**/*.test.ts"] },
});
