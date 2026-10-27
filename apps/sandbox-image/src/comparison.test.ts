// The Container's side of This branch: the scripts run for real, under bash, with real git, between a bare "remote" and
// clones of it in a throwaway root.
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off preferEffectRecord:off processEnv:off
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blobsScript,
  comparisonScript,
  parseBlobs,
  parseComparison,
} from "@cloudpid/sandbox-image/comparison";

const env = {
  PATH: process.env.PATH ?? "",
  HOME: tmpdir(),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join("");

/**
 * A Workspace root with a bare remote `origin.git` (main: one commit) and repo `app`, a clone of it on `main`. Other
 * clones push to the remote from `other`.
 */
const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), "comparison-"));
  const dir = join(root, "app");

  const sh = (script: string, cwd: string = root) => {
    const result = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env });

    if (result.status !== 0) throw new Error(`${script}: ${result.stderr}`);

    return result.stdout.trim();
  };

  const write = (at: string, path: string, content: string | Uint8Array) => {
    mkdirSync(dirname(join(at, path)), { recursive: true });
    writeFileSync(join(at, path), content);
  };

  const commit = (
    at: string,
    files: Readonly<Record<string, string | Uint8Array>>,
    message = "c",
  ) => {
    for (const [path, content] of Object.entries(files)) write(at, path, content);

    sh(`git add -A && git commit -q -m '${message}'`, at);
  };

  sh("git init -q --bare -b main origin.git");
  sh("git clone -q origin.git seed 2>/dev/null");

  const seed = join(root, "seed");

  commit(seed, { "README.md": "hello\n", "lib/keep.txt": lines(30, "keep") }, "first");
  sh("git push -q origin main", seed);
  sh("git clone -q origin.git app 2>/dev/null");

  return {
    root,
    dir,
    seed,
    remote: join(root, "origin.git"),
    sh,
    write,
    commit,
    /** The Comparison of `app` as the script makes it. */
    compare: (
      options: {
        base?: string;
        fetch?: boolean;
        pull?: { number: number; head?: string };
        drop?: number[];
      } = {},
    ) =>
      parseComparison(
        sh(
          comparisonScript(
            {
              repo: "app",
              base: options.base,
              fetch: options.fetch ?? false,
              pull: options.pull,
              drop: options.drop,
            },
            root,
          ),
        ),
      ),
  };
};

type Fixture = ReturnType<typeof workspace>;

/** `app` on a branch `feat` with commits since it left `main`, after `main` moved on in the remote. */
const branched = (): Fixture => {
  const repo = workspace();

  repo.sh("git switch -q -c feat", repo.dir);
  repo.commit(repo.dir, { "a.txt": "one\ntwo\nthree\n" }, "add");
  repo.commit(
    repo.dir,
    { "a.txt": "one\n2\nthree\nfour\n", "lib/keep.txt": lines(31, "keep") },
    "edit",
  );

  // main moves on in the remote, after the branch left it.
  repo.commit(repo.seed, { "later.txt": "later\n" }, "later");
  repo.sh("git push -q origin main", repo.seed);

  return repo;
};

