// A Session's `codemode` tool over the real Workspace and sandbox Durable Objects.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off
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
