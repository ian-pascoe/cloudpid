// Pull request Comparisons in the Workspace module (docs/spec.md → Diffs and review → Comparisons): the Workspace DO's files
// are a temp directory, the Container is bash running the real script on it with real git, and GitHub's API is a stub that
// answers by path. Nothing here starts a Container the call may not start.
// @effect-diagnostics asyncFunction:off globalDate:off nodeBuiltinImport:off preferEffectArray:off preferEffectRecord:off processEnv:off globalFetch:off
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Comparison, WORKSPACE_ROOT } from "@cloudpid/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangesFiles } from "./changes.ts";
import type { JsonObject } from "./github-pulls.fixtures.ts";
import { WorkspaceComparisonModule } from "./comparison.ts";
import { PULLS_CACHE_MS } from "./github-pulls.ts";

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

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join("");

/**
 * A Workspace root with a bare remote (GitHub's `acme/app` to the module, git fetching from the bare repo), `seed`, a
 * clone to push from, and `app`, the clone the Workspace has, on `main`. The remote has pull request 7: two commits off
 * `main` at `refs/pull/7/head`, as GitHub keeps them, and `main` has moved on since.
 */
const workspace = (github = true) => {
  const root = mkdtempSync(join(tmpdir(), "comparison-pull-"));
  const dir = join(root, "app");
  const seed = join(root, "seed");

  roots.push(root);

  const sh = (script: string, cwd: string = dir) => {
    const result = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env });

    if (result.status !== 0) throw new Error(`${script}: ${result.stderr}`);

    return result.stdout.trim();
  };

  const commit = (at: string, files: Readonly<Record<string, string>>, message = "c") => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(at, path)), { recursive: true });
      writeFileSync(join(at, path), content);
    }

    sh(`git add -A && git commit -q -m '${message}'`, at);

    return sh("git rev-parse HEAD", at);
  };

  sh("git init -q --bare -b main origin.git", root);
  sh("git clone -q origin.git seed 2>/dev/null", root);
  commit(seed, { "README.md": "hello\n", "keep.txt": lines(20, "keep") }, "first");
  sh("git push -q origin main", seed);
  sh("git clone -q origin.git app 2>/dev/null", root);

  if (github) {
    sh("git remote set-url origin https://github.com/acme/app.git");
    sh(`git config url.${root}/origin.git.insteadOf https://github.com/acme/app.git`);
  }

  sh("git switch -q -c topic-7", seed);
  commit(seed, { "p.txt": "p1\n" }, "p1");

  const head7 = commit(
    seed,
    { "p.txt": "p1\np2\n", "keep.txt": `${lines(20, "keep")}more\n` },
    "p2",
  );

  sh("git push -q origin HEAD:refs/pull/7/head", seed);
  sh("git switch -q main", seed);
  commit(seed, { "later.txt": "later\n" }, "later");
  sh("git push -q origin main", seed);

  const files: ChangesFiles = {
    readFile: (path, options) =>
      fsp.readFile(root + path.slice(WORKSPACE_ROOT.length), options ?? null),
    stat: (path) => fsp.stat(root + path.slice(WORKSPACE_ROOT.length)),
    lstat: (path) => fsp.lstat(root + path.slice(WORKSPACE_ROOT.length)),
    readdir: (path) => fsp.readdir(root + path.slice(WORKSPACE_ROOT.length)),
    readlink: (path) => fsp.readlink(root + path.slice(WORKSPACE_ROOT.length)),
  };

  return { root, dir, seed, sh, commit, files, head7 };
};

type Space = ReturnType<typeof workspace>;

/** GitHub's JSON for pull request `number`. */
const pullJson = (number: number, overrides: JsonObject = {}): JsonObject => ({
  number,
  title: `Pull request ${number}`,
  state: "open",
  merged: false,
  draft: false,
  additions: 3,
  deletions: 1,
  changed_files: 2,
  updated_at: "2026-01-01T00:00:00Z",
  user: { login: "dev" },
  head: { sha: "0".repeat(40), ref: `topic-${number}`, repo: { full_name: "acme/app" } },
  base: { ref: "main" },
  ...overrides,
});