describe("This branch's Container command", () => {
  it("lists the commits since the branch left its base, with git's counts, from the merge-base", () => {
    const repo = workspace();
    const first = repo.sh("git rev-parse HEAD", repo.dir);

    repo.sh("git switch -q -c feat", repo.dir);
    repo.commit(repo.dir, {
      "a.txt": "one\ntwo\nthree\n",
      "bin.dat": Uint8Array.from([0, 1, 2, 3]),
    });
    repo.sh("git mv lib/keep.txt lib/kept.txt", repo.dir);
    repo.commit(repo.dir, { "lib/kept.txt": `${lines(30, "keep")}more\n` }, "rename and edit");
    repo.sh("git rm -q README.md && git commit -q -m delete", repo.dir);

    // main moves on: not part of the Comparison.
    repo.commit(repo.seed, { "later.txt": "later\n" }, "later");
    repo.sh("git push -q origin main", repo.seed);

    const result = repo.compare({ fetch: true });

    expect(result.ok).toBe(true);

    if (!result.ok) return;

    const { comparison } = result;

    expect(comparison).toMatchObject({
      remote: "origin",
      base: "main",
      branch: "feat",
      mergeBase: first,
      head: repo.sh("git rev-parse HEAD", repo.dir),
      commits: 3,
      fetched: true,
    });
    expect(
      comparison.files.map(({ path, oldPath, status, additions, deletions, binary }) => ({
        path,
        oldPath,
        status,
        additions,
        deletions,
        binary,
      })),
    ).toEqual([
      {
        path: "README.md",
        oldPath: undefined,
        status: "deleted",
        additions: 0,
        deletions: 1,
        binary: false,
      },
      {
        path: "a.txt",
        oldPath: undefined,
        status: "added",
        additions: 3,
        deletions: 0,
        binary: false,
      },
      {
        path: "bin.dat",
        oldPath: undefined,
        status: "added",
        additions: null,
        deletions: null,
        binary: true,
      },
      {
        path: "lib/kept.txt",
        oldPath: "lib/keep.txt",
        status: "renamed",
        additions: 1,
        deletions: 0,
        binary: false,
      },
    ]);

    const [readme, a, , kept] = comparison.files;

    expect(readme?.oldBytes).toBe(6);
    expect(readme?.newId).toBeNull();
    expect(a?.oldId).toBeNull();
    expect(a?.newBytes).toBe(14);
    expect(kept?.oldId).toBe(repo.sh(`git rev-parse ${first}:lib/keep.txt`, repo.dir));
    expect(kept?.oldBytes).toBe(Buffer.byteLength(lines(30, "keep")));
  });

  it("never touches refs/heads, refs/remotes, FETCH_HEAD, the index or the tree", () => {
    const repo = branched();
    const { dir, sh } = repo;

    // A dirty tree with something staged: the index holds an entry the tree does not match.
    repo.write(dir, "staged.txt", "staged\n");
    sh("git add staged.txt", dir);
    repo.write(dir, "a.txt", "dirty edit\n");
    repo.write(dir, "untracked.txt", "untracked\n");

    const snapshot = () => ({
      heads: sh(
        "git for-each-ref refs/heads refs/remotes refs/tags --format='%(refname) %(objectname)'",
        dir,
      ),
      head: sh("cat .git/HEAD", dir),
      index: readFileSync(join(dir, ".git/index")),
      indexMtime: statSync(join(dir, ".git/index")).mtimeMs,
      tree: sh("find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 sha256sum", dir),
      status: sh("git --no-optional-locks status --porcelain -uall", dir),
    });

    const before = snapshot();
    const mainBefore = sh("git rev-parse refs/remotes/origin/main", dir);
    const tipOfRemote = sh("git rev-parse main", repo.remote);

    expect(mainBefore).not.toBe(tipOfRemote);

    const result = repo.compare({ fetch: true });

    expect(result.ok).toBe(true);

    const after = snapshot();

    expect(after.heads).toBe(before.heads);
    expect(after.head).toBe(before.head);
    expect(after.index.equals(before.index)).toBe(true);
    expect(after.indexMtime).toBe(before.indexMtime);
    expect(after.tree).toBe(before.tree);
    expect(after.status).toBe(before.status);
    expect(existsSync(join(dir, ".git/FETCH_HEAD"))).toBe(false);
    expect(sh("git rev-parse refs/remotes/origin/main", dir)).toBe(mainBefore);

    // The fetch did land, in the private ref, and in nothing else.
    expect(sh("git rev-parse refs/cloudpid/base/main", dir)).toBe(tipOfRemote);
    expect(sh("git for-each-ref --format='%(refname)' refs/cloudpid", dir)).toBe(
      "refs/cloudpid/base/main",
    );
  });

  it("does not fetch the base again unless asked, and fetches it when its ref is missing", () => {
    const repo = branched();

    // The ref is missing: fetched without being asked.
    const first = repo.compare({ fetch: false });

    expect(first.ok && first.comparison.fetched).toBe(true);

    const fetchedTip = repo.sh("git rev-parse refs/cloudpid/base/main", repo.dir);

    // main moves again, and a call that is not asked to fetch keeps what it has.
    repo.commit(repo.seed, { "again.txt": "again\n" }, "again");
    repo.sh("git push -q origin main", repo.seed);

    const second = repo.compare({ fetch: false });

    expect(second.ok && second.comparison.fetched).toBe(false);
    expect(repo.sh("git rev-parse refs/cloudpid/base/main", repo.dir)).toBe(fetchedTip);

    const refreshed = repo.compare({ fetch: true });

    expect(refreshed.ok && refreshed.comparison.fetched).toBe(true);
    expect(repo.sh("git rev-parse refs/cloudpid/base/main", repo.dir)).toBe(
      repo.sh("git rev-parse main", repo.remote),
    );
  });

  it("takes the base from the one it is given, so a stacked branch compares with the branch under it", () => {
    const repo = workspace();

    repo.sh("git switch -q -c feat/a", repo.dir);
    repo.commit(repo.dir, { "a.txt": "a\n" }, "a");
    repo.sh("git push -q origin feat/a", repo.dir);

    const underneath = repo.sh("git rev-parse HEAD", repo.dir);

    repo.sh("git switch -q -c feat/b", repo.dir);
    repo.commit(repo.dir, { "b.txt": "b\n" }, "b");
    repo.commit(repo.dir, { "c.txt": "c\n" }, "c");

    const stacked = repo.compare({ base: "feat/a" });

    expect(stacked.ok && stacked.comparison).toMatchObject({
      base: "feat/a",
      branch: "feat/b",
      mergeBase: underneath,
      commits: 2,
    });
    expect(stacked.ok && stacked.comparison.files.map((file) => file.path)).toEqual([
      "b.txt",
      "c.txt",
    ]);

    // Against the default branch it would also hold a.txt.
    const plain = repo.compare();

    expect(plain.ok && plain.comparison.files.map((file) => file.path)).toEqual([
      "a.txt",
      "b.txt",
      "c.txt",
    ]);
    expect(plain.ok && plain.comparison.base).toBe("main");
  });

  it("finds the remote's default branch: its HEAD ref, else ls-remote", () => {
    const repo = workspace();

    // The remote's default branch is `trunk`.
    repo.sh("git push -q origin main:trunk", repo.dir);
    repo.sh("git symbolic-ref HEAD refs/heads/trunk", repo.remote);
    repo.sh("git remote set-head origin trunk", repo.dir);
    repo.sh("git switch -q -c feat", repo.dir);
    repo.commit(repo.dir, { "f.txt": "f\n" });

    const fromRef = repo.compare();

    expect(fromRef.ok && fromRef.comparison.base).toBe("trunk");

    // Without the local HEAD ref, ls-remote answers.
    repo.sh("git remote set-head origin -d", repo.dir);
    repo.sh("git update-ref -d refs/cloudpid/base/trunk", repo.dir);

    const fromRemote = repo.compare();

    expect(fromRemote.ok && fromRemote.comparison.base).toBe("trunk");
    expect(fromRemote.ok && fromRemote.comparison.fetched).toBe(true);
  });

  it("uses the branch's tracked remote, else origin, else the only remote", () => {
    const repo = workspace();

    repo.sh("git clone -q --bare origin.git upstream.git 2>/dev/null");
    repo.sh(`git remote add upstream ${repo.root}/upstream.git`, repo.dir);
    repo.sh("git switch -q -c feat", repo.dir);
    repo.commit(repo.dir, { "f.txt": "f\n" });

    const plain = repo.compare({ base: "main" });

    expect(plain.ok && plain.comparison.remote).toBe("origin");

    repo.sh("git config branch.feat.remote upstream", repo.dir);

    const tracked = repo.compare({ base: "main" });

    expect(tracked.ok && tracked.comparison.remote).toBe("upstream");
    expect(repo.sh("git for-each-ref --format='%(refname)' refs/cloudpid", repo.dir)).toBe(
      "refs/cloudpid/base/main",
    );

    // Only one remote, and it is not called origin.
    repo.sh("git remote remove origin", repo.dir);
    repo.sh("git config --unset branch.feat.remote", repo.dir);

    const only = repo.compare({ base: "main", fetch: true });

    expect(only.ok && only.comparison.remote).toBe("upstream");
  });

  it("compares a detached HEAD by its commit", () => {
    const repo = branched();
    const head = repo.sh("git rev-parse HEAD", repo.dir);

    repo.sh("git checkout -q --detach", repo.dir);

    const detached = repo.compare();

    expect(detached.ok && detached.comparison).toMatchObject({ branch: null, head, base: "main" });
    expect(detached.ok && detached.comparison.files.length).toBe(2);
  });

  it("lists nothing for a branch with no commits beyond its base", () => {
    const repo = workspace();

    repo.sh("git switch -q -c empty", repo.dir);

    const result = repo.compare();

    expect(result.ok && result.comparison).toMatchObject({ commits: 0, files: [] });
    expect(result.ok && result.comparison.mergeBase).toBe(result.ok && result.comparison.head);
  });

  it("works without a remote when the base exists locally, and says so when it does not", () => {
    const repo = workspace();

    repo.sh("git remote remove origin", repo.dir);
    repo.sh("git switch -q -c feat", repo.dir);
    repo.commit(repo.dir, { "f.txt": "f\n" });

    const local = repo.compare();

    expect(local.ok && local.comparison).toMatchObject({
      remote: null,
      base: "main",
      commits: 1,
      fetched: false,
    });
    expect(repo.sh("git for-each-ref refs/cloudpid", repo.dir)).toBe("");

    repo.sh("git branch -q -m main renamed 2>/dev/null || true", repo.dir);
    repo.sh("git branch -D main 2>/dev/null || true", repo.dir);

    const none = repo.compare();

    expect(none).toMatchObject({ ok: false, kind: "no_remote" });
  });

  it("says when the base is not on the remote", () => {
    const repo = branched();

    expect(repo.compare({ base: "gone" })).toMatchObject({
      ok: false,
      kind: "no_base",
      base: "gone",
      message: "The base branch gone is not on origin",
    });
  });

  it("says when the branch and the base share no commit", () => {
    const repo = workspace();

    repo.sh("git switch -q --orphan lonely", repo.dir);
    repo.commit(repo.dir, { "x.txt": "x\n" }, "orphan");

    expect(repo.compare()).toMatchObject({
      ok: false,
      kind: "no_common_ancestor",
      base: "main",
      message: "No common ancestor with main",
    });
  });

  it("says when a shallow clone does not reach the base", () => {
    const repo = branched();

    repo.sh("git push -q origin feat", repo.dir);
    repo.sh(`git clone -q --depth 1 --branch feat file://${repo.remote} shallow 2>/dev/null`);

    const result = parseComparison(
      repo.sh(comparisonScript({ repo: "shallow", fetch: true }, repo.root)),
    );

    expect(result).toMatchObject({ ok: false, kind: "shallow", base: "main" });
  });

  it("retries a fetch once when a ref is locked", () => {
    const repo = branched();

    // A lock another git holds for a moment.
    const lock = join(repo.dir, ".git/refs/cloudpid/base/main.lock");

    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "");

    const result = parseComparison(
      repo.sh(
        `(sleep 0.4; rm -f ${JSON.stringify(lock)}) & ${comparisonScript({ repo: "app", fetch: true }, repo.root)}; wait`,
      ),
    );

    expect(result.ok && result.comparison.fetched).toBe(true);
  });

  it("gives up on a ref that stays locked, with git's message", () => {
    const repo = branched();
    const lock = join(repo.dir, ".git/refs/cloudpid/base/main.lock");

    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "");

    const result = repo.compare({ fetch: true });

    expect(result).toMatchObject({ ok: false, kind: "failed", base: "main" });
    expect(!result.ok && result.message).toContain("cannot lock ref");
  });

  it("keeps a path with spaces, a quote or non-ASCII characters whole", () => {
    const repo = workspace();

    repo.sh("git switch -q -c feat", repo.dir);
    repo.commit(repo.dir, { 'dir/odd "name" é.txt': "x\n" });

    const result = repo.compare();

    expect(result.ok && result.comparison.files.map((file) => file.path)).toEqual([
      'dir/odd "name" é.txt',
    ]);
  });

  it("refuses a base name that is not a branch name", () => {
    const repo = branched();

    expect(repo.compare({ base: "--upload-pack=x" })).toMatchObject({ ok: false, kind: "failed" });
    expect(repo.compare({ base: "a b" })).toMatchObject({ ok: false, kind: "failed" });
    expect(repo.compare({ base: "a..b" })).toMatchObject({ ok: false, kind: "failed" });
  });

  it("reads a stopped-short output as an error", () => {
    expect(parseComparison("base\tbWFpbg==\n")).toMatchObject({ ok: false, kind: "failed" });
  });
});

