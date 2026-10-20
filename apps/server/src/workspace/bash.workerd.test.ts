// `bash` without a `backend`, on a real Workspace DO: a command routed to the Worker Shell runs there, whole, and never
// starts the Container. The Workspace test Worker has no Container, so a command sent to it fails, and its counter
// (`liveStubs().container`) says whether one was.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import { CodingTools } from "@cloudpid/extensions/coding-tools";
import { WORKER_SHELL_COMMANDS } from "@cloudpid/extensions/bash-routing";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestWorkspace } from "./workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the Workspace test Worker. */
    interface Env {
      readonly WORKSPACES: DurableObjectNamespace<TestWorkspace>;
    }
  }
}

const context = BACKGROUND_CONTEXT;

const bash = CodingTools.tools?.find((tool) => tool.name === "bash");

/** One Workspace for every case (each Workspace loads its own Worker Shell); each case gets a directory of its own. */
const shared = env.WORKSPACES.getByName("bash-routing");

let cases = 0;

const open = async () => {
  cases++;

  const cwd = `/workspace/case-${cases}`;
  const executionEnv = new ComputerExecutionEnv({ workspace: shared, id: "computer:bash", cwd });
  const before = await shared.liveStubs();

  getOrThrow(await executionEnv.createDir(cwd, { recursive: true }, context));
  getOrThrow(
    await executionEnv.writeFile("package.json", '{"name":"demo","version":"1.2.3"}\n', context),
  );
  getOrThrow(await executionEnv.writeFile("notes.txt", "alpha\nneedle\nomega\n", context));

  /** What the model sees from calling `bash` with `args`. */
  const run = async (args: Record<string, string | number>) => {
    if (bash === undefined) throw new Error("no bash tool");

    const chunks: string[] = [];

    const api = {
      env: executionEnv,
      output: (text: string) => chunks.push(text),
      retainedOutput: () => chunks.join(""),
      diagnostic: () => {},
    };

    try {
      // SAFETY: `args` are `bash`'s parameters (the lookup by name types it as any of the tools), and `bash` uses only the
      // environment, the output sink, and diagnostics of the API.
      await bash.execute(args as never, api as never, context);

      return { text: chunks.join(""), isError: false };
    } catch (error) {
      return { text: `${chunks.join("")}${String(error)}`, isError: true };
    }
  };

  /** The commands the Workspace started since this case opened. */
  const counts = async () => {
    const now = await shared.liveStubs();

    return { started: now.started - before.started, container: now.container - before.container };
  };

  return { run, counts };
};

// The first command loads the Worker Shell and its modules (git, jq) cold, which can take longer than the default 5 s on CI.
describe("bash on a Workspace", { timeout: 30_000 }, () => {
  it.each([
    ["cat notes.txt", "alpha\nneedle\nomega"],
    ["grep needle notes.txt", "needle"],
    ["sed -n 2p notes.txt", "needle"],
    ["jq -r .version package.json", "1.2.3"],
    ["grep -c a notes.txt | cat", "2"],
    ["cd . && ls | head -1", "notes.txt"],
  ])("runs `%s` on the Worker Shell without starting the Container", async (command, output) => {
    const { run, counts } = await open();

    const result = await run({ command });

    expect(result.isError).toBe(false);
    expect(result.text.trim()).toBe(output);
    expect(await counts()).toMatchObject({ started: 1, container: 0 });
  });

  it("runs git status on the Worker Shell, inside a repository it initialized there", async () => {
    const { run, counts } = await open();

    const init = await run({ command: "git init -b main && git add -A && git status --short" });

    expect(init.isError).toBe(false);
    expect(init.text).toContain("notes.txt");
    expect(await counts()).toMatchObject({ started: 1, container: 0 });
  });

  it("commits on the Worker Shell with an identity, which git log shows", async () => {
    const { run, counts } = await open();

    const log = await run({
      command: "git init -b main && git add -A && git commit -m 'first' && git log --oneline",
    });

    expect(log.isError).toBe(false);
    expect(log.text).toContain("first");
    expect(await counts()).toMatchObject({ started: 1, container: 0 });
  });

  it.each(["node -v", "npm test", "gh pr list", "cat notes.txt && node x.js", "git push"])(
    "sends `%s` to the Container",
    async (command) => {
      const { run, counts } = await open();

      // This test Worker has no Container, so the command fails; what matters is that it was sent there.
      await run({ command });

      expect(await counts()).toMatchObject({ started: 1, container: 1 });
    },
  );

  it("runs an explicit worker backend on the Worker Shell even for a binary, which fails there", async () => {
    const { run, counts } = await open();

    const result = await run({ command: "node -v", backend: "worker" });

    expect(result.text).toMatch(/not found/);
    expect(await counts()).toMatchObject({ started: 1, container: 0 });
  });

  it("has every command the router sends to the Worker Shell", async () => {
    const { run } = await open();
    const missing: string[] = [];

    for (const name of WORKER_SHELL_COMMANDS) {
      const result = await run({ command: `command -v ${name}`, backend: "worker" });

      // `command -v` prints where it found the command, and nothing for one it did not.
      if (result.text.trim() === "") missing.push(name);
    }

    expect(missing).toEqual([]);
  });
});
