// A Workspace's worktree on the Container (ADR-0015): the scripts run for real, under bash, with real git, against a
// throwaway root holding a Repo cloned from a local "remote".
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off processEnv:off newPromise:off asyncFunction:off
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SETUP_SCRIPT, setupRecord, setupScriptRunIfDue } from "@cloudpid/sandbox-image/toolchains";
import {
  prepareWorktreeScript,
  releaseWorktreeScript,
  removeWorktreeScript,
  type Worktree,
  WORKTREE_KEPT,
  worktreePath,
  worktreeSetupScript,
} from "@cloudpid/sandbox-image/worktrees";

/** A root with Repo `app` cloned from a bare `origin` whose default branch is `main`, and a Setup Script state. */
const machine = (options: { readonly remote?: boolean } = {}) => {
  const base = mkdtempSync(join(tmpdir(), "worktrees-"));
  const root = join(base, "workspace");
  const state = join(base, "state");
  const home = join(base, "home");
  const origin = join(base, "origin.git");

  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
  };

  for (const directory of [root, state, home]) mkdirSync(directory, { recursive: true });

  const sh = (script: string, cwd: string = root) =>
    spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env });

  const git = (args: string, cwd: string) => {
    const result = sh(`git ${args}`, cwd);

    if (result.status !== 0) throw new Error(`git ${args}: ${result.stderr}`);

    return result.stdout.trim();
  };

  const repo = join(root, "app");

  if (options.remote === false) {
    mkdirSync(repo);
    git("init -q -b main", repo);
  } else {
    git(`init -q --bare -b main ${origin}`, base);
    git(`clone -q ${origin} app`, root);
  }

  writeFileSync(join(repo, "README.md"), "hello\n");
  git("add README.md", repo);
  git("commit -q -m first", repo);

  if (options.remote !== false) git("push -q origin main", repo);

  const run = (script: string) => sh(script);

  /** Run `script` in bash as `run` does, without waiting for it: its exit status. */
  const start = (script: string) =>
    new Promise<number | null>((resolve) => {
      spawn("bash", ["-c", script], { cwd: root, env, stdio: "ignore" }).on("close", resolve);
    });

  return { base, root, state, repo, origin, git, sh, run, start };
};

const tree = (id: string, branch = `cloudpid/${id}`): Worktree => ({ repo: "app", id, branch });

/** The upstream of the branch checked out in `dir`, or "" when it tracks none. */
const upstreamOf = (dir: string, git: (args: string, cwd: string) => string): string => {
  try {
    return git("rev-parse --abbrev-ref @{upstream}", dir);
  } catch {
    return "";
  }
};

