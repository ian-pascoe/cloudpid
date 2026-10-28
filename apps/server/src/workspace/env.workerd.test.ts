// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off preferEffectArray:off preferEffectRecord:off
import { Workspace as ComputerWorkspace } from "@cloudflare/computer";
import {
  ContainerBackend,
  type IWorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { DEFAULT_CONTAINER_SETTINGS, type InstanceType } from "@cloudpid/config";
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import { secretReference } from "@cloudpid/extensions/secrets/core";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { discoverSkills } from "@cloudpid/extensions/skills-discovery";
import { discoverInstructions } from "@cloudpid/extensions/agents-md-discovery";
import { discoverPrompts } from "@cloudpid/extensions/prompt-templates";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { IdleStop } from "./idle.ts";
import { ContainerLaunch, type LaunchRecord } from "./launch.ts";
import { ContainerResizes } from "./resize.ts";
import { workspaceObjectsRemote } from "./lifecycle.ts";
import { EMPTY_SKILL_SET, type SkillSet } from "./skill-set-schema.ts";
import { skillFile } from "./skills.fixtures.ts";
import { mountedSkills, PRIOR_SKILLS } from "./skills.ts";
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

/** A Skill set an Environment might hand its Workspaces: one Skill, `tdd`, with a file it refers to. */
const ENVIRONMENT_SET: SkillSet = {
  hash: "sha256:environment",
  files: { "tdd/SKILL.md": skillFile("tdd"), "tdd/tests.md": "# tests\n" },
};

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
      // The Container that was started died: it is not merely slow.
      exitInfo: async () =>
        starts.length === 0 ? null : { reason: "exited with 1", exitedAt: Date.now() },
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
      settings: async () => ({
        ...DEFAULT_CONTAINER_SETTINGS,
        instance: "standard-3",
        maxInstance: "standard-3",
      }),
      resized: async () => undefined,
      ignore: () => undefined,
      snapshots: {
        restorable: async () => ({ id: "snap-1", image: undefined }),
        restored: async () => undefined,
        coverage: async () => undefined,
        kept: async () => "snap-1",
        forget: async () => {
          forgotten++;
        },
        take: async () => "taken",
        capture: async () => ({ outcome: "skipped", reason: "not used" }),
      },
      image: () => undefined,
      load: async () => record,
      save: async (saved) => {
        record = saved;
      },
      running: () => false,
      now: () => Date.now(),
      warn: () => undefined,
      info: () => undefined,
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

    // The restart kept the size, dropped the snapshot, and the snapshot of the Container that died was forgotten.
    expect(restarts).toHaveLength(1);
    expect(restarts[0]?.instance).toBe("standard-3");
    expect(restarts[0]?.containerSnapshot).toBeUndefined();
    expect(forgotten).toBe(1);
  });
});

