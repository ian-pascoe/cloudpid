import { WORKER_OBSERVABILITY } from "@cloudpid/telemetry/observability";
import { APP_DOMAIN } from "@cloudpid/server/view-host";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

/**
 * The `ianpascoe.app` zone's id (the same zone `infra/github.ts` gives the deploy token), so the stack looks nothing
 * up. A zone id is not a secret.
 */
const APP_ZONE_ID = "e4bbd85e38d5fc25694c911588c2ccc4";

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
