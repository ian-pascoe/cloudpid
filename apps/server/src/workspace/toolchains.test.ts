// The Container's Toolchains on the Workspace DO's side (docs/spec.md → Container and Toolchains, ADR-0004): the
// bootstrap that runs before the first command of each Container start, and the environment every command gets. The
// Container is a fake backend whose shell records what it is asked and answers from a script.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferEffectArray:off
import { secretReference } from "@cloudpid/extensions/secrets/core";
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import { DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import {
  BOOTSTRAP_CHANGED,
  ENVIRONMENT_SETUP_FILE,
  ENVIRONMENT_START_FILE,
  SETUP_TIMED_OUT_MESSAGE,
  START_TIMED_OUT_MESSAGE,
} from "@cloudpid/sandbox-image/toolchains";
import { describe, expect, it } from "vitest";
import { ToolchainBackend } from "./toolchains.ts";

type Shell = BackendHandle["rpc"]["shell"];

type ExecInput = Parameters<Shell["exec"]>[0];

const encoder = new TextEncoder();

/** Whether `input` is the bootstrap, whose script is the only one that defines this function. */
const isBootstrap = (input: ExecInput) => input.source.includes("has_mise_config");

/** Whether `input` lists the due Setup Scripts. */
const isSetupList = (input: ExecInput) => input.source.includes("/.agents/setup.sh ] || continue");

/** Whether `input` runs a script of the bootstrap's own, bounded in time (a command's note may quote one's output). */
const isScriptRun = (input: ExecInput) =>
  input.source.startsWith("exec bash -c") && input.source.includes("timeout --kill-after");

/** Whether `input` runs a Setup Script: the only scripts that can print its time-out message. */
const isSetupRun = (input: ExecInput) =>
  isScriptRun(input) && input.source.includes("Setup Script ran past its time");

/** Whether `input` lists the repos' Start Scripts. */
const isStartList = (input: ExecInput) => input.source.includes("/.agents/start.sh ] && printf");

/** Whether `input` runs a Start Script. */
const isStartRun = (input: ExecInput) =>
  isScriptRun(input) && input.source.includes("Start Script ran past its time");

/** `source` with the quoting of a note taken off its apostrophes. */
const unquoted = (source: string | undefined) => source?.replaceAll("'\\''", "'");

/** Whether `input` is part of a bootstrap: its install, its Setup Scripts, or its Start Scripts. */
const isOwn = (input: ExecInput) =>
  isBootstrap(input) ||
  isSetupList(input) ||
  isSetupRun(input) ||
  isStartList(input) ||
  isStartRun(input);

/** A stream of one command's events: its output (each of `stdout` a chunk), then its exit. */
const events = (id: string, stdout: readonly string[], stderr: string, code: number) =>
  new ReadableStream({
    start(controller) {
      let seq = 0;

      for (const chunk of stdout) {
        controller.enqueue({ id, seq: seq++, name: "stdout", value: encoder.encode(chunk) });
      }

      if (stderr !== "") {
        controller.enqueue({ id, seq: seq++, name: "stderr", value: encoder.encode(stderr) });
      }

      controller.enqueue({ id, seq: seq++, name: "exit", code });
      controller.close();
    },
  });

/** What a fake Container's shell does with a command: its stderr and exit status, after `gate` if there is one. */
type Answer = { stdout?: string[]; stderr?: string; code?: number; gate?: Promise<void> };

/** A Container that records the commands it is sent, and what happened to its connection. */
const fakeContainer = (answer: (input: ExecInput) => Answer = () => ({})) => {
  const execs: ExecInput[] = [];
  const disposed: string[] = [];
  const kills: string[] = [];
  let connects = 0;
  let runtimeId = "runtime-1";

  const backend: WorkspaceBackend = {
    id: "container-shell",
    type: "cloudflare-container",
    description: "a fake Container",
    async connect() {
      connects++;

      const shell: Shell = {
        async exec(input) {
          execs.push(input);

          const { stdout = [], stderr = "", code = 0, gate } = answer(input);

          await gate;

          return {
            id: input.id ?? `exec-${execs.length}`,
            events: events("x", stdout, stderr, code),
          };
        },
        getExec: async ({ id }) => ({ id, events: events("x", ["g", "hp_secret g"], "", 0) }),
        killExec: async ({ id }) => {
          kills.push(id);
        },
        disposeExec: async ({ id }) => {
          disposed.push(id);
        },
      };

      // SAFETY: the bootstrap and the commands only use the shell; nothing here touches the sync half.
      const sync = {} as BackendHandle["rpc"]["sync"];

      return {
        runtimeId,
        rpc: { shell, sync },
        close: () => Promise.resolve(),
      };
    },
  };

  return {
    backend,
    execs,
    disposed,
    kills,
    connects: () => connects,
    restart: () => {
      runtimeId = `runtime-${connects + 1}`;
    },
  };
};

/** The commands the backend was sent that are not its bootstrap. */
const commands = (execs: readonly ExecInput[]) => execs.filter((input) => !isOwn(input));

const bootstraps = (execs: readonly ExecInput[]) => execs.filter((input) => isBootstrap(input));

// SAFETY: the fake backend ignores the host computer would pass it.
const host = {} as Parameters<WorkspaceBackend["connect"]>[0];

const open = (
  container: ReturnType<typeof fakeContainer>,
  options: Partial<ConstructorParameters<typeof ToolchainBackend>[0]> = {},
) => {
  const warnings: string[] = [];
  const clock = { now: 1_000_000 };

  const toolchains = new ToolchainBackend({
    backend: container.backend,
    githubToken: "ghp_secret",
    git: { name: "Pi Agent", email: "pi@example.com" },
    warn: (message) => warnings.push(message),
    now: () => clock.now,
    ...options,
  });

  return { toolchains, warnings, clock };
};

describe("the Container's backend as the Workspace sees it", () => {
  it("is the Container's backend: same id, type and description", () => {
    const { toolchains } = open(fakeContainer());

    expect(toolchains.id).toBe("container-shell");
    expect(toolchains.type).toBe("cloudflare-container");
    expect(toolchains.description).toBe("a fake Container");
  });

  it("keeps the connection's own runtime id", async () => {
    const container = fakeContainer();
    const handle = await open(container).toolchains.connect(host);

    expect(handle.runtimeId).toBe("runtime-1");
  });
});

describe("the hook after a successful install", () => {
  it("runs once the bootstrap succeeded, before the command that waited for it is sent", async () => {
    const container = fakeContainer();
    const seen: number[] = [];

    const { toolchains } = open(container, {
      afterInstall: async () => {
        seen.push(container.execs.length);
      },
    });

    const handle = await toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "git --version" });
    await handle.rpc.shell.exec({ source: "git status" });

    // Only the bootstrap (and its look for Setup Scripts) had been sent when it ran, and it ran once.
    expect(seen).toEqual([2]);
  });

  it("is told the bootstrap changed the Container's disk when its output ends with the marker", async () => {
    // The marker split across chunks, after more output than a failure's report keeps.
    const [head, tail] = [BOOTSTRAP_CHANGED.slice(0, 9), BOOTSTRAP_CHANGED.slice(9)];

    const container = fakeContainer((input) =>
      isBootstrap(input) ? { stdout: ["x".repeat(5_000), `\n${head}`, `${tail}\n`] } : {},
    );

    const seen: boolean[] = [];

    const { toolchains } = open(container, {
      afterInstall: async (changed) => {
        seen.push(changed);
      },
    });

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "true" });

    expect(seen).toEqual([true]);
  });

  it("is told nothing changed when the bootstrap printed no marker: everything was there already", async () => {
    const container = fakeContainer((input) =>
      isBootstrap(input)
        ? { stdout: ["mise all tools are installed\n"], stderr: BOOTSTRAP_CHANGED }
        : {},
    );

    const seen: boolean[] = [];

    const { toolchains } = open(container, {
      afterInstall: async (changed) => {
        seen.push(changed);
      },
    });

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "true" });

    // On stderr it is not the bootstrap's marker (a tool could print anything there).
    expect(seen).toEqual([false]);
  });

  it("does not run when the bootstrap failed", async () => {
    const container = fakeContainer((input) => (isBootstrap(input) ? { code: 1 } : {}));
    let runs = 0;

    const { toolchains } = open(container, {
      afterInstall: async () => {
        runs++;
      },
    });

    const handle = await toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "true" });

    expect(runs).toBe(0);
  });

  it("does not fail the bootstrap or the command when it throws", async () => {
    const container = fakeContainer();

    const { toolchains, warnings } = open(container, {
      afterInstall: async () => {
        throw new Error("no snapshots here");
      },
    });

    const handle = await toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "git --version" });

    expect(commands(container.execs).map((input) => input.source)).toEqual(["git --version"]);
    expect(warnings.join("\n")).toContain("no snapshots here");
  });
});

