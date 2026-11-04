// The MCP tasks' socket messages (`docs/architecture/mcp-server-requests.md` → MCP tasks, Cancellation).
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { ClientMessage, ServerMessage } from "./session.ts";

const decodeClient = Schema.decodeUnknownOption(ClientMessage);
const decodeServer = Schema.decodeUnknownOption(ServerMessage);

describe("MCP task messages", () => {
  it("reads the owner's cancel and Keep the Container, and refuses a field it does not know", () => {
    expect(
      Option.isSome(decodeClient({ type: "mcp_task_cancel", id: "1", task: "mcp-task-1" })),
    ).toBe(true);
    expect(
      Option.isSome(decodeClient({ type: "container_keep", id: "2", task: "mcp-task-1" })),
    ).toBe(true);
    expect(Option.isNone(decodeClient({ type: "container_keep", id: "2" }))).toBe(true);
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(ClientMessage, { onExcessProperty: "error" })({
          type: "mcp_task_cancel",
          id: "1",
          task: "mcp-task-1",
          extra: true,
        }),
      ),
    ).toBe(true);
    expect(
      Option.isNone(decodeClient({ type: "mcp_task_cancel", id: "1", task: "t".repeat(65) })),
    ).toBe(true);
  });

  it("lists the tasks, one that ended and a status a later build adds included", () => {
    const task = {
      task: "mcp-task-1",
      server: "docs",
      tool: "mcp__docs__index",
      status: "working",
      background: true,
      callId: "call-1",
      conversationId: 1,
      startedAt: 10,
    };

    expect(
      Option.isSome(
        decodeServer({
          type: "mcp_tasks",
          tasks: [
            task,
            {
              ...task,
              task: "mcp-task-2",
              status: "later",
              stdio: true,
              agent: "a",
              endedAt: 20,
              end: { by: "owner", reason: "stopped" },
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(Option.isSome(decodeServer({ type: "mcp_tasks", tasks: [] }))).toBe(true);
  });

  it("says in hello whether the Session takes them, and a hello without it still reads", () => {
    expect(Option.isSome(decodeServer({ type: "hello", root: 1, mcpTasks: true }))).toBe(true);
    expect(Option.isSome(decodeServer({ type: "hello", root: 1 }))).toBe(true);
  });
});
