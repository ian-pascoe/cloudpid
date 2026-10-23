// An Environment's Build on the Container (docs/spec.md → Builds): the scripts run for real, under bash, with real git,
// against a throwaway scratch root and local bare "remotes", and the clean-up against real processes it must stop.
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off processEnv:off newPromise:off asyncFunction:off globalDate:off globalRandom:off globalTimers:off
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILD_RUN_VARIABLE,
  buildCleanupScript,
  buildCloneScript,
  buildCommitsScript,
  buildPrelude,
  parseCommits,
  remoteHeadsScript,
} from "@cloudpid/sandbox-image/builds";
import {
  environmentSetupScriptRun,
  ENVIRONMENT_SETUP_RECORD,
  SETUP_SCRIPT,
  setupRecord,
  setupScriptRunIfDue,
} from "@cloudpid/sandbox-image/toolchains";

/** Processes a test started, killed after it whatever became of it. */
const started: number[] = [];

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
});

/** A scratch root, a Setup Script state, a fake `mise`, and bare remotes `app` and `api` whose default branch is `main`. */
const container = () => {
  const base = mkdtempSync(join(tmpdir(), "builds-"));
  const root = join(base, "build");
  const state = join(base, "state");
  const home = join(base, "home");
  const bin = join(base, "bin");
  const run = `run-${Math.random().toString(16).slice(2)}`;

  for (const directory of [state, home, bin]) mkdirSync(directory, { recursive: true });

  // mise as the Build sees it: where it ran, and which configs it was told to trust.
  writeFileSync(
    join(bin, "mise"),
    `#!/bin/bash\necho "$1 in $PWD trusting $MISE_TRUSTED_CONFIG_PATHS" >> ${join(base, "mise.log")}\n`,
  );
  chmodSync(join(bin, "mise"), 0o755);

  const env = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: home,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
    MISE_TRUSTED_CONFIG_PATHS: "/workspace",
  };

  const sh = (script: string, cwd: string = base) =>
    spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env });

  const git = (args: string, cwd: string) => {
    const result = sh(`git ${args}`, cwd);

    if (result.status !== 0) throw new Error(`git ${args}: ${result.stderr}`);

    return result.stdout.trim();
  };

  /** A bare remote `name` with one commit on `main`, and the work tree it was pushed from. */
  const remote = (name: string) => {
    const origin = join(base, `${name}.git`);
    const work = join(base, `${name}-work`);

    git(`init -q --bare -b main ${origin}`, base);
    git(`clone -q ${origin} ${work}`, base);
    writeFileSync(join(work, "README.md"), `${name}\n`);
    git("add README.md", work);
    git("commit -q -m first", work);
    git("push -q origin main", work);

    return { origin, work };
  };

  const app = remote("app");
  const api = remote("api");

  const repos = [
    { name: "app", url: app.origin },
    { name: "api", url: api.origin },
  ];

  const miseLog = () =>
    existsSync(join(base, "mise.log")) ? readFileSync(join(base, "mise.log"), "utf8") : "";

  return { base, root, state, home, run, app, api, repos, sh, git, miseLog };
};

