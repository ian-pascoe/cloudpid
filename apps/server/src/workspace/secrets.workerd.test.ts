// A Session's Secrets used by real tools on a Workspace: the Worker Shell gets them in its environment and placeholders
// resolve in file writes, also in calls a code mode script makes, while every result shows the reference.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off preferEffectArray:off preferSchemaOverJson:off
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import { secretEnvName, secretReference } from "@cloudpid/extensions/secrets";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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

  it("redacts the Result Spill of a command whose output crosses the spill thresholds", async () => {
    const stub = env.CODEMODE_SESSIONS.getByName("secrets-2");

    const results = await runInDurableObject(stub, async (instance: TestCodemodeSession) => {
      instance.bindWorkspace("secrets-2");
      await instance.hold({ TOKEN: VALUE });
      instance.script([
        call("bash", {
          command: `for i in $(seq 1 2100); do echo "line $i $${TOKEN}"; done`,
        }),
        "done",
      ]);

      const answer = await instance.prompt({ requestId: crypto.randomUUID(), text: "go" });

      expect(answer).toMatchObject({ status: "answered", text: "done" });

      return instance.toolResults();
    });

    expect(JSON.stringify(results)).not.toContain(VALUE);

    const spillPath = /Full output: (\S+)/.exec(results.join("\n"))?.[1];

    expect(spillPath).toBeDefined();

    const workspace = new ComputerExecutionEnv({
      workspace: env.WORKSPACES.getByName("secrets-2"),
      id: "computer:secrets-2",
      cwd: "/workspace",
    });

    const spill = getOrThrow(await workspace.readTextFile(spillPath ?? "", BACKGROUND_CONTEXT));

    expect(spill.split("\n")).toHaveLength(2101);
    expect(spill).toContain(`line 2100 ${ref}\n`);
    expect(spill).not.toContain(VALUE);
  });
});
