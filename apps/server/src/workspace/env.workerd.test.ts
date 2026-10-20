// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off preferEffectArray:off
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
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

/** One Workspace for the conformance cases; each case gets its own empty directory in it. */
const shared = env.WORKSPACES.getByName("conformance");

let cases = 0;

/** Polls faster than the 2 s default, so the conformance watch cases settle quickly. */
const watch = { pollIntervalMs: 250 };

/** An environment on `workspace` whose `cwd` is a fresh, empty directory. */
const freshEnv = async (workspace: DurableObjectStub<TestWorkspace>) => {
  const cwd = `/workspace/case-${++cases}`;
  const created = new ComputerExecutionEnv({ workspace, id: "computer:test", cwd: "/workspace" });

  getOrThrow(await created.createDir(cwd, { recursive: true }, context));

  return new ComputerExecutionEnv({ workspace, id: "computer:test", cwd, watch });
};

registerEnvConformance(
  { describe, expect, it },
  "ComputerExecutionEnv on the Worker Shell",
  async (use) => {
    await use(await freshEnv(shared));
  },
  { listFiles: true },
);

describe("ComputerExecutionEnv exec", () => {
  it("attributes each chunk of output to stdout or stderr", async () => {
    const chunks: Array<{ stream: string; text: string }> = [];
    const executionEnv = await freshEnv(shared);

    const result = await executionEnv.exec(
      "echo one; echo two >&2; echo three; exit 4",
      { onOutput: (text, _context, info) => chunks.push({ stream: info.stream, text }) },
      context,
    );

    expect(getOrThrow(result).exitCode).toBe(4);

    const joined = (stream: string) =>
      chunks.flatMap((chunk) => (chunk.stream === stream ? [chunk.text] : [])).join("");

    expect(joined("stdout")).toBe("one\nthree\n");
    expect(joined("stderr")).toBe("two\n");
  });

  it("kills a command aborted while the Workspace client is still being acquired", async () => {
    const executionEnv = await freshEnv(shared);
    const controller = new AbortController();
    const started = Date.now();

    const running = executionEnv.exec(
      "sleep 2",
      undefined,
      withAbortSignal(controller.signal, context),
    );

    controller.abort();

    const result = await running;

    expect(result.ok ? result.value : result.error.code).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("fails with callback_error when onOutput throws", async () => {
    const executionEnv = await freshEnv(shared);

    const result = await executionEnv.exec(
      "echo out",
      {
        onOutput: () => {
          throw new Error("sink closed");
        },
      },
      context,
    );

    expect(result.ok ? result.value : result.error.code).toBe("callback_error");
  });
});

describe("ComputerExecutionEnv over many calls", () => {
  it("disposes every Workspace and exec stub it takes", async () => {
    const workspace = env.WORKSPACES.getByName("stubs");
    const executionEnv = await freshEnv(workspace);

    for (let round = 0; round < 3; round++) {
      getOrThrow(await executionEnv.writeFile(`file-${round}.txt`, "x", context));
      getOrThrow(await executionEnv.exec("cat file-0.txt", undefined, context));
      await executionEnv.exec(["pi-durable-missing-program"], undefined, context);
      await executionEnv.exec("sleep 2", { timeout: 0.05 }, context);

      const controller = new AbortController();

      const running = executionEnv.exec(
        "sleep 2",
        undefined,
        withAbortSignal(controller.signal, context),
      );

      setTimeout(() => controller.abort(), 50);
      await running;

      getOrThrow(await executionEnv.listFiles?.(".", undefined, context));
    }

    // `cleanup()` kills what still runs, through a Workspace client of its own.
    const lingering = executionEnv.exec("sleep 2", undefined, context);

    await new Promise((resolve) => setTimeout(resolve, 100));
    await executionEnv.cleanup(context);
    await lingering;

    // A disposed stub reaches the Workspace DO asynchronously.
    for (let attempt = 0; attempt < 100; attempt++) {
      const live = await workspace.liveStubs();

      if (live.workspaces === 0 && live.execs === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const live = await workspace.liveStubs();

    // Every exec opened at least one counted Workspace stub, so none bypassed the count.
    expect(live.opened).toBeGreaterThanOrEqual(12);
    expect(live).toMatchObject({ workspaces: 0, execs: 0 });
  }, 30_000);
});
