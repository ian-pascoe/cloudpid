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
  pendingSampling,
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

describe("a script's MCP call whose Modern server also asks to use a model", () => {
  it("keeps the Sampling request with the form through an eviction, sends the call once, and runs the sample and resumes once", async () => {
    const { stub, workspace } = session();

    await asked(stub, workspace, ASK, false, true);
    await settles(async () => expect(await pendingSampling(stub)).toHaveLength(1));

    const [form] = await pending(stub);
    const [sample] = await pendingSampling(stub);

    expect(sample).toMatchObject({ server: "docs", tool: "mcp__docs__ask", waits: "owner" });
    expect(await sent(stub)).toMatchObject({ calls: 1, resumes: 0 });

    await evict(stub);

    // The next instance has both waiting, sent the call no second time, and has made no sample.
    await settles(async () => expect(await pendingSampling(stub)).toEqual([sample]));
    expect(await pending(stub)).toEqual([form]);
    expect(await sent(stub)).toMatchObject({ calls: 1, resumes: 0 });
    expect(
      await runInDurableObject(stub, (instance: TestMcpCodemodeSession) =>
        instance.samplingUsage(),
      ),
    ).toMatchObject({ requests: 0 });

    await runInDurableObject(stub, async (instance: TestMcpCodemodeSession) => {
      await instance.mcpSamplingAnswer(sample?.id ?? "", "allow_call");
      await instance.mcpAnswer(form?.id ?? "", { name: "Ada" });
    });
    await idle(stub);

    // One tools/call, one resume carrying both answers; the sample ran once, as the round resumed.
    expect(await sent(stub)).toMatchObject({
      calls: 1,
      resumes: 1,
      answers: {
        q1: { action: "accept", content: { name: "Ada" } },
        s1: expect.objectContaining({ role: "assistant" }),
      },
    });
    expect(
      await runInDurableObject(stub, (instance: TestMcpCodemodeSession) =>
        instance.samplingUsage(),
      ),
    ).toMatchObject({ requests: 1 });
    expect(await pending(stub)).toEqual([]);
    expect(await pendingSampling(stub)).toEqual([]);

    const results = await runInDurableObject(stub, (instance: TestMcpCodemodeSession) =>
      instance.toolResults(),
    );

    expect(results[0]).toContain("Script completed");
    expect(results[0]).toContain('Hello \\"Ada\\" and \\"a sampled reply\\"');
  }, 30_000);

  it("withdraws the form and resumes nothing when the owner refuses the Sampling request, and the script's call fails", async () => {
    const { stub, workspace } = session();

    await asked(stub, workspace, ASK, false, true);
    await settles(async () => expect(await pendingSampling(stub)).toHaveLength(1));

    const [sample] = await pendingSampling(stub);

    await runInDurableObject(stub, (instance: TestMcpCodemodeSession) =>
      instance.mcpSamplingAnswer(sample?.id ?? "", "refuse"),
    );
    await idle(stub);

    expect(await pending(stub)).toEqual([]);
    expect(await pendingSampling(stub)).toEqual([]);
    expect(await sent(stub)).toMatchObject({ calls: 1, resumes: 0 });

    const results = await runInDurableObject(stub, (instance: TestMcpCodemodeSession) =>
      instance.toolResults(),
    );

    expect(results[0]).toContain("docs asked for a model reply, which was refused by you");
    expect(
      await runInDurableObject(stub, (instance: TestMcpCodemodeSession) =>
        instance.samplingUsage(),
      ),
    ).toMatchObject({ requests: 0 });
  }, 30_000);
});
