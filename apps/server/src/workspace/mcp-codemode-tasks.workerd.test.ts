// A script's MCP call whose Modern server runs it as an MCP task (`docs/architecture/mcp-server-requests.md` → MCP tasks,
// Delivery, The inline window; #494): the nested call is offered a task, and one that outlasts its window gets an error
// value naming the handle (`mcp_task_background`) rather than a result, while the follower goes on for the script's
// conversation; Stop all and Archive (`stopEverything`) cancel it at the server once. A fake host stands for the server
// (`./mcp-codemode.fixture.ts`); the Session, the follower, the Workspace and the codemode sandbox are real.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import type { TestMcpCodemodeSession } from "./mcp-codemode.fixture.ts";
import { idle, script, session, settles } from "./mcp-codemode.workerd.helpers.ts";

/** The script that calls the server's `report` tool and prints what it got back. */
const REPORT = `
  const result = await tools.mcp__docs__report({});
  text(JSON.stringify(result));
  return "reported";
`;

describe("a script's MCP call that runs as a task", () => {
  it("is offered the task, detaches at the window with an error value that names the handle, and is cancelled by Stop all", async () => {
    const { stub, workspace } = session();

    await runInDurableObject(stub, async (instance: TestMcpCodemodeSession) => {
      instance.bindWorkspace(workspace);
      instance.mcpTasks();
      instance.script([script(REPORT), "done"]);
      await instance.submit({ requestId: "turn-1", text: "go" });
    });
    await idle(stub);

    const results = await runInDurableObject(stub, (instance: TestMcpCodemodeSession) =>
      instance.toolResults(),
    );

    // The call went out once, offered a task; the script got a value, not a result, that names the handle.
    expect(results[0]).toContain("Script completed");
    expect(results[0]).toContain("runs as MCP task mcp-task-1");
    expect(results[0]).toContain("isError");
    expect(results[0]).not.toContain("srv-task-secret");
    expect(
      await runInDurableObject(stub, (instance: TestMcpCodemodeSession) => instance.mcpTaskSent()),
    ).toMatchObject({ "tools/call": 1 });

    // Stop all (and Archive) end the follower, which cancels the task at the server.
    await runInDurableObject(stub, (instance: TestMcpCodemodeSession) => instance.stopEverything());
    await settles(async () =>
      expect(
        (
          await runInDurableObject(stub, (instance: TestMcpCodemodeSession) =>
            instance.mcpTaskSent(),
          )
        )["tasks/cancel"],
      ).toBe(1),
    );
    await idle(stub);
  }, 30_000);
});
