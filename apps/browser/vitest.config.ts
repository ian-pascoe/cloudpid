import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * A stand-in for the Workspaces Worker's Container previews entrypoint (`WorkspaceContainerPreviews`), which the browser
 * Worker's `ContainerPreviews` hands requests to: its `containerPreview` answers with what it was asked, and throws for
 * the Workspace `ws:unreachable`.
 */
const WORKSPACES_STAND_IN = `
import { WorkerEntrypoint } from "cloudflare:workers";

export class WorkspaceContainerPreviews extends WorkerEntrypoint {
  async containerPreview(workspace, request, port) {
    if (workspace === "ws:unreachable") throw new Error("overloaded");

    return Response.json({
      workspace,
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
        },
        workerLoaders: { LOADER: {} },
        serviceBindings: {
          // Browser Run is not simulated: the binding answers every request that reaches it with a failure.
          BROWSER: () => new Response("no browser in tests", { status: 503 }),
          CONTAINER_PREVIEWS: { name: "workspaces", entrypoint: "WorkspaceContainerPreviews" },
        },
        workers: [
          {
            name: "workspaces",
            modules: true,
            script: WORKSPACES_STAND_IN,
            compatibilityDate: "2026-08-31",
          },
        ],
      },
    }),
  ],
  test: { include: ["src/**/*.test.ts"] },
});
