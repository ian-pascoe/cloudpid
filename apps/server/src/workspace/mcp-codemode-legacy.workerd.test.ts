// A script's call of an MCP tool whose Legacy server asks the owner a question, cut by a crash (`docs/architecture/
// mcp-server-requests.md` → The waiting-question record: `codemode`; #388 D5.4): the question lives only as long as its
// call, so the next instance expires it, and the script reads its call as cut. Its own file, since the crash resets every
// object of the file's Worker (`abortAllDurableObjects`). A fake host (`./mcp-codemode.fixture.ts`) stands for the server.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestMcpCodemodeSession } from "./mcp-codemode.fixture.ts";
import { asked, idle, pending, sent, session } from "./mcp-codemode.workerd.helpers.ts";

describe("a script's MCP call whose Legacy server asks a question", () => {
  it("withdraws a Legacy server's question with its call, which the script reads as cut", async () => {
    const { stub: first, name, workspace } = session();

    await asked(
      first,
      workspace,
      `
        try {
          await tools.mcp__docs__ask({});
          return "answered";
        } catch (error) {
          return "cut: " + String(error);
        }
      `,
      true,
    );
    // The Legacy call's question holds a timer, which an eviction waits for: the objects are reset instead, as a crash
    // does (every object of this file's Worker, so this test is the file's only one).
    await abortAllDurableObjects();

    const stub = env.MCP_CODEMODE_SESSIONS.getByName(name);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await idle(stub);

    expect(await pending(stub)).toEqual([]);
    expect(await sent(stub)).toMatchObject({ calls: 1, resumes: 0 });

    const results = await runInDurableObject(stub, (instance: TestMcpCodemodeSession) =>
      instance.toolResults(),
    );

    expect(results[0]).toContain("may have partially run");
    expect(
      await runInDurableObject(stub, (instance: TestMcpCodemodeSession) => instance.mcpRecords()),
    ).toEqual([
      expect.objectContaining({ action: "cancel", reason: "expired: the server's call ended" }),
    ]);
  }, 30_000);
});