describe("the agent's resize, over ContainerLaunch and IdleStop in a Durable Object's storage", () => {
  type Spec = Parameters<IWorkspaceContainerAPI["start"]>[0];

  const SPEC: Spec = { env: {}, enableInternet: true, name: "WorkspaceContainer" };

  it("launches on the new size from the snapshot, keeps it through a restart, and the launch after the idle stop is on the Environment's size", async () => {
    await runInDurableObject(env.WORKSPACES.getByName("resize-until-idle"), async (_i, state) => {
      const { storage } = state;
      const starts: Spec[] = [];
      const taken: string[] = [];
      let running = false;
      let now = 1_000_000;
      let snapshot: { id: string; image: string } | undefined;

      const platform: IWorkspaceContainerAPI = {
        start: async (spec) => {
          starts.push(spec);
          running = true;

          return { runtimeId: "r", clientSecret: "s", outcome: "launched" };
        },
        restart: async () => {
          throw new Error("not used");
        },
        status: async () => ({ running, exit: null }),
        exitInfo: async () => null,
        interceptOutboundHttp: async () => undefined,
        interceptAllOutboundHttp: async () => undefined,
        setInactivityTimeout: async () => undefined,
        fetchPort: async () => {
          throw new Error("not used");
        },
        port: () => {
          throw new Error("not used");
        },
      };

      // The Environment's size is the default, cpu-1, under the default size limit, cpu-2.
      const settings = async () => DEFAULT_CONTAINER_SETTINGS;

      const launch: ContainerLaunch = new ContainerLaunch({
        settings,
        resized: () => resizes.recorded(),
        ignore: () => undefined,
        snapshots: {
          restorable: async () => snapshot,
          restored: async () => undefined,
          coverage: async () => undefined,
          kept: async () => snapshot?.id,
          forget: async () => undefined,
          take: async (reason) => {
            taken.push(reason);
            snapshot = { id: `snap-${taken.length}`, image: "img-1" };

            return "taken";
          },
          capture: async () => ({ outcome: "skipped", reason: "not used" }),
        },
        image: () => "img-1",
        load: () => storage.get<LaunchRecord>("test:launch"),
        save: (record) => storage.put("test:launch", record),
        running: () => running,
        writing: () => idle.writing(),
        now: () => now,
        warn: () => undefined,
        info: () => undefined,
      });

      const resizes: ContainerResizes = new ContainerResizes({
        settings,
        running: () => running,
        launched: async () => (await storage.get<LaunchRecord>("test:launch"))?.instance,
        load: () => storage.get<InstanceType>("test:resize"),
        save: (size) => storage.put("test:resize", size),
        clear: async () => {
          await storage.delete("test:resize");
        },
        snapshot: () => launch.snapshot("resize"),
        stop: async () => {
          running = false;
        },
        info: () => undefined,
      });

      const idle: IdleStop = new IdleStop({
        idleMs: () => launch.idleMs(),
        now: () => now,
        load: () => storage.get<number>("test:last-use"),
        save: (at) => storage.put("test:last-use", at),
        setAlarm: async () => undefined,
        snapshot: async () => {
          await launch.snapshot("idle");
        },
        stop: () => resizes.stopIdle(),
        wrote: () => launch.noteWrite(),
      });

      const container = launch.wrap(platform);
      const custom1 = { vcpu: 1, memoryMib: 3072, diskMb: 12_000 };
      const custom2 = { vcpu: 2, memoryMib: 6144, diskMb: 12_000 };

      // A Container on the Environment's size runs a command.
      await container.start(SPEC);
      await idle.touch();
      expect(starts[0]?.instance).toEqual(custom1);

      // A size above the limit stops nothing.
      expect(await resizes.resize("standard-3")).toEqual({ outcome: "refused", limit: "cpu-2" });
      expect(running).toBe(true);

      // The agent resizes: the Container is snapshotted and stopped, and the next command's launch restores it larger.
      expect(await resizes.resize("cpu-2")).toMatchObject({
        outcome: "resized",
        wasRunning: true,
        previous: "cpu-1",
        snapshotted: true,
      });
      expect(running).toBe(false);
      await container.start(SPEC);
      await idle.touch();
      expect(starts[1]).toMatchObject({ instance: custom2, containerSnapshot: { id: "snap-1" } });

      // A resize to the size it already runs on stops nothing.
      expect(await resizes.resize("cpu-2")).toEqual({ outcome: "unchanged", size: "cpu-2" });
      expect(running).toBe(true);

      // `container_restart` stops it without a snapshot: the next launch keeps the size. A command runs on it.
      running = false;
      await container.start(SPEC);

      const command = idle.hold();

      await command.begun;
      await command.end();
      expect(starts[2]?.instance).toEqual(custom2);

      // The idle stop snapshots and stops it, and forgets the size: the next launch is on the Environment's again.
      now += 3 * 60_000;
      await idle.alarm();
      expect(running).toBe(false);
      expect(taken).toEqual(["resize", "idle"]);
      expect(await storage.get("test:resize")).toBeUndefined();

      await container.start(SPEC);
      expect(starts[3]).toMatchObject({ instance: custom1, containerSnapshot: { id: "snap-2" } });
    });
  });
});

