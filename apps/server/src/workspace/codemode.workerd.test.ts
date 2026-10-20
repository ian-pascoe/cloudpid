// A Session's `codemode` tool over the real Workspace and sandbox Durable Objects, and its Secrets used by real tools
// there: the Worker Shell gets them in its environment and placeholders resolve in file writes, also in calls a code
// mode script makes, while every result shows the reference. (One file: the workerd-session pool crashes a second file
// that runs code mode in a reused worker.)
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off preferEffectArray:off preferSchemaOverJson:off
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import { secretEnvName, secretReference } from "@cloudpid/extensions/secrets";
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

const VALUE = "ghp_live0123456789abcdef";
const TOKEN = secretEnvName("TOKEN");
const ref = secretReference("TOKEN");

/** The scripted model call of `tool` with `args`. */
const call = (tool: string, args: Readonly<Record<string, string>>) =>
  `call:${tool}:${JSON.stringify(args)}`;

describe("Secrets on a Workspace", () => {
  it("reach Worker Shell commands and file writes, directly and from a script, as references in every result", async () => {
    const stub = env.CODEMODE_SESSIONS.getByName("secrets-1");

    const results = await runInDurableObject(stub, async (instance: TestCodemodeSession) => {
      instance.bindWorkspace("secrets-1");
      await instance.hold({ TOKEN: VALUE });
      instance.script([
        call("bash", { command: `echo direct=$${TOKEN}` }),
        call("write", { path: ".env", content: `TOKEN=${ref}\n` }),
        call("bash", { command: "cat .env" }),
        call("codemode", {
          code: `
            const shell = await tools.bash({ command: "echo nested=$${TOKEN}" });
            await tools.write({ path: "nested.txt", content: "${ref}" });
            return shell.output.trim();
          `,
        }),
        "done",
      ]);

      const answer = await instance.prompt({ requestId: crypto.randomUUID(), text: "go" });

      expect(answer).toMatchObject({ status: "answered", text: "done" });

      return instance.toolResults();
    });

    expect(results).toEqual([
      `direct=${ref}\n`,
      expect.stringContaining("Successfully wrote"),
      `TOKEN=${ref}\n`,
      expect.stringContaining(`nested=${ref}`),
    ]);
    expect(JSON.stringify(results)).not.toContain(VALUE);

    // The files hold the value itself: only what the model sees is redacted.
    const workspace = new ComputerExecutionEnv({
      workspace: env.WORKSPACES.getByName("secrets-1"),
      id: "computer:secrets-1",
      cwd: "/workspace",
    });

    const read = async (path: string) =>
      new TextDecoder().decode(
        getOrThrow(await workspace.readBinaryFile(path, BACKGROUND_CONTEXT)),
      );

    expect(await read(".env")).toBe(`TOKEN=${VALUE}\n`);
    expect(await read("nested.txt")).toBe(VALUE);
  });
});
