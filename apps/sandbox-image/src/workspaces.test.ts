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
import { SETUP_SCRIPT, setupRecord, START_SCRIPT } from "@cloudpid/sandbox-image/toolchains";
import {
  prepareWorkspaceScript,
  repoSetupScript,
  repoStartScript,
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

describe("a clone's Start Script", () => {
  /** A Workspace whose clone `app` was made with a Start Script that counts its runs. */
  const withStartScript = () => {
    const workspace = container();
    const { root, prepare } = workspace;

    prepare();
    mkdirSync(join(root, "app", ".agents"), { recursive: true });
    writeFileSync(join(root, "app", START_SCRIPT), 'echo "$PWD" >> ../start-runs\n');

    const runs = () =>
      existsSync(join(root, "start-runs")) ? readFileSync(join(root, "start-runs"), "utf8") : "";

    return { ...workspace, runs };
  };

  it("runs once in the clone that was made, though two Sessions ask", async () => {
    const { root, runs, start } = withStartScript();

    expect(
      await Promise.all([start(repoStartScript("app", root)), start(repoStartScript("app", root))]),
    ).toEqual([0, 0]);
    expect(runs()).toBe(`${join(root, "app")}\n`);
  });

  it("runs again in a clone made again", () => {
    const { root, sh, runs, prepare } = withStartScript();

    sh(repoStartScript("app", root));
    sh(`rm -rf ${join(root, "app")}`);
    prepare();
    mkdirSync(join(root, "app", ".agents"), { recursive: true });
    writeFileSync(join(root, "app", START_SCRIPT), 'echo "$PWD" >> ../start-runs\n');
    sh(repoStartScript("app", root));

    expect(runs()).toBe(`${join(root, "app")}\n${join(root, "app")}\n`);
  });

  it("exits with the script's status", () => {
    const { root, sh } = withStartScript();

    writeFileSync(join(root, "app", START_SCRIPT), "exit 5\n");

    expect(sh(repoStartScript("app", root)).status).toBe(5);
  });

  it("does nothing for a clone without one", () => {
    const { root, sh, runs } = withStartScript();

    expect(sh(repoStartScript("api", root)).status).toBe(0);
    expect(runs()).toBe("");
  });
});

describe("taking a spare Workspace's clones", () => {
  const SPARE = "cloudpid/spare";

  /** A Workspace whose clones were made as a spare's, on `SPARE`, then the readying of the Workspace that took it. */
  const spare = () => {
    const workspace = container();
    const { root, state, app, api, sh } = workspace;

    const take = (clones: Partial<WorkspaceClones> = {}) =>
      sh(
        prepareWorkspaceScript(
          {
            repos: [
              { name: "app", url: app.origin },
              { name: "api", url: api.origin },
            ],
            branch: "cloudpid/1a2b3c4d",
            base: null,
            spare: SPARE,
            ...clones,
          },
          root,
          "file",
          state,
        ),
      );

    const made = take({ branch: SPARE });

    if (made.status !== 0) throw new Error(made.stderr);

    // The spare's Start Scripts ran when it was prepared.
    sh(`rm -rf /tmp/cloudpid-start-due${root}`);

    const startDue = (name: string) => existsSync(`/tmp/cloudpid-start-due${root}/${name}`);

    return { ...workspace, take, startDue };
  };

  /** Push a commit of `file` to `branch` of the remote whose work tree is `work`. */
  const pushCommit = (
    git: (args: string, cwd: string) => string,
    work: string,
    branch: string,
    file: string,
  ) => {
    git(`checkout -q -B ${branch}`, work);
    writeFileSync(join(work, file), `${file}\n`);
    git(`add ${file}`, work);
    git(`commit -q -m ${file}`, work);
    git(`push -q origin ${branch}`, work);
  };

  it("switches each clone to the Workspace's branch, made from the default branch, and drops the spare's", () => {
    const { root, git, take } = spare();

    const taken = take();

    expect(taken.status, taken.stderr).toBe(0);

    for (const name of ["app", "api"]) {
      const dir = join(root, name);

      expect(git("branch --show-current", dir)).toBe("cloudpid/1a2b3c4d");
      expect(upstreamOf(dir, git)).toBe("");
      expect(git(`branch --list ${SPARE}`, dir)).toBe("");
    }
  });

  it("fetches first, so a branch pushed since is checked out and tracked, and a new base is found", () => {
    const { root, app, api, git, take } = spare();

    pushCommit(git, app.work, "feature", "feature.txt");
    pushCommit(git, api.work, "release", "release.txt");

    const taken = take({ branch: "feature", base: "release" });

    expect(taken.status, taken.stderr).toBe(0);
    expect(existsSync(join(root, "app", "feature.txt"))).toBe(true);
    expect(upstreamOf(join(root, "app"), git)).toBe("origin/feature");
    expect(existsSync(join(root, "api", "release.txt"))).toBe(true);
    expect(git("branch --show-current", join(root, "api"))).toBe("feature");
    expect(upstreamOf(join(root, "api"), git)).toBe("");
  });

  it("marks a clone whose commit moved for its Setup Script and its Start Script", () => {
    const { root, state, app, git, take, startDue } = spare();

    writeFileSync(setupRecord("app", state), "hash\n");
    writeFileSync(setupRecord("api", state), "hash\n");
    pushCommit(git, app.work, "main", "later.txt");

    const taken = take();

    expect(taken.status, taken.stderr).toBe(0);
    expect(existsSync(join(root, "app", "later.txt"))).toBe(true);
    expect(existsSync(setupRecord("app", state))).toBe(false);
    expect(startDue("app")).toBe(true);
    // The other's commit did not move: its Setup Script is done and its services run.
    expect(existsSync(setupRecord("api", state))).toBe(true);
    expect(startDue("api")).toBe(false);
  });

  it("keeps what the spare's Setup Script changed when the commit did not move", () => {
    const { root, take } = spare();

    writeFileSync(join(root, "app", "README.md"), "installed\n");

    expect(take().status).toBe(0);
    expect(readFileSync(join(root, "app", "README.md"), "utf8")).toBe("installed\n");
  });

  it("fails a clone whose base the remote does not have, and still switches the others", () => {
    const { root, api, git, take } = spare();

    pushCommit(git, api.work, "release", "release.txt");

    const taken = take({ base: "release" });

    expect(taken.status).toBe(1);
    expect(taken.stderr).toContain("has no branch release");
    expect(git("branch --show-current", join(root, "app"))).toBe(SPARE);
    expect(git("branch --show-current", join(root, "api"))).toBe("cloudpid/1a2b3c4d");
  });

  it("leaves the spare's own clones on its branch when it is readied again", () => {
    const { root, git, take } = spare();

    expect(take({ branch: SPARE }).status).toBe(0);
    expect(git("branch --show-current", join(root, "app"))).toBe(SPARE);
  });

  it("puts a clone of an empty repo on the Workspace's branch, still unborn", () => {
    const { base, root, state, git, sh } = container();
    const empty = join(base, "empty.git");

    git(`init -q --bare -b main ${empty}`, base);

    const clones = (branch: string): WorkspaceClones => ({
      repos: [{ name: "empty", url: empty }],
      branch,
      base: null,
      spare: SPARE,
    });

    sh(prepareWorkspaceScript(clones(SPARE), root, "file", state));

    const taken = sh(prepareWorkspaceScript(clones("cloudpid/1a2b3c4d"), root, "file", state));

    expect(taken.status, taken.stderr).toBe(0);
    expect(git("symbolic-ref --short HEAD", join(root, "empty"))).toBe("cloudpid/1a2b3c4d");
  });

  it("ends on the Workspace's branch when it is taken while the spare is still cloning", async () => {
    const { root, state, app, api, git, start } = container();

    const script = (branch: string) =>
      prepareWorkspaceScript(
        {
          repos: [
            { name: "app", url: app.origin },
            { name: "api", url: api.origin },
          ],
          branch,
          base: null,
          spare: SPARE,
        },
        root,
        "file",
        state,
      );

    expect(await Promise.all([start(script(SPARE)), start(script("cloudpid/1a2b3c4d"))])).toEqual([
      0, 0,
    ]);

    // Whichever ran first, the second found the clones there: on the Workspace's branch, or on the spare's to switch.
    expect(git("branch --show-current", join(root, "app"))).toBe("cloudpid/1a2b3c4d");
    expect(git("branch --show-current", join(root, "api"))).toBe("cloudpid/1a2b3c4d");
  });
});
