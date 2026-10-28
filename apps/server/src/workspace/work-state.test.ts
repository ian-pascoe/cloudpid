// The work-state module over repos real git made in a temp directory: the Workspace DO's files are that directory (as
// `/workspace`), and the Container is bash running the real `workStateScript` there, so every answer the Workspace DO
// gives itself is checked against the Container's.
// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off preferEffectArray:off processEnv:off
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WORKSPACE_ROOT } from "@cloudpid/protocol";
import { parseWorkState, workStateScript } from "@cloudpid/sandbox-image/workspaces";
import { afterEach, describe, expect, it } from "vitest";
import { type ChangesFiles, type ContainerOnly, WorkspaceChangesModule } from "./changes.ts";
import { porcelainLines, WorkspaceWorkStateModule } from "./work-state.ts";

const BRANCH = "cloudpid/1a2b3c4d";

const env = {
  PATH: process.env.PATH ?? "",
  HOME: tmpdir(),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A Workspace root with a bare `origin` beside it: `sh` runs bash in the root, and `clone(repo)` clones the origin's
 * `main` as `/workspace/<repo>` and checks out `BRANCH` from it, as a Subagent Workspace's set-up does.
 */
const workspace = () => {
  const base = mkdtempSync(join(tmpdir(), "work-state-"));
  const root = join(base, "workspace");
  const origin = join(base, "origin.git");

  roots.push(base);
  mkdirSync(root);

  const sh = (script: string, cwd = root) => {
    const result = spawnSync("bash", ["-c", `set -e\n${script}`], { cwd, encoding: "utf8", env });

    if (result.status !== 0) throw new Error(`${script}\n${result.stderr}`);

    return result.stdout;
  };

  // The remote: `main` with two commits.
  sh(`git init -q --bare -b main '${origin}'
seed='${join(base, "seed")}'
git init -q -b main "$seed"
cd "$seed"
printf 'one\\n' > a.txt
printf 'out/\\n*.log\\n' > .gitignore
mkdir -p src/lib
printf 'lib\\n' > src/lib/lib.ts
git add -A && git commit -q -m first
printf 'two\\n' >> a.txt
git commit -q -am second
git push -q '${origin}' main`);

  const clone = (repo: string) =>
    sh(`git clone -q '${origin}' ${repo}
git -C ${repo} checkout -q -b ${BRANCH}`);

  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };

  /** The Workspace DO's files: the root, as `/workspace`. */
  const files: ChangesFiles = {
    readFile: (path, options) =>
      fsp.readFile(root + path.slice(WORKSPACE_ROOT.length), options ?? null),
    stat: (path) => fsp.stat(root + path.slice(WORKSPACE_ROOT.length)),
    lstat: (path) => fsp.lstat(root + path.slice(WORKSPACE_ROOT.length)),
    readdir: (path) => fsp.readdir(root + path.slice(WORKSPACE_ROOT.length)),
    readlink: (path) => fsp.readlink(root + path.slice(WORKSPACE_ROOT.length)),
  };

  /** What the Container's git reads of `repos`: the real script, run on the root. */
  const onContainer = (repos: ReadonlyArray<string>, branch = BRANCH) =>
    parseWorkState(sh(workStateScript(repos, branch, root)), repos);

  return { root, origin, sh, clone, write, files, onContainer };
};

/** A module over `space`, its Container stopped until a read starts it, and what it ran and logged recorded. */
const module = (
  space: ReturnType<typeof workspace>,
  options: {
    readonly containerOnly?: ContainerOnly;
    readonly maxWalkedCommits?: number;
    readonly running?: boolean;
  } = {},
) => {
  const scripts: string[] = [];
  const container = { running: options.running ?? false, scripts, fails: false };
  const warnings: string[] = [];
  const containerOnly = options.containerOnly ?? (() => false);

  const changes = new WorkspaceChangesModule({
    files: () => space.files,
    containerOnly: async () => containerOnly,
    running: () => container.running,
    run: async () => {
      throw new Error("The Changes are not listed here");
    },
    kept: { load: async () => undefined, save: async () => {} },
    warn: () => {},
  });

  const workState = new WorkspaceWorkStateModule({
    files: () => space.files,
    needsContainer: (repo) => changes.needsContainer(repo),
    containerOnly: async () => containerOnly,
    running: () => container.running,
    run: async (script) => {
      container.scripts.push(script);
      container.running = true;

      if (container.fails) return { exitCode: 1, stdout: "", stderr: "git: no\n" };

      // The script the Workspace DO runs, for `/workspace`, is run on the temp root instead.
      expect(script).toMatch(/^root=.*\/workspace.*$/mu);

      const ran = spawnSync("bash", ["-c", script.replace(/^root=.*$/mu, `root='${space.root}'`)], {
        cwd: space.root,
        encoding: "utf8",
        env,
      });

      return { exitCode: ran.status, stdout: ran.stdout, stderr: ran.stderr };
    },
    warn: (message) => warnings.push(message),
    maxWalkedCommits: options.maxWalkedCommits,
  });

  return { workState, container, warnings };
};