describe("the bootstrap", () => {
  it("runs before the first command of a Container start, which waits for it", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));

    const container = fakeContainer((input) => (isBootstrap(input) ? { gate } : {}));

    const handle = await open(container).toolchains.connect(host);

    const command = handle.rpc.shell.exec({ source: "git --version" });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // The bootstrap is under way; the command has not been sent.
    expect(container.execs).toHaveLength(1);
    expect(container.execs[0]?.source).toContain("mise install");

    finish();
    await command;

    expect(commands(container.execs).map((input) => input.source)).toEqual(["git --version"]);
    expect(container.execs.at(-1)?.source).toBe("git --version");
  });

  it("runs in the Workspace root, bounded in time", async () => {
    const container = fakeContainer();
    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "true" });

    const [bootstrap] = bootstraps(container.execs);

    expect(bootstrap?.cwd).toBe("/workspace");
    expect(bootstrap?.timeoutMs).toBeGreaterThan(60_000);
  });

  it("locks the directories it is told the Workspace holds read-only, and no others", async () => {
    for (const [readOnlyDirectories, locked] of [
      [["/workspace/.agents/skills"], true],
      [undefined, false],
    ] as const) {
      const container = fakeContainer();
      const handle = await open(container, { readOnlyDirectories }).toolchains.connect(host);

      await handle.rpc.shell.exec({ source: "true" });

      const source = bootstraps(container.execs)[0]?.source ?? "";

      expect(source.includes("/workspace/.agents/skills")).toBe(locked);
    }
  });

  it("runs bash, because computerd's shell is dash", async () => {
    const container = fakeContainer();
    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "true" });

    expect(bootstraps(container.execs)[0]?.source).toMatch(/^exec bash -c /);
  });

  it("is shared by commands that arrive while it runs", async () => {
    const container = fakeContainer();
    const handle = await open(container).toolchains.connect(host);

    await Promise.all([
      handle.rpc.shell.exec({ source: "a" }),
      handle.rpc.shell.exec({ source: "b" }),
      handle.rpc.shell.exec({ source: "c" }),
    ]);

    expect(bootstraps(container.execs)).toHaveLength(1);
    expect(commands(container.execs).map((input) => input.source)).toEqual(["a", "b", "c"]);
  });

  it("does not run again for later commands", async () => {
    const container = fakeContainer();
    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "a" });
    await handle.rpc.shell.exec({ source: "b" });

    expect(bootstraps(container.execs)).toHaveLength(1);
  });

  it("releases its own exec once it has finished", async () => {
    const container = fakeContainer();
    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "a" });

    // The install's exec, and the looks for Setup and Start Scripts.
    expect(container.disposed).toHaveLength(3);
  });

  it("runs again after the Container restarts, and not after a mere reconnect", async () => {
    const container = fakeContainer();
    const { toolchains } = open(container);

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "a" });
    // The same Container, a new connection to it: the Toolchains are there.
    await (await toolchains.connect(host)).rpc.shell.exec({ source: "b" });

    expect(container.connects()).toBe(2);
    expect(bootstraps(container.execs)).toHaveLength(1);

    container.restart();
    await (await toolchains.connect(host)).rpc.shell.exec({ source: "c" });

    expect(bootstraps(container.execs)).toHaveLength(2);
  });

  it("does not stop a command when it fails, and says so without the token", async () => {
    const container = fakeContainer((input) =>
      isBootstrap(input)
        ? { stderr: "mise ERROR download failed (token ghp_secret)", code: 1 }
        : {},
    );

    const { toolchains, warnings } = open(container);
    const handle = await toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "echo hi" });

    expect(commands(container.execs)).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("exit status 1");
    expect(warnings[0]).toContain("download failed");
    expect(warnings.join("\n")).not.toContain("ghp_secret");
  });

  it("is tried again by a later command once a failure is a minute old, not before", async () => {
    let fail = true;

    const container = fakeContainer((input) => (isBootstrap(input) ? { code: fail ? 1 : 0 } : {}));

    const { toolchains, clock } = open(container);
    const handle = await toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "a" });
    clock.now += 30_000;
    await handle.rpc.shell.exec({ source: "b" });

    expect(bootstraps(container.execs)).toHaveLength(1);

    fail = false;
    clock.now += 31_000;
    await handle.rpc.shell.exec({ source: "c" });
    await handle.rpc.shell.exec({ source: "d" });

    expect(bootstraps(container.execs)).toHaveLength(2);
  });

  it("waits twice as long after each failure in a row, up to a quarter of an hour", async () => {
    const container = fakeContainer((input) => (isBootstrap(input) ? { code: 1 } : {}));
    const { toolchains, clock } = open(container);
    const handle = await toolchains.connect(host);

    /** Moves the clock on and sends a command; how many bootstraps have run. */
    const after = async (seconds: number) => {
      clock.now += seconds * 1000;
      await handle.rpc.shell.exec({ source: "x" });

      return bootstraps(container.execs).length;
    };

    expect(await after(0)).toBe(1);

    // A minute, then two, four, eight, fifteen, and fifteen again.
    for (const [attempt, seconds] of [60, 120, 240, 480, 900, 900].entries()) {
      expect(await after(seconds - 1)).toBe(attempt + 1);
      expect(await after(1)).toBe(attempt + 2);
    }
  });

  it("tells the command that waited for a failed bootstrap, on its stderr, without the token", async () => {
    const container = fakeContainer((input) =>
      isBootstrap(input) ? { stderr: "mise ERROR no such tool (ghp_secret)", code: 1 } : {},
    );

    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "git --version" });

    const [command] = commands(container.execs);

    expect(command?.source).toMatch(/^printf .*>&2\ngit --version$/s);
    expect(command?.source).toContain("Toolchain bootstrap failed (exit status 1)");
    expect(command?.source).toContain("no such tool (***)");
    expect(command?.source).not.toContain("ghp_secret");
  });

  it("points later commands to the failure while it is not retried yet", async () => {
    const container = fakeContainer((input) => (isBootstrap(input) ? { code: 2 } : {}));
    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "a" });
    await handle.rpc.shell.exec({ source: "b" });

    const [, second] = commands(container.execs);

    expect(second?.source).toContain("failed earlier (exit status 2)");
    expect(second?.source).toMatch(/\nb$/);
  });

  it("sends a command as it is once the bootstrap succeeded", async () => {
    const container = fakeContainer();
    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "a" });

    expect(commands(container.execs)[0]?.source).toBe("a");
  });

  it("carries the git identity and the token, for git and gh", async () => {
    const container = fakeContainer();
    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "true" });

    expect(bootstraps(container.execs)[0]?.env).toMatchObject({
      CLOUDPID_GIT_NAME: "Pi Agent",
      CLOUDPID_GIT_EMAIL: "pi@example.com",
      GITHUB_TOKEN: "ghp_secret",
    });
  });
});

