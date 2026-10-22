// @effect-diagnostics asyncFunction:off preferEffectArray:off
import type { Context } from "@earendil-works/chord";
import { err, ExecutionError, ok, type Shell } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import {
  CLONE_TIMEOUT_SECONDS,
  cloneCommand,
  cloneInto,
  listRepos,
  REMOVE_TIMEOUT_SECONDS,
  REMOVE_SCRIPT,
  removeFrom,
  stillThere,
} from "./repos.ts";

type Exec = Shell["exec"];

type Call = { command: string | readonly string[]; options: Parameters<Exec>[1] };

/** A shell that records its commands and answers each with `answer`, after printing `output` as stderr. */
const shell = (answer: Awaited<ReturnType<Exec>>, output = "") => {
  const calls: Call[] = [];

  const exec: Exec = (command, options, context: Context) => {
    calls.push({ command, options });
    options?.onOutput?.(output, context, { stream: "stderr" });

    return Promise.resolve(answer);
  };

  return { exec, calls };
};

const source = { url: "https://github.com/octocat/Hello-World.git", name: "Hello-World" };

describe("removeFrom", () => {
  it("removes the repo, its Workspaces' worktrees and their Setup Script records, the name an argument of its own", async () => {
    const container = shell(ok({ exitCode: 0 }));

    await removeFrom(container, "Hello-World");

    expect(container.calls).toHaveLength(1);
    expect(container.calls[0]?.command).toEqual([
      "bash",
      "-c",
      REMOVE_SCRIPT,
      "cloudpid-remove",
      "Hello-World",
      "/var/lib/cloudpid/setup/Hello-World",
    ]);
    expect(REMOVE_SCRIPT).toBe('rm -rf -- "$1" ".worktrees/$1" "$2" "$2"@*');
    expect(container.calls[0]?.options).toMatchObject({
      cwd: "/workspace",
      timeout: REMOVE_TIMEOUT_SECONDS,
    });
  });

  it("runs nothing for a name that is a path, the parent, hidden or an option", async () => {
    for (const name of ["..", ".", "a/b", "/", "-rf", ".git", ""]) {
      const container = shell(ok({ exitCode: 0 }));

      await expect(removeFrom(container, name)).rejects.toThrow("is not a repo name");
      expect(container.calls).toEqual([]);
    }
  });

  it("fails with the end of rm's output when it exits nonzero, and when it cannot run or times out", async () => {
    await expect(
      removeFrom(shell(ok({ exitCode: 1 }), "rm: cannot remove 'x': Permission denied\n"), "x"),
    ).rejects.toThrow("rm failed (exit 1): rm: cannot remove 'x': Permission denied");

    await expect(
      removeFrom(shell(err(new ExecutionError("spawn_error", "No Container"))), "x"),
    ).rejects.toThrow("The removal could not run: No Container");

    await expect(
      removeFrom(shell(err(new ExecutionError("timeout", "Command timed out"))), "x"),
    ).rejects.toThrow("The removal did not finish in 5 minutes");
  });
});

describe("stillThere", () => {
  const entry = (name: string) => ({ name, isDirectory: true, isSymbolicLink: false });

  it("says whether /workspace still has the entry, and that a /workspace that is not there has none", async () => {
    const files = { readdir: async () => [entry("pi"), entry("other")] };

    expect(await stillThere(files, "pi")).toBe(true);
    expect(await stillThere(files, "gone")).toBe(false);

    const missing = {
      readdir: () =>
        Promise.reject(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })),
    };

    expect(await stillThere(missing, "pi")).toBe(false);
  });
});