describe("the idle stop's snapshot, over ContainerLaunch and IdleStop in a Durable Object's storage", () => {
  type Spec = Parameters<IWorkspaceContainerAPI["start"]>[0];

  const SPEC: Spec = { env: {}, enableInternet: true, name: "WorkspaceContainer" };

  /** A fake platform and Container, kept outside the object so they outlive its eviction. */
  type PlatformFake = {
    running: boolean;
    now: number;
    /** The reason of each snapshot taken. */
    readonly taken: string[];
    stops: number;
    readonly infos: string[];
  };

  const platformFake = (): PlatformFake => ({
    running: false,
    now: 1_000_000,
    taken: [],
    stops: 0,
    infos: [],
  });

  /** The object's launch and idle stop over its storage, as a Workspace DO builds them after each start. */
  const objects = (storage: DurableObjectStorage, fake: PlatformFake) => {
    const platform: IWorkspaceContainerAPI = {
      start: async () => {
        fake.running = true;

        return { runtimeId: "r", clientSecret: "s", outcome: "launched" };
      },
      restart: async () => {
        throw new Error("not used");
      },
      status: async () => ({ running: fake.running, exit: null }),
      exitInfo: async () => null,
      interceptOutboundHttp: async () => undefined,
      interceptAllOutboundHttp: async () => undefined,
      setInactivityTimeout: async () => undefined,
      fetchPort: async () => {
        throw new Error("not used");
      },
      port: () => {
        throw new Error("not used");
      },
    };

    const launch: ContainerLaunch = new ContainerLaunch({
      settings: async () => DEFAULT_CONTAINER_SETTINGS,
      resized: async () => undefined,
      ignore: () => undefined,
      snapshots: {
        // The Workspace keeps snapshot snap-1, which a launch restores.
        restorable: async () => ({ id: "snap-1", image: "img-1" }),
        restored: async () => undefined,
        coverage: async () => undefined,
        kept: async () => "snap-1",
        forget: async () => undefined,
        take: async (reason) => {
          fake.taken.push(reason);

          return "taken";
        },
        capture: async () => ({ outcome: "skipped", reason: "not used" }),
      },
      image: () => "img-1",
      load: () => storage.get<LaunchRecord>("test:launch"),
      save: (record) => storage.put("test:launch", record),
      running: () => fake.running,
      writing: () => idle.writing(),
      now: () => fake.now,
      warn: () => undefined,
      info: (message) => fake.infos.push(message),
    });

    const idle: IdleStop = new IdleStop({
      idleMs: () => launch.idleMs(),
      now: () => fake.now,
      load: () => storage.get<number>("test:last-use"),
      save: (at) => storage.put("test:last-use", at),
      setAlarm: async () => undefined,
      snapshot: async () => {
        await launch.snapshot("idle");
      },
      stop: async () => {
        fake.running = false;
        fake.stops++;
      },
      wrote: () => launch.noteWrite(),
    });

    return { launch, idle, container: launch.wrap(platform) };
  };

  /** Restore the Container from the Workspace's snapshot and run `use` on it, evict the object, then run its idle alarm. */
  const restoreUseEvictAndIdle = async (
    name: string,
    use: (idle: IdleStop) => Promise<void>,
  ): Promise<PlatformFake> => {
    const workspace = env.WORKSPACES.getByName(name);
    const fake = platformFake();

    await runInDurableObject(workspace, async (_instance, state) => {
      const { container, idle } = objects(state.storage, fake);

      await container.start(SPEC);
      await use(idle);
    });

    await evictDurableObject(workspace);

    await runInDurableObject(workspace, async (_instance, state) => {
      fake.now += 3 * 60_000;
      await objects(state.storage, fake).idle.alarm();
    });

    return fake;
  };

  it("snapshots, after an eviction, a restored Container in which a command ran", async () => {
    const fake = await restoreUseEvictAndIdle("idle-snapshot-written", async (idle) => {
      const command = idle.hold();

      await command.begun;
      await command.end();
    });

    expect(fake.taken).toEqual(["idle"]);
    expect(fake.stops).toBe(1);
  });

  it("stops, after an eviction, a restored Container that was only read, without a snapshot, and says so", async () => {
    const fake = await restoreUseEvictAndIdle("idle-snapshot-read", async (idle) => {
      const read = idle.hold({ writes: false });

      await read.begun;
      await read.end();
    });

    expect(fake.taken).toEqual([]);
    expect(fake.stops).toBe(1);
    expect(fake.infos.join("\n")).toContain("no snapshot taken, that one stays current");
  });
});

