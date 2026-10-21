// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off preferEffectArray:off
import {
  ContainerBackend,
  type IWorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { DEFAULT_WORKSPACE_SETTINGS } from "@cloudpid/config";
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ContainerLaunch, type LaunchRecord } from "./launch.ts";
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

describe("ComputerExecutionEnv on a chosen backend", () => {
  it("runs a command on the Worker Shell when asked, against the same files", async () => {
    const executionEnv = await freshEnv(shared);
    const chunks: string[] = [];

    getOrThrow(await executionEnv.writeFile("shared.txt", "from the env", context));

    const result = await executionEnv
      .onBackend("worker")
      .exec("cat shared.txt", { onOutput: (text) => chunks.push(text) }, context);

    expect(getOrThrow(result).exitCode).toBe(0);
    expect(chunks.join("")).toBe("from the env");
  });

  it("fails a command on the Container, as an error result, where the Workspace has none", async () => {
    const executionEnv = await freshEnv(shared);

    const result = await executionEnv.onBackend("container").exec("echo hi", undefined, context);

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toMatch(/container/i);
  });

  it("kills the commands of every backend it ran on when the environment is cleaned up", async () => {
    const workspace = env.WORKSPACES.getByName("backend-cleanup");
    const executionEnv = await freshEnv(workspace);
    const lingering = executionEnv.onBackend("worker").exec("sleep 1", undefined, context);

    await new Promise((resolve) => setTimeout(resolve, 150));
    await executionEnv.cleanup(context);
    await lingering;

    expect((await workspace.liveStubs()).killed).toBe(1);
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

describe("the Container launch, through computer's own ContainerBackend", () => {
  type Spec = Parameters<IWorkspaceContainerAPI["start"]>[0];

  it("starts on the Workspace's instance type from a snapshot, and restarts from the image when it never comes up", async () => {
    const starts: Spec[] = [];
    const restarts: Spec[] = [];
    let record: LaunchRecord | undefined;
    let forgotten = 0;

    // A platform whose Container never answers its health probe, so the backend restarts it once.
    const platform: IWorkspaceContainerAPI = {
      start: async (spec) => {
        starts.push(spec);

        return { runtimeId: "r1", clientSecret: "s", outcome: "launched" };
      },
      restart: async (spec) => {
        restarts.push(spec);

        return { runtimeId: "r2", clientSecret: "s", outcome: "launched" };
      },
      status: async () => ({ running: false, exit: null }),
      exitInfo: async () => null,
      interceptOutboundHttp: async () => undefined,
      interceptAllOutboundHttp: async () => undefined,
      setInactivityTimeout: async () => undefined,
      fetchPort: async () => {
        throw new Error("not up");
      },
      port: () => {
        throw new Error("not used");
      },
    };

    const launch = new ContainerLaunch({
      settings: async () => ({ ...DEFAULT_WORKSPACE_SETTINGS, instance: "standard-3" }),
      snapshots: {
        restorable: async () => ({ id: "snap-1" }),
        forget: async () => {
          forgotten++;
        },
        take: async () => "taken",
      },
      load: async () => record,
      save: async (saved) => {
        record = saved;
      },
      running: () => false,
      now: () => Date.now(),
      warn: () => undefined,
    });

    const backend = new ContainerBackend({
      container: () => ({ getWorkspaceContainer: () => launch.wrap(platform) }),
      workspace: { binding: "WORKSPACES", id: "x" },
      name: "WorkspaceContainer",
      connectTimeoutMs: 600,
      healthRetryInitialDelayMs: 5,
      healthRetryMaxDelayMs: 10,
    });

    await expect(backend.connect()).rejects.toThrow();

    // The first launch asked for the Workspace's size and the snapshot (and no image: computer picks it from the name).
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      instance: "standard-3",
      containerSnapshot: { id: "snap-1" },
    });
    expect(starts[0]?.env.MOUNT_POINT).toBe("/workspace");

    // The restart kept the size, dropped the snapshot, and the snapshot was forgotten.
    expect(restarts).toHaveLength(1);
    expect(restarts[0]?.instance).toBe("standard-3");
    expect(restarts[0]?.containerSnapshot).toBeUndefined();
    expect(forgotten).toBe(1);
  });
});