describe("cloneInto", () => {
  it("runs git clone as an argument vector in /workspace, with only https allowed", async () => {
    const container = shell(ok({ exitCode: 0 }));

    await cloneInto(container, source);

    expect(container.calls).toHaveLength(1);
    expect(container.calls[0]?.command).toEqual([
      "git",
      "clone",
      "--",
      "https://github.com/octocat/Hello-World.git",
      "Hello-World",
    ]);
    expect(container.calls[0]?.options).toMatchObject({
      cwd: "/workspace",
      env: { GIT_ALLOW_PROTOCOL: "https", GIT_TERMINAL_PROMPT: "0" },
      timeout: CLONE_TIMEOUT_SECONDS,
    });
  });

  it("never lets a value pass as an option or reach a shell: the command is a vector with -- before the URL", () => {
    const command = cloneCommand({ url: "https://example.com/a/b", name: "b" });

    expect(command.indexOf("--")).toBeLessThan(command.indexOf("https://example.com/a/b"));
  });

  it("fails with the end of git's output when it exits nonzero", async () => {
    const container = shell(
      ok({ exitCode: 128 }),
      "Cloning into 'x'...\nfatal: repository 'https://github.com/a/missing/' not found\n",
    );

    await expect(cloneInto(container, source)).rejects.toThrow(
      "git clone failed (exit 128): Cloning into 'x'...\nfatal: repository 'https://github.com/a/missing/' not found",
    );
  });

  it("fails with the exit status alone when git printed nothing", async () => {
    await expect(cloneInto(shell(ok({ exitCode: 1 })), source)).rejects.toThrow(
      "git clone failed (exit 1)",
    );
  });

  it("fails when the command cannot run, and when it times out", async () => {
    await expect(
      cloneInto(shell(err(new ExecutionError("spawn_error", "No such program: git"))), source),
    ).rejects.toThrow("The clone could not run: No such program: git");

    await expect(
      cloneInto(shell(err(new ExecutionError("timeout", "Command timed out"))), source),
    ).rejects.toThrow("The clone did not finish in 10 minutes");
  });
});

type Entry = { name: string; isDirectory: boolean; isSymbolicLink: boolean };

const dir = (name: string): Entry => ({ name, isDirectory: true, isSymbolicLink: false });
const file = (name: string): Entry => ({ name, isDirectory: false, isSymbolicLink: false });

const tree = (entries: Record<string, readonly Entry[]>) => ({
  readdir: (path: string) =>
    path in entries ? Promise.resolve(entries[path] ?? []) : Promise.reject(new Error("ENOENT")),
});

describe("listRepos", () => {
  it("lists the directories below /workspace that hold a .git, in name order", async () => {
    const files = tree({
      "/workspace": [
        dir("zeta"),
        dir("alpha"),
        dir("plain"),
        dir(".agents"),
        file("mise.toml"),
        { name: "link", isDirectory: true, isSymbolicLink: true },
      ],
      "/workspace/zeta": [dir(".git"), file("a.txt")],
      "/workspace/alpha": [file(".git")],
      "/workspace/plain": [file("a.txt")],
    });

    expect(await listRepos(files)).toEqual(["alpha", "zeta"]);
  });

  it("lists nothing for a Workspace with no /workspace yet", async () => {
    expect(await listRepos(tree({}))).toEqual([]);
  });

  it("skips a directory that vanished, and ignores names the Registry would refuse", async () => {
    const long = "x".repeat(101);

    const files = {
      readdir: (path: string) => {
        if (path === "/workspace") return Promise.resolve([dir("gone"), dir("ok"), dir(long)]);

        if (path === "/workspace/ok") return Promise.resolve([dir(".git")]);

        return Promise.reject(new Error("ENOENT: no such file or directory"));
      },
    };

    expect(await listRepos(files)).toEqual(["ok"]);
  });

  it("fails, rather than list nothing, when a directory cannot be read", async () => {
    const unreadable = new Error("RPC stub disconnected");

    await expect(listRepos({ readdir: () => Promise.reject(unreadable) })).rejects.toBe(unreadable);

    await expect(
      listRepos({
        readdir: (path) =>
          path === "/workspace"
            ? Promise.resolve([dir("repo")])
            : Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })),
      }),
    ).rejects.toThrow("denied");
  });
});