/** An environment on `workspace` whose calls to the Workspace DO are listed, with the Workspace's skills in `/workspace/<repo>`. */
const countingEnv = (workspace: DurableObjectStub<TestWorkspace>, cwd: string) => {
  const calls: string[] = [];

  const counted = {
    fileOperation: (request: Parameters<typeof workspace.fileOperation>[0]) => {
      calls.push("fileOperation");

      return workspace.fileOperation(request);
    },
    skills: (at: string) => {
      calls.push("skills");

      return workspace.skills(at);
    },
    prompts: (at: string) => {
      calls.push("prompts");

      return workspace.prompts(at);
    },
    instructions: (directory: string) => {
      calls.push("instructions");

      return workspace.instructions(directory);
    },
    __getWorkspaceStub: () => workspace.__getWorkspaceStub(),
  };

  return { calls, env: new ComputerExecutionEnv({ workspace: counted, id: "computer:test", cwd }) };
};

describe("project instructions on the Workspace DO", () => {
  it("answers a lookup in one RPC call and finds what a walk of the files does", async () => {
    const workspace = env.WORKSPACES.getByName("instructions-discovery");
    const { calls, env: executionEnv } = countingEnv(workspace, "/workspace/repo");

    getOrThrow(await executionEnv.writeFile("/workspace/repo/AGENTS.md", "Repo rules.", context));
    getOrThrow(
      await executionEnv.writeFile("/workspace/repo/packages/app/CLAUDE.md", "App rules.", context),
    );

    calls.length = 0;

    const found = await executionEnv.discoverInstructions(
      "/workspace/repo/packages/app/src",
      context,
    );

    expect(calls).toEqual(["instructions"]);
    expect(found).toEqual([
      { path: "/workspace/repo/AGENTS.md", directory: "/workspace/repo", content: "Repo rules." },
      {
        path: "/workspace/repo/packages/app/CLAUDE.md",
        directory: "/workspace/repo/packages/app",
        content: "App rules.",
      },
    ]);

    const walked = await Effect.runPromise(
      discoverInstructions(
        { readTextFile: (path, at) => executionEnv.readTextFile(path, at) },
        "/workspace/repo/packages/app/src",
      ),
    );

    expect(found).toEqual(walked);
  });
});