describe("a Build's scratch clones", () => {
  it("clones each Repo in full at its default branch, outside the Workspace, with git's hooks off", () => {
    const { root, repos, app, home, git, sh, base } = container();

    git("checkout -q -b other", app.work);
    git("push -q origin other", app.work);
    // A hook git would run on checkout, from the Container's own git config.
    const hooks = join(base, "hooks");

    mkdirSync(hooks);
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\ntouch ${join(base, "hooked")}\n`);
    chmodSync(join(hooks, "post-checkout"), 0o755);
    writeFileSync(join(home, ".gitconfig"), `[core]\n\thooksPath = ${hooks}\n`);

    const made = sh(buildCloneScript(repos, root, "file"));

    expect(made.status, made.stderr).toBe(0);

    for (const name of ["app", "api"]) {
      const dir = join(root, name);

      expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(`${name}\n`);
      expect(git("branch --show-current", dir)).toBe("main");
    }

    expect(git("rev-parse --is-shallow-repository", join(root, "app"))).toBe("false");
    expect(git("branch -r", join(root, "app"))).toContain("origin/other");
    expect(existsSync(join(base, "hooked"))).toBe(false);
  });

  it("starts from an empty root, so nothing of an earlier Build is left", () => {
    const { root, repos, sh } = container();

    mkdirSync(join(root, "stale"), { recursive: true });

    expect(sh(buildCloneScript(repos, root, "file")).status).toBe(0);
    expect(existsSync(join(root, "stale"))).toBe(false);
  });

  it("installs the Toolchains of a clone that declares them, trusting the scratch root", () => {
    const { root, repos, app, git, sh, miseLog } = container();

    writeFileSync(join(app.work, "mise.toml"), '[tools]\nnode = "22"\n');
    git("add mise.toml", app.work);
    git("commit -q -m mise", app.work);
    git("push -q origin main", app.work);

    const made = sh(`${buildPrelude("r", root)}${buildCloneScript(repos, root, "file")}`);

    expect(made.status, made.stderr).toBe(0);
    expect(miseLog()).toBe(`install in ${join(root, "app")} trusting /workspace:${root}\n`);
  });

  it("fails the Build when a Repo cannot be cloned, naming it", () => {
    const { root, base, sh } = container();

    const made = sh(
      buildCloneScript([{ name: "gone", url: join(base, "missing.git") }], root, "file"),
    );

    expect(made.status).toBe(1);
    expect(made.stderr).toContain(`could not clone ${join(base, "missing.git")}`);
  });

  it("refuses a transport the Build does not allow", () => {
    const { root, repos, sh } = container();

    expect(sh(buildCloneScript(repos, root)).status).toBe(1);
  });

  it("tells each clone's commit, and each remote's default branch head, the same way", () => {
    const { root, repos, app, api, git, sh } = container();

    sh(buildCloneScript(repos, root, "file"));

    const commits = parseCommits(sh(buildCommitsScript(repos, root)).stdout);

    expect(commits).toEqual({
      app: git("rev-parse HEAD", app.work),
      api: git("rev-parse HEAD", api.work),
    });

    writeFileSync(join(app.work, "next.txt"), "next\n");
    git("add next.txt", app.work);
    git("commit -q -m next", app.work);
    git("push -q origin main", app.work);

    const heads = sh(remoteHeadsScript(repos, "file"));

    expect(heads.status, heads.stderr).toBe(0);
    expect(parseCommits(heads.stdout)).toEqual({
      app: git("rev-parse HEAD", app.work),
      api: commits["api"],
    });
  });

  it("tells a Repo with no commits yet as none", () => {
    const { root, base, git, sh } = container();
    const empty = join(base, "empty.git");

    git(`init -q --bare -b main ${empty}`, base);

    const repos = [{ name: "empty", url: empty }];

    expect(sh(buildCloneScript(repos, root, "file")).status).toBe(0);
    expect(parseCommits(sh(buildCommitsScript(repos, root)).stdout)).toEqual({ empty: null });
    expect(parseCommits(sh(remoteHeadsScript(repos, "file")).stdout)).toEqual({ empty: null });
  });

  it("fails when a remote cannot be asked for its head", () => {
    const { base, sh } = container();

    const heads = sh(remoteHeadsScript([{ name: "gone", url: join(base, "missing.git") }], "file"));

    expect(heads.status).toBe(1);
  });
});

describe("a Build's Setup Scripts", () => {
  it("runs the Environment's in the scratch root and each Repo's in its clone, recording them", () => {
    const { root, state, repos, app, git, sh } = container();

    mkdirSync(join(app.work, ".agents"));
    writeFileSync(join(app.work, SETUP_SCRIPT), 'echo "repo in $PWD" > ../repo-ran\n');
    git("add .agents", app.work);
    git("commit -q -m setup", app.work);
    git("push -q origin main", app.work);
    sh(buildCloneScript(repos, root, "file"));

    const file = join(state, "..", "environment-setup.sh");

    const environment = sh(
      environmentSetupScriptRun('echo "environment in $PWD" > env-ran\n', root, file, state),
    );

    expect(environment.status, environment.stderr).toBe(0);
    expect(readFileSync(join(root, "env-ran"), "utf8")).toBe(`environment in ${root}\n`);
    expect(existsSync(setupRecord(ENVIRONMENT_SETUP_RECORD, state))).toBe(true);

    const repo = sh(setupScriptRunIfDue(join(root, "app"), state, undefined, root));

    expect(repo.status, repo.stderr).toBe(0);
    expect(readFileSync(join(root, "repo-ran"), "utf8")).toBe(`repo in ${join(root, "app")}\n`);
    expect(existsSync(setupRecord("app", state))).toBe(true);
  });
});

/** Start `script` in bash, detached, with `env`; its pid. It is killed after the test. */
const detached = (script: string, env: Record<string, string>): number => {
  const child = spawn("bash", ["-c", script], {
    env: { PATH: process.env.PATH ?? "", ...env },
    detached: true,
    stdio: "ignore",
  });

  child.unref();

  // SAFETY: a spawned process that started has a pid.
  const pid = child.pid as number;

  started.push(pid);

  return pid;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    // A zombie is gone for this purpose.
    return !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
  } catch {
    return false;
  }
};

/** Wait until `check` holds, for up to `ms`. */
const until = async (check: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;

  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
};

describe("a Build's clean-up", () => {
  it("stops what the Build's scripts left running, Docker's daemon first, and leaves every other process alone", async () => {
    const { base, root, state, run, sh } = container();
    const tagged = { [BUILD_RUN_VARIABLE]: run };

    // A daemon named dockerd that notes, when asked to stop, whether the Build's other service still ran.
    const bin = join(base, "daemons");

    mkdirSync(bin);
    writeFileSync(
      join(bin, "dockerd"),
      `#!/bin/bash\ntrap 'kill -0 "$(cat ${join(base, "service.pid")})" 2>/dev/null && echo first > ${join(base, "dockerd.stopped")}; exit 0' TERM\nwhile :; do sleep 0.1; done\n`,
    );
    chmodSync(join(bin, "dockerd"), 0o755);

    const service = detached("exec sleep 300", tagged);

    writeFileSync(join(base, "service.pid"), String(service));

    const dockerd = detached(`exec ${join(bin, "dockerd")}`, tagged);
    // One that ignores the polite request.
    const stubborn = detached("trap '' TERM; while :; do sleep 0.1; done", tagged);
    // Not the Build's: another run's, and one with no tag.
    const other = detached("exec sleep 300", { [BUILD_RUN_VARIABLE]: `${run}-other` });
    const untagged = detached("exec sleep 300", {});

    await until(() => existsSync(`/proc/${stubborn}`));
    // Give the shells a moment to set their traps.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The stubborn one gets one second, not five, to keep the test short.
    const cleaned = sh(`${buildPrelude(run, root)}${buildCleanupScript(run, root, state, 1)}`);

    expect(cleaned.status, cleaned.stderr).toBe(0);
    await until(() => !alive(service) && !alive(dockerd) && !alive(stubborn));
    expect([alive(service), alive(dockerd), alive(stubborn)]).toEqual([false, false, false]);
    expect(readFileSync(join(base, "dockerd.stopped"), "utf8")).toBe("first\n");
    expect([alive(other), alive(untagged)]).toEqual([true, true]);
  }, 60_000);

  it("deletes the scratch clones and every Setup Script record, the Environment's too", () => {
    const { root, state, run, repos, sh } = container();

    sh(buildCloneScript(repos, root, "file"));
    writeFileSync(setupRecord("app", state), "hash\n");
    writeFileSync(setupRecord(ENVIRONMENT_SETUP_RECORD, state), "hash\n");

    const cleaned = sh(buildCleanupScript(run, root, state));

    expect(cleaned.status, cleaned.stderr).toBe(0);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(setupRecord("app", state))).toBe(false);
    expect(existsSync(setupRecord(ENVIRONMENT_SETUP_RECORD, state))).toBe(false);
  });
});
