// @effect-diagnostics asyncFunction:off
import { DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import { SPARE_BRANCH } from "@cloudpid/protocol";
import type { Context } from "@earendil-works/chord";
import { ExecutionError, err, ok, type Shell } from "@earendil-works/pi-durable/env";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { type KeptSecret, secretEnvName } from "@cloudpid/extensions/secrets/core";
import type { EnvironmentBuild } from "./build-record.ts";
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

/** The Build a fake object holds, and each one written in its place. */
type HeldBuilds = { held: EnvironmentBuild | null; written: Array<EnvironmentBuild | null> };

/**
 * A Workspace whose files hold the clones `present` (their `.git`), each on its branch in `heads` or else on the
 * Workspace's, whose Container answers each script in turn from `answers`, and whose object holds the settings `held`.
 */
const host = (
  present: readonly string[],
  answers: readonly ScriptRun[] = [],
  held: Schema.Json = {},
  heads: Readonly<Record<string, string>> = {},
) => {
  const scripts: Array<{
    script: string;
    timeoutSeconds: number;
    env?: Readonly<Record<string, string>> | undefined;
  }> = [];

  const warnings: string[] = [];
  const written: Schema.Json[] = [];
  /** Each set of Secrets handed to the object, with how many scripts had run by then. */
  const secrets: Array<{ handed: ReadonlyArray<KeptSecret>; scriptsBefore: number }> = [];
  /** Each reason the object was told it has no Secrets it can show. */
  const unavailable: string[] = [];
  /** The copy the object holds, which a set-up without Secrets reads. */
  let heldSecrets: ReadonlyArray<KeptSecret> = [];

  /** The Build the object holds, and what was written in its place, with what had happened by then. */
  const builds: HeldBuilds = {
    held: null,
    written: [],
  };

  let scriptsBeforeBuild: number | undefined;
  let refuse = false;
  let next = 0;

  const prepare = (with_: WorkspaceSetup = setup) =>
    prepareWorkspace(
      {
        readText: (path) => {
          const clone = path.replace(/\/\.git\/HEAD$/, "");

          return Promise.resolve(
            path.endsWith("/.git/HEAD") && present.includes(`${clone}/.git`)
              ? `ref: refs/heads/${heads[clone] ?? with_.branch}\n`
              : null,
          );
        },
        run: (script, timeoutSeconds, env) => {
          scripts.push({ script, timeoutSeconds, env });

          return Promise.resolve(answers[next++] ?? { exitCode: 0, output: "" });
        },
        settings: {
          read: () =>
            Promise.resolve({
              settings: DEFAULT_CONTAINER_SETTINGS,
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
                      settings: DEFAULT_CONTAINER_SETTINGS,
                      overrides,
                    },
                  },
            );
          },
        },
        build: {
          read: () => Promise.resolve(builds.held),
          write: (build) => {
            builds.written.push(build);
            builds.held = build;
            scriptsBeforeBuild ??= scripts.length;

            return Promise.resolve();
          },
        },
        secrets: {
          write: (handed) => {
            secrets.push({ handed, scriptsBefore: scripts.length });
            heldSecrets = handed;

            return Promise.resolve();
          },
          unavailable: (reason) => {
            unavailable.push(reason);

            return Promise.resolve();
          },
          read: () => Promise.resolve(heldSecrets),
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
    builds,
    secrets,
    unavailable,
    hold: (secrets: ReadonlyArray<KeptSecret>) => {
      heldSecrets = secrets;
    },
    scriptsBeforeBuild: () => scriptsBeforeBuild,
    refuseSettings: () => {
      refuse = true;
    },
  };
};

const cloned = ["/workspace/app/.git", "/workspace/api/.git"];

describe("readying a Workspace", () => {
  it("hands the object its Environment's Secrets before any script runs, and none when the set-up has none", async () => {
    const kept: KeptSecret = {
      name: "API_KEY",
      value: "sk-live-0123456789",
      scope: "environment",
      build: false,
    };

    const { prepare, secrets } = host([]);

    await prepare({ ...setup, secrets: [kept] });
    expect(secrets).toEqual([{ handed: [kept], scriptsBefore: 0 }]);

    // A spare's stored set-up holds none: what the object holds stays.
    await prepare(setup);
    expect(secrets).toHaveLength(1);
  });

  it("tells the object it has no Secrets it can show when the Registry could not open them", async () => {
    const { prepare, secrets, unavailable } = host([]);

    await prepare({ ...setup, secretsUnavailable: "the Registry could not open them" });

    expect(unavailable).toEqual(["the Registry could not open them"]);
    expect(secrets).toEqual([]);
  });

  it("gives a new clone's Setup Script the Secrets marked for the Build, and its Start Script none", async () => {
    const marked: KeptSecret = {
      name: "NPM_TOKEN",
      value: "npm_0123456789abcdef",
      scope: "environment",
      build: true,
    };

    const other: KeptSecret = { ...marked, name: "API_KEY", build: false };
    const variable = secretEnvName(marked.name);

    const { prepare, scripts } = host(["/workspace/app/.git"]);

    await prepare({ ...setup, secrets: [marked, other] });

    expect(scripts[1]?.script).toContain("/workspace/api/.cloudpid/setup.sh");
    expect(scripts[1]?.env).toEqual({ [variable]: marked.value });
    expect(scripts[0]?.env ?? {}).not.toHaveProperty(variable);
    expect(scripts[2]?.env ?? {}).not.toHaveProperty(variable);
  });

  it("gives a Setup Script the copy the object holds for a set-up that carries no Secrets (a spare's)", async () => {
    const marked: KeptSecret = {
      name: "NPM_TOKEN",
      value: "npm_0123456789abcdef",
      scope: "environment",
      build: true,
    };

    const { prepare, scripts, hold } = host(["/workspace/app/.git"]);

    hold([marked]);
    await prepare(setup);

    expect(scripts[1]?.env).toEqual({ [secretEnvName(marked.name)]: marked.value });
  });

  it("starts no Container when its files have every clone", async () => {
    const { prepare, scripts } = host(cloned);

    await prepare();

    expect(scripts).toEqual([]);
  });

  it("clones only the Repos that are missing, then runs each one's Setup Script if due, then its Start Script", async () => {
    const { prepare, scripts } = host(["/workspace/app/.git"]);

    await prepare();

    expect(scripts).toHaveLength(3);
    expect(scripts[0]?.script).toContain("clone_or_report 'api' 'https://github.com/acme/api.git'");
    expect(scripts[0]?.script).not.toContain("clone_or_report 'app'");
    expect(scripts[0]?.script).toContain("branch='cloudpid/1a2b3c4d'");
    expect(scripts[0]?.timeoutSeconds).toBe(CLONE_TIMEOUT_SECONDS);
    expect(scripts[1]?.script).toContain("/workspace/api/.cloudpid/setup.sh");
    expect(scripts[2]?.script).toContain("/workspace/api/.cloudpid/start.sh");
    expect(scripts[2]?.timeoutSeconds).toBeGreaterThan(5 * 60);
  });

  it("switches the clones still on the spare's branch, then runs each one's Setup Script if due and its Start Script", async () => {
    const { prepare, scripts } = host(cloned, [], {}, { "/workspace/app": SPARE_BRANCH });

    await prepare();

    expect(scripts).toHaveLength(3);
    expect(scripts[0]?.script).toContain("clone_or_report 'app' 'https://github.com/acme/app.git'");
    expect(scripts[0]?.script).not.toContain("clone_or_report 'api'");
    expect(scripts[0]?.script).toContain(`spare='${SPARE_BRANCH}'`);
    expect(scripts[1]?.script).toContain("/workspace/app/.cloudpid/setup.sh");
    expect(scripts[2]?.script).toContain("/workspace/app/.cloudpid/start.sh");
  });

  it("leaves a spare's own clones on its branch, starting no Container", async () => {
    const heads = { "/workspace/app": SPARE_BRANCH, "/workspace/api": SPARE_BRANCH };
    const { prepare, scripts } = host(cloned, [], {}, heads);

    await prepare({ ...setup, branch: SPARE_BRANCH });

    expect(scripts).toEqual([]);
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
      "The Workspace's repos could not all be cloned on, or switched to, branch cloudpid/1a2b3c4d (exit 1): fatal: repository",
    );
    expect(scripts).toHaveLength(5);
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
    expect(warnings[0]).toContain("/workspace/app/.cloudpid/setup.sh failed");
    expect(warnings[0]).toContain("ERR_PNPM_NO_LOCKFILE");
  });

  it("only reports a Start Script that fails, after a Setup Script that failed too", async () => {
    const { prepare, warnings } = host(
      ["/workspace/api/.git"],
      [
        { exitCode: 0, output: "" },
        { exitCode: 1, output: "ERR_PNPM_NO_LOCKFILE\n" },
        { exitCode: 2, output: "docker: not running\n" },
      ],
    );

    await prepare();

    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("/workspace/app/.cloudpid/start.sh failed");
    expect(warnings[1]).toContain("docker: not running");
  });

  it("hands the Environment's settings to the Workspace when they differ from what it holds", async () => {
    const same = host(cloned, [], { idleMinutes: 30, instance: "standard-4" });

    await same.prepare({ ...setup, settings: { instance: "standard-4", idleMinutes: 30 } });

    expect(same.written).toEqual([]);

    const changed = host(cloned, [], { idleMinutes: 30 });

    await changed.prepare({ ...setup, settings: { idleMinutes: 60 } });

    expect(changed.written).toEqual([{ idleMinutes: 60 }]);
  });

  it("hands the Environment's Build to the Workspace before any Container starts, when it is not the one it holds", async () => {
    const build: EnvironmentBuild = {
      key: "k1",
      snapshot: { id: "build-1", size: 1 },
      image: "img",
      ignore: null,
      commits: {},
      finishedAt: 1,
    };

    const fresh = host([]);

    await fresh.prepare({ ...setup, build });

    expect(fresh.builds.written).toEqual([build]);
    // Before the clones, whose script starts the Container: its first launch can start from the Build.
    expect(fresh.scriptsBeforeBuild()).toBe(0);

    await fresh.prepare({ ...setup, build });
    expect(fresh.builds.written).toEqual([build]);

    // A newer Build replaces it; a set-up that says nothing of Builds leaves it.
    const newer = { ...build, key: "k2", snapshot: { id: "build-2", size: 1 } };

    await fresh.prepare({ ...setup, build: newer });
    await fresh.prepare(setup);

    expect(fresh.builds.written).toEqual([build, newer]);
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