/**
 * The remote has pull request 7: a branch off `main` with two commits at `refs/pull/7/head` (as GitHub keeps it), `main`
 * moved on after it left; `app` is on `main`, with a branch of its own it must not lose.
 */
const withPull = () => {
  const repo = workspace();

  repo.sh("git switch -q -c topic", repo.seed);
  repo.commit(repo.seed, { "p.txt": "p1\n" }, "p1");
  repo.commit(repo.seed, { "p.txt": "p1\np2\n", "lib/keep.txt": lines(31, "keep") }, "p2");
  repo.sh("git push -q origin HEAD:refs/pull/7/head", repo.seed);
  repo.sh("git switch -q main", repo.seed);
  repo.commit(repo.seed, { "later.txt": "later\n" }, "later");
  repo.sh("git push -q origin main", repo.seed);
  repo.sh("git switch -q -c mine", repo.dir);
  repo.commit(repo.dir, { "mine.txt": "mine\n" }, "mine");

  return { ...repo, pullHead: repo.sh("git rev-parse topic", repo.seed) };
};

describe("a pull request's Container command", () => {
  it("compares the pull request's head, fetched into refs/cloudpid/pr/<n>, with the merge-base of its base", () => {
    const repo = withPull();
    const result = repo.compare({ base: "main", pull: { number: 7, head: repo.pullHead } });

    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.comparison).toMatchObject({
      remote: "origin",
      base: "main",
      branch: null,
      head: repo.pullHead,
      commits: 2,
      fetched: true,
    });
    expect(result.comparison.mergeBase).toBe(repo.sh("git rev-parse main~1", repo.seed));
    expect(result.comparison.files.map((file) => [file.path, file.status])).toEqual([
      ["lib/keep.txt", "modified"],
      ["p.txt", "added"],
    ]);
    expect(repo.sh("git rev-parse refs/cloudpid/pr/7", repo.dir)).toBe(repo.pullHead);
  });

  it("writes only the hidden refs: never refs/heads, refs/remotes, FETCH_HEAD, the index or the tree", () => {
    const repo = withPull();
    const { dir, sh } = repo;

    repo.write(dir, "dirty.txt", "dirty\n");

    const state = () => ({
      refs: sh(
        "git for-each-ref refs/heads refs/remotes refs/tags --format='%(refname) %(objectname)'",
        dir,
      ),
      head: sh("cat .git/HEAD", dir),
      index: readFileSync(join(dir, ".git/index")).toString("hex"),
      status: sh("git --no-optional-locks status --porcelain -uall", dir),
    });

    const before = state();

    expect(repo.compare({ base: "main", pull: { number: 7 } }).ok).toBe(true);
    expect(state()).toEqual(before);
    expect(existsSync(join(dir, ".git/FETCH_HEAD"))).toBe(false);
    expect(sh("git for-each-ref --format='%(refname)' refs/cloudpid", dir)).toBe(
      "refs/cloudpid/base/main\nrefs/cloudpid/pr/7",
    );
  });

  it("fetches again only when the ref is missing, not the pull request's head, or asked", () => {
    const repo = withPull();
    const first = repo.compare({ base: "main", pull: { number: 7, head: repo.pullHead } });

    expect(first.ok && first.comparison.fetched).toBe(true);

    const same = repo.compare({ base: "main", pull: { number: 7, head: repo.pullHead } });

    expect(same.ok && same.comparison.fetched).toBe(false);

    // Someone pushes: the pull request's head moves.
    repo.sh("git switch -q topic", repo.seed);
    repo.commit(repo.seed, { "p.txt": "p1\np2\np3\n" }, "p3");
    repo.sh("git push -q origin HEAD:refs/pull/7/head", repo.seed);

    const moved = repo.sh("git rev-parse topic", repo.seed);
    const stale = repo.compare({ base: "main", pull: { number: 7, head: repo.pullHead } });

    // Asked for the head it knows: the ref is that, so nothing is fetched.
    expect(stale.ok && stale.comparison.head).toBe(repo.pullHead);

    const fresh = repo.compare({ base: "main", pull: { number: 7, head: moved } });

    expect(fresh.ok && fresh.comparison).toMatchObject({ head: moved, commits: 3, fetched: true });

    const refreshed = repo.compare({ base: "main", fetch: true, pull: { number: 7 } });

    expect(refreshed.ok && refreshed.comparison.fetched).toBe(true);
  });

  it("compares the base the pull request has, so a stacked pull request shows only its own commits", () => {
    const repo = withPull();

    repo.sh("git switch -q topic", repo.seed);
    repo.sh("git push -q origin topic:refs/heads/topic", repo.seed);
    repo.sh("git switch -q -c stacked", repo.seed);
    repo.commit(repo.seed, { "s.txt": "s\n" }, "s");
    repo.sh("git push -q origin HEAD:refs/pull/8/head", repo.seed);

    const result = repo.compare({ base: "topic", pull: { number: 8 } });

    expect(result.ok && result.comparison).toMatchObject({ base: "topic", commits: 1 });
    expect(result.ok && result.comparison.files.map((file) => file.path)).toEqual(["s.txt"]);
  });

  it("says when the pull request is not on the remote, and when the repo has no remote", () => {
    const repo = withPull();

    expect(repo.compare({ base: "main", pull: { number: 9 } })).toMatchObject({
      ok: false,
      kind: "failed",
      message: "Pull request #9 is not on origin",
    });

    repo.sh("git remote remove origin", repo.dir);

    expect(repo.compare({ base: "main", pull: { number: 7 } })).toMatchObject({
      ok: false,
      kind: "no_remote",
    });
  });

  it("deletes the refs of pull requests no longer open, and only those", () => {
    const repo = withPull();

    repo.sh("git push -q origin HEAD:refs/pull/3/head", repo.seed);
    expect(repo.compare({ base: "main", pull: { number: 7 } }).ok).toBe(true);
    expect(repo.compare({ base: "main", pull: { number: 3 } }).ok).toBe(true);
    repo.sh("git update-ref refs/cloudpid/run/x HEAD", repo.dir);

    const result = repo.compare({ base: "main", pull: { number: 7 }, drop: [3, 99] });

    expect(result.ok).toBe(true);
    expect(repo.sh("git for-each-ref --format='%(refname)' refs/cloudpid", repo.dir)).toBe(
      "refs/cloudpid/base/main\nrefs/cloudpid/pr/7\nrefs/cloudpid/run/x",
    );
    // The objects stay: nothing runs gc.
    expect(repo.sh("git cat-file -t " + repo.sh("git rev-parse topic", repo.seed), repo.dir)).toBe(
      "commit",
    );
  });

  it("refuses a pull request number or head that is not one", () => {
    expect(() => comparisonScript({ repo: "app", fetch: false, pull: { number: 0 } })).toThrow();
    expect(() => comparisonScript({ repo: "app", fetch: false, pull: { number: 1.5 } })).toThrow();
    expect(() =>
      comparisonScript({ repo: "app", fetch: false, pull: { number: 1, head: "main; rm -rf /" } }),
    ).toThrow();
    expect(() => comparisonScript({ repo: "app", fetch: false, drop: [1, -2] })).toThrow();
  });
});