describe("preparing a Workspace's worktree", () => {
  it("makes it on a new branch from the remote's default branch, without tracking it", () => {
    const { root, state, git, run } = machine();
    const dir = worktreePath("app", "1a2b3c4d", root);

    const made = run(prepareWorktreeScript(tree("1a2b3c4d"), root, state));

    expect(made.status, made.stderr).toBe(0);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("hello\n");
    expect(git("branch --show-current", dir)).toBe("cloudpid/1a2b3c4d");
    expect(upstreamOf(dir, git)).toBe("");
  });

  it("starts from what the remote has, not from the main checkout's own branch", () => {
    const { root, state, repo, git, run } = machine();

    git("checkout -q -b local-work", repo);
    writeFileSync(join(repo, "local.txt"), "only here\n");
    git("add local.txt", repo);
    git("commit -q -m local", repo);

    run(prepareWorktreeScript(tree("1a2b3c4d"), root, state));

    expect(existsSync(join(worktreePath("app", "1a2b3c4d", root), "local.txt"))).toBe(false);
  });

  it("asks the remote for its default branch when the Repo does not know it", () => {
    const { root, state, repo, git, run } = machine();

    // A remote added by hand, not cloned from, has no `origin/HEAD`.
    git("remote set-head origin -d", repo);
    git("checkout -q -b local-work", repo);
    writeFileSync(join(repo, "local.txt"), "only here\n");
    git("add local.txt", repo);
    git("commit -q -m local", repo);

    const made = run(prepareWorktreeScript(tree("1a2b3c4d"), root, state));

    expect(made.status, made.stderr).toBe(0);
    expect(existsSync(join(worktreePath("app", "1a2b3c4d", root), "local.txt"))).toBe(false);
  });

  it("starts from the main checkout's HEAD when the Repo has no remote", () => {
    const { root, state, git, run } = machine({ remote: false });
    const dir = worktreePath("app", "1a2b3c4d", root);

    const made = run(prepareWorktreeScript(tree("1a2b3c4d"), root, state));

    expect(made.status, made.stderr).toBe(0);
    expect(git("branch --show-current", dir)).toBe("cloudpid/1a2b3c4d");
  });

  it("checks out a branch the Repo already has, and tracks one only the remote has", () => {
    const { root, state, repo, git, run } = machine();

    git("branch feature", repo);
    git("push -q origin main:remote-only", repo);

    expect(run(prepareWorktreeScript(tree("aaaa0001", "feature"), root, state)).status).toBe(0);
    expect(run(prepareWorktreeScript(tree("aaaa0002", "remote-only"), root, state)).status).toBe(0);

    expect(git("branch --show-current", worktreePath("app", "aaaa0001", root))).toBe("feature");
    expect(git("rev-parse --abbrev-ref @{upstream}", worktreePath("app", "aaaa0002", root))).toBe(
      "origin/remote-only",
    );
  });

  it("does nothing to a worktree that is there, changes included", () => {
    const { root, state, run } = machine();
    const dir = worktreePath("app", "1a2b3c4d", root);

    run(prepareWorktreeScript(tree("1a2b3c4d"), root, state));
    writeFileSync(join(dir, "draft.txt"), "work in progress\n");

    expect(run(prepareWorktreeScript(tree("1a2b3c4d"), root, state)).status).toBe(0);
    expect(readFileSync(join(dir, "draft.txt"), "utf8")).toBe("work in progress\n");
  });

  it("makes a removed worktree again from its branch, with the commits made on it", () => {
    const { root, state, git, run } = machine();
    const dir = worktreePath("app", "1a2b3c4d", root);

    run(prepareWorktreeScript(tree("1a2b3c4d"), root, state));
    writeFileSync(join(dir, "done.txt"), "committed\n");
    git("add done.txt", dir);
    git("commit -q -m done", dir);

    expect(run(removeWorktreeScript(tree("1a2b3c4d"), root, state)).status).toBe(0);
    expect(existsSync(dir)).toBe(false);

    expect(run(prepareWorktreeScript(tree("1a2b3c4d"), root, state)).status).toBe(0);
    expect(readFileSync(join(dir, "done.txt"), "utf8")).toBe("committed\n");
  });

  it("repairs a worktree whose .git file was deleted, keeping its changes", () => {
    const { root, state, run } = machine();
    const dir = worktreePath("app", "1a2b3c4d", root);

    run(prepareWorktreeScript(tree("1a2b3c4d"), root, state));
    writeFileSync(join(dir, "draft.txt"), "kept\n");
    rmSync(join(dir, ".git"));

    const made = run(prepareWorktreeScript(tree("1a2b3c4d"), root, state));

    expect(made.status, made.stderr).toBe(0);
    expect(readFileSync(join(dir, "draft.txt"), "utf8")).toBe("kept\n");
    expect(existsSync(join(dir, ".git"))).toBe(true);
  });

  it("clears what a removal left behind, with the Setup Script's record, so the script runs again", () => {
    const { root, state, run } = machine();
    const dir = worktreePath("app", "1a2b3c4d", root);
    const record = setupRecord("app@1a2b3c4d", state);

    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(record, "stale\n");

    expect(run(prepareWorktreeScript(tree("1a2b3c4d"), root, state)).status).toBe(0);
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    expect(existsSync(record)).toBe(false);
  });

  it("is ready for its Setup Script, which then runs in the worktree", () => {
    const { root, state, repo, git, run } = machine();
    const dir = worktreePath("app", "1a2b3c4d", root);

    mkdirSync(join(repo, ".agents"));
    writeFileSync(join(repo, SETUP_SCRIPT), "pwd > prepared.txt\n");
    git("add .agents", repo);
    git("commit -q -m setup", repo);
    git("push -q origin main", repo);

    run(prepareWorktreeScript(tree("1a2b3c4d"), root, state));

    const setup = run(setupScriptRunIfDue(dir, state, 60, root));

    expect(setup.status, setup.stderr).toBe(0);
    expect(readFileSync(join(dir, "prepared.txt"), "utf8").trim()).toBe(dir);
    expect(existsSync(setupRecord("app@1a2b3c4d", state))).toBe(true);
  });
});

