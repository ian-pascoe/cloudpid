// What the owner is told of an MCP task (`mcp-task.ts`).
import type { ConversationId, McpTask } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import { describe, expect, it } from "vite-plus/test";
import { clock, endText, liveTasks, taskLine, taskOfCall } from "./mcp-task.ts";

const task = (more: Partial<McpTask> = {}): McpTask => ({
  task: "mcp-task-1",
  server: "docs",
  tool: "mcp__docs__index",
  status: "working",
  background: false,
  callId: "call-1",
  // SAFETY: a test's conversation ID.
  conversationId: 1 as ConversationId,
  startedAt: 1_000,
  ...more,
});

describe("an MCP task's words", () => {
  it("shows how long a task has gone on", () => {
    expect(clock(42_000)).toBe("0:42");
    expect(clock(725_000)).toBe("12:05");
    expect(clock(3_723_000)).toBe("1:02:03");
    expect(clock(-5)).toBe("0:00");
  });

  it("reads a call that waits inline, with what the server says", () => {
    expect(taskLine(task({ statusMessage: "indexing" }), 43_000)).toBe(
      "Running as an MCP task · indexing · 0:42",
    );
    expect(taskLine(task(), 43_000)).toBe("Running as an MCP task · Working · 0:42");
  });

  it("reads a task in the background with who keeps it, and one that is cancelled", () => {
    const line = taskLine(task({ background: true, keptUntil: 3_600_000 }), 201_000);

    expect(line).toMatch(/^In the background · Working · 3:20 · kept by docs until /);
    expect(taskLine(task({ background: true, cancel: { by: "owner", at: 5 } }), 3_000)).toBe(
      "In the background · Cancelling… · 0:02",
    );
    expect(taskLine(task({ waitingFor: "owner", status: "input_required" }), 1_000)).toContain(
      "Waiting for you",
    );
  });

  it("says how an ended task ended, in cloudpid's words and never the server's", () => {
    expect(endText(task({ status: "completed", endedAt: 9 }))).toBe("Completed");
    expect(endText(task({ status: "completed", endedAt: 9, cancel: { by: "owner", at: 5 } }))).toBe(
      "Finished before the cancel took effect",
    );
    expect(endText(task({ status: "cancelled", end: { by: "owner" } }))).toBe("Cancelled by you");
    expect(endText(task({ status: "cancelled", end: { by: "stop" } }))).toBe("Cancelled by Stop");
    expect(
      endText(
        task({ status: "unknown", end: { by: "cloudpid", reason: "the Container stopped" } }),
      ),
    ).toBe("cloudpid lost track of it: the Container stopped");
    expect(endText(task({ status: "later" }))).toBe("later");
    expect(taskLine(task({ status: "failed", startedAt: 0, endedAt: 65_000 }), 70_000)).toMatch(
      /^Failed · ran 1:05 · ended /,
    );
    expect(
      taskLine(
        task({ status: "completed", startedAt: 0, endedAt: 65_000, toldAt: 70_000 }),
        80_000,
      ),
    ).toMatch(/^Completed · ran 1:05 · told the agent at /);
  });

  it("finds a call's task and the live ones", () => {
    const tasks = [task(), task({ task: "mcp-task-2", callId: "call-2", endedAt: 5 })];

    expect(taskOfCall(tasks, "call-2")?.task).toBe("mcp-task-2");
    expect(taskOfCall(tasks, "none")).toBeUndefined();
    expect(Arr.map(liveTasks(tasks), (each) => each.task)).toEqual(["mcp-task-1"]);
  });
});
