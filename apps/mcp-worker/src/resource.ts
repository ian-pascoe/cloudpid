import { WORKER_OBSERVABILITY } from "@cloudpid/telemetry/observability";
import * as Cloudflare from "@alchemy.run/cloudflare";

/**
 * `McpWorker`, the Worker the MCP SDK runs in (ADR-0038; `docs/architecture/mcp-connections.md` → The engine). It is a
 * plain Worker of its own because it exports a `WorkerEntrypoint` (`McpEngine`), which alchemy's Effect Workers cannot,
 * and because the SDK's cold heap must stay out of the isolates `Server`'s Durable Objects share (ADR-0036). It runs
 * without `nodejs_compat`. It has no public URL: `workersDev` is off and it declares no routes, so the only way in is
 * the `MCP_ENGINE` binding `Server` declares with this Worker as its Output, so this Worker deploys first.
 */
export const McpWorker = Cloudflare.Worker("McpWorker", {
  main: new URL("./worker.ts", import.meta.url).href,
  compatibility: { date: "2026-08-31" },
  workersDev: false,
  observability: WORKER_OBSERVABILITY,
  env: {
    // The deployed version, which the engine names itself by in `clientInfo` (The MCP core #394, smaller decisions).
    CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
  },
});
