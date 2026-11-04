// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- plain Promise code over pi-durable's commits.
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
import { cancelDue, sendCancelWithin, taskSpan } from "./task-host.ts";
import { liveTasks, McpTasksDoc, type McpTaskEnd } from "./task-state.ts";

const context = BACKGROUND_CONTEXT;

/** What the sweep reads and writes of the Session's Harness. */
export type SweepHarness = Pick<Harness, "snapshot" | "inspect" | "commit">;

/** What the sweep works with. */
export type TaskSweep = {
  readonly harness: SweepHarness;
  readonly client: McpHostClientService;
  readonly origin: McpCallOrigin;
  /** The time now, from the runtime's clock. */
  readonly now: () => number;
};

/**
 * End the live inline records whose call is gone, cancelling each at its server (once, best effort: a cancel that fails
 * leaves the end all the same, since nothing else would ever follow the task). Says how many it ended.
 */
export const sweepTasks = async (sweep: TaskSweep): Promise<number> => {
  const { harness, client, origin, now } = sweep;
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
    // A record from before the call's task was kept cannot be told from one whose call is live.
    if (record.callTask === undefined || live.has(String(record.callTask))) continue;

    const end: McpTaskEnd = { status: "cancelled", by: "stop", at: now() };

    // Once (a Stop that ended the call may have sent it), and not for longer than the bound: the end stands without the
    // cancel, and the server's TTL ends the task.
    if (cancelDue(client, record, end.at)) await sendCancelWithin(client, record, origin);

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