describe("skill discovery on the Workspace DO", () => {
  it("answers a request in one RPC call, however many skills the repo holds, and finds what a walk of the files does", async () => {
    const workspace = env.WORKSPACES.getByName("skills-discovery");
    const { calls, env: executionEnv } = countingEnv(workspace, "/workspace/repo/packages/app");

    for (let index = 0; index < 30; index++) {
      const name = `repo-${String(index).padStart(2, "0")}`;

      getOrThrow(
        await executionEnv.writeFile(
          `/workspace/repo/.agents/skills/${name}/SKILL.md`,
          skillFile(name),
          context,
        ),
      );
    }

    getOrThrow(
      await executionEnv.writeFile(
        "/workspace/repo/packages/app/.agents/skills/near/SKILL.md",
        skillFile("near"),
        context,
      ),
    );

    await env.WORKSPACES.getByName("skills-discovery").updateSkills(ENVIRONMENT_SET);

    calls.length = 0;

    const found = await executionEnv.discoverSkills(context);

    expect(calls).toEqual(["skills"]);

    // Nearest first: the app's skill, the repo's thirty, then the Environment's.
    expect(found).toHaveLength(32);
    expect(found[0]?.name).toBe("near");
    expect(found.filter((skill) => skill.filePath.startsWith("/workspace/repo/")).length).toBe(31);
    expect(found.map((skill) => skill.name)).toContain("tdd");
    expect(found.find((skill) => skill.name === "tdd")?.filePath).toBe(
      "/workspace/.agents/skills/tdd/SKILL.md",
    );

    // The same skills a walk through the file operations finds, the Environment's read from the mount's own files.
    const walked = await Effect.runPromise(discoverSkills(executionEnv));

    expect(found).toEqual(walked);
  });

  it("answers the Skill set handed over in one RPC call, as a walk of the mount finds it, after an eviction too", async () => {
    const workspace = env.WORKSPACES.getByName("skills-handed-over");
    const { calls, env: executionEnv } = countingEnv(workspace, "/workspace/repo");

    expect(await executionEnv.discoverSkills(context)).toEqual([]);

    await workspace.updateSkills({
      hash: "sha256:handed",
      files: {
        "alpha/SKILL.md": skillFile("alpha"),
        "alpha/notes.md": "# notes\n",
        "beta/SKILL.md": skillFile("beta"),
      },
    });

    for (const evict of [false, true]) {
      if (evict) await evictDurableObject(workspace);

      calls.length = 0;

      const found = await executionEnv.discoverSkills(context);

      expect(calls).toEqual(["skills"]);
      expect(found.map((skill) => skill.filePath)).toEqual([
        "/workspace/.agents/skills/alpha/SKILL.md",
        "/workspace/.agents/skills/beta/SKILL.md",
      ]);
      expect(found).toEqual(await Effect.runPromise(discoverSkills(executionEnv)));
      expect(await workspace.skillSetHash()).toBe("sha256:handed");
    }
  });

  it("asks the Workspace for the skills of the environment's own directory", async () => {
    const workspace = env.WORKSPACES.getByName("skills-cwd");
    const { env: executionEnv } = countingEnv(workspace, "/workspace/other");

    getOrThrow(
      await executionEnv.writeFile(
        "/workspace/repo/.agents/skills/mine/SKILL.md",
        skillFile("mine"),
        context,
      ),
    );

    expect((await executionEnv.discoverSkills(context)).map((skill) => skill.name)).not.toContain(
      "mine",
    );
  });

  it("answers the Prompt templates of a directory in one RPC call, nearest first, as a walk of the files finds them, without their bodies", async () => {
    const workspace = env.WORKSPACES.getByName("prompts-discovery");
    const { calls, env: executionEnv } = countingEnv(workspace, "/workspace/repo/app");

    for (const [path, text] of [
      ["/workspace/repo/app/.agents/prompts/review.md", "---\ndescription: Near\n---\nReview $1"],
      ["/workspace/repo/.agents/prompts/review.md", "Far review"],
      ["/workspace/repo/.agents/prompts/ship.md", "---\nargument-hint: <tag>\n---\nShip $1"],
      ["/workspace/.agents/prompts/root.md", "At the root"],
      // Too big to expand: not listed, and found so by its size.
      ["/workspace/.agents/prompts/big.md", "x".repeat(256 * 1024 + 1)],
    ] as const) {
      getOrThrow(await executionEnv.writeFile(path, text, context));
    }

    calls.length = 0;

    const found = await executionEnv.discoverPrompts(context);

    expect(calls).toEqual(["prompts"]);
    expect(found).toEqual([
      {
        name: "review",
        description: "Near",
        filePath: "/workspace/repo/app/.agents/prompts/review.md",
      },
      {
        name: "ship",
        description: "Ship $1",
        argumentHint: "<tag>",
        filePath: "/workspace/repo/.agents/prompts/ship.md",
      },
      {
        name: "root",
        description: "At the root",
        filePath: "/workspace/.agents/prompts/root.md",
      },
    ]);
    expect(found).toEqual(await Effect.runPromise(discoverPrompts(executionEnv)));
  });

  it("reads a Skill set's Skills from the set in memory once per hash", () => {
    const first = mountedSkills(ENVIRONMENT_SET);

    expect(first.length).toBeGreaterThan(0);
    expect(mountedSkills(ENVIRONMENT_SET)).toBe(first);
    expect(mountedSkills(EMPTY_SKILL_SET)).toEqual([]);

    // The same hash at another mount has other paths.
    expect(
      mountedSkills(ENVIRONMENT_SET, "/elsewhere")[0]?.filePath.startsWith("/elsewhere/"),
    ).toBe(true);
    expect(mountedSkills(ENVIRONMENT_SET)[0]?.filePath.startsWith("/workspace/.agents/")).toBe(
      true,
    );

    // A set of another hash is read again, and not mistaken for a cached one.
    const files = { "a/SKILL.md": skillFile("a"), "a/notes.md": "# notes\n" };
    const one = mountedSkills({ hash: "v1", files }, "/m");

    expect(one.map((skill) => skill.filePath)).toEqual(["/m/a/SKILL.md"]);
    expect(
      mountedSkills({ hash: "v2", files: { "b/SKILL.md": skillFile("b") } }, "/m").map(
        (skill) => skill.name,
      ),
    ).toEqual(["b"]);
    // Workspaces of an isolate can hold different sets: each keeps its own parse.
    expect(mountedSkills({ hash: "v1", files }, "/m")).toBe(one);
    expect(mountedSkills(ENVIRONMENT_SET)).toBe(first);
  });
});

