import { Files, WorkspaceFiles } from "@cloudpid/extensions/files";
import { Web, WebConfig, WebNetworkLive } from "@cloudpid/extensions/web";
import type { Extension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import * as Effect from "effect/Effect";

/**
 * The extensions every Session's conversations run with: pi-durable's `read`, `write`, `edit`, and `bash`, and `ls`,
 * `find`, and `grep`, which work on the Session's Workspace (`./workspace.ts`) through the environment the Harness
 * builds for each call and the `WorkspaceFiles` they need; and `web_search` and `web_fetch`. Needs `WebConfig`: the
 * search keys, which the Session DO reads with `Config.Redacted` so the stack binds them as secrets.
 */
export const sessionExtensions: Effect.Effect<
  readonly Extension[],
  never,
  WorkspaceFiles | WebConfig
> = Effect.all([Effect.succeed(CodingTools), Files, Web]).pipe(
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(WebNetworkLive),
);
