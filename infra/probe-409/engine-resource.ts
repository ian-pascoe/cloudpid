// Throwaway probe for #409. The stand-in `McpWorker`, declared apart from its entry module (a plain Worker), as
// `apps/server/src/workspace/resource.ts` declares `Workspaces`.

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const Engine = Effect.gen(function* () {
  return yield* Cloudflare.Worker("ProbeEngine", {
    main: new URL("./engine.ts", import.meta.url).href,
    compatibility: { date: "2026-08-31", flags: ["nodejs_compat"] },
    workersDev: true,
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true },
      traces: { enabled: true },
    },
    env: {
      // Changing it redeploys only this Worker (the deploy-cut check).
      VERSION: yield* Config.String("ENGINE_VERSION").pipe(Config.withDefault("e1")),
      PROBE_KEY: yield* Config.String("PROBE_KEY"),
      SELF_URL: yield* Config.String("ENGINE_SELF_URL").pipe(Config.withDefault("")),
      RECORDER: Cloudflare.DurableObject("Recorder"),
    },
  });
});
