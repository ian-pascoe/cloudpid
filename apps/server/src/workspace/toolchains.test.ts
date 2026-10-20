// The Container's Toolchains on the Workspace DO's side (docs/spec.md → Container and Toolchains, ADR-0004): the
// bootstrap that runs before the first command of each Container start, and the environment every command gets. The
// Container is a fake backend whose shell records what it is asked and answers from a script.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferEffectArray:off
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import { describe, expect, it } from "vitest";
import { ToolchainBackend } from "./toolchains.ts";

type Shell = BackendHandle["rpc"]["shell"];

type ExecInput = Parameters<Shell["exec"]>[0];

const encoder = new TextEncoder();

/** A stream of one command's events: its output, then its exit. */
const events = (id: string, stderr: string, code: number) =>
  new ReadableStream({
    start(controller) {
      let seq = 0;

      if (stderr !== "") {
        controller.enqueue({ id, seq: seq++, name: "stderr", value: encoder.encode(stderr) });
      }

      controller.enqueue({ id, seq: seq++, name: "exit", code });
      controller.close();
    },
  });

/** What a fake Container's shell does with a command: its stderr and exit status, after `gate` if there is one. */
type Answer = { stderr?: string; code?: number; gate?: Promise<void> };

/** A Container that records the commands it is sent, and what happened to its connection. */
const fakeContainer = (answer: (input: ExecInput) => Answer = () => ({})) => {
  const execs: ExecInput[] = [];
  const disposed: string[] = [];
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

          const { stderr = "", code = 0, gate } = answer(input);

          await gate;

          return { id: input.id ?? `exec-${execs.length}`, events: events("x", stderr, code) };
        },
        getExec: () => Promise.reject(new Error("not used")),
        killExec: () => Promise.resolve(),
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
    connects: () => connects,
    restart: () => {
      runtimeId = `runtime-${connects + 1}`;
    },
  };
};

/** The commands the backend was sent that are not its bootstrap. */
const commands = (execs: readonly ExecInput[]) =>
  execs.filter((input) => !input.source.includes("mise install"));

const bootstraps = (execs: readonly ExecInput[]) =>
  execs.filter((input) => input.source.includes("mise install"));

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

describe("the bootstrap", () => {
  it("runs before the first command of a Container start, which waits for it", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));

    const container = fakeContainer((input) =>
      input.source.includes("mise install") ? { gate } : {},
    );

    const handle = await open(container).toolchains.connect(host);

    const command = handle.rpc.shell.exec({ source: "git --version" });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // The bootstrap is under way; the command has not been sent.
    expect(container.execs).toHaveLength(1);
    expect(container.execs[0]?.source).toContain("mise install");

    finish();
    await command;

    expect(container.execs).toHaveLength(2);
    expect(container.execs[1]?.source).toBe("git --version");
  });

  it("runs in the Workspace root, bounded in time", async () => {
    const container = fakeContainer();
    const handle = await open(container).toolchains.connect(host);

    await handle.rpc.shell.exec({ source: "true" });

    const [bootstrap] = bootstraps(container.execs);

    expect(bootstrap?.cwd).toBe("/workspace");
    expect(bootstrap?.timeoutMs).toBeGreaterThan(60_000);
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

    expect(container.disposed).toHaveLength(1);
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
      input.source.includes("mise install")
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

    const container = fakeContainer((input) =>
      input.source.includes("mise install") ? { code: fail ? 1 : 0 } : {},
    );

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
