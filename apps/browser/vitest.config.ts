import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * A stand-in for the Workspaces Worker's Workspace DO, which the Container previews' entrypoint hands requests to: its
 * `preview` answers with what it was asked, and the object named `ws:unreachable` throws.
 */
const WORKSPACES_STAND_IN = `
import { DurableObject } from "cloudflare:workers";

export class Workspace extends DurableObject {
  async preview(request, port) {
    if (this.ctx.id.name === "ws:unreachable") throw new Error("overloaded");

    return Response.json({
      workspace: this.ctx.id.name,
      port,
      method: request.method,
      url: request.url,
      origin: request.headers.get("origin"),
      body: await request.text(),
    });
  }
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
`;

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
          WORKSPACES: { className: "Workspace", scriptName: "workspaces" },
        },
        workerLoaders: { LOADER: {} },
        // Browser Run is not simulated: the binding answers every request that reaches it with a failure.
        serviceBindings: { BROWSER: () => new Response("no browser in tests", { status: 503 }) },
        workers: [
          {
            name: "workspaces",
            modules: true,
            script: WORKSPACES_STAND_IN,
            compatibilityDate: "2026-08-31",
            durableObjects: { WORKSPACES: { className: "Workspace", useSQLite: true } },
          },
        ],
      },
    }),
  ],
  test: { include: ["src/**/*.test.ts"] },
});