describe("a command's environment", () => {
  it("has the token, mise's trust settings, no git prompts, and Turborepo's cache on the Container's disk", async () => {
    const container = fakeContainer();
    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "gh auth status" });

    expect(commands(container.execs)[0]?.env).toEqual({
      GH_TOKEN: "ghp_secret",
      GITHUB_TOKEN: "ghp_secret",
      MISE_GLOBAL_CONFIG_FILE: "/workspace/mise.toml",
      MISE_TRUSTED_CONFIG_PATHS: "/workspace",
      MISE_YES: "1",
      GIT_TERMINAL_PROMPT: "0",
      TURBO_CACHE_DIR: "/root/.cache/turbo",
    });
  });

  it("keeps what the caller passes, over its own", async () => {
    const container = fakeContainer();
    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({
      source: "true",
      env: { GITHUB_TOKEN: "ghp_theirs", CI: "1" },
    });

    expect(commands(container.execs)[0]?.env).toMatchObject({
      GITHUB_TOKEN: "ghp_theirs",
      GH_TOKEN: "ghp_secret",
      CI: "1",
    });
  });

  it("has no token variable where the stack bound none", async () => {
    const container = fakeContainer();
    const handle = await open(container, { githubToken: undefined }).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "true" });

    expect(commands(container.execs)[0]?.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(commands(container.execs)[0]?.env).not.toHaveProperty("GH_TOKEN");
  });
});

describe("a command killed while it waits for the bootstrap", () => {
  it("is not run once the bootstrap ends, and ends with an exit status", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const container = fakeContainer((input) => (isBootstrap(input) ? { gate } : {}));
    const handle = await open(container).toolchains.connect(host);

    const command = handle.rpc.shell.exec({ id: "cmd-1", source: "git --version" });
    const other = handle.rpc.shell.exec({ id: "cmd-2", source: "git status" });

    await handle.rpc.shell.killExec({ id: "cmd-1" });
    finish();

    const execution = await command;
    await other;

    expect(commands(container.execs).map((input) => input.id)).toEqual(["cmd-2"]);
    // The Container never heard of the command, so it is not asked to kill it.
    expect(container.kills).toEqual([]);

    const reader = execution.events.getReader();
    const exit = await reader.read();

    expect(exit.value).toMatchObject({ name: "exit" });
    expect(exit.value?.name === "exit" ? exit.value.code : 0).not.toBe(0);
  });

  it("is killed on the Container as usual once it has started", async () => {
    const container = fakeContainer();
    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ id: "cmd-1", source: "sleep 60" });
    await handle.rpc.shell.killExec({ id: "cmd-1" });

    expect(container.kills).toEqual(["cmd-1"]);
  });
});

