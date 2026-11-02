// Throwaway probe for #409 (Verify MCP host ↔ engine RPC on a deployed stage). Not part of cloudpid; never merged.
//
// `bun alchemy deploy --config probe-409/stack.ts --stage probe` from `infra/`, with `PROBE_KEY` set (any random
// string; the probe's routes answer only with it). State is local. `ENGINE_VERSION` or `SERVER_VERSION` changes only
// that Worker, for the deploy checks. Destroy with `alchemy destroy` and the same flags.
//
// - ProbeEngine: the stand-in `McpWorker`, a plain Worker exporting `McpEngine` (and its own `Recorder` DO).
// - ProbeServer: the stand-in `Server`, an Effect Worker with the `Session` and `Host` Effect DOs, binding `McpEngine`
//   one way. It deploys after ProbeEngine, as `Server` deploys after `McpWorker`.

import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { Engine } from "./engine-resource.ts";
import ProbeServer from "./server.ts";

export default Alchemy.Stack(
  "cloudpid-mcp-rpc-probe",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const engine = yield* Engine;
    const server = yield* ProbeServer;
    return { engine: engine.url, server: server.url };
  }),
);
