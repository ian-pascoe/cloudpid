// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off -- plain values over the object's key-value storage.
// What outlives an App View's MCP task request, for the sweep (`docs/architecture/mcp-server-requests.md` → MCP tasks, The
// record): a small entry in the Session's own storage while the request is in flight, so a task whose View's request was
// lost (the Session's object restarted or was replaced) is cancelled at its server by the next wake's sweep, which ends
// the entry. A View's task is followed in memory (`./task-view.ts`) and is never in the `cloudpid.mcp-tasks` document, so
// never in `mcp_tasks`, the agent's tools or the Registry's count; its own caps are counted here.
import type { McpHostRequestContext } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import type { Mutable } from "effect/Types";
import type { McpHostClientService } from "./client.ts";
import { cancelViewTask } from "./task-view.ts";
import type { McpTaskStorage } from "./task-results.ts";
import { MCP_TASKS_PER_SERVER, MCP_TASKS_PER_SESSION } from "./task-state.ts";

const INDEX_KEY = "mcp-task:app";

/** What the sweep needs to cancel a View's task. The `taskId` is the server's bearer token: never shown, logged or spanned. */
export type ViewTaskEntry = {
  readonly id: string;
  readonly server: string;
  readonly tool: string;
  readonly taskId: string;
  readonly conn: string;
  readonly callId: string;
  readonly conversation: string;
  readonly workspace?: string | undefined;
};

export type ViewTaskStore = {
  /** A View's task started: kept until `end`, and live in this instance. */
  readonly begin: (entry: ViewTaskEntry) => void;
  /** The task's request is over, however it ended. */
  readonly end: (id: string) => void;
  /** Whether a View's task may be offered to a call to `server`: the Session and the server are under their caps. */
  readonly offers: (server: string) => boolean;
  /** The entries no request of this instance follows: their requests went with an earlier instance. */
  readonly orphans: () => ReadonlyArray<ViewTaskEntry>;
};

export const viewTaskStore = (storage: McpTaskStorage): ViewTaskStore => {
  const live = new Set<string>();

  const index = (): ReadonlyArray<ViewTaskEntry> =>
    storage.get<ReadonlyArray<ViewTaskEntry>>(INDEX_KEY) ?? [];

  return {
    begin: (entry) => {
      live.add(entry.id);
      storage.put(INDEX_KEY, [...Arr.filter(index(), (each) => each.id !== entry.id), entry]);
    },
    end: (id) => {
      live.delete(id);

      const kept = Arr.filter(index(), (each) => each.id !== id);

      if (kept.length === 0) storage.delete(INDEX_KEY);
      else storage.put(INDEX_KEY, kept);
    },
    offers: (server) => {
      const held = index();

      return (
        held.length < MCP_TASKS_PER_SESSION &&
        Arr.filter(held, (each) => each.server === server).length < MCP_TASKS_PER_SERVER
      );
    },
    orphans: () => Arr.filter(index(), (each) => !live.has(each.id)),
  };
};

/** The context of `entry`'s `tasks/cancel`: an `app` request of the call's conversation. */
const ctxOf = (entry: ViewTaskEntry, session: string | undefined): McpHostRequestContext => {
  const ctx: Mutable<McpHostRequestContext> = {
    origin: "app",
    callId: entry.callId,
    conversation: entry.conversation,
  };

  if (session !== undefined) ctx.session = session;

  if (entry.workspace !== undefined) ctx.workspace = entry.workspace;

  return ctx;
};

/**
 * Cancel the View's tasks no request follows (once, best effort: a cancel that fails leaves the end all the same, since
 * nothing else would ever follow the task) and end their entries. Says how many it ended.
 */
export const sweepViewTasks = async (
  store: ViewTaskStore,
  client: McpHostClientService,
  session: string | undefined,
): Promise<number> => {
  const gone = store.orphans();

  await Promise.all(
    Arr.map(gone, (entry) =>
      cancelViewTask(
        client,
        { server: entry.server, taskId: entry.taskId, tool: entry.tool, conn: entry.conn },
        ctxOf(entry, session),
      ),
    ),
  );

  for (const entry of gone) store.end(entry.id);

  return gone.length;
};