/** Everything a command printed, by stream, and its exit: what its client sees. */
const output = async (execution: Awaited<ReturnType<Shell["exec"]>>) => {
  const seen = { stdout: "", stderr: "", exits: 0, lastName: "" };
  const decoder = new TextDecoder();
  const reader = execution.events.getReader();

  for (;;) {
    const next = await reader.read();

    if (next.done) break;

    seen.lastName = next.value.name;

    if (next.value.name === "exit") seen.exits++;
    else seen[next.value.name] += decoder.decode(next.value.value, { stream: true });
  }

  return seen;
};

describe("a command's output", () => {
  it("has the token taken out, wherever the chunks split it", async () => {
    const container = fakeContainer((input) =>
      isBootstrap(input)
        ? {}
        : { stdout: ["GH_TOKEN=gh", "p_sec", "ret\n", "done\n"], stderr: "ghp_secret!" },
    );

    const handle = await open(container).toolchains.connect(host);
    const seen = await output(await handle.rpc.shell.exec({ source: "env" }));

    expect(seen.stdout).toBe("GH_TOKEN=***\ndone\n");
    expect(seen.stderr).toBe("***!");
    expect(seen.exits).toBe(1);
  });

  it("has the Environment's Secrets taken out too, each as its reference", async () => {
    const kept = {
      name: "API_KEY",
      value: "sk-live-0123456789",
      scope: "environment" as const,
      build: false,
    };

    const container = fakeContainer((input) =>
      isBootstrap(input) ? {} : { stdout: ["KEY=sk-live-01", "23456789 token=ghp_secret\n"] },
    );

    const handle = await open(container, {
      secrets: { read: async () => [kept], known: () => [kept] },
    }).toolchains.connect(host);

    const seen = await output(await handle.rpc.shell.exec({ source: "env" }));

    expect(seen.stdout).toBe(`KEY=${secretReference("API_KEY")} token=***\n`);
  });

  it("gets what was held back at the end before the exit", async () => {
    const container = fakeContainer((input) =>
      isBootstrap(input) ? {} : { stdout: ["almost ghp_sec"] },
    );

    const handle = await open(container).toolchains.connect(host);
    const seen = await output(await handle.rpc.shell.exec({ source: "x" }));

    expect(seen.stdout).toBe("almost ghp_sec");
    expect(seen.lastName).toBe("exit");
  });

  it("has the token taken out of an execution resumed with getExec too", async () => {
    const container = fakeContainer();
    const handle = await open(container).toolchains.connect(host);
    const seen = await output(await handle.rpc.shell.getExec({ id: "cmd-1" }));

    expect(seen.stdout).toBe("*** g");
  });

  it("is as the Container wrote it where the stack bound no token", async () => {
    const container = fakeContainer((input) =>
      isBootstrap(input) ? {} : { stdout: ["ghp_secret"] },
    );

    const handle = await open(container, { githubToken: undefined }).toolchains.connect(host);
    const seen = await output(await handle.rpc.shell.exec({ source: "x" }));

    expect(seen.stdout).toBe("ghp_secret");
  });
});

describe("the bootstrap without a command (`runBootstrap`, the early start)", () => {
  it("runs on the Container connected last, and the first command then waits for nothing", async () => {
    const container = fakeContainer();
    const { toolchains } = open(container);
    const handle = await toolchains.connect(host);

    await toolchains.runBootstrap();

    expect(bootstraps(container.execs)).toHaveLength(1);
    expect(commands(container.execs)).toEqual([]);

    await handle.rpc.shell.exec({ source: "git status" });

    expect(bootstraps(container.execs)).toHaveLength(1);
    expect(commands(container.execs).map((input) => input.source)).toEqual(["git status"]);
  });

  it("is the one bootstrap a command that arrives meanwhile waits for", async () => {
    let release: () => void = () => undefined;

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const container = fakeContainer((input) => (isBootstrap(input) ? { gate } : {}));
    const { toolchains } = open(container);
    const handle = await toolchains.connect(host);

    const ran = toolchains.runBootstrap();
    const command = handle.rpc.shell.exec({ source: "git status" });

    release();
    await Promise.all([ran, command]);

    expect(bootstraps(container.execs)).toHaveLength(1);
    expect(commands(container.execs)).toHaveLength(1);
  });

  it("does nothing before any connection", async () => {
    const container = fakeContainer();
    const { toolchains } = open(container);

    await toolchains.runBootstrap();

    expect(container.execs).toEqual([]);
  });

  it("does not fail when the bootstrap does, and leaves the first command its own attempt", async () => {
    let attempts = 0;

    const container = fakeContainer((input) => {
      if (!isBootstrap(input)) return {};

      attempts++;

      return { code: attempts === 1 ? 1 : 0 };
    });

    const { toolchains, warnings } = open(container);
    const handle = await toolchains.connect(host);

    await expect(toolchains.runBootstrap()).resolves.toBeUndefined();
    expect(warnings.join("\n")).toContain("Toolchain bootstrap failed");

    // No wait before the retry, as there would be after a command's own failure: the command bootstraps as it would
    // have without the early start, and here it succeeds.
    await handle.rpc.shell.exec({ source: "git status" });

    expect(bootstraps(container.execs)).toHaveLength(2);
    expect(commands(container.execs).map((input) => input.source)).toEqual(["git status"]);
  });

  it("gives a command that waited for a bootstrap that failed the note with its output", async () => {
    let release: () => void = () => undefined;

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const container = fakeContainer((input) =>
      isBootstrap(input) ? { gate, code: 1, stderr: "mise broke" } : {},
    );

    const { toolchains } = open(container);
    const handle = await toolchains.connect(host);
    const ran = toolchains.runBootstrap();
    const command = handle.rpc.shell.exec({ source: "true" });

    release();
    await Promise.all([ran, command]);

    expect(commands(container.execs)[0]?.source).toContain("bootstrap failed (");
  });
});