/** What the GitHub stub knows: the pull requests by number (the open ones are listed), and a status to fail with. */
type GitHub = { pulls: Map<number, JsonObject>; status?: number };

/** A module over `space` with a GitHub stub that answers by path, the Container's runs and a clock the test moves. */
const module = (space: Space, github: GitHub) => {
  const runs: string[] = [];
  const container = { running: false, runs };
  const store = new Map<string, unknown>();
  const requests: string[] = [];
  const clock = { now: 1_000_000 };

  const comparison = new WorkspaceComparisonModule({
    files: () => space.files,
    running: () => container.running,
    run: async (script) => {
      container.runs.push(script);
      container.running = true;

      const local = script.replace(/^dir=.*$/mu, `dir='${space.root}/app'`);

      const result = spawnSync("bash", ["-c", local], {
        cwd: space.root,
        encoding: "utf8",
        env,
        maxBuffer: 64 * 1024 * 1024,
      });

      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    store: {
      // SAFETY: the module reads back only what it put under the key, which is its own record for it.
      get: async <A>(key: string) => store.get(key) as A | undefined,
      put: async (key, value) => {
        store.set(key, structuredClone(value));
      },
      delete: async (key) => {
        store.delete(key);
      },
    },
    fetch: async (url) => {
      const { pathname, search } = new URL(url);

      requests.push(`${pathname}${search}`);

      if (github.status !== undefined) return new Response("{}", { status: github.status });

      if (pathname === "/repos/acme/app/pulls") {
        const open = [...github.pulls.values()].filter((pull) => pull.state === "open");

        return Response.json(open);
      }

      const single = github.pulls.get(Number(pathname.split("/").at(-1)));

      return single === undefined
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : Response.json(single);
    },
    token: () => "ghp_secret",
    now: () => clock.now,
    redact: (text) => text.replaceAll("ghp_secret", "***"),
    warn: () => undefined,
  });

  return { comparison, container, store, requests, clock };
};

const ask = (options: { startContainer?: boolean; fetch?: boolean; pull?: number } = {}) => ({
  repo: "app",
  pull: options.pull ?? 7,
  startContainer: options.startContainer ?? false,
  fetch: options.fetch ?? false,
});

const okOf = async (
  result: ReturnType<WorkspaceComparisonModule["compare"]>,
): Promise<Comparison> => {
  const made = await result;

  if (made.status !== "ok") throw new Error(`not ok: ${JSON.stringify(made.error)}`);

  return made.comparison;
};

/** GitHub with pull request 7 open at the space's head. */
const open7 = (space: Space): GitHub => ({
  pulls: new Map([
    [
      7,
      pullJson(7, { head: { sha: space.head7, ref: "topic-7", repo: { full_name: "acme/app" } } }),
    ],
  ]),
});

describe("comparing a pull request", () => {
  it("fetches its head into refs/cloudpid/pr/<n> and lists its files against the merge-base with its base", async () => {
    const space = workspace();
    const github = open7(space);
    const { comparison, container, requests } = module(space, github);
    const made = await okOf(comparison.compare(ask({ startContainer: true })));

    expect(made).toMatchObject({
      repo: "app",
      base: "main",
      branch: "topic-7",
      head: space.head7,
      commits: 2,
      more: 0,
      pull: { number: 7, title: "Pull request 7", author: "dev", draft: false, state: "open" },
    });
    expect(made.mergeBase).toBe(space.sh("git rev-parse main~1", space.seed));
    expect(
      made.files.map((file) => [file.path, file.status, file.additions, file.deletions]),
    ).toEqual([
      ["keep.txt", "modified", 1, 0],
      ["p.txt", "added", 2, 0],
    ]);

    // Each file carries its head blob, which a Viewed box records.
    expect(made.files.map((file) => file.blob)).toEqual([
      space.sh(`git rev-parse ${space.head7}:keep.txt`),
      space.sh(`git rev-parse ${space.head7}:p.txt`),
    ]);
    expect(space.sh("git rev-parse refs/cloudpid/pr/7")).toBe(space.head7);
    expect(container.runs).toHaveLength(1);
    expect(container.runs[0]).toContain("+refs/pull/$pull/head:$pullref");
    expect(requests).toEqual(["/repos/acme/app/pulls/7"]);
  });

  it("keeps the list by (merge-base, head): asked again with the Container stopped it starts nothing, and reads the title as GitHub has it", async () => {
    const space = workspace();
    const github = open7(space);
    const { comparison, container, store } = module(space, github);
    const made = await okOf(comparison.compare(ask({ startContainer: true })));

    container.running = false;
    github.pulls.set(7, { ...github.pulls.get(7), title: "Renamed" });

    expect(await okOf(comparison.compare(ask()))).toEqual({
      ...made,
      pull: { ...made.pull, title: "Renamed" },
    });
    expect(container.runs).toHaveLength(1);
    expect(container.running).toBe(false);
    expect([...store.keys()]).toEqual(
      expect.arrayContaining([
        `cloudpid:comparison-pull:app:${made.mergeBase}:${made.head}`,
        "cloudpid:comparison-pull-last:app:7",
      ]),
    );
  });

  it("says it needs the Container when nothing is kept and the call may not start it", async () => {
    const space = workspace();
    const { comparison, container } = module(space, open7(space));

    expect(await comparison.compare(ask())).toMatchObject({
      status: "error",
      error: { kind: "needs_container", base: "main" },
    });
    expect(container.runs).toEqual([]);
  });

  it("shows a head that moved as New commits (behind), even with the Container running, until the owner asks for it", async () => {
    const space = workspace();
    const github = open7(space);
    const { comparison, container } = module(space, github);
    const first = await okOf(comparison.compare(ask({ startContainer: true })));

    // Someone pushes: GitHub's head, and the remote's pull ref, move.
    space.sh("git switch -q topic-7", space.seed);

    const moved = space.commit(space.seed, { "p.txt": "p1\np2\np3\n" }, "p3");

    space.sh("git push -q origin HEAD:refs/pull/7/head", space.seed);
    github.pulls.set(
      7,
      pullJson(7, { head: { sha: moved, ref: "topic-7", repo: { full_name: "acme/app" } } }),
    );

    expect(container.running).toBe(true);

    const seen = await okOf(comparison.compare(ask()));

    expect(seen).toMatchObject({ head: first.head, behind: moved });
    expect(container.runs).toHaveLength(1);

    // The owner's pick or Refresh asks again with the Container allowed: fetched, and the new head compared.
    const fresh = await okOf(comparison.compare(ask({ startContainer: true })));

    expect(fresh).toMatchObject({ head: moved, commits: 3 });
    expect(fresh.behind).toBeUndefined();
    expect(container.runs).toHaveLength(2);

    // Not behind any more, and the pull request's last is the new head's.
    container.running = false;
    expect(await okOf(comparison.compare(ask()))).toEqual(fresh);
  });

  it("fetches again on the owner's Refresh even at the same head, and not without the Container allowed", async () => {
    const space = workspace();
    const { comparison, container } = module(space, open7(space));

    await okOf(comparison.compare(ask({ startContainer: true })));
    container.running = false;

    expect(await comparison.compare(ask({ fetch: true }))).toMatchObject({
      status: "error",
      error: { kind: "needs_container" },
    });
    expect(container.runs).toHaveLength(1);

    await okOf(comparison.compare(ask({ fetch: true, startContainer: true })));
    expect(container.runs).toHaveLength(2);
  });

  it("marks the last result closed or merged and keeps it readable; with none it says so", async () => {
    const space = workspace();
    const github = open7(space);
    const { comparison, container } = module(space, github);
    const first = await okOf(comparison.compare(ask({ startContainer: true })));

    container.running = false;
    github.pulls.set(7, { ...github.pulls.get(7), state: "closed", merged: false });

    expect(await okOf(comparison.compare(ask()))).toEqual({
      ...first,
      pull: { ...first.pull, state: "closed" },
    });

    github.pulls.set(7, { ...github.pulls.get(7), state: "closed", merged: true });

    expect(await okOf(comparison.compare(ask()))).toMatchObject({ pull: { state: "merged" } });
    expect(container.runs).toHaveLength(1);

    github.pulls.set(8, pullJson(8, { state: "closed", merged: true }));

    expect(await comparison.compare(ask({ pull: 8 }))).toMatchObject({
      status: "error",
      error: { kind: "pull_merged", message: "This pull request is merged" },
    });

    github.pulls.set(9, pullJson(9, { state: "closed" }));

    expect(await comparison.compare(ask({ pull: 9 }))).toMatchObject({
      status: "error",
      error: { kind: "pull_closed" },
    });
  });

  it.each([401, 403, 404])("says GitHub refused the token on a %s", async (status) => {
    const space = workspace();
    const github = open7(space);
    const { comparison, container } = module(space, { ...github, status });

    expect(await comparison.compare(ask({ startContainer: true }))).toMatchObject({
      status: "error",
      error: { kind: "github_refused", message: "GitHub refused the token" },
    });
    expect(container.runs).toEqual([]);
  });

  it("says pull requests need a GitHub remote for a remote that is not GitHub's", async () => {
    const space = workspace(false);
    const { comparison, requests } = module(space, open7(space));

    expect(await comparison.compare(ask({ startContainer: true }))).toMatchObject({
      status: "error",
      error: { kind: "no_github", message: "Pull requests need a GitHub remote" },
    });
    expect(requests).toEqual([]);
  });

  it("reads each side of a file by the blob ids the list kept", async () => {
    const space = workspace();
    const { comparison, container } = module(space, open7(space));
    const made = await okOf(comparison.compare(ask({ startContainer: true })));

    container.running = false;

    const file = await comparison.file({
      repo: "app",
      mergeBase: made.mergeBase,
      head: made.head,
      path: "p.txt",
    });

    expect(file).toEqual({ old: null, new: { kind: "text", text: "p1\np2\n" } });
  });
});

describe("the open pull requests of a repo", () => {
  it("lists them with GitHub's REST API, never starts the Container, and keeps the list for 60 s", async () => {
    const space = workspace();
    const github = open7(space);
    const { comparison, container, requests, clock } = module(space, github);

    const list = async () => {
      const { repos } = await comparison.sources(WORKSPACE_ROOT, true);

      return repos[0]?.pulls;
    };

    const first = await list();

    expect(first).toMatchObject({
      status: "ok",
      pulls: [
        { number: 7, title: "Pull request 7", head: space.head7, additions: 3, changedFiles: 2 },
      ],
    });

    const asked = requests.length;

    clock.now += PULLS_CACHE_MS - 1;
    expect(await list()).toEqual(first);
    expect(requests).toHaveLength(asked);

    clock.now += 1;
    await list();
    expect(requests.length).toBeGreaterThan(asked);
    expect(container.runs).toEqual([]);
    expect(container.running).toBe(false);
  });

  it("lists none without asking for them, and says a plain remote is not GitHub's", async () => {
    const space = workspace(false);
    const { comparison, requests } = module(space, open7(space));
    const plain = await comparison.sources(WORKSPACE_ROOT);

    expect(plain.repos[0]).not.toHaveProperty("pulls");

    const asked = await comparison.sources(WORKSPACE_ROOT, true);

    expect(asked.repos[0]?.pulls).toEqual({
      status: "error",
      kind: "no_github",
      message: "Pull requests need a GitHub remote",
    });
    expect(requests).toEqual([]);
  });

  it("says GitHub refused the token", async () => {
    const space = workspace();
    const { comparison } = module(space, { pulls: new Map(), status: 401 });
    const { repos } = await comparison.sources(WORKSPACE_ROOT, true);

    expect(repos[0]?.pulls).toEqual({
      status: "error",
      kind: "refused",
      message: "GitHub refused the token",
    });
  });
});

describe("the refs of pull requests no longer open", () => {
  const refs = (space: Space) =>
    space.sh("git for-each-ref --format='%(refname)' refs/cloudpid/pr");

  /** pull requests 7 and 8 fetched, and the Container running. */
  const fetchedTwo = async () => {
    const space = workspace();

    space.sh("git push -q origin HEAD:refs/pull/8/head", space.seed);

    const github = open7(space);

    github.pulls.set(
      8,
      pullJson(8, {
        head: {
          sha: space.sh("git rev-parse HEAD", space.seed),
          ref: "topic-8",
          repo: { full_name: "acme/app" },
        },
      }),
    );

    const mod = module(space, github);

    await okOf(mod.comparison.compare(ask({ startContainer: true })));
    await okOf(mod.comparison.compare(ask({ pull: 8, startContainer: true })));

    return { space, github, ...mod };
  };

  it("deletes a ref when the picker's list no longer has the pull request, with the Container running", async () => {
    const { space, github, comparison, container, clock } = await fetchedTwo();

    expect(refs(space)).toBe("refs/cloudpid/pr/7\nrefs/cloudpid/pr/8");

    github.pulls.set(8, { ...github.pulls.get(8), state: "closed", merged: true });
    clock.now += PULLS_CACHE_MS;

    const before = container.runs.length;

    await comparison.sources(WORKSPACE_ROOT, true);

    expect(refs(space)).toBe("refs/cloudpid/pr/7");
    expect(container.runs).toHaveLength(before + 1);
    expect(container.runs.at(-1)).toContain("update-ref -d");
    // Nothing else is touched, and the objects stay: nothing runs gc.
    expect(container.runs.at(-1)).not.toMatch(/\bgc\b/u);
    expect(space.sh(`git cat-file -t ${space.sh("git rev-parse HEAD", space.seed)}`)).toBe(
      "commit",
    );
  });

  it("waits for the Container when it is stopped: nothing starts it, and the next opening deletes the ref", async () => {
    const { space, github, comparison, container, clock } = await fetchedTwo();

    github.pulls.set(8, { ...github.pulls.get(8), state: "closed" });
    container.running = false;
    clock.now += PULLS_CACHE_MS;

    const before = container.runs.length;

    await comparison.sources(WORKSPACE_ROOT, true);

    expect(container.runs).toHaveLength(before);
    expect(container.running).toBe(false);
    expect(refs(space)).toBe("refs/cloudpid/pr/7\nrefs/cloudpid/pr/8");

    container.running = true;
    clock.now += PULLS_CACHE_MS;
    await comparison.sources(WORKSPACE_ROOT, true);

    expect(refs(space)).toBe("refs/cloudpid/pr/7");
  });

  it("deletes them as part of the next pull request Comparison too", async () => {
    const { space, github, comparison, clock } = await fetchedTwo();

    github.pulls.set(8, { ...github.pulls.get(8), state: "closed" });
    clock.now += PULLS_CACHE_MS;

    // The list is read (the Container will not run a delete of its own here), then the owner compares pull request 7.
    await comparison.sources(WORKSPACE_ROOT, true);
    await okOf(comparison.compare(ask({ fetch: true, startContainer: true })));

    expect(refs(space)).toBe("refs/cloudpid/pr/7");
  });
});
