// A script's call of an MCP tool whose Modern server asks the owner a question, across an eviction (`docs/architecture/
// mcp-server-requests.md` → The waiting-question record: `codemode`; #388 D5.4): the nested call is a durable task the
// script replays from its journal, so the question, kept for later, survives the eviction and the call waits for it
// again, sent once and resumed once; and the script's `timeout_ms` passing during the eviction (the script times out,
// the question is withdrawn, nothing resumed). The Legacy variant is `mcp-codemode-legacy.workerd.test.ts`.
// A fake host (`./mcp-codemode.fixture.ts`) stands for the server, since this Worker has no McpHost DO or engine; the
// Session, its questions, the Workspace and the codemode sandbox are real. The same deferral through the real host,
// engine and a fake Modern server, on a direct call, is in `../session/mcp-elicitation.workerd.test.ts`.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TestMcpCodemodeSession } from "./mcp-codemode.fixture.ts";
import {
  ASK,
  asked,
  evict,
  idle,
  pending,
  sent,
  session,
  settles,
} from "./mcp-codemode.workerd.helpers.ts";

describe("a script's MCP call whose server asks a question", () => {
  it("keeps a Modern server's question through an eviction, sends the call once, and resumes it once with the answer", async () => {
    const { stub, workspace } = session();

    await asked(stub, workspace, ASK);

    const [before] = await pending(stub);

    expect(before).toMatchObject({ server: "docs", tool: "mcp__docs__ask", waits: "owner" });
    expect(await sent(stub)).toMatchObject({ calls: 1, resumes: 0 });

    await evict(stub);

    // The next instance has the same question waiting, and sent the call no second time.
    await settles(async () => expect(await pending(stub)).toEqual([before]));
    expect(await sent(stub)).toMatchObject({ calls: 1, resumes: 0 });

    await runInDurableObject(stub, (instance: TestMcpCodemodeSession) =>
      instance.mcpAnswer(before?.id ?? "", { name: "Ada" }),
    );
    await idle(stub);

    expect(await sent(stub)).toEqual({
      calls: 1,
      resumes: 1,
      answers: { q1: { action: "accept", content: { name: "Ada" } } },
    });
    expect(await pending(stub)).toEqual([]);

    const results = await runInDurableObject(stub, (instance: TestMcpCodemodeSession) =>
      instance.toolResults(),
    );

    expect(results[0]).toContain("Script completed");
    expect(results[0]).toContain('Hello \\"Ada\\"');
  }, 30_000);

  it("withdraws the question, and resumes nothing, when the script's timeout passes during the eviction", async () => {
    const { stub, workspace } = session();

    await asked(stub, workspace, `// @options: {"timeout_ms": 3000}\n${ASK}`);
    await evict(stub);

    // The deadline passed while no instance ran the script.
    await new Promise((resolve) => setTimeout(resolve, 3500));
    await runDurableObjectAlarm(stub);
    await idle(stub);

    expect(await pending(stub)).toEqual([]);
    expect(await sent(stub)).toMatchObject({ calls: 1, resumes: 0 });

    const results = await runInDurableObject(stub, (instance: TestMcpCodemodeSession) =>
      instance.toolResults(),
    );

    expect(results[0]).toContain("Script timed out");
    expect(
      await runInDurableObject(stub, (instance: TestMcpCodemodeSession) => instance.mcpRecords()),
    ).toEqual([expect.objectContaining({ action: "cancel", by: "cloudpid" })]);
  }, 30_000);
});