describe("the Setup Scripts", () => {
  /** A Container whose repos `due` have a Setup Script due, each answering with `scripts[repo]`. */
  const withScripts = (
    due: readonly string[],
    scripts: Record<string, Answer> = {},
    bootstrap: Answer = {},
  ) =>
    fakeContainer((input) => {
      if (isBootstrap(input)) return bootstrap;

      if (isSetupList(input)) return { stdout: due.map((dir) => `${dir}\n`) };

      if (isSetupRun(input)) return scripts[input.cwd ?? ""] ?? {};

      return {};
    });

  const runs = (execs: readonly ExecInput[]) =>
    execs.flatMap((input) => (isSetupRun(input) ? [input.cwd] : []));

  /** What the after-install hook is told of a bootstrap on `container`: whether it installed something. */
  const changedAfter = async (container: ReturnType<typeof fakeContainer>) => {
    const seen: boolean[] = [];

    const { toolchains } = open(container, {
      afterInstall: async (changed) => {
        seen.push(changed);
      },
    });

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "true" });

    return seen;
  };

  it("count as an install for the snapshot when one succeeded, though mise installed nothing", async () => {
    expect(
      await changedAfter(
        withScripts(["/workspace/a", "/workspace/b"], { "/workspace/a": { code: 1 } }),
      ),
    ).toEqual([true]);
  });

  it("do not count when every one that ran failed: each runs again at the next Container start", async () => {
    expect(
      await changedAfter(withScripts(["/workspace/a"], { "/workspace/a": { code: 1 } })),
    ).toEqual([false]);
  });

  it("leave the install's own signal standing when they fail", async () => {
    const container = withScripts(
      ["/workspace/a"],
      { "/workspace/a": { code: 1 } },
      { stdout: [`${BOOTSTRAP_CHANGED}\n`] },
    );

    expect(await changedAfter(container)).toEqual([true]);
  });

  it("do not count when none was due", async () => {
    expect(await changedAfter(withScripts([]))).toEqual([false]);
  });

  it("run after the install, each due one in its repo's directory, before the command that waited", async () => {
    const container = withScripts(["/workspace/a", "/workspace/b"]);
    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "ls node_modules" });

    expect(container.execs.map((input) => (isOwn(input) ? input.cwd : input.source))).toEqual([
      "/workspace",
      "/workspace",
      "/workspace/a",
      "/workspace/b",
      // The look for Start Scripts.
      "/workspace",
      "ls node_modules",
    ]);
    expect(container.execs.filter(isSetupRun)[0]?.source).toContain(".agents/setup.sh");
  });

  it("are given a command's environment, the token included, and a quarter of an hour", async () => {
    const container = withScripts(["/workspace/a"]);
    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "true" });

    const [script] = container.execs.filter(isSetupRun);

    expect(script?.env).toMatchObject({ GITHUB_TOKEN: "ghp_secret", MISE_YES: "1" });
    expect(script?.source).toContain("timeout --kill-after=10 900 ");
    expect(script?.timeoutMs).toBeGreaterThan(15 * 60_000);
  });

  it("are skipped when none is due: the command is sent as it is", async () => {
    const container = withScripts([]);
    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "a" });

    expect(runs(container.execs)).toEqual([]);
    expect(commands(container.execs)[0]?.source).toBe("a");
  });

  it("are not looked for when the install failed", async () => {
    const container = withScripts(["/workspace/a"], {}, { code: 1 });
    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "a" });

    expect(container.execs.filter(isSetupList)).toEqual([]);
  });

  it("run before the hook after the install, so the snapshot keeps what they installed", async () => {
    const container = withScripts(["/workspace/a"]);
    const seen: (string | undefined)[] = [];

    const { toolchains } = open(container, {
      afterInstall: async () => {
        seen.push(...runs(container.execs));
      },
    });

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "a" });

    expect(seen).toEqual(["/workspace/a"]);
  });

  it("do not stop the command when one fails: it gets a note with the end of the output, without the token", async () => {
    const container = withScripts(["/workspace/a", "/workspace/b"], {
      "/workspace/a": { stderr: `${"x".repeat(5_000)}ERR_PNPM_FETCH (ghp_secret)`, code: 1 },
    });

    const { toolchains, warnings } = open(container);
    const handle = await toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "pnpm test" });

    const [command] = commands(container.execs);

    expect(runs(container.execs)).toEqual(["/workspace/a", "/workspace/b"]);
    expect(command?.source).toMatch(/^printf .*>&2\npnpm test$/s);
    expect(command?.source).toContain(
      "the Setup Script /workspace/a/.agents/setup.sh failed (exit status 1)",
    );
    expect(command?.source).toContain("ERR_PNPM_FETCH (***)");
    expect(command?.source).not.toContain("x".repeat(2_001));
    expect(command?.source).not.toContain("/workspace/b/.agents");
    expect(command?.source).not.toContain("ghp_secret");
    expect(warnings.join("\n")).toContain("ERR_PNPM_FETCH");
    expect(warnings.join("\n")).not.toContain("ghp_secret");
  });

  it("leave no piece of the token where the end of the output cuts through it", async () => {
    const container = withScripts(["/workspace/a"], {
      "/workspace/a": { stderr: `ghp_secret${"y".repeat(1_995)}ghp_secret`, code: 1 },
    });

    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "true" });

    const [command] = commands(container.execs);

    // What is reported of the output is y's and the whole token, taken out: nothing of the token cut at the start.
    expect(command?.source).toMatch(/may be missing: y+\*\*\*\n/);
  });

  it("say so when one ran past its time and was stopped", async () => {
    const container = withScripts(["/workspace/a"], {
      "/workspace/a": {
        stderr: `Progress: resolved 812\n${SETUP_TIMED_OUT_MESSAGE}\n`,
        code: 124,
      },
    });

    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "true" });

    const [command] = commands(container.execs);

    expect(command?.source).toContain("ran past 15 minutes and was stopped");
    expect(command?.source).toContain("Progress: resolved 812");
  });

  it("are not taken for stopped when one exits with timeout's status on its own", async () => {
    const container = withScripts(["/workspace/a"], {
      "/workspace/a": { stderr: "gave up", code: 124 },
    });

    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "true" });

    const [command] = commands(container.execs);

    expect(command?.source).toContain("failed (exit status 124)");
    expect(command?.source).not.toContain("ran past");
  });

  it("are not run again in the same Container after a failure: later commands, on any connection, get a pointer", async () => {
    const container = withScripts(["/workspace/a"], {
      "/workspace/a": { stderr: "ERR_PNPM_FETCH", code: 1 },
    });

    const { toolchains, clock } = open(container);

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "a" });
    clock.now += 60 * 60_000;
    await (await toolchains.connect(host)).rpc.shell.exec({ source: "b" });

    const [, later] = commands(container.execs);

    expect(runs(container.execs)).toEqual(["/workspace/a"]);
    expect(later?.source).toMatch(/\nb$/);
    expect(later?.source).toContain("Setup Script (.agents/setup.sh) of /workspace/a failed");
    expect(later?.source).not.toContain("ERR_PNPM_FETCH");
  });

  it("give the full note to the first command that starts, when the one that waited was killed", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));

    const container = withScripts(["/workspace/a"], {
      "/workspace/a": { stderr: "ERR_PNPM_FETCH", code: 1, gate },
    });

    const handle = await open(container).toolchains.connect(host);
    const waited = handle.rpc.shell.exec({ id: "cmd-1", source: "a" });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await handle.rpc.shell.killExec({ id: "cmd-1" });
    finish();
    await waited;
    await handle.rpc.shell.exec({ source: "b" });

    const [command] = commands(container.execs);

    expect(command?.source).toMatch(/\nb$/);
    expect(command?.source).toContain("ERR_PNPM_FETCH");
  });

  it("are reported afresh after the next Container start, which runs them again", async () => {
    let fail = true;

    const container = fakeContainer((input) => {
      if (isSetupList(input)) return { stdout: ["/workspace/a\n"] };

      return isSetupRun(input) && fail ? { code: 1 } : {};
    });

    const { toolchains } = open(container);

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "a" });
    fail = false;
    container.restart();
    await (await toolchains.connect(host)).rpc.shell.exec({ source: "b" });

    expect(commands(container.execs)[1]?.source).toBe("b");
  });

  it("are looked for again at the next Container start", async () => {
    const container = withScripts(["/workspace/a"], { "/workspace/a": { code: 1 } });
    const { toolchains } = open(container);

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "a" });
    container.restart();
    await (await toolchains.connect(host)).rpc.shell.exec({ source: "b" });

    expect(runs(container.execs)).toEqual(["/workspace/a", "/workspace/a"]);
  });

  it("keep the Container in use while they run, whether or not a command still waits", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const container = withScripts(["/workspace/a"], { "/workspace/a": { gate } });
    const activity: string[] = [];

    const { toolchains } = open(container, {
      activity: {
        begin: async () => {
          activity.push("begin");
        },
        end: async () => {
          activity.push("end");
        },
      },
    });

    const handle = await toolchains.connect(host);
    const command = handle.rpc.shell.exec({ id: "cmd-1", source: "a" });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await handle.rpc.shell.killExec({ id: "cmd-1" });

    expect(activity).toEqual(["begin"]);

    finish();
    await command;

    expect(activity).toEqual(["begin", "end"]);
  });

  it("run in a bootstrap without a command (the early start), whose failure the first command after it is told", async () => {
    const container = withScripts(["/workspace/a"], {
      "/workspace/a": { stderr: "ERR_PNPM_FETCH", code: 1 },
    });

    const activity: string[] = [];

    const { toolchains } = open(container, {
      activity: {
        begin: async () => {
          activity.push("begin");
        },
        end: async () => {
          activity.push("end");
        },
      },
    });

    const handle = await toolchains.connect(host);

    await toolchains.runBootstrap();

    expect(runs(container.execs)).toEqual(["/workspace/a"]);
    expect(commands(container.execs)).toEqual([]);
    // The bootstrap held the Container once, and let it go.
    expect(activity).toEqual(["begin", "end"]);

    await handle.rpc.shell.exec({ source: "a" });
    await handle.rpc.shell.exec({ source: "b" });

    const [first, second] = commands(container.execs);

    expect(runs(container.execs)).toEqual(["/workspace/a"]);
    expect(first?.source).toContain("ERR_PNPM_FETCH");
    expect(second?.source).toContain("Setup Script (.agents/setup.sh) of /workspace/a failed");
    expect(second?.source).not.toContain("ERR_PNPM_FETCH");
  });

  it("do not stop the command when they cannot be looked for", async () => {
    const container = fakeContainer((input) =>
      isSetupList(input) ? { stderr: "no disk", code: 2 } : {},
    );

    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "a" });

    expect(commands(container.execs)[0]?.source).toContain("could not tell which repos");
    expect(commands(container.execs)[0]?.source).toMatch(/\na$/);
  });
});

