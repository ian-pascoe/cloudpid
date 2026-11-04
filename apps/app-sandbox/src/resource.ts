// docs/architecture/mcp-apps.md → The App sandbox (Domain and Worker; Who deploys it). The stack's declaration of the
// App sandbox: its Worker, route and wildcard record, which only `prod` yields (`infra/alchemy.run.ts`).
import { WORKER_OBSERVABILITY } from "@cloudpid/telemetry/observability";
import {
  APP_DOMAIN,
  APP_ZONE_ID,
  LOCAL_SANDBOX_PORT,
  SANDBOX_LOCAL_VAR,
} from "@cloudpid/server/view-host";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

/**
 * The App sandbox: a public Worker on the route `*.ianpascoe.app/*` and the proxied wildcard record
 * `*.ianpascoe.app AAAA 100::` that sends the zone's traffic to it (no origin exists), which only the `prod` stage
 * deploys: every other stage frames prod's (`infra/alchemy.run.ts`, docs/architecture/mcp-apps.md → The App sandbox).
 * It has no `workers.dev` URL, no Access and no binding or secret. The Worker is declared plain, as the other
 * Workers that export nothing of alchemy's: its entry holds no alchemy code.
 *
 * The record is created only after the Worker, so no request reaches a route with no script behind it. The deploy
 * token holds Zone Read, DNS Write and Workers Routes Write on the zone (docs/development/infra.md → CI credentials).
 */
export const AppSandbox = Effect.gen(function* () {
  const worker = yield* Cloudflare.Worker("AppSandbox", {
    main: new URL("./worker.ts", import.meta.url).href,
    compatibility: { date: "2026-08-31" },
    workersDev: false,
    observability: WORKER_OBSERVABILITY,
    routes: [{ pattern: `*.${APP_DOMAIN}/*`, zoneId: APP_ZONE_ID }],
  });

  yield* Cloudflare.DNS.Record("AppSandboxWildcard", {
    zoneId: APP_ZONE_ID,
    name: `*.${APP_DOMAIN}`,
    type: "AAAA",
    content: "100::",
    proxied: true,
    comment: "App sandbox (ADR-0031): the Worker route serves every host; no origin exists.",
  });

  return worker;
});

/**
 * The App sandbox under `alchemy dev` (docs/architecture/mcp-apps.md → The App sandbox, Who deploys it): the same Worker
 * in workerd on a second local port, {@link LOCAL_SANDBOX_PORT} beside the main Worker's 1337, one shared origin for every
 * View. It has no route and no record, and the var that puts it in local mode (`SANDBOX_LOCAL_VAR`); `strictPort` keeps it
 * on the port the main Worker's View URLs name (`LOCAL_SANDBOX_ORIGIN`) rather than the next free one. The stack declares it
 * under `alchemy dev` and never on a deployed stage (`infra/alchemy.run.ts`).
 */
export const LocalAppSandbox = Cloudflare.Worker("LocalAppSandbox", {
  main: new URL("./worker.ts", import.meta.url).href,
  compatibility: { date: "2026-08-31" },
  workersDev: false,
  observability: WORKER_OBSERVABILITY,
  env: { [SANDBOX_LOCAL_VAR]: "true" },
  dev: { port: LOCAL_SANDBOX_PORT, strictPort: true },
});
