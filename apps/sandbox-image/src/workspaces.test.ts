// A Workspace's clones on the Container (ADR-0016): the scripts run for real, under bash, with real git, against a
// throwaway root and local bare "remotes".
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off processEnv:off newPromise:off asyncFunction:off
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
import { describe, expect, it } from "vitest";
import { SETUP_SCRIPT, setupRecord } from "@cloudpid/sandbox-image/toolchains";
import {
  prepareWorkspaceScript,
  repoSetupScript,
  type WorkspaceClones,
} from "@cloudpid/sandbox-image/workspaces";

/** A Workspace root, a Setup Script state, and bare remotes `app` and `api` whose default branch is `main`. */
const container = () => {
  const base = mkdtempSync(join(tmpdir(), "workspaces-"));
  const root = join(base, "workspace");
  const state = join(base, "state");
  const home = join(base, "home");
  const hooks = join(base, "hooks");

  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
  };

  for (const directory of [root, state, home, hooks]) mkdirSync(directory, { recursive: true });

  const sh = (script: string, cwd: string = root) =>
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

  const prepare = (clones: Partial<WorkspaceClones> = {}) =>
    sh(
      prepareWorkspaceScript(
        {
          repos: [
            { name: "app", url: app.origin },
            { name: "api", url: api.origin },
          ],
          branch: "cloudpid/1a2b3c4d",
          base: null,
          ...clones,
        },
        root,
        "file",
      ),
    );

  /** Run `script` in bash without waiting for it: its exit status. */
  const start = (script: string) =>
    new Promise<number | null>((resolve) => {
      spawn("bash", ["-c", script], { cwd: root, env, stdio: "ignore" }).on("close", resolve);
    });

  return { base, root, state, home, hooks, app, api, git, sh, prepare, start };
};

/** The upstream of the branch checked out in `dir`, or "" when it tracks none. */
const upstreamOf = (dir: string, git: (args: string, cwd: string) => string): string => {
  try {
    return git("rev-parse --abbrev-ref @{upstream}", dir);
  } catch {
    return "";
  }
};