/** The Environment's settings a bootstrap reads, with `changes` over the defaults. */
const environment = (changes: Partial<typeof DEFAULT_CONTAINER_SETTINGS> = {}) => ({
  ...DEFAULT_CONTAINER_SETTINGS,
  ...changes,
});

describe("the Environment's variables", () => {
  it("reach every command, under the Container's own variables and what the caller passes", async () => {
    const container = fakeContainer();

    const { toolchains } = open(container, {
      settings: async () => environment({ variables: { NODE_ENV: "test", API_URL: "http://x" } }),
    });

    const handle = await toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "true", env: { NODE_ENV: "production" } });

    expect(commands(container.execs)[0]?.env).toMatchObject({
      NODE_ENV: "production",
      API_URL: "http://x",
      MISE_YES: "1",
      GITHUB_TOKEN: "ghp_secret",
    });
  });

  it("reach the bootstrap and every script it runs", async () => {
    const container = fakeContainer((input) => {
      if (isSetupList(input)) return { stdout: [`${ENVIRONMENT_SETUP_FILE}\n`, "/workspace/a\n"] };

      if (isStartList(input)) return { stdout: ["/workspace/a\n"] };

      return {};
    });

    const { toolchains } = open(container, {
      settings: async () =>
        environment({ variables: { API_URL: "http://x" }, setupScript: "a", startScript: "b" }),
    });

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "true" });

    const own = container.execs.filter(isOwn);

    expect(own).toHaveLength(7);

    for (const input of own)
      expect(input.env).toMatchObject({ API_URL: "http://x", MISE_YES: "1" });
  });

  it("are read once per Container start, so a change applies at the next one", async () => {
    const container = fakeContainer();
    let value = "one";
    let reads = 0;

    const { toolchains } = open(container, {
      settings: async () => {
        reads++;

        return environment({ variables: { WHICH: value } });
      },
    });

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "a" });
    value = "two";
    await (await toolchains.connect(host)).rpc.shell.exec({ source: "b" });
    container.restart();
    await (await toolchains.connect(host)).rpc.shell.exec({ source: "c" });

    expect(commands(container.execs).map((input) => input.env?.WHICH)).toEqual([
      "one",
      "one",
      "two",
    ]);
    expect(reads).toBe(2);
  });

  it("are left out, with the Environment's scripts, when the settings cannot be read, which stops nothing", async () => {
    const container = fakeContainer();

    const { toolchains, warnings } = open(container, {
      settings: async () => {
        throw new Error("storage is gone");
      },
    });

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "a" });

    expect(commands(container.execs)[0]?.source).toBe("a");
    expect(commands(container.execs)[0]?.env).toMatchObject({ MISE_YES: "1" });
    expect(warnings.join("\n")).toContain("storage is gone");
  });
});

