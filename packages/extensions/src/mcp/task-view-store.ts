// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain values over the object's key-value storage.
// What outlives an App View's MCP task request, for the sweep (`docs/architecture/mcp-server-requests.md` → MCP tasks, The
// record): a small entry in the Session's own storage while the request is in flight, so a task whose View's request was
// lost (the Session's object restarted or was replaced) is cancelled at its server by the next wake's sweep, which ends
// the entry. A View's task is followed in memory (`./task-view.ts`) and is never in the `cloudpid.mcp-tasks` document, so
// never in `mcp_tasks`, the agent's tools or the Registry's count; its own caps are counted here.
import type { McpHostRequestContext } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { Mutable } from "effect/Types";
import type { McpHostClientService } from "./client.ts";
import { cancelViewTask } from "./task-view.ts";
import type { McpTaskStorage } from "./task-results.ts";
import { atCapOf } from "./task-state.ts";

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

/** A place among the caps, held from the offer of an MCP task to a View's call until its task ends or none comes. */
export type ViewTaskPlace = {
  /** The server answered with a task: the place becomes `entry`, kept until `release`, and live in this instance. */
  readonly begin: (entry: ViewTaskEntry) => void;
  /** The request is over, however it ended (no task came, or it ended): the place is given back. Safe to repeat. */
  readonly release: () => void;
};

export type ViewTaskStore = {
  /**
   * A place for a task of `server`, taken when the call is offered one: the caps are one set with the agent's tasks
   * (`others`, their servers), so it is refused at 16 in the Session or 8 of the server, counting the places held and the
   * entries kept. Taken before the call goes out, so two calls cannot both take the last one.
   */
  readonly offer: (server: string, others: ReadonlyArray<string>) => ViewTaskPlace | undefined;
  /** The server of each place held and each entry kept: what the agent's tasks count beside (`atCap`). */
  readonly held: () => ReadonlyArray<string>;
  /** The task's request is over, however it ended. */
  readonly end: (id: string) => void;
  /** The entries no request of this instance follows: their requests went with an earlier instance. */
  readonly orphans: () => ReadonlyArray<ViewTaskEntry>;
};

export const viewTaskStore = (storage: McpTaskStorage): ViewTaskStore => {
  const live = new Set<string>();

  /** The places offered whose call has not answered yet, by server. */
  const offered = new Set<{ readonly server: string }>();

  const index = (): ReadonlyArray<ViewTaskEntry> =>
    storage.get<ReadonlyArray<ViewTaskEntry>>(INDEX_KEY) ?? [];

  const end = (id: string) => {
    live.delete(id);

    const kept = Arr.filter(index(), (each) => each.id !== id);

    if (kept.length === 0) storage.delete(INDEX_KEY);
    else storage.put(INDEX_KEY, kept);
  };

  const held = (): ReadonlyArray<string> => [
    ...Arr.map([...offered], (place) => place.server),
    ...Arr.map(index(), (entry) => entry.server),
  ];

  return {
    offer: (server, others) => {
      if (atCapOf([...held(), ...others], server)) return undefined;

      const place = { server };
      let entryId: string | undefined;

      offered.add(place);

      return {
        begin: (entry) => {
          offered.delete(place);
          entryId = entry.id;
          live.add(entry.id);
          storage.put(INDEX_KEY, [...Arr.filter(index(), (each) => each.id !== entry.id), entry]);
        },
        release: () => {
          offered.delete(place);

          if (entryId !== undefined) end(entryId);

          entryId = undefined;
        },
      };
    },
    held,
    end,
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
export const sweepViewTasks = (
  store: ViewTaskStore,
  client: McpHostClientService,
  session: string | undefined,
): Effect.Effect<number> =>
  Effect.gen(function* () {
    const gone = store.orphans();

    yield* Effect.forEach(
      gone,
      (entry) =>
        cancelViewTask(
          client,
          { server: entry.server, taskId: entry.taskId, tool: entry.tool, conn: entry.conn },
          ctxOf(entry, session),
        ),
      { concurrency: "unbounded", discard: true },
    );

    for (const entry of gone) store.end(entry.id);

    return gone.length;
  });