describe("preparing a Workspace's clones", () => {
  it("clones every Repo on a new branch from its default branch, without tracking it", () => {
    const { root, git, prepare } = container();

    const made = prepare();

    expect(made.status, made.stderr).toBe(0);

    for (const name of ["app", "api"]) {
      const dir = join(root, name);

      expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(`${name}\n`);
      expect(git("branch --show-current", dir)).toBe("cloudpid/1a2b3c4d");
      expect(upstreamOf(dir, git)).toBe("");
    }
  });

  it("makes full clones, with every branch the remote has", () => {
    const { root, app, git, prepare } = container();

    git("checkout -q -b other", app.work);
    git("push -q origin other", app.work);

    prepare();

    expect(git("rev-parse --is-shallow-repository", join(root, "app"))).toBe("false");
    expect(git("branch -r", join(root, "app"))).toContain("origin/other");
  });

  it("checks out and tracks the branch when the remote has it", () => {
    const { root, app, git, prepare } = container();

    git("checkout -q -b feature", app.work);
    writeFileSync(join(app.work, "feature.txt"), "on the branch\n");
    git("add feature.txt", app.work);
    git("commit -q -m feature", app.work);
    git("push -q origin feature", app.work);

    const made = prepare({ branch: "feature" });

    expect(made.status, made.stderr).toBe(0);
    expect(existsSync(join(root, "app", "feature.txt"))).toBe(true);
    expect(upstreamOf(join(root, "app"), git)).toBe("origin/feature");
    // The other Repo has no such branch: it is made there from the default one.
    expect(git("branch --show-current", join(root, "api"))).toBe("feature");
    expect(upstreamOf(join(root, "api"), git)).toBe("");
  });

  it("starts the new branch from the base when one is given", () => {
    const { root, app, api, git, prepare } = container();

    for (const { work } of [app, api]) {
      git("checkout -q -b release", work);
      writeFileSync(join(work, "release.txt"), "release\n");
      git("add release.txt", work);
      git("commit -q -m release", work);
      git("push -q origin release", work);
    }

    const made = prepare({ base: "release" });

    expect(made.status, made.stderr).toBe(0);
    expect(existsSync(join(root, "app", "release.txt"))).toBe(true);
    expect(git("branch --show-current", join(root, "app"))).toBe("cloudpid/1a2b3c4d");
  });

  it("fails a Repo that has no such base, and still clones the others", () => {
    const { root, app, git, prepare } = container();

    git("checkout -q -b release", app.work);
    git("push -q origin release", app.work);

    const made = prepare({ base: "release" });

    expect(made.status).toBe(1);
    expect(made.stderr).toContain("has no branch release");
    expect(existsSync(join(root, "app", ".git"))).toBe(true);
    expect(existsSync(join(root, "api"))).toBe(false);
    expect(existsSync(join(root, ".cloudpid-clone-api"))).toBe(false);
  });

  it("leaves a clone that is there alone, uncommitted work included", () => {
    const { root, prepare } = container();

    prepare();
    writeFileSync(join(root, "app", "README.md"), "changed\n");

    const again = prepare();

    expect(again.status, again.stderr).toBe(0);
    expect(readFileSync(join(root, "app", "README.md"), "utf8")).toBe("changed\n");
  });

  it("does not clone over a directory that is not a clone", () => {
    const { root, prepare } = container();

    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app", "notes.txt"), "mine\n");

    const made = prepare();

    expect(made.status).toBe(1);
    expect(made.stderr).toContain("is not a clone");
    expect(readFileSync(join(root, "app", "notes.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(root, "api", ".git"))).toBe(true);
  });

  it("runs no git hook, and tells the Repo's scripts to skip reference clones", () => {
    const { root, hooks, git, prepare, home } = container();
    const ran = join(home, "hook-ran");

    writeFileSync(
      join(hooks, "post-checkout"),
      `#!/bin/sh\necho "$SKIP_REFERENCE_REPOS" > ${ran}\n`,
    );
    chmodSync(join(hooks, "post-checkout"), 0o755);
    git(`config --global core.hooksPath ${hooks}`, root);

    const made = prepare();

    expect(made.status, made.stderr).toBe(0);
    expect(existsSync(ran)).toBe(false);
  });

  it("clones a Repo with no commits on the Workspace's branch", () => {
    const { base, root, git, sh } = container();
    const empty = join(base, "empty.git");

    git(`init -q --bare -b main ${empty}`, base);

    const made = sh(
      prepareWorkspaceScript(
        { repos: [{ name: "empty", url: empty }], branch: "cloudpid/1a2b3c4d", base: null },
        root,
        "file",
      ),
    );

    expect(made.status, made.stderr).toBe(0);
    expect(git("symbolic-ref --short HEAD", join(root, "empty"))).toBe("cloudpid/1a2b3c4d");
  });

  it("clones once when two Sessions prepare the Workspace at the same time", async () => {
    const { root, app, api, start } = container();

    const script = prepareWorkspaceScript(
      {
        repos: [
          { name: "app", url: app.origin },
          { name: "api", url: api.origin },
        ],
        branch: "cloudpid/1a2b3c4d",
        base: null,
      },
      root,
      "file",
    );

    expect(await Promise.all([start(script), start(script)])).toEqual([0, 0]);
    expect(existsSync(join(root, "app", ".git"))).toBe(true);
  });

  it("only uses the transports it is allowed", () => {
    const { root, app, sh } = container();

    const made = sh(
      prepareWorkspaceScript(
        { repos: [{ name: "app", url: app.origin }], branch: "b", base: null },
        root,
      ),
    );

    expect(made.status).toBe(1);
    expect(existsSync(join(root, "app"))).toBe(false);
  });
});

describe("a clone's Setup Script", () => {
  it("runs once the clone is made, and not again until it changes", () => {
    const { root, state, sh, prepare } = container();

    prepare();
    mkdirSync(join(root, "app", ".agents"), { recursive: true });
    writeFileSync(join(root, "app", SETUP_SCRIPT), "echo ran >> ../setup-runs\n");

    expect(sh(repoSetupScript("app", root, state)).status).toBe(0);
    expect(sh(repoSetupScript("app", root, state)).status).toBe(0);
    expect(readFileSync(join(root, "setup-runs"), "utf8")).toBe("ran\n");
    expect(existsSync(setupRecord("app", state))).toBe(true);
  });

  it("does nothing for a clone without one", () => {
    const { root, state, sh, prepare } = container();

    prepare();

    expect(sh(repoSetupScript("api", root, state)).status).toBe(0);
    expect(existsSync(setupRecord("api", state))).toBe(false);
  });
});
