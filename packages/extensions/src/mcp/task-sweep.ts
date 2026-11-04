// @effect-diagnostics missingPipeableSignature:off asyncFunction:off globalDate:off -- plain Promise code over pi-durable's commits.
// The sweep at every wake (`docs/architecture/mcp-server-requests.md` → MCP tasks, The record): an inline task whose call is
// no longer live has no one to follow it (the call was ended without running its own end: the Session was stopped or
// replaced while the object was away), so it is cancelled at the server and its record ended, by Stop. A task that went
// to the background has its follower, and one whose record is already ended needs nothing.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import type { McpHostClientService } from "./client.ts";
import type { McpCallOrigin } from "./exchange.ts";
import { endedRecord, endInDoc } from "./task-end.ts";
import { sendCancel, taskSpan } from "./task-host.ts";
import { liveTasks, McpTasksDoc, type McpTaskEnd } from "./task-state.ts";

const context = BACKGROUND_CONTEXT;

/** What the sweep works with. */
export type TaskSweep = {
  readonly harness: Pick<Harness, "snapshot" | "inspect" | "commit">;
  readonly client: McpHostClientService;
  readonly origin: McpCallOrigin;
};

/**
 * End the live inline records whose call is gone, cancelling each at its server (once, best effort: a cancel that fails
 * leaves the end all the same, since nothing else would ever follow the task). Says how many it ended.
 */
export const sweepTasks = async (sweep: TaskSweep): Promise<number> => {
  const { harness, client, origin } = sweep;
  const state = await harness.snapshot(McpTasksDoc, context);

  if (state === undefined) return 0;

  const orphans = Arr.filter(
    liveTasks(state),
    (record) => !record.background && record.end === undefined,
  );

  if (orphans.length === 0) return 0;

  const live = new Set<string>(
    Arr.map((await harness.inspect(context)).tasks, (task) => String(task.record.id)),
  );

  let ended = 0;

  for (const record of orphans) {
    if (live.has(String(record.callTask))) continue;

    const end: McpTaskEnd = { status: "cancelled", by: "stop", at: Date.now() };

    try {
      await sendCancel(client, record, origin);
    } catch {
      // The end stands without the cancel; the server's TTL ends the task it keeps.
    }

    const closed = endedRecord(record, end, {});
    let wrote = false;

    await harness.commit(async (tx) => {
      wrote =
        endInDoc(await tx.doc(McpTasksDoc), record.handle, end, { delivery: "none" }) !== undefined;
    }, context);

    if (!wrote) continue;

    ended += 1;
    await taskSpan(closed);
  }

  return ended;
};