describe("a Workspace that had files at the Skill set's mount before it was mounted", () => {
  /** The Workspace `name`, with `files` written into its storage before it ever indexes the mount, as before the mount existed. */
  const seeded = async (name: string, files: Readonly<Record<string, string>>) => {
    const workspace = env.WORKSPACES.getByName(name);

    await runInDurableObject(workspace, async (_instance, state) => {
      // A Workspace without the mount, over the same storage: what an older deployment wrote.
      const before = new ComputerWorkspace({ storage: state.storage });

      for (const [path, text] of Object.entries(files)) {
        // A path ending in a slash is an empty directory.
        await before.fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });

        if (!path.endsWith("/")) await before.fs.writeFile(path, text);
      }
    });

    return {
      workspace,
      env: new ComputerExecutionEnv({ workspace, id: "computer:test", cwd: "/workspace" }),
    };
  };

  it("keeps them beside the mount instead of clearing them when the mount is first indexed", async () => {
    const { workspace, env: executionEnv } = await seeded("prior-skills", {
      "/workspace/.agents/skills/mine/SKILL.md": skillFile("mine"),
      "/workspace/.agents/skills/mine/notes.md": "my notes\n",
    });

    const skills = await executionEnv.discoverSkills(context);

    // The mount is the Skill set held (empty), and read-only now.
    expect(skills).toEqual([]);
    expect(getOrThrow(await executionEnv.exists("/workspace/.agents/skills/mine", context))).toBe(
      false,
    );
    expect((await executionEnv.writeFile("/workspace/.agents/skills/x", "x", context)).ok).toBe(
      false,
    );

    // Everything the Workspace had is where it was moved to, and a skill no longer.
    expect(
      getOrThrow(await executionEnv.readTextFile(`${PRIOR_SKILLS}/mine/notes.md`, context)),
    ).toBe("my notes\n");
    expect(
      getOrThrow(await executionEnv.readTextFile(`${PRIOR_SKILLS}/mine/SKILL.md`, context)),
    ).toBe(skillFile("mine"));

    // Reached again by a new instance of the object (an evicted one), nothing more is moved: the mount is the set's.
    await evictDurableObject(workspace);
    expect(await workspace.skills("/workspace")).toEqual(skills);
    expect(getOrThrow(await executionEnv.exists(`${PRIOR_SKILLS}-2`, context))).toBe(false);
  });

  it("does not overwrite files it kept before, and moves a second batch beside them", async () => {
    const { env: executionEnv } = await seeded("prior-skills-twice", {
      "/workspace/.agents/skills/one/SKILL.md": skillFile("one"),
      [`${PRIOR_SKILLS}/older/SKILL.md`]: skillFile("older"),
    });

    await executionEnv.discoverSkills(context);

    expect(
      getOrThrow(await executionEnv.readTextFile(`${PRIOR_SKILLS}/older/SKILL.md`, context)),
    ).toBe(skillFile("older"));
    expect(
      getOrThrow(await executionEnv.readTextFile(`${PRIOR_SKILLS}-2/one/SKILL.md`, context)),
    ).toBe(skillFile("one"));
  });

  it("moves nothing where there is nothing to keep: no directory, or an empty one", async () => {
    const empty = await seeded("prior-skills-empty", { "/workspace/.agents/skills/": "" });
    const none = await seeded("prior-skills-none", { "/workspace/README.md": "# hi\n" });

    for (const { env: executionEnv } of [empty, none]) {
      expect(await executionEnv.discoverSkills(context)).toEqual([]);
      expect(getOrThrow(await executionEnv.exists(PRIOR_SKILLS, context))).toBe(false);
    }
  });
});

