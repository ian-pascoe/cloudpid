// A Session's `codemode` tool over the real Workspace and sandbox Durable Objects.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off preferEffectArray:off preferSchemaOverJson:off
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { TestCodemodeSession } from "./codemode.fixture.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the Workspace test Worker. */
    interface Env {
      readonly WORKSPACES: DurableObjectNamespace<TestWorkspace>;
      readonly CODEMODE_SESSIONS: DurableObjectNamespace<TestCodemodeSession>;
    }
  }
}

let sessions = 0;

/** A new Session, and a Workspace no other test uses. */
const session = () => {
  const stub = env.CODEMODE_SESSIONS.getByName(`codemode-${(sessions += 1)}`);

  return { stub, workspace: `codemode-${sessions}` };
};

/** The scripted model call of the `codemode` tool with `code`. */
const script = (code: string) => `call:codemode:${JSON.stringify({ code })}`;

describe("the codemode tool", () => {
  it("runs a script that calls read, grep, and bash on the Workspace and returns their combined output", async () => {
    const { stub, workspace } = session();

    const results = await runInDurableObject(stub, async (instance: TestCodemodeSession) => {
      instance.bindWorkspace(workspace);
      instance.script([
        'call:write:{"path":"notes.txt","content":"alpha\\ngamma\\n"}',
        script(`
          const content = await tools.read({ path: "notes.txt" });
          const hits = await tools.grep({ pattern: "gamma" });
          const shell = await tools.bash({ command: "wc -l < notes.txt" });
          text("read: " + JSON.stringify(content));
          text("grep: " + hits);
          return { lines: shell.output.trim(), exitCode: shell.exitCode };
        `),
        "done",
      ]);

      const answer = await instance.prompt({ requestId: crypto.randomUUID(), text: "go" });

      expect(answer).toMatchObject({ status: "answered", text: "done" });

      return instance.toolResults();
    });

    const [, codemode] = results;

    expect(codemode).toContain("Script completed");
    expect(codemode).toContain('read: "alpha\\ngamma\\n"');
    expect(codemode).toContain("grep: notes.txt:2: gamma");
    expect(codemode).toMatch(/"lines":\s*"2"/);
    expect(codemode).toMatch(/"exitCode":\s*0/);
  });

  it("leaves deferred tools out of the model's tool list until tool_search loads them, and lets scripts call them unloaded", async () => {
    const { stub, workspace } = session();

    const { results, offered } = await runInDurableObject(
      stub,
      async (instance: TestCodemodeSession) => {
        instance.bindWorkspace(workspace);
        instance.script([
          // `secret_list` is deferred: the script calls it without loading it.
          script("return await tools.secret_list({});"),
          'call:tool_search:{"query":"secret list"}',
          "call:secret_list:{}",
          "done",
        ]);

        const answer = await instance.prompt({ requestId: crypto.randomUUID(), text: "go" });

        expect(answer).toMatchObject({ status: "answered", text: "done" });

        return { results: await instance.toolResults(), offered: instance.offeredTools() };
      },
    );

    const [scripted, searched, loaded] = results;

    expect(scripted).toContain("Script completed");
    expect(scripted).toContain("No Secrets are held");
    expect(searched).toContain("secret_list");
    // The model's own call of the tool it loaded ran: it was offered, and answered as the tool does.
    expect(loaded).not.toMatch(/not available|unavailable|unknown tool/i);
    expect(loaded).toBe("No Secrets are held. Call secret_ask to request one.");

    const core = [
      "read",
      "write",
      "edit",
      "bash",
      "ls",
      "find",
      "grep",
      "codemode",
      "tool_search",
      "secret_ask",
    ];

    const deferred = [
      "secret_list",
      "secret_forget",
      "todo",
      "web_fetch",
      "web_search",
      "browser",
      "subagent",
    ];

    // The first two requests came before the search: the core tools, `secret_ask` (so the Secret guidance stays), and
    // the context tools Rollover needs.
    for (const request of offered.slice(0, 2)) {
      expect(request).toEqual(expect.arrayContaining([...core, "context_rollover"]));

      for (const tool of deferred) expect(request).not.toContain(tool);
    }

    // The request after the search offers what it loaded, and not a tool the query does not match.
    expect(offered[2]).toContain("secret_list");
    expect(offered[3]).toContain("secret_list");
    expect(offered[3]).not.toContain("web_fetch");
  }, 30_000);

  it("resumes a script an eviction cut off, without running its finished calls again", async () => {
    const { stub, workspace } = session();

    await runInDurableObject(stub, async (instance: TestCodemodeSession) => {
      instance.bindWorkspace(workspace);
      instance.script([
        script(`
          await tools.write({ path: "log.txt", content: "start\\n" });
          await tools.bash({ command: "echo before >> log.txt" });
          const held = await tools.hold({});
          await tools.bash({ command: "echo after >> log.txt" });
          return held;
        `),
        "done",
      ]);
      await instance.submit({ requestId: "turn-1", text: "go" });
      // The script has made its first call, and waits in the second.
      await instance.holding.promise;

      // A client that watches sees the calls under the `codemode` call that is running them.
      const { nestedTools, tools } = await instance.snapshot();
      const parent = tools.find((slot) => slot.name === "codemode");

      expect(parent?.status).toBe("running");
      expect(
        nestedTools.map(({ name, status, parentCallId }) => ({ name, status, parentCallId })),
      ).toEqual([
        { name: "write", status: "done", parentCallId: parent?.callId },
        { name: "bash", status: "done", parentCallId: parent?.callId },
        { name: "hold", status: "running", parentCallId: parent?.callId },
      ]);
    });

    await runInDurableObject(stub, (instance: TestCodemodeSession) => instance.closeSandbox());
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await vi.waitFor(async () =>
      expect(
        await runInDurableObject(stub, (instance: TestCodemodeSession) => instance.idle()),
      ).toBe(true),
    );

    const { results, holds } = await runInDurableObject(
      stub,
      async (instance: TestCodemodeSession) => ({
        results: await instance.toolResults(),
        holds: instance.holds(),
      }),
    );

    const files = new ComputerExecutionEnv({
      workspace: env.WORKSPACES.getByName(workspace),
      id: `computer:${workspace}`,
      cwd: "/workspace",
    });

    const log = getOrThrow(await files.readTextFile("log.txt", BACKGROUND_CONTEXT));

    // `before` ran once: the new instance's script took the first call's result from the journal.
    expect(log).toBe("start\nbefore\nafter\n");
    expect(holds).toBe(2);
    expect(results[0]).toContain("Script completed");
    expect(results[0]).toContain("released");
  }, 30_000);
});