describe("the blob fallback", () => {
  it("reads the blobs asked for, and only the size of one over the limit", () => {
    const repo = workspace();
    const small = repo.sh("git rev-parse HEAD:README.md", repo.dir);
    const big = repo.sh("git rev-parse HEAD:lib/keep.txt", repo.dir);

    const blobs = parseBlobs(
      repo.sh(blobsScript("app", [small, big, "0".repeat(40)], 100, repo.root)),
    );

    expect(blobs.get(small)?.bytes).toBe(6);
    expect(Buffer.from(blobs.get(small)?.blob ?? []).toString()).toBe("hello\n");
    expect(blobs.get(big)).toEqual({ bytes: Buffer.byteLength(lines(30, "keep")) });
    expect(blobs.has("0".repeat(40))).toBe(false);
  });

  it("reads on past an id that is not a blob, whose bytes git prints too", () => {
    const repo = workspace();
    const commit = repo.sh("git rev-parse HEAD", repo.dir);
    const tree = repo.sh("git rev-parse HEAD^{tree}", repo.dir);
    const small = repo.sh("git rev-parse HEAD:README.md", repo.dir);

    const blobs = parseBlobs(
      repo.sh(blobsScript("app", [commit, tree, small, commit, small], 100, repo.root)),
    );

    expect(blobs.has(commit)).toBe(false);
    expect(blobs.has(tree)).toBe(false);
    expect(Buffer.from(blobs.get(small)?.blob ?? []).toString()).toBe("hello\n");
  });

  it("refuses an id that is not a blob id", () => {
    expect(() => blobsScript("app", ["HEAD:x; rm -rf /"], 10)).toThrow("Not a blob id");
  });
});