describe("deleting a Workspace", () => {
  it("wipes its files and its settings, so its slug starts afresh", async () => {
    const workspace = env.WORKSPACES.getByName("delete-me");

    const executionEnv = new ComputerExecutionEnv({
      workspace,
      id: "computer:test",
      cwd: "/workspace",
    });

    getOrThrow(await executionEnv.createDir("/workspace/repo", { recursive: true }, context));
    getOrThrow(await executionEnv.writeFile("/workspace/repo/notes.md", "kept?", context));
    expect(
      await workspace.updateContainerSettings({ instance: "standard-3", idleMinutes: 10 }),
    ).toMatchObject({ ok: true });

    // As the main Worker deletes it: the wipe, then the reset in a call of its own, which breaks the stub that saw it;
    // the next stub, as each call of the main Worker takes one, reaches a new instance over the wiped storage.
    await workspaceObjectsRemote(env.WORKSPACES).destroy("delete-me");

    const again = env.WORKSPACES.getByName("delete-me");

    const after = new ComputerExecutionEnv({
      workspace: again,
      id: "computer:test",
      cwd: "/workspace",
    });

    const read = await after.readTextFile("/workspace/repo/notes.md", context);

    expect(read.ok ? read.value : read.error.code).toBe("not_found");
    expect(await again.containerSettings()).toEqual({
      settings: DEFAULT_CONTAINER_SETTINGS,
      overrides: {},
    });
  });
});

describe("restarting a Workspace's Container", () => {
  it("forgets the snapshot and keeps the files and settings", async () => {
    const workspace = env.WORKSPACES.getByName("restart-me");

    const executionEnv = new ComputerExecutionEnv({
      workspace,
      id: "computer:test",
      cwd: "/workspace",
    });

    getOrThrow(await executionEnv.writeFile("/workspace/notes.md", "kept", context));
    expect(await workspace.updateContainerSettings({ idleMinutes: 10 })).toMatchObject({
      ok: true,
    });

    await runInDurableObject(workspace, async (_instance, state) => {
      await state.storage.put("cloudpid:container-snapshot", {
        id: "snap-1",
        size: 1,
        takenAt: 1,
        refreshedAt: 1,
      });
    });
    expect(await workspace.resizeContainer({ size: "cpu-2" })).toMatchObject({
      outcome: "resized",
    });

    await workspaceObjectsRemote(env.WORKSPACES).restartContainer("restart-me");

    // The owner's restart starts over on the Environment's size: the agent's resize is forgotten.
    expect(
      await runInDurableObject(workspace, (_instance, state) =>
        state.storage.get("cloudpid:container-resize"),
      ),
    ).toBeUndefined();

    expect(getOrThrow(await executionEnv.readTextFile("/workspace/notes.md", context))).toBe(
      "kept",
    );
    expect((await workspace.containerSettings()).overrides).toEqual({ idleMinutes: 10 });
    expect(
      await runInDurableObject(workspace, (_instance, state) =>
        state.storage.get("cloudpid:container-snapshot"),
      ),
    ).toBeUndefined();
  });

  it("keeps the snapshot when the agent stops the Container, and says none was running", async () => {
    const workspace = env.WORKSPACES.getByName("agent-restarts");
    const snapshot = { id: "snap-2", size: 1, takenAt: 1, refreshedAt: 1 };

    await runInDurableObject(workspace, async (_instance, state) => {
      await state.storage.put("cloudpid:container-snapshot", snapshot);
    });

    // The test Worker runs no Container.
    expect(await workspace.stopContainer({ forgetSnapshot: false })).toEqual({ wasRunning: false });
    expect(
      await runInDurableObject(workspace, (_instance, state) =>
        state.storage.get("cloudpid:container-snapshot"),
      ),
    ).toEqual(snapshot);

    expect(await workspace.stopContainer({ forgetSnapshot: true })).toEqual({ wasRunning: false });
    expect(
      await runInDurableObject(workspace, (_instance, state) =>
        state.storage.get("cloudpid:container-snapshot"),
      ),
    ).toBeUndefined();
  });

  it("records the agent's resize for the next launch, within the Environment's size limit, and keeps it through a restart", async () => {
    const workspace = env.WORKSPACES.getByName("agent-resizes");

    const resized = () =>
      runInDurableObject(workspace, (_instance, state) =>
        state.storage.get("cloudpid:container-resize"),
      );

    expect(await workspace.updateContainerSettings({ maxInstance: "standard-3" })).toMatchObject({
      ok: true,
    });

    // The test Worker runs no Container: the size is only recorded.
    expect(await workspace.resizeContainer({ size: "standard-3" })).toEqual({
      outcome: "resized",
      wasRunning: false,
      previous: "cpu-1",
      next: "standard-3",
      environment: "cpu-1",
      snapshotted: false,
    });
    expect(await resized()).toBe("standard-3");

    expect(await workspace.resizeContainer({ size: "standard-4" })).toEqual({
      outcome: "refused",
      limit: "standard-3",
    });
    expect(await workspace.stopContainer({ forgetSnapshot: true })).toEqual({ wasRunning: false });
    expect(await resized()).toBe("standard-3");

    // Back to the Environment's own size: nothing is recorded.
    expect(await workspace.resizeContainer({ size: "cpu-1" })).toMatchObject({
      previous: "standard-3",
      next: "cpu-1",
    });
    expect(await resized()).toBeUndefined();
  });
});