describe("the Environment's Setup Script", () => {
  /** A Container where the Environment's Setup Script and the repo `a`'s are due, each answering from `scripts`. */
  const withEnvironmentScript = (scripts: Record<string, Answer> = {}) =>
    fakeContainer((input) => {
      if (isSetupList(input)) return { stdout: [`${ENVIRONMENT_SETUP_FILE}\n`, "/workspace/a\n"] };

      if (isSetupRun(input)) {
        return scripts[input.source.includes(ENVIRONMENT_SETUP_FILE) ? "environment" : "a"] ?? {};
      }

      return {};
    });

  it("is handed to the look for due ones, which writes it to its file", async () => {
    const container = fakeContainer();

    const { toolchains } = open(container, {
      settings: async () => environment({ setupScript: "pnpm install\n" }),
    });

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "true" });

    const [list] = container.execs.filter(isSetupList);

    // The script is in it base64-encoded: "pnpm install\n".
    expect(list?.source).toContain(btoa("pnpm install\n"));
    expect(list?.source).toContain(ENVIRONMENT_SETUP_FILE);
  });

  it("runs first when it is due, in the Workspace root, then the repos'", async () => {
    const container = withEnvironmentScript();

    const { toolchains } = open(container, {
      settings: async () => environment({ setupScript: "pnpm install\n" }),
    });

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "true" });

    const runs = container.execs.filter(isSetupRun);

    expect(runs.map((input) => input.cwd)).toEqual(["/workspace", "/workspace/a"]);
    expect(runs[0]?.source).toContain(ENVIRONMENT_SETUP_FILE);
    expect(runs[0]?.source).toContain("@environment");
  });

  it("counts as an install for the snapshot when it succeeded", async () => {
    const container = withEnvironmentScript({ a: { code: 1 } });
    const seen: boolean[] = [];

    const { toolchains } = open(container, {
      settings: async () => environment({ setupScript: "true\n" }),
      afterInstall: async (changed) => {
        seen.push(changed);
      },
    });

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "true" });

    expect(seen).toEqual([true]);
  });

  it("does not stop the command when it fails: the first command gets a note, later ones a pointer", async () => {
    const container = withEnvironmentScript({
      environment: { stderr: "apt-get: not found", code: 1 },
    });

    const { toolchains, warnings } = open(container, {
      settings: async () => environment({ setupScript: "apt-get install x\n" }),
    });

    const handle = await toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "a" });
    await handle.rpc.shell.exec({ source: "b" });

    const [first, second] = commands(container.execs);

    expect(container.execs.filter(isSetupRun).map((input) => input.cwd)).toEqual([
      "/workspace",
      "/workspace/a",
    ]);
    expect(unquoted(first?.source)).toContain(
      "the Environment's Setup Script failed (exit status 1)",
    );
    expect(first?.source).toContain("apt-get: not found");
    expect(first?.source).toContain(ENVIRONMENT_SETUP_FILE);
    expect(first?.source).toMatch(/\na$/);
    expect(unquoted(second?.source)).toContain(
      "the Environment's Setup Script failed at this Container's start",
    );
    expect(second?.source).not.toContain("apt-get: not found");
    expect(warnings.join("\n")).toContain("apt-get: not found");
  });
});

