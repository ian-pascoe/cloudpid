import { Server, Workspaces } from "@cloudpid/server";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "cloudpid",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const server = yield* Server;

    yield* Workspaces;

    return { url: server.url.as<string>() };
  }),
);