describe("a spare Workspace preparing itself", () => {
  /** Wait for `done` to hold, as work the alarm started goes on after it. */
  const until = async (done: () => Promise<boolean>) => {
    for (let tries = 0; tries < 200 && !(await done()); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  it("readies itself at its alarm, over its own files and Container", async () => {
    const workspace = env.WORKSPACES.getByName("spare-prepares");

    await workspace.prepareSpare({
      repos: [{ name: "app", url: "https://github.com/acme/app.git" }],
      branch: "cloudpid/spare",
      base: null,
      settings: { idleMinutes: 30 },
    });

    // The alarm is due at once; it may have fired already.
    await runDurableObjectAlarm(workspace);

    const preparation = () =>
      runInDurableObject(workspace, (_instance, state) =>
        state.storage.get("cloudpid:spare-preparation"),
      );

    await until(async () => (await preparation()) === undefined);

    // The settings were handed over, and the clone found missing (its `.git/HEAD` read from the files) was asked of
    // the Container, with its Setup and Start Scripts; this one has no Container, so the readying failed, and the
    // request is forgotten, leaving the spare to the Session that takes it.
    expect((await workspace.containerSettings()).overrides).toEqual({ idleMinutes: 30 });
    expect((await workspace.liveStubs()).container).toBe(3);
    expect(await preparation()).toBeUndefined();
  });
});

describe("an exit report on the Workspace DO", () => {
  const kept = {
    name: "API_KEY",
    value: "sk-live-0123456789abcdef",
    scope: "environment" as const,
    build: false,
  };

  it("has the Environment's Secrets taken out with the copy the DO keeps sealed, after an eviction too", async () => {
    const workspace = env.WORKSPACES.getByName("exit-report-redaction");

    await workspace.updateEnvironmentSecrets([kept]);

    expect(await workspace.redactExitReport(`Error: bad key ${kept.value}`)).toBe(
      `Error: bad key ${secretReference("API_KEY")}`,
    );

    await evictDurableObject(workspace);

    const redacted = await workspace.redactExitReport(`Error: bad key ${kept.value}`);

    expect(redacted).toBe(`Error: bad key ${secretReference("API_KEY")}`);
  });

  it("is not answered while the copy does not open: the report cannot be shown free of them", async () => {
    const workspace = env.WORKSPACES.getByName("exit-report-unopened");

    await workspace.updateEnvironmentSecrets([kept]);
    await runInDurableObject(workspace, async (_instance, state) => {
      // As a copy sealed under another key reads: a Secret whose value does not open.
      await state.storage.put("cloudpid:environment-secrets", {
        version: 1,
        secrets: [{ name: "API_KEY", scope: "environment", build: false, sealed: null }],
      });
    });
    await evictDurableObject(workspace);

    expect(await workspace.redactExitReport(`Error: bad key ${kept.value}`)).toBeNull();
  });
});
