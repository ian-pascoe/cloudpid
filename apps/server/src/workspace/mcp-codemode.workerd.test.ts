// A script's call of an MCP tool whose server asks the owner a question, across an eviction (`docs/architecture/
// mcp-server-requests.md` → The waiting-question record: `codemode`; #388 D5.4): the nested call is a durable task the
// script replays from its journal, so a Modern server's question, kept for later, survives the eviction and the call
// waits for it again, sent once and resumed once. The variants: the script's `timeout_ms` passing during the eviction
// (the script times out, the question is withdrawn, nothing resumed), and a Legacy server, whose question lives only as
// long as its call (withdrawn, the call cut in the script). A fake host (`./mcp-codemode.fixture.ts`) stands for the
// server; the Session, its questions, the Workspace and the codemode sandbox are real.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off preferEffectArray:off newPromise:off globalTimers:off
import {
  abortAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { TestMcpCodemodeSession } from "./mcp-codemode.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the Workspace test Worker. */
    interface Env {
      readonly MCP_CODEMODE_SESSIONS: DurableObjectNamespace<TestMcpCodemodeSession>;
    }
  }
}

let sessions = 0;

/** A new Session, and a Workspace no other test uses. */
const session = () => {
  const stub = env.MCP_CODEMODE_SESSIONS.getByName(`mcp-codemode-${(sessions += 1)}`);

  return { stub, workspace: `mcp-codemode-${sessions}` };
};

/** The scripted model call of the `codemode` tool with `code`. */
const script = (code: string) => `call:codemode:${JSON.stringify({ code })}`;

/** `vi.waitFor`, with room for a loaded CI runner. */
const settles = <A>(check: () => Promise<A>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 50 });

type Stub = DurableObjectStub<TestMcpCodemodeSession>;

const pending = (stub: Stub) =>
  runInDurableObject(stub, (instance: TestMcpCodemodeSession) => instance.mcpPending());

const sent = (stub: Stub) =>
  runInDurableObject(stub, (instance: TestMcpCodemodeSession) => instance.mcpSent());

/** Start a Run whose script awaits the server's `ask` tool, and wait until its question is on a card. */
const asked = async (stub: Stub, workspace: string, code: string, legacy = false) => {
  await runInDurableObject(stub, async (instance: TestMcpCodemodeSession) => {
    instance.bindWorkspace(workspace);

    if (legacy) instance.mcpLegacy();

    instance.script([script(code), "done"]);
    await instance.submit({ requestId: crypto.randomUUID(), text: "go" });
  });

  await settles(async () => expect(await pending(stub)).toHaveLength(1));
};

/** Shut the instance down as an eviction does, and start the next one at its alarm. */
const evict = async (stub: Stub) => {
  await runInDurableObject(stub, (instance: TestMcpCodemodeSession) => instance.closeSandbox());
  await evictDurableObject(stub);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
};

const idle = (stub: Stub) =>
  settles(async () =>
    expect(
      await runInDurableObject(stub, (instance: TestMcpCodemodeSession) => instance.idle()),
    ).toBe(true),
  );

const ASK = `
  const answer = await tools.mcp__docs__ask({});
  text(JSON.stringify(answer));
  return "asked";
`;

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

  it("withdraws a Legacy server's question with its call, which the script reads as cut", async () => {
    const { stub: first, workspace } = session();

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
    // does (every object of this file's Worker, so this test is the file's last).
    await abortAllDurableObjects();

    const stub = env.MCP_CODEMODE_SESSIONS.getByName(`mcp-codemode-${sessions}`);

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
