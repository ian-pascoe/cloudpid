// Throwaway stack for the Live View spike (#152): one workers.dev Worker with a Durable Object that holds a Browser
// Run session and a browser-level CDP connection, and serves the harness and the test page. Deploy and destroy from
// this directory (see README.md). Every route but the test pages needs `?t=<SPIKE_TOKEN>`.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const Spike = Cloudflare.Worker("LiveViewSpike", {
  main: new URL("./worker.ts", import.meta.url).href,
  compatibility: { date: "2026-08-31" },
  workersDev: true,
  env: {
    SPIKE: Cloudflare.DurableObject("Spike"),
    BROWSER: Cloudflare.Browser(),
    SPIKE_TOKEN: Config.Redacted("SPIKE_TOKEN"),
  },
});

export default Alchemy.Stack(
  "cloudpid-live-view-spike",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* Spike;

    return { url: worker.url.as<string>() };
  }),
);
