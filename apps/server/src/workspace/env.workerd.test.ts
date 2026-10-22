// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off preferEffectArray:off preferEffectRecord:off
import { Workspace as ComputerWorkspace } from "@cloudflare/computer";
import {
  ContainerBackend,
  type IWorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { DEFAULT_MACHINE_SETTINGS } from "@cloudpid/config";
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { discoverSkills } from "@cloudpid/extensions/skills-discovery";
import { discoverPrompts } from "@cloudpid/extensions/prompt-templates";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { BUNDLED_SKILLS } from "./bundled-skills.generated.ts";
import { ContainerLaunch, type LaunchRecord } from "./launch.ts";
import { workspaceObjectsRemote } from "./lifecycle.ts";
import { bundledSkills, PRIOR_SKILLS } from "./skills.ts";
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
      settings: async () => ({ ...DEFAULT_MACHINE_SETTINGS, instance: "standard-3" }),
      ignore: () => undefined,
      snapshots: {
        restorable: async () => ({ id: "snap-1", image: undefined }),
        restored: async () => undefined,
        forget: async () => {
          forgotten++;
        },
        take: async () => "taken",
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

/** A skill's `SKILL.md`. */
const skillFile = (name: string) =>
  `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n# ${name}\n`;

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
    __getWorkspaceStub: () => workspace.__getWorkspaceStub(),
  };

  return { calls, env: new ComputerExecutionEnv({ workspace: counted, id: "computer:test", cwd }) };
};

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

    calls.length = 0;

    const found = await executionEnv.discoverSkills(context);

    expect(calls).toEqual(["skills"]);

    // Nearest first: the app's skill, the repo's thirty, then the bundled ones.
    expect(found[0]?.name).toBe("near");
    expect(found.filter((skill) => skill.filePath.startsWith("/workspace/repo/")).length).toBe(31);
    expect(found.map((skill) => skill.name)).toContain("tdd");
    expect(found.find((skill) => skill.name === "tdd")?.filePath).toBe(
      "/workspace/.agents/skills/tdd/SKILL.md",
    );

    // The same skills a walk through the file operations finds, the bundled ones read from the mount's own files.
    const walked = await Effect.runPromise(discoverSkills(executionEnv));

    expect(found).toEqual(walked);
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

  it("reads the bundled skills from the bundle once per version", () => {
    const first = bundledSkills(BUNDLED_SKILLS);

    expect(first.length).toBeGreaterThan(0);
    expect(bundledSkills(BUNDLED_SKILLS)).toBe(first);

    // The same version at another mount has other paths.
    expect(bundledSkills(BUNDLED_SKILLS, "/elsewhere")[0]?.filePath.startsWith("/elsewhere/")).toBe(
      true,
    );
    expect(bundledSkills(BUNDLED_SKILLS)[0]?.filePath.startsWith("/workspace/.agents/")).toBe(true);

    // A bundle of another version is read again, and not mistaken for the cached one.
    const files = { "a/SKILL.md": skillFile("a"), "a/notes.md": "# notes\n" };

    expect(bundledSkills({ version: "v1", files }, "/m").map((skill) => skill.filePath)).toEqual([
      "/m/a/SKILL.md",
    ]);
    expect(
      bundledSkills({ version: "v2", files: { "b/SKILL.md": skillFile("b") } }, "/m").map(
        (skill) => skill.name,
      ),
    ).toEqual(["b"]);
  });
});

describe("a Workspace that had files at the bundled skills' mount before it was mounted", () => {
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

    // The mount is the bundle, and read-only now.
    expect(skills.map((skill) => skill.name)).toContain("tdd");
    expect(skills.map((skill) => skill.name)).not.toContain("mine");
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

    // Reached again by a new instance of the object (an evicted one), nothing more is moved: the mount is the bundle's.
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
      expect((await executionEnv.discoverSkills(context)).map((skill) => skill.name)).toContain(
        "tdd",
      );
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
      settings: DEFAULT_MACHINE_SETTINGS,
      overrides: {},
    });
  });
});

describe("resetting a Workspace", () => {
  it("wipes its files but keeps its settings", async () => {
    const workspace = env.WORKSPACES.getByName("reset-me");

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

    // As the main Worker resets it: the clear, then the reset in a call of its own.
    await workspaceObjectsRemote(env.WORKSPACES).clear("reset-me");

    const again = env.WORKSPACES.getByName("reset-me");

    const after = new ComputerExecutionEnv({
      workspace: again,
      id: "computer:test",
      cwd: "/workspace",
    });

    const read = await after.readTextFile("/workspace/repo/notes.md", context);

    expect(read.ok ? read.value : read.error.code).toBe("not_found");
    expect(await again.containerSettings()).toEqual({
      settings: { ...DEFAULT_MACHINE_SETTINGS, instance: "standard-3", idleMinutes: 10 },
      overrides: { instance: "standard-3", idleMinutes: 10 },
    });
    // The bundled skills are mounted again in the fresh Workspace.
    expect((await after.discoverSkills(context)).map((skill) => skill.name)).toContain("tdd");
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

    await workspaceObjectsRemote(env.WORKSPACES).restartContainer("restart-me");

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
});
