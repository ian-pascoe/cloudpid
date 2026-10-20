import type { Harness } from "@cloudpid/effect-durable";
import { CodingTools } from "@cloudpid/extensions/coding-tools";
import { ContextManagement } from "@cloudpid/extensions/context";
import { Files, WorkspaceFiles } from "@cloudpid/extensions/files";
import { type Secrets, secretsExtension } from "@cloudpid/extensions/secrets";
import { Subagents, SubagentSettings } from "@cloudpid/extensions/subagents";
import { Web, WebConfig, WebNetworkLive } from "@cloudpid/extensions/web";
import type { Extension } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import { Codemode, CodemodeSandbox } from "./codemode.ts";

/**
 * The extensions every Session's conversations run with: pi-durable's `read`, `write`, and `edit`, and a `bash` that can run on the Worker Shell or the Container, and `ls`,
 * `find`, and `grep`, which work on the Session's Workspace (`./workspace.ts`) through the environment the Harness
 * builds for each call and the `WorkspaceFiles` they need; `web_search` and `web_fetch`; `codemode`, whose scripts call
 * the tools above and run in the `CodemodeSandbox` (`./codemode.ts`); the subagent tools, which read their roles,
 * depth cap, and toolsets from `SubagentSettings`; and the context tools (`context_notes`, `context_history`,
 * `context_rollover`), whose compaction hook asks the agent for a Handoff through the Session's `Harness`; and the secret tools
 * (`secret_ask`, `secret_list`, `secret_forget`), whose wraps let the coding, file, and web tools use the Session's
 * `Secrets`. Needs `WebConfig`: the search keys, which the Session DO reads with
 * `Config.Redacted` so the stack binds them as secrets.
 */
export const sessionExtensions: Effect.Effect<
  readonly Extension[],
  never,
  WorkspaceFiles | WebConfig | CodemodeSandbox | SubagentSettings | Harness | Secrets
> = Effect.all([
  Effect.succeed(CodingTools),
  Files,
  Web,
  Codemode,
  Subagents,
  ContextManagement,
]).pipe(
  // Last, so its hooks see every other extension's results; only these tools' arguments resolve Secrets.
  Effect.flatMap((extensions) => {
    const [coding, files, web] = extensions;

    return Effect.map(secretsExtension([coding, files, web]), (secrets) => [
      ...extensions,
      secrets,
    ]);
  }),
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(WebNetworkLive),
);
