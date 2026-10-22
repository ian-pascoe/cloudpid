// The Container's Toolchains on the Workspace DO's side (docs/spec.md → Container and Toolchains, ADR-0004): the
// bootstrap that runs before the first command of each Container start, and the environment every command gets. The
// Container is a fake backend whose shell records what it is asked and answers from a script.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferEffectArray:off
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import { describe, expect, it } from "vitest";
import { SETUP_TIMED_OUT_MESSAGE } from "@cloudpid/sandbox-image/toolchains";
import { ToolchainBackend } from "./toolchains.ts";

type Shell = BackendHandle["rpc"]["shell"];

type ExecInput = Parameters<Shell["exec"]>[0];

const encoder = new TextEncoder();

/** Whether `input` is the bootstrap, whose script is the only one that defines this function. */
const isBootstrap = (input: ExecInput) => input.source.includes("has_mise_config");

/** Whether `input` lists the due Setup Scripts. */
const isSetupList = (input: ExecInput) => input.source.includes("/.agents/setup.sh ] || continue");

/** Whether `input` runs a Setup Script. */
const isSetupRun = (input: ExecInput) => input.source.includes("timeout --kill-after");

/** Whether `input` is part of a bootstrap: its install, or its Setup Scripts. */
const isOwn = (input: ExecInput) => isBootstrap(input) || isSetupList(input) || isSetupRun(input);

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

    // The install's exec, and the look for Setup Scripts.
    expect(container.disposed).toHaveLength(2);
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
  it("has the token, mise's trust settings, and no git prompts", async () => {
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

  it("run after the install, each due one in its repo's directory, before the command that waited", async () => {
    const container = withScripts(["/workspace/a", "/workspace/b"]);
    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "ls node_modules" });

    expect(container.execs.map((input) => (isOwn(input) ? input.cwd : input.source))).toEqual([
      "/workspace",
      "/workspace",
      "/workspace/a",
      "/workspace/b",
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
