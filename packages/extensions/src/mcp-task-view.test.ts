// What an App View's MCP task does when the question it waits on cannot be asked (`docs/architecture/
// mcp-server-requests.md` → MCP tasks, App View calls): a hook that fails never leaves the task running at the server.
// The host is a stand-in that answers `tasks/get` and records every request.
// @effect-diagnostics asyncFunction:off preferEffectArray:off missingPipeableSignature:off
import { McpHostTaskAck, McpHostTaskStarted, McpHostTaskState } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { DOCS } from "./mcp.fixture.ts";
import { fakeMcpHost } from "./mcp.testing.ts";
import { followViewTask, type ViewTask } from "./mcp/task-view.ts";

const FIELDS = {
  taskId: "t1",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUpdatedAt: "2026-01-01T00:00:00.000Z",
  ttlMs: 60_000,
};

const asking = McpHostTaskState.make({
  task: {
    ...FIELDS,
    status: "input_required",
    inputRequests: {
      which: {
        method: "elicitation/create",
        params: { message: "Which?", requestedSchema: { type: "object", properties: {} } },
      },
    },
  },
});

const setup = (onInput: () => Promise<never>) => {
  const host = fakeMcpHost([DOCS]);

  host.answer(async (input) => (input.op === "tasks/get" ? asking : McpHostTaskAck.make({})));

  const task: ViewTask = {
    client: host.client,
    started: McpHostTaskStarted.make({ task: { ...FIELDS, status: "input_required" }, conn: "c" }),
    server: DOCS.name,
    tool: "report",
    modelTool: "mcp__docs__report",
    ctx: { origin: "app", callId: "c1", conversation: "1" },
    // SAFETY: the follower only carries the conversation id into a record it never stores.
    conversation: 1 as ViewTask["conversation"],
    transport: "http",
    signal: new AbortController().signal,
    timing: { pollMs: 5 },
    questions: {
      answers: { elicitation: true },
      hooks: { onInput },
      expire: () => undefined,
    },
  };

  const sent = () =>
    host.calls.flatMap((each) => (each.method === "request" ? [each.input.op] : []));

  return { task, sent };
};

describe("an App View's MCP task whose question cannot be asked", () => {
  it("is cancelled at the server when the hook rejects, not left running", async () => {
    const { task, sent } = setup(() => Promise.reject(new Error("the question store is down")));

    expect(await Effect.runPromise(followViewTask(task))).toMatchObject({ kind: "refused" });
    expect(sent()).toEqual(["tasks/get", "tasks/cancel"]);
  });

  it("is cancelled at the server when the hook throws", async () => {
    const { task, sent } = setup(() => {
      throw new Error("boom");
    });

    expect(await Effect.runPromise(followViewTask(task))).toMatchObject({ kind: "refused" });
    expect(sent()).toEqual(["tasks/get", "tasks/cancel"]);
  });
});
