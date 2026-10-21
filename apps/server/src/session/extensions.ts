import type { Harness } from "@cloudpid/effect-durable";
import {
  Browser,
  type BrowserHost,
  type BrowserSession,
  type BrowserHandoffs,
} from "@cloudpid/extensions/browser";
import { CodingTools } from "@cloudpid/extensions/coding-tools";
import { ContextManagement } from "@cloudpid/extensions/context";
import { Files, WorkspaceFiles } from "@cloudpid/extensions/files";
import { type Secrets, secretsExtension } from "@cloudpid/extensions/secrets";
import { Skills } from "@cloudpid/extensions/skills";
import { Subagents, SubagentSettings } from "@cloudpid/extensions/subagents";
import { Todo } from "@cloudpid/extensions/todo";
import { Web, WebConfig, WebNetworkLive } from "@cloudpid/extensions/web";
import type { Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { Codemode, CodemodeSandbox } from "./codemode.ts";

/**
 * The extensions every Session's conversations run with: pi-durable's `read`, `write`, and `edit`, and a `bash` that can run on the Worker Shell or the Container, and `ls`,
 * `find`, and `grep`, which work on the Session's Workspace (`./workspace.ts`) through the environment the Harness
 * builds for each call and the `WorkspaceFiles` they need; `web_search` and `web_fetch`; `codemode`, whose scripts call
 * the tools above and run in the `CodemodeSandbox` (`./codemode.ts`); the subagent tools, which read their roles,
 * depth cap, and toolsets from `SubagentSettings`; and the context tools (`context_notes`, `context_history`,
 * `context_rollover`), whose compaction hook asks the agent for a Handoff through the Session's `Harness`; the `todo` tool,
 * whose list is a conversation document that a hook puts back in front of the model after a Handoff or compaction; and the secret tools
 * (`secret_ask`, `secret_list`, `secret_forget`), whose wraps let the coding and file tools and `web_fetch` use the
 * Session's `Secrets` (never `web_search`: a Secret does not belong in a search query); the `skills` section, which lists
 * the skills in the conversation's `.agents/skills` directories (`@cloudpid/extensions/skills`); and `browser`, which drives the
 * Session's one browser over CDP with a tab per conversation (`./browser.ts`) and is not one of them: its code is stored with
 * the run, so Secret references stay references there, while its results are redacted; and `browser_handoff`, which gives the owner the
 * browser's Live View for a step the agent cannot do (`BrowserHandoffs`, with the `OwnerNotifications` it pushes through). Needs `WebConfig`: the search keys, which the Session DO reads with
 * `Config.Redacted` so the stack binds them as secrets.
 */
export const sessionExtensions: Effect.Effect<
  readonly Extension[],
  never,
  | WorkspaceFiles
  | WebConfig
  | CodemodeSandbox
  | SubagentSettings
  | Harness
  | Secrets
  | BrowserHost
  | BrowserSession
  | BrowserHandoffs
> = Effect.all([
  Effect.succeed(CodingTools),
  Files,
  Web,
  Codemode,
  Subagents,
  ContextManagement,
  Todo,
  Browser,
  Skills,
]).pipe(
  // Last, so its hooks see every other extension's results; only these tools' arguments resolve Secrets.
  Effect.flatMap((extensions) => {
    const [coding, files, web] = extensions;

    const resolving = [
      ...(coding.tools ?? []),
      ...(files.tools ?? []),
      ...Arr.filter(web.tools ?? [], (tool) => tool.name === "web_fetch"),
    ];

    return Effect.map(secretsExtension(resolving), (secrets) => [...extensions, secrets]);
  }),
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(WebNetworkLive),
);