describe("the Workspace DO's read of unpushed work", () => {
  it("answers as the Container's git does, and starts no Container", async () => {
    const space = workspace();
    const { sh, clone, write } = space;

    // Fresh from the remote: the branch is not on it, but has no commit of its own.
    clone("fresh");

    // No upstream: two commits on a branch the remote never had.
    clone("local");
    sh(`cd local && printf 'x\\n' > x.txt && git add x.txt && git commit -q -m x
printf 'y\\n' >> x.txt && git commit -q -am y`);

    // Uncommitted changes of every kind git status lists.
    clone("dirty");
    write("dirty/a.txt", "changed\n");
    write("dirty/staged.txt", "staged\n");
    sh(`cd dirty && git add staged.txt`);
    write("dirty/staged.txt", "staged, then changed\n");
    write("dirty/new.txt", "untracked\n");
    write("dirty/fresh/one.txt", "1\n");
    write("dirty/fresh/deep/two.txt", "2\n");
    write("dirty/src/lib/extra.ts", "extra\n");
    write("dirty/src/new/three.ts", "3\n");
    write("dirty/out/ignored.js", "ignored\n");
    write("dirty/debug.log", "ignored\n");
    sh(`cd dirty && git rm -q --cached .gitignore`);
    sh(`cd dirty && git rm -q src/lib/lib.ts`);

    // A clone a set-up left on another branch, and one on a detached HEAD.
    clone("spare");
    sh(`cd spare && git checkout -q -b cloudpid/spare && git branch -q -D ${BRANCH}`);
    clone("detached");
    sh(`cd detached && git checkout -q --detach`);

    // Nothing ahead: the branch pushed as it is.
    clone("pushed");
    sh(`cd pushed && git push -q origin ${BRANCH}`);

    // Commits ahead of the remote branch, one of them a merge of the remote's newer `main`.
    clone("ahead");
    sh(`cd ahead && printf 'mine\\n' > mine.txt && git add mine.txt && git commit -q -m mine
cd .. && git clone -q "$(git -C ahead remote get-url origin)" other
cd other && printf 'theirs\\n' > theirs.txt && git add theirs.txt && git commit -q -m theirs && git push -q origin main
cd ../ahead && git fetch -q origin && git merge -q --no-edit origin/main
printf 'more\\n' >> mine.txt && git commit -q -am more
git gc -q`);
    rmSync(join(space.root, "other"), { recursive: true, force: true });

    // A repo with no remote at all, and one with no commit yet.
    sh(`git init -q -b ${BRANCH} alone && cd alone && printf 'a\\n' > a && git add a && git commit -q -m a
printf 'b\\n' > a && git commit -q -am b && printf 'c\\n' > a && git commit -q -am c`);
    sh(`git init -q -b ${BRANCH} unborn && printf 'u\\n' > unborn/u.txt`);

    const repos = [
      "pushed",
      "fresh",
      "ahead",
      "local",
      "dirty",
      "spare",
      "detached",
      "alone",
      "unborn",
      "missing",
    ];

    const { workState, container, warnings } = module(space);
    const own = await workState.read(BRANCH, repos);

    expect(container.scripts).toEqual([]);
    expect(warnings).toEqual([]);
    expect(own).toEqual(space.onContainer(repos));
    // What the Container says, so the comparison above is of the cases named.
    expect(own).toEqual([
      { repo: "pushed", cloned: true, uncommitted: 0, unpushed: 0, onRemote: true, head: BRANCH },
      { repo: "fresh", cloned: true, uncommitted: 0, unpushed: 0, onRemote: false, head: BRANCH },
      { repo: "ahead", cloned: true, uncommitted: 0, unpushed: 3, onRemote: true, head: BRANCH },
      { repo: "local", cloned: true, uncommitted: 0, unpushed: 2, onRemote: false, head: BRANCH },
      // a.txt, staged.txt, new.txt, fresh/, src/lib/lib.ts, src/ (no tracked file left in it), .gitignore twice.
      { repo: "dirty", cloned: true, uncommitted: 8, unpushed: 0, onRemote: false, head: BRANCH },
      {
        repo: "spare",
        cloned: true,
        uncommitted: 0,
        unpushed: 0,
        onRemote: false,
        head: "cloudpid/spare",
      },
      { repo: "detached", cloned: true, uncommitted: 0, unpushed: 0, onRemote: false, head: null },
      { repo: "alone", cloned: true, uncommitted: 0, unpushed: 3, onRemote: false, head: BRANCH },
      { repo: "unborn", cloned: true, uncommitted: 1, unpushed: 0, onRemote: false, head: BRANCH },
      { repo: "missing", cloned: false, uncommitted: 0, unpushed: 0, onRemote: false, head: null },
    ]);

    // Another branch than the one checked out: its commits counted as git counts them.
    expect(await workState.read("main", ["ahead", "local"])).toEqual(
      space.onContainer(["ahead", "local"], "main"),
    );
    expect(container.scripts).toEqual([]);
  });

  it("leaves to a running Container every read, as it sees what is not synced yet", async () => {
    const space = workspace();

    space.clone("app");

    const { workState, container } = module(space, { running: true });

    expect(await workState.read(BRANCH, ["app"])).toEqual(space.onContainer(["app"]));
    expect(container.scripts).toEqual([workStateScript(["app"], BRANCH)]);
  });

  it("starts the Container for a repo it cannot read, only that repo, and says so in the log", async () => {
    const space = workspace();

    space.clone("app");
    space.clone("api");
    // A rule git applies when it compares: a CRLF-only change is no change to git.
    space.sh(`cd api && printf '* text=auto eol=lf\\n' > .gitattributes && git add . && git commit -q -m attributes
printf 'one\\r\\ntwo\\r\\n' > a.txt`);
    space.write("app/new.txt", "new\n");

    const { workState, container, warnings } = module(space);

    expect(await workState.read(BRANCH, ["app", "api"])).toEqual(space.onContainer(["app", "api"]));
    expect(container.scripts).toEqual([workStateScript(["api"], BRANCH)]);
    expect(warnings).toEqual([
      expect.stringMatching(/^work state: api needs the Container's git/u),
    ]);
  });

  it("leaves to the Container a repo whose walk is past the cap", async () => {
    const space = workspace();

    space.clone("app");
    space.sh(`cd app && for n in 1 2 3; do git commit -q --allow-empty -m "$n"; done`);

    const { workState, container, warnings } = module(space, { maxWalkedCommits: 3 });

    expect(await workState.read(BRANCH, ["app"])).toEqual([
      { repo: "app", cloned: true, uncommitted: 0, unpushed: 3, onRemote: false, head: BRANCH },
    ]);
    expect(container.scripts).toHaveLength(1);
    expect(warnings).toEqual([expect.stringContaining("more than 3 commits to walk")]);
  });

  it("falls back to the Container when isomorphic-git fails, and rejects when that read fails", async () => {
    const space = workspace();

    space.clone("app");
    // A remote branch whose commit the clone lacks.
    space.write("app/.git/refs/remotes/origin/gone", `${"0".repeat(40)}\n`);

    const { workState, container, warnings } = module(space);

    container.fails = true;

    await expect(workState.read(BRANCH, ["app"])).rejects.toThrow(
      "The workspace's repos could not be read: git: no",
    );
    expect(container.scripts).toHaveLength(1);
    expect(warnings).toEqual([expect.stringMatching(/^work state: isomorphic-git failed in app/u)]);
  });

  it("does not count Container-only paths, which the Workspace DO never holds", async () => {
    const space = workspace();

    space.clone("app");
    space.write("app/target/built.txt", "built\n");

    const { workState, container } = module(space, {
      containerOnly: (path) => path.startsWith("/workspace/app/target/"),
    });

    expect(await workState.read(BRANCH, ["app"])).toMatchObject([{ uncommitted: 0 }]);
    expect(container.scripts).toEqual([]);
  });
});

describe("porcelainLines", () => {
  it("counts a line per changed path and per untracked entry, as git status --porcelain does", () => {
    expect(
      porcelainLines(
        [
          ["same.txt", 1, 1, 1],
          ["modified.txt", 1, 2, 1],
          ["staged.txt", 1, 2, 2],
          ["both.txt", 1, 2, 3],
          ["deleted.txt", 1, 0, 1],
          ["removed.txt", 1, 0, 0],
          // `git rm --cached`: `D ` and `??`.
          ["uncached.txt", 1, 1, 0],
          ["added.txt", 0, 2, 2],
          ["added-gone.txt", 0, 0, 3],
          ["new.txt", 0, 2, 0],
          ["dir/tracked.txt", 1, 1, 1],
          ["dir/new.txt", 0, 2, 0],
          ["dir/sub/a.txt", 0, 2, 0],
          ["dir/sub/b.txt", 0, 2, 0],
          ["other/a.txt", 0, 2, 0],
          ["other/deep/b.txt", 0, 2, 0],
          ["target/x", 1, 0, 1],
        ],
        (path) => path.startsWith("target/"),
      ),
    ).toBe(
      // modified, staged, both, deleted, removed, uncached ×2, added, added-gone, new, dir/new.txt, dir/sub/, other/.
      13,
    );
  });
});
