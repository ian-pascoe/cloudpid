// The Session's side of its MCP tasks (`docs/architecture/mcp-server-requests.md` → MCP tasks): what the `mcp` extension
// follows them with. The record and the follower live in the Harness, the results in this object's key-value storage;
// this file only gives the extension that storage and the one thing it cannot reach, the host's list of Runs whose end the
// owner is told of (`notify-submissions`): a follow-up Run a follower starts for an MCP task's end is one.
import type { McpTasksOptions, McpTasksTiming } from "@cloudpid/extensions/mcp";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { recordRunNotice, type SessionNoticeKv } from "./host.ts";

export type SessionMcpTasksOptions = {
  /** The object's synchronous key-value storage. */
  readonly storage: SessionNoticeKv & Pick<McpTasksOptions["storage"], "delete">;
  /** Shorter times, for a test; the spec's otherwise. */
  readonly timing?: McpTasksTiming | undefined;
};

/** What the Session gives its MCP tools to follow MCP tasks. */
export const sessionMcpTasks = (options: SessionMcpTasksOptions): McpTasksOptions => {
  const tasks: McpTasksOptions = {
    storage: options.storage,
    submitted: (id: SubmissionId) => {
      recordRunNotice(options.storage, id);
    },
  };

  return options.timing === undefined ? tasks : { ...tasks, timing: options.timing };
};
