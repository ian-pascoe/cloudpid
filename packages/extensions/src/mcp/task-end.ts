// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over a record and its document.
// How an MCP task's end is written (`docs/architecture/mcp-server-requests.md` → MCP tasks): the inline window, the follower
// and its abort all end a record the same way, in one commit that applies the poll's decision, notes the pooled result, says
// how the result is delivered and marks the end. The record as it stands after it, for the span and the result, is made
// by the same rule, so what is emitted is what is stored.
import { applyDecision, type Decision } from "./task-poll.ts";
import {
  endTask,
  type McpTaskDelivery,
  type McpTaskEnd,
  type McpTaskRecord,
  type McpTaskResultNote,
  type McpTasksState,
} from "./task-state.ts";

/** What the commit that ends a record writes besides the end itself. */
export type EndChange = {
  /** The poll's decision, applied first: its patch (the polls it counted) and failures. */
  readonly decision?: Decision | undefined;
  /** The pooled result's note. */
  readonly note?: McpTaskResultNote | undefined;
  /** How the result reaches the agent. */
  readonly delivery: McpTaskDelivery;
};

/** The record as it stands once `end` is applied to a copy of `record`, with the same change the commit makes. */
export const endedRecord = (
  record: McpTaskRecord,
  end: McpTaskEnd,
  change: Pick<EndChange, "decision">,
): McpTaskRecord => {
  const ended = structuredClone(record);

  if (change.decision !== undefined) applyDecision(ended, change.decision);

  ended.end = end;
  ended.status = end.status;

  return ended;
};

/** End `handle` in `doc`, in the commit that stores it. A record already ended, or gone, is left as it is. */
export const endInDoc = (
  doc: McpTasksState,
  handle: string,
  end: McpTaskEnd,
  change: EndChange,
): McpTaskRecord | undefined => {
  const current = doc.tasks[handle];

  if (current === undefined || current.end !== undefined) return undefined;

  if (change.decision !== undefined) applyDecision(current, change.decision);

  if (change.note !== undefined) current.result = change.note;

  current.delivery = change.delivery;

  // A wait that claims the result at the end is the agent being told.
  if (change.delivery === "wait") current.toldAt = end.at;

  return endTask(doc, handle, end);
};

/** Mark the cancel of `record` as delivered or not, in the commit that follows its send. */
export const markCancelSent = (record: McpTaskRecord | undefined, took: boolean): void => {
  if (record?.cancel !== undefined) record.cancel.sent = took ? "sent" : "failed";
};