describe("the Start Scripts", () => {
  /** A Container whose repos `repos` have a Start Script, each answering from `scripts` (by directory). */
  const withStartScripts = (repos: readonly string[], scripts: Record<string, Answer> = {}) =>
    fakeContainer((input) => {
      if (isStartList(input)) return { stdout: repos.map((dir) => `${dir}\n`) };

      if (isStartRun(input)) return scripts[input.cwd ?? ""] ?? {};

      return {};
    });

  const starts = (execs: readonly ExecInput[]) =>
    execs.flatMap((input) => (isStartRun(input) ? [input.cwd] : []));

  it("run after the Setup Scripts and the hook after the install, the Environment's first, before the command", async () => {
    const container = withStartScripts(["/workspace/a", "/workspace/b"]);
    const order: string[] = [];

    const { toolchains } = open(container, {
      settings: async () => environment({ startScript: "docker start db\n" }),
      afterInstall: async () => {
        order.push(`hook after ${container.execs.filter(isStartRun).length} Start Scripts`);
      },
    });

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "pnpm dev" });

    expect(order).toEqual(["hook after 0 Start Scripts"]);
    expect(
      container.execs.map((input) => (isOwn(input) ? input.cwd : input.source)).slice(2),
    ).toEqual(["/workspace", "/workspace", "/workspace/a", "/workspace/b", "pnpm dev"]);
    expect(container.execs.filter(isStartRun)[0]?.source).toContain(ENVIRONMENT_START_FILE);
    expect(container.execs.filter(isStartRun)[0]?.source).toContain(btoa("docker start db\n"));
    expect(container.execs.filter(isStartRun)[1]?.source).toContain(".agents/start.sh");
  });

  it("are bounded by five minutes, and do not count as an install", async () => {
    const container = withStartScripts(["/workspace/a"]);
    const seen: boolean[] = [];

    const { toolchains } = open(container, {
      afterInstall: async (changed) => {
        seen.push(changed);
      },
    });

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "true" });

    const [script] = container.execs.filter(isStartRun);

    expect(script?.source).toContain("timeout --kill-after=10 300 ");
    expect(script?.timeoutMs).toBeGreaterThan(5 * 60_000);
    expect(seen).toEqual([false]);
  });

  it("leave the Environment's out when it has none", async () => {
    const container = withStartScripts(["/workspace/a"]);
    const { toolchains } = open(container, { settings: async () => environment() });

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "true" });

    expect(starts(container.execs)).toEqual(["/workspace/a"]);
  });

  it("run at every Container start, and not after a mere reconnect", async () => {
    const container = withStartScripts(["/workspace/a"]);
    const { toolchains } = open(container);

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "a" });
    await (await toolchains.connect(host)).rpc.shell.exec({ source: "b" });
    container.restart();
    await (await toolchains.connect(host)).rpc.shell.exec({ source: "c" });

    expect(starts(container.execs)).toEqual(["/workspace/a", "/workspace/a"]);
  });

  it("do not stop the command when one fails: the first command gets a note, later ones a pointer", async () => {
    const container = withStartScripts(["/workspace/a", "/workspace/b"], {
      "/workspace/a": { stderr: "port 5432 in use (ghp_secret)", code: 1 },
      "/workspace": { stderr: "docker: not running", code: 2 },
    });

    const { toolchains, warnings } = open(container, {
      settings: async () => environment({ startScript: "docker start db\n" }),
    });

    const handle = await toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "a" });
    await handle.rpc.shell.exec({ source: "b" });

    const [first, second] = commands(container.execs);

    expect(starts(container.execs)).toEqual(["/workspace", "/workspace/a", "/workspace/b"]);
    expect(unquoted(first?.source)).toContain(
      "the Environment's Start Script failed (exit status 2)",
    );
    expect(first?.source).toContain("docker: not running");
    expect(first?.source).toContain(
      "the Start Script /workspace/a/.agents/start.sh failed (exit status 1)",
    );
    expect(first?.source).toContain("port 5432 in use (***)");
    expect(first?.source).not.toContain("/workspace/b/.agents");
    expect(first?.source).toMatch(/\na$/);
    expect(unquoted(second?.source)).toContain(
      "the Environment's Start Script failed at this Container's start",
    );
    expect(second?.source).toContain("Start Script (.agents/start.sh) of /workspace/a failed");
    expect(second?.source).not.toContain("port 5432");
    expect(warnings.join("\n")).toContain("port 5432 in use (***)");
  });

  it("are reported along with the Setup Scripts that failed", async () => {
    const container = fakeContainer((input) => {
      if (isSetupList(input)) return { stdout: ["/workspace/a\n"] };

      if (isStartList(input)) return { stdout: ["/workspace/a\n"] };

      return isSetupRun(input) || isStartRun(input) ? { stderr: "boom", code: 1 } : {};
    });

    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "a" });

    const [command] = commands(container.execs);

    expect(command?.source).toContain("Setup Script /workspace/a/.agents/setup.sh failed");
    expect(command?.source).toContain("Start Script /workspace/a/.agents/start.sh failed");
  });

  it("say so when one ran past its time and was stopped", async () => {
    const container = withStartScripts(["/workspace/a"], {
      "/workspace/a": { stderr: `postgres starting\n${START_TIMED_OUT_MESSAGE}\n`, code: 124 },
    });

    await (await open(container).toolchains.connect(host)).rpc.shell.exec({ source: "true" });

    const [command] = commands(container.execs);

    expect(command?.source).toContain("ran past 5 minutes and was stopped");
    expect(command?.source).toContain("detach");
  });

  it("are not run when the install failed", async () => {
    const container = fakeContainer((input) => (isBootstrap(input) ? { code: 1 } : {}));

    const { toolchains } = open(container, {
      settings: async () => environment({ startScript: "docker start db\n" }),
    });

    await (await toolchains.connect(host)).rpc.shell.exec({ source: "a" });

    expect(container.execs.filter((input) => isStartList(input) || isStartRun(input))).toEqual([]);
  });

  it("do not stop the command when they cannot be looked for", async () => {
    const container = fakeContainer((input) =>
      isStartList(input) ? { stderr: "no disk", code: 2 } : {},
    );

    await (await open(container).toolchains.connect(host)).rpc.shell.exec({ source: "a" });

    expect(unquoted(commands(container.execs)[0]?.source)).toContain(
      "could not tell which repos' Start Script",
    );
    expect(commands(container.execs)[0]?.source).toMatch(/\na$/);
  });
});
