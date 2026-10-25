import type { Harness } from "@cloudpid/effect-durable";
import { AgentsMd } from "@cloudpid/extensions/agents-md";
import {
  Browser,
  type BrowserHost,
  type BrowserSession,
  type BrowserHandoffs,
} from "@cloudpid/extensions/browser";
import { CodingTools } from "@cloudpid/extensions/coding-tools";
import { ContainerTools, WorkspaceContainer } from "@cloudpid/extensions/container";
import { ContextManagement } from "@cloudpid/extensions/context";
import { Files, WorkspaceFiles } from "@cloudpid/extensions/files";
import { type Images, ResultImages } from "@cloudpid/extensions/images";
import { type Secrets, secretsExtension } from "@cloudpid/extensions/secrets";
import { Skills } from "@cloudpid/extensions/skills";
import { Subagents, SubagentSettings } from "@cloudpid/extensions/subagents";
import { Todo } from "@cloudpid/extensions/todo";
import { ToolSearch, ToolSearchSettings } from "@cloudpid/extensions/tool-search";
import { Web, WebConfig, WebNetworkLive } from "@cloudpid/extensions/web";
import type { Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { Codemode, CodemodeSandbox } from "./codemode.ts";

/**
 * The extensions every Session's conversations run with: pi-durable's `read` (whose images the Session's `Images`
 * binding holds to the conversation's bound), `write`, and `edit`, and a `bash` that can run on the Worker Shell or the
 * Container, and `ls`, `find`, and `grep`, which work on the Session's Workspace (`./workspace.ts`) through the environment the Harness
 * builds for each call and the `WorkspaceFiles` they need; `container_restart`, which stops the Workspace's Container through
 * `WorkspaceContainer` when it no longer answers, and `container_resize`, which restarts it at another size; `web_search` and `web_fetch`; `codemode`, whose scripts call
 * the tools above and run in the `CodemodeSandbox` (`./codemode.ts`); the subagent tools, which read their roles,
 * depth cap, and toolsets from `SubagentSettings`; and the context tools (`context_notes`, `context_history`,
 * `context_rollover`), whose compaction hook asks the agent for a Handoff through the Session's `Harness`; the `todo` tool,
 * whose list is a conversation document that a hook puts back in front of the model after a Handoff or compaction; and the secret tools
 * (`secret_ask`, `secret_list`, `secret_forget`), whose wraps let the coding and file tools and `web_fetch` use the
 * Session's `Secrets` (never `web_search`: a Secret does not belong in a search query); the `skills` section, which lists
 * the skills in the conversation's `.agents/skills` directories (`@cloudpid/extensions/skills`); the `project_context`
 * section and the wraps of `read`, `edit` and `write` that put the Workspace's `AGENTS.md` files in front of the model
 * (`@cloudpid/extensions/agents-md`); and `browser`, which drives the
 * Session's one browser over CDP with a tab per conversation (`./browser.ts`) and is not one of them: its code is stored with
 * the run, so Secret references stay references there, while its results are redacted; and `browser_handoff`, which gives the owner the
 * browser in a Live View for a step the agent cannot do (`BrowserHandoffs`, with the `OwnerNotifications` it pushes through); and
 * `tool_search`, last: it defers every tool above that the settings' offered set (`ToolSearchSettings`) does not name, so
 * the model is offered only the core tools and loads the rest by searching, while scripts call all of them
 * (`docs/spec.md` → Tool discovery). Needs `WebConfig`: the search keys, which the Session DO reads with
 * `Config.Redacted` so the stack binds them as secrets.
 */
export const sessionExtensions: Effect.Effect<
  readonly Extension[],
  never,
  | WorkspaceFiles
  | WorkspaceContainer
  | Images
  | WebConfig
  | CodemodeSandbox
  | SubagentSettings
  | ToolSearchSettings
  | Harness
  | Secrets
  | BrowserHost
  | BrowserSession
  | BrowserHandoffs
> = Effect.all([
  CodingTools,
  Files,
  Web,
  Codemode,
  Subagents,
  ContextManagement,
  Todo,
  Browser,
  Skills,
  // Before the secrets extension, whose wraps then run first: a path's Secret references are resolved when it looks.
  AgentsMd,
  ContainerTools,
  // Every tool result's images held to one result's budget before it is stored.
  Effect.succeed(ResultImages),
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
  // After every other extension, so each of their tools is named: those the settings do not offer are deferred.
  Effect.flatMap((extensions) =>
    Effect.map(
      ToolSearch(
        Arr.map(
          Arr.flatMap(
            extensions,
            (extension): ReadonlyArray<{ readonly name: string }> => extension.tools ?? [],
          ),
          (tool) => tool.name,
        ),
      ),
      (toolSearch) => [...extensions, toolSearch],
    ),
  ),
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(WebNetworkLive),
);
