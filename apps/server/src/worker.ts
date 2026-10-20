import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { hello } from "./hello.ts";

/** The main Worker. This file is its own entry, so it is bundled as written. */
export default class Server extends Cloudflare.Worker<Server>()(
  "Server",
  { main: import.meta.url, compatibility: { date: "2026-08-31" } },
  Effect.succeed({ fetch: Effect.succeed(hello) }),
) {}
