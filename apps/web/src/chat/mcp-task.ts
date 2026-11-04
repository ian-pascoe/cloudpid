// @effect-diagnostics missingPipeableSignature:off globalDate:off -- plain helpers over the Session's list; a time of day is shown in the reader's locale.
// What the owner is told of an MCP task (`docs/architecture/mcp-server-requests.md` → MCP tasks, The owner's UI): the words of
// the call card, the Session details row and the header chip, from the Session's `mcp_tasks` list. `status` and `by` are
// strings, so one a later build adds reads as itself. Nothing here is the server's: `statusMessage` and a reason are
// redacted and cut by the Session before they get here, and they are drawn as plain text.
import type { McpTask } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

/** The tasks that go on: not ended. */
export const liveTasks = (tasks: readonly McpTask[]): readonly McpTask[] =>
  Arr.filter(tasks, (task) => task.endedAt === undefined);

/** The tasks the Session follows in the background: live ones whose call has returned (an inline one is part of its call). */
export const followedTasks = (tasks: readonly McpTask[]): readonly McpTask[] =>
  Arr.filter(tasks, (task) => task.endedAt === undefined && task.background);

/** Whether `task` goes on. */
export const isLive = (task: McpTask): boolean => task.endedAt === undefined;

/** The task a call started, if the Session lists it. */
export const taskOfCall = (tasks: readonly McpTask[], callId: string): McpTask | undefined =>
  Option.getOrUndefined(Arr.findFirst(tasks, (task) => task.callId === callId));

/** "Following 1 MCP task", "Following 3 MCP tasks": the list's label and the header chip's. */
export const followingLabel = (count: number): string =>
  `Following ${count} MCP ${count === 1 ? "task" : "tasks"}`;

/** "0:42", "12:05", "1:02:03": how long a task has gone on. */
export const clock = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");

  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
};

/** The time of day a time is, in the reader's locale. */
const timeOfDay = (time: number): string =>
  new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** How a live task stands, in the owner's words. */
export const statusText = (task: McpTask): string => {
  if (task.waitingFor === "owner") return "Waiting for you";

  switch (task.status) {
    case "working":
      return "Working";
    case "input_required":
      return "Waiting for input";
    default:
      return task.status;
  }
};

/** Who cancelled a task that ended cancelled; the server, or no one the Session names, is no one in particular. */
const cancelledText = (by: string | undefined): string => {
  switch (by) {
    case "owner":
      return "Cancelled by you";
    case "agent":
      return "Cancelled by the agent";
    case "stop":
      return "Cancelled by Stop";
    default:
      return "Cancelled";
  }
};

/** How an ended task ended, in the owner's words: cancels have the grace and the race the spec names. */
export const endText = (task: McpTask): string => {
  const reason = task.end?.reason;

  switch (task.status) {
    case "completed":
      return task.cancel === undefined ? "Completed" : "Finished before the cancel took effect";
    case "failed":
      return reason === undefined ? "Failed" : `Failed: ${reason}`;
    case "cancelled":
      return cancelledText(task.end?.by);
    case "unknown":
      return reason === undefined
        ? "cloudpid lost track of it"
        : `cloudpid lost track of it: ${reason}`;
    case "stopped":
      return reason === undefined ? "cloudpid stopped following" : `Stopped: ${reason}`;
    default:
      return task.status;
  }
};

/**
 * The line of a call card or a Session details row for `task` at `now`: while inline "Running as an MCP task · <what the
 * server says> · 0:42"; after a detach "In the background · working · 3:20 · kept by docs until 14:05"; when it ended how
 * and when. A cancel that was asked for reads "Cancelling…" until the task ends.
 */
export const taskLine = (task: McpTask, now: number): string => {
  const parts = Arr.empty<string>();

  if (task.endedAt !== undefined) {
    parts.push(endText(task));
    parts.push(`ran ${clock(task.endedAt - task.startedAt)}`);
    parts.push(`ended ${timeOfDay(task.endedAt)}`);

    return Arr.join(parts, " · ");
  }

  parts.push(task.background ? "In the background" : "Running as an MCP task");

  if (task.cancel !== undefined) parts.push("Cancelling…");
  else if (task.statusMessage !== undefined && task.statusMessage !== "")
    parts.push(task.statusMessage);
  else parts.push(statusText(task));

  parts.push(clock(now - task.startedAt));

  if (task.background && task.keptUntil !== undefined) {
    parts.push(`kept by ${task.server} until ${timeOfDay(task.keptUntil)}`);
  }

  return Arr.join(parts, " · ");
};

/** What a stdio server's task warns of, which the card shows once the call has gone on in the background. */
export const STDIO_WARNING =
  "This task runs in the Workspace's Container, which stops after an hour with no activity of yours; the task then ends.";
