// @effect-diagnostics asyncFunction:off
import { worktreeDirectory, WORKTREES_DIRECTORY } from "@cloudpid/protocol";
import { WORKTREES_DIRECTORY as CONTAINER_WORKTREES } from "@cloudpid/sandbox-image/toolchains";
import { WORKTREE_KEPT, worktreePath } from "@cloudpid/sandbox-image/worktrees";
import type { Context } from "@earendil-works/chord";
import { ExecutionError, err, ok, type Shell } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { runScript, type ScriptRun, WORKTREE_TIMEOUT_SECONDS, worktreesOn } from "./worktrees.ts";

const worktree = { repo: "app", id: "1a2b3c4d", branch: "cloudpid/1a2b3c4d" };

/** A Machine whose files hold `present`, whose Container answers each script in turn from `answers`. */
const host = (present: readonly string[], answers: readonly ScriptRun[] = []) => {
  const scripts: Array<{ script: string; timeoutSeconds: number }> = [];
  const warnings: string[] = [];
  let next = 0;

  const worktrees = worktreesOn({
    exists: (path) => Promise.resolve(present.includes(path)),
    run: (script, timeoutSeconds) => {
      scripts.push({ script, timeoutSeconds });

      return Promise.resolve(answers[next++] ?? { exitCode: 0, output: "" });
    },
    warn: (message) => {
      warnings.push(message);
    },
  });

  return { worktrees, scripts, warnings };
};

describe("a Workspace's worktree", () => {
  it("is where the Container's scripts make it", () => {
    expect(WORKTREES_DIRECTORY).toBe(CONTAINER_WORKTREES);
    expect(worktreeDirectory("app", "1a2b3c4d")).toBe(worktreePath("app", "1a2b3c4d"));
  });
});

describe("preparing a worktree", () => {
  it("starts no Container when the Machine's files have it", async () => {
    const { worktrees, scripts } = host([`${worktreeDirectory("app", "1a2b3c4d")}/.git`]);

    await worktrees.prepare(worktree);

    expect(scripts).toEqual([]);
  });

  it("makes it on the Container, then runs its Setup Script if due", async () => {
    const { worktrees, scripts } = host([]);

    await worktrees.prepare(worktree);

    expect(scripts).toHaveLength(2);
    expect(scripts[0]?.script).toContain("git worktree add");
    expect(scripts[0]?.timeoutSeconds).toBe(WORKTREE_TIMEOUT_SECONDS);
    expect(scripts[1]?.script).toContain(".agents/setup.sh");
  });

  it("fails with git's output when the worktree cannot be made, and runs no Setup Script", async () => {
    const { worktrees, scripts } = host(
      [],
      [{ exitCode: 128, output: "fatal: 'feature' is already checked out at '/workspace/app'\n" }],
    );

    await expect(worktrees.prepare({ ...worktree, branch: "feature" })).rejects.toThrow(
      "The worktree of branch feature could not be made (exit 128): fatal: 'feature' is already checked out",
    );
    expect(scripts).toHaveLength(1);
  });

  it("only reports a Setup Script that fails: the worktree is there to work in", async () => {
    const { worktrees, warnings } = host(
      [],
      [
        { exitCode: 0, output: "" },
        { exitCode: 1, output: "ERR_PNPM_NO_LOCKFILE\n" },
      ],
    );

    await worktrees.prepare(worktree);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ERR_PNPM_NO_LOCKFILE");
  });
});

describe("removing and releasing a worktree", () => {
  it("removes it, and fails with why when it cannot", async () => {
    await expect(host([]).worktrees.remove(worktree)).resolves.toBeUndefined();
    await expect(
      host([], [{ exitCode: 1, output: "rm: Permission denied\n" }]).worktrees.remove(worktree),
    ).rejects.toThrow("could not be removed (exit 1): rm: Permission denied");
  });

  it("says whether a release removed it or kept its changes, and fails otherwise", async () => {
    expect(await host([]).worktrees.release(worktree)).toBe(true);
    expect(
      await host([], [{ exitCode: WORKTREE_KEPT, output: "" }]).worktrees.release(worktree),
    ).toBe(false);
    await expect(
      host([], [{ exitCode: null, output: "No Container" }]).worktrees.release(worktree),
    ).rejects.toThrow("could not be released (it did not finish): No Container");
  });
});

describe("runScript", () => {
  it("runs bash in /workspace and answers the exit status with what it printed", async () => {
    const calls: unknown[] = [];

    const exec: Shell["exec"] = (command, options, context: Context) => {
      calls.push({ command, cwd: options?.cwd, timeout: options?.timeout });
      options?.onOutput?.("hello\n", context, { stream: "stdout" });

      return Promise.resolve(ok({ exitCode: 3 }));
    };

    const ran = await runScript({ exec }, "echo hello", 60);

    expect(ran).toEqual({ exitCode: 3, output: "hello\n" });
    expect(calls).toEqual([
      { command: ["bash", "-c", "echo hello"], cwd: "/workspace", timeout: 60 },
    ]);
  });

  it("answers no exit status for a script that could not run or ran past its time", async () => {
    const failing = (error: ExecutionError) => {
      const exec: Shell["exec"] = () => Promise.resolve(err(error));

      return { exec };
    };

    expect(await runScript(failing(new ExecutionError("timeout", "timed out")), "x", 120)).toEqual({
      exitCode: null,
      output: "it ran past 2 minutes",
    });
    expect(
      await runScript(failing(new ExecutionError("spawn_error", "No Container")), "x", 60),
    ).toEqual({ exitCode: null, output: "No Container" });
  });
});
