// What the `mcp` extension tells the Session of MCP Apps (`docs/architecture/mcp-apps.md` → Declaring and reading Apps,
// App records): the App tools of the inventory, and the draft of an App record for each completed call of an App tool.
// The extension writes nothing itself: the Session hands it a recorder (`McpToolOptions.apps`), which redacts, bounds and
// keeps what it is given in the Session's storage, outside History.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off -- builders over plain values; the recorder is handed to pi-durable's Promise seam.
import { isJsonObject, type JsonObject } from "@cloudpid/mcp/types";
import type { McpAppDraft, McpAppHtmlAnswer, McpAppTool } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import type * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import type { McpHostClientService } from "./client.ts";
import { type McpCallOrigin, contextOf } from "./exchange.ts";
import type { McpTasksOptions } from "./task-port.ts";
import type { McpTaskRecord } from "./task-state.ts";

/**
 * The host feature that lists App HTML (`MCP_HOST_FEATURES`): a `tools/call` of an App tool answers `app.htmlHash`, and
 * `request({ op: "ui/html" })` is served. It is optional for the tools (an older host has none of it, and every tool is
 * built as before), and the Session reads `app` off a `Completed` and sends `ui/html` only when it is listed.
 */
export const MCP_APP_FEATURE = "app_html";

/** Where a Session keeps what its MCP tools say of Apps: the records of its App calls, and the inventory's App tools. */
export type McpAppRecorder = {
  /**
   * Keep the record of a completed call of an App tool (`draft`), which redacts it of the Secrets held and bounds it
   * (`boundAppRecord`). Never fails: a record that could not be kept is logged, and the call goes on without.
   */
  readonly put: (draft: McpAppDraft) => Effect.Effect<void>;
  /** The App tools of the inventory the tools were last built from, whole; the recorder tells the clients when they change. */
  readonly setTools: (tools: ReadonlyArray<McpAppTool>) => void;
};

/** What a completed call of an App tool is recorded from. */
export type McpAppCall = {
  readonly callId: string;
  readonly conversation: string;
  readonly parentCall: string | undefined;
  readonly server: string;
  readonly tool: string;
  readonly arguments: JsonObject;
  /** `Completed.app.htmlHash`, read only when the host lists `app_html`. */
  readonly htmlHash: string | undefined;
  /** `Completed.app.viewHash`: what names the origin of the server's Views, as the call found it. */
  readonly viewHash: string | undefined;
};

/** The draft of the record of `call`, whose `value` is the server's `CallToolResult`; none for a value that is no object. */
export const draftOf = (call: McpAppCall, value: Schema.Json): McpAppDraft | undefined => {
  if (!isJsonObject(value)) return undefined;

  const draft: Mutable<McpAppDraft> = {
    callId: call.callId,
    server: call.server,
    tool: call.tool,
    conversation: call.conversation,
    arguments: call.arguments,
    result: value,
  };

  if (call.parentCall !== undefined) draft.parentCall = call.parentCall;

  if (call.htmlHash !== undefined) draft.htmlHash = call.htmlHash;

  if (call.viewHash !== undefined) draft.viewHash = call.viewHash;

  return draft;
};

/**
 * What `mcp_app_html` asks the host for, of the call `callId` of `server`: the page kept under `hash`, or, with `uri`, the
 * `ui://` resource read now (for a record that pins no page, or one the host evicted).
 */
export type McpAppHtmlInput = {
  readonly server: string;
  readonly callId: string;
  readonly conversation: string;
} & ({ readonly hash: string } | { readonly uri: string });

/**
 * The page under `input.hash`, or read from `input.uri`, through the host's `request({ op: "ui/html" })` (`docs/architecture/mcp-apps.md` → Declaring
 * and reading Apps): asked only when the host lists `app_html` (`listed`), so an older host is never sent it; its
 * `HostUnsupported` is the backstop for one that lists it and answers otherwise. The request is the App's own
 * (`origin: "app"`), which reads nothing remote.
 */
export const appHtmlOf = (
  client: McpHostClientService,
  listed: boolean,
  origin: McpCallOrigin,
  input: McpAppHtmlInput,
): Effect.Effect<McpAppHtmlAnswer> => {
  if (!listed) {
    return Effect.succeed({
      status: "unsupported",
      message: "The MCP host does not serve App pages yet",
    });
  }

  const ctx = {
    ...contextOf(origin, { callId: input.callId, conversation: input.conversation }),
    origin: "app" as const,
  };

  return client
    .request(
      {
        op: "ui/html",
        server: input.server,
        params: "hash" in input ? { hash: input.hash } : { uri: input.uri },
        ctx,
      },
      {},
    )
    .pipe(
      Effect.map((answer) =>
        Match.value(answer).pipe(
          Match.tag("AppHtml", (page): McpAppHtmlAnswer => {
            const answer = {
              status: "html" as const,
              hash: page.hash,
              html: page.html,
              meta: page.meta,
            };

            return page.viewHash === undefined ? answer : { ...answer, view: page.viewHash };
          }),
          Match.tag("NoAppHtml", (none): McpAppHtmlAnswer => ({
            status: "missing",
            message: none.message,
          })),
          Match.tag("HostUnsupported", (none): McpAppHtmlAnswer => ({
            status: "unsupported",
            message: none.message,
          })),
          Match.tag("CallFailed", (failed): McpAppHtmlAnswer => ({
            status: "failed",
            message: failed.error.message,
          })),
          Match.tag("UnknownServer", "NotAllowed", (refused): McpAppHtmlAnswer => ({
            status: "failed",
            message: refused.message,
          })),
          Match.orElse((): McpAppHtmlAnswer => ({
            status: "failed",
            message: "The MCP host could not serve the App page",
          })),
        ),
      ),
    );
};

/**
 * What records the App call of an MCP task when the task completes (`McpTaskRecord.app`): its whole result goes to the
 * recorder, so the View of the original call gets it whenever it arrives. None for a task of another tool, or on a Session
 * that keeps no App records.
 */
export const appRecorderOf = (
  tasks: McpTasksOptions,
  record: McpTaskRecord,
): ((value: Schema.Json) => Promise<void>) | undefined => {
  const apps = tasks.apps;

  if (apps === undefined || record.app === undefined) return undefined;

  const app = record.app;

  return async (value) => {
    const draft = draftOf(
      {
        callId: record.callId,
        conversation: String(record.conversation),
        parentCall: app.parentCall,
        server: record.server,
        tool: record.tool,
        arguments: app.arguments,
        htmlHash: undefined,
        viewHash: undefined,
      },
      value,
    );

    if (draft === undefined) return;

    await Effect.runPromise(apps.put(draft)).catch(() => undefined);
  };
};