describe("a Workspace's Setup Script", () => {
  it("runs once for two Sessions that made the worktree at once: the second waits for the first's run", async () => {
    const { root, state, repo, git, run, start } = machine();
    const dir = worktreePath("app", "5e7a0001", root);
    const runs = join(root, "runs.txt");

    mkdirSync(join(repo, ".agents"));
    writeFileSync(join(repo, SETUP_SCRIPT), `echo ran >> ${runs}\nsleep 1\n`);
    git("add .agents", repo);
    git("commit -q -m setup", repo);
    git("push -q origin main", repo);
    run(prepareWorktreeScript(tree("5e7a0001"), root, state));

    const script = worktreeSetupScript(tree("5e7a0001"), root, state, 60);

    expect(await Promise.all([start(script), start(script)])).toEqual([0, 0]);
    expect(readFileSync(runs, "utf8")).toBe("ran\n");
    expect(existsSync(setupRecord("app@5e7a0001", state))).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("removing a Workspace's worktree", () => {
  it("deletes it, changes included, and keeps its branch", () => {
    const { root, state, repo, git, run } = machine();
    const dir = worktreePath("app", "1a2b3c4d", root);

    run(prepareWorktreeScript(tree("1a2b3c4d"), root, state));
    writeFileSync(join(dir, "draft.txt"), "lost\n");

    expect(run(removeWorktreeScript(tree("1a2b3c4d"), root, state)).status).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(git("branch --list cloudpid/1a2b3c4d", repo)).toContain("cloudpid/1a2b3c4d");
    expect(git("worktree list", repo)).not.toContain("1a2b3c4d");
  });

  it("succeeds when there is nothing to remove", () => {
    const { root, state, run } = machine();

    expect(run(removeWorktreeScript(tree("1a2b3c4d"), root, state)).status).toBe(0);
  });
});

describe("releasing a Workspace's worktree", () => {
  it("removes it when it holds nothing uncommitted", () => {
    const { root, state, run } = machine();
    const dir = worktreePath("app", "1a2b3c4d", root);

    run(prepareWorktreeScript(tree("1a2b3c4d"), root, state));

    expect(run(releaseWorktreeScript(tree("1a2b3c4d"), root, state)).status).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it.each([
    ["a changed tracked file", "README.md"],
    ["an untracked file", "new.txt"],
  ])("keeps it when it holds %s", (_, file) => {
    const { root, state, run } = machine();
    const dir = worktreePath("app", "1a2b3c4d", root);

    run(prepareWorktreeScript(tree("1a2b3c4d"), root, state));
    writeFileSync(join(dir, file), "changed\n");

    expect(run(releaseWorktreeScript(tree("1a2b3c4d"), root, state)).status).toBe(WORKTREE_KEPT);
    expect(readFileSync(join(dir, file), "utf8")).toBe("changed\n");
  });

  it("succeeds when there is nothing to release", () => {
    const { root, state, run } = machine();

    expect(run(releaseWorktreeScript(tree("1a2b3c4d"), root, state)).status).toBe(0);
  });
});
