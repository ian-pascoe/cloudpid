import { CodingTools } from "@cloudpid/extensions/coding-tools";
import { Files, WorkspaceFiles } from "@cloudpid/extensions/files";
import { Web, WebConfig, WebNetworkLive } from "@cloudpid/extensions/web";
import type { Extension } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import { Codemode, CodemodeSandbox } from "./codemode.ts";

/**
 * The extensions every Session's conversations run with: pi-durable's `read`, `write`, and `edit`, and a `bash` that can run on the Worker Shell or the Container, and `ls`,
 * `find`, and `grep`, which work on the Session's Workspace (`./workspace.ts`) through the environment the Harness
 * builds for each call and the `WorkspaceFiles` they need; `web_search` and `web_fetch`; and `codemode`, whose scripts call
 * the tools above and run in the `CodemodeSandbox` (`./codemode.ts`). Needs `WebConfig`: the search keys, which the Session
 * DO reads with `Config.Redacted` so the stack binds them as secrets.
 */
export const sessionExtensions: Effect.Effect<
  readonly Extension[],
  never,
  WorkspaceFiles | WebConfig | CodemodeSandbox
> = Effect.all([Effect.succeed(CodingTools), Files, Web, Codemode]).pipe(
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(WebNetworkLive),
);
