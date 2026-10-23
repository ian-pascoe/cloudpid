// @effect-diagnostics asyncFunction:off
import type { Context } from "@earendil-works/chord";
import { ExecutionError, err, ok, type Shell } from "@earendil-works/pi-durable/env";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  CLONE_TIMEOUT_SECONDS,
  prepareWorkspace,
  runScript,
  type ScriptRun,
  type WorkspaceSetup,
} from "./prepare.ts";

const setup: WorkspaceSetup = {
  repos: [
    { name: "app", url: "https://github.com/acme/app.git" },
    { name: "api", url: "https://github.com/acme/api.git" },
  ],
  branch: "cloudpid/1a2b3c4d",
  base: null,
  settings: {},
};

/**
 * A Workspace whose files hold `present`, whose Container answers each script in turn from `answers`, and whose object
 * holds the settings `held`.
 */
const host = (
  present: readonly string[],
  answers: readonly ScriptRun[] = [],
  held: Schema.Json = {},
) => {
  const scripts: Array<{ script: string; timeoutSeconds: number }> = [];
  const warnings: string[] = [];
  const written: Schema.Json[] = [];
  let refuse = false;
  let next = 0;

  const prepare = (with_: WorkspaceSetup = setup) =>
    prepareWorkspace(
      {
        exists: (path) => Promise.resolve(present.includes(path)),
        run: (script, timeoutSeconds) => {
          scripts.push({ script, timeoutSeconds });

          return Promise.resolve(answers[next++] ?? { exitCode: 0, output: "" });
        },
        settings: {
          read: () =>
            Promise.resolve({
              settings: { instance: "custom-2", idleMinutes: 5, ignore: [] },
              overrides: held,
            }),
          write: (overrides) => {
            written.push(overrides);

            return Promise.resolve(
              refuse
                ? { ok: false as const, message: "idleMinutes: too long" }
                : {
                    ok: true as const,
                    state: {
                      settings: { instance: "custom-2", idleMinutes: 5, ignore: [] },
                      overrides,
                    },
                  },
            );
          },
        },
        warn: (message) => {
          warnings.push(message);
        },
      },
      with_,
    );

  return {
    prepare,
    scripts,
    warnings,
    written,
    refuseSettings: () => {
      refuse = true;
    },
  };
};

const cloned = ["/workspace/app/.git", "/workspace/api/.git"];

describe("readying a Workspace", () => {
  it("starts no Container when its files have every clone", async () => {
    const { prepare, scripts } = host(cloned);

    await prepare();

    expect(scripts).toEqual([]);
  });

  it("clones only the Repos that are missing, then runs each one's Setup Script if due", async () => {
    const { prepare, scripts } = host(["/workspace/app/.git"]);

    await prepare();

    expect(scripts).toHaveLength(2);
    expect(scripts[0]?.script).toContain("clone_or_report 'api' 'https://github.com/acme/api.git'");
    expect(scripts[0]?.script).not.toContain("clone_or_report 'app'");
    expect(scripts[0]?.script).toContain("branch='cloudpid/1a2b3c4d'");
    expect(scripts[0]?.timeoutSeconds).toBe(CLONE_TIMEOUT_SECONDS);
    expect(scripts[1]?.script).toContain("/workspace/api/.agents/setup.sh");
  });

  it("starts a new branch from the base it is given", async () => {
    const { prepare, scripts } = host([]);

    await prepare({ ...setup, base: "release" });

    expect(scripts[0]?.script).toContain("base='release'");
  });

  it("fails with git's output when a Repo cannot be cloned, after setting up the ones that were", async () => {
    const { prepare, scripts } = host(
      [],
      [{ exitCode: 1, output: "fatal: repository 'https://github.com/acme/api.git/' not found\n" }],
    );

    await expect(prepare()).rejects.toThrow(
      "The Workspace's repos could not all be cloned on branch cloudpid/1a2b3c4d (exit 1): fatal: repository",
    );
    expect(scripts).toHaveLength(3);
  });

  it("only reports a Setup Script that fails: the Workspace is there to work in", async () => {
    const { prepare, warnings } = host(
      ["/workspace/api/.git"],
      [
        { exitCode: 0, output: "" },
        { exitCode: 1, output: "ERR_PNPM_NO_LOCKFILE\n" },
      ],
    );

    await prepare();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("/workspace/app/.agents/setup.sh failed");
    expect(warnings[0]).toContain("ERR_PNPM_NO_LOCKFILE");
  });

  it("hands the Environment's settings to the Workspace when they differ from what it holds", async () => {
    const same = host(cloned, [], { idleMinutes: 30, instance: "standard-4" });

    await same.prepare({ ...setup, settings: { instance: "standard-4", idleMinutes: 30 } });

    expect(same.written).toEqual([]);

    const changed = host(cloned, [], { idleMinutes: 30 });

    await changed.prepare({ ...setup, settings: { idleMinutes: 60 } });

    expect(changed.written).toEqual([{ idleMinutes: 60 }]);
  });

  it("only reports settings the Workspace refuses", async () => {
    const { prepare, warnings, refuseSettings } = host(cloned);

    refuseSettings();
    await prepare({ ...setup, settings: { idleMinutes: 60 } });

    expect(warnings).toEqual([
      "The Workspace refused its Environment's settings: idleMinutes: too long",
    ]);
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
