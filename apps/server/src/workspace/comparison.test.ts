// The Comparison module's choices, over repos real git made in a temp directory: the Workspace DO's files are that
// directory (as `/workspace`), the Container is bash running the real script there, and GitHub's API is a stub. The
// Workspace DO's own storage and reading are covered in workerd (`comparison.workerd.test.ts`).
// @effect-diagnostics asyncFunction:off globalDate:off nodeBuiltinImport:off preferEffectArray:off preferEffectRecord:off processEnv:off globalFetch:off
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WORKSPACE_ROOT } from "@cloudpid/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangesFiles } from "./changes.ts";
import {
  githubRepoOf,
  isSafeBase,
  KEPT_COMPARISONS,
  WorkspaceComparisonModule,
} from "./comparison.ts";

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
  vi.restoreAllMocks();

  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join("");

/**
 * A Workspace root with a bare remote and repo `app`, a clone of it (its remote GitHub's `acme/app` to the module, git
 * itself fetching from the bare repo), on `main`.
 */
const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), "comparison-module-"));
  const dir = join(root, "app");

  roots.push(root);

  const sh = (script: string, cwd: string = dir) => {
    const result = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env });

    if (result.status !== 0) throw new Error(`${script}: ${result.stderr}`);

    return result.stdout.trim();
  };

  const commit = (files: Readonly<Record<string, string>>, message = "c") => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }

    sh(`git add -A && git commit -q -m '${message}'`);

    return sh("git rev-parse HEAD");
  };

  sh("git init -q --bare -b main origin.git", root);
  sh("git clone -q origin.git app 2>/dev/null", root);
  commit({ "README.md": "hello\n", "keep.txt": lines(20, "keep") }, "first");
  sh("git push -q origin main");

  const files: ChangesFiles = {
    readFile: (path, options) =>
      fsp.readFile(root + path.slice(WORKSPACE_ROOT.length), options ?? null),
    stat: (path) => fsp.stat(root + path.slice(WORKSPACE_ROOT.length)),
    lstat: (path) => fsp.lstat(root + path.slice(WORKSPACE_ROOT.length)),
    readdir: (path) => fsp.readdir(root + path.slice(WORKSPACE_ROOT.length)),
    readlink: (path) => fsp.readlink(root + path.slice(WORKSPACE_ROOT.length)),
  };

  return { root, dir, sh, commit, files };
};

type Space = ReturnType<typeof workspace>;

/** `app`'s remote is `https://github.com/acme/app.git`, which git reads as the bare repo. */
const onGitHub = (space: Space) => {
  space.sh("git remote set-url origin https://github.com/acme/app.git");
  space.sh(`git config url.${space.root}/origin.git.insteadOf https://github.com/acme/app.git`);
};

type Pull = { readonly base: { readonly ref: string } };

/** The Container as the test's module sees it: whether it runs, and the scripts run on it. */
class ContainerLog {
  running = false;
  readonly runs: string[] = [];
}

/** A module over `space`, with the Container's runs, GitHub's requests and the kept lists recorded. */
const module = (
  space: Space,
  options: {
    readonly pulls?: ReadonlyArray<Pull>;
    readonly status?: number;
    /** Runs while GitHub is being asked, as the Container may stop meanwhile. */
    readonly during?: (container: ContainerLog) => void;
  } = {},
) => {
  const container = new ContainerLog();
  const store = new Map<string, unknown>();
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const warnings: string[] = [];

  const comparison = new WorkspaceComparisonModule({
    files: () => space.files,
    running: () => container.running,
    run: async (script) => {
      container.runs.push(script);
      container.running = true;

      // The script the Workspace DO runs, for `/workspace`, is run on the temp root instead.
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
    fetch: async (url, init) => {
      requests.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) });

      options.during?.(container);

      return options.status === undefined
        ? Response.json(options.pulls ?? [])
        : new Response("no", { status: options.status });
    },
    token: () => "ghp_secret",
    redact: (text) => text.replaceAll("ghp_secret", "***"),
    warn: (message) => warnings.push(message),
  });

  return { comparison, container, store, requests, warnings };
};

/** Compare `app`, the Container allowed to start. */
const start = { repo: "app", startContainer: true, fetch: false } as const;

const ok = async (result: ReturnType<WorkspaceComparisonModule["compare"]>) => {
  const made = await result;

  if (made.status !== "ok") throw new Error(`not ok: ${JSON.stringify(made.error)}`);

  return made.comparison;
};

describe("the Comparison module's choice of base", () => {
  it("takes the base of the branch's open pull request, so a stacked branch compares with the branch under it", async () => {
    const space = workspace();

    onGitHub(space);
    space.sh("git switch -q -c feat/a");
    space.commit({ "a.txt": "a\n" }, "a");
    space.sh("git push -q origin feat/a");
    space.sh("git switch -q -c feat/b");
    space.commit({ "b.txt": "b\n" }, "b");

    const { comparison, requests } = module(space, { pulls: [{ base: { ref: "feat/a" } }] });
    const made = await ok(comparison.compare(start));

    expect(made).toMatchObject({ base: "feat/a", branch: "feat/b", commits: 1 });
    expect(made.files.map((file) => file.path)).toEqual(["b.txt"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://api.github.com/repos/acme/app/pulls?state=open&head=acme%3Afeat%2Fb&per_page=1",
    );
    expect(requests[0]?.headers.authorization).toBe("Bearer ghp_secret");
  });

  it("falls back to the remote's default branch when the branch has no open pull request", async () => {
    const space = workspace();

    onGitHub(space);
    space.sh("git switch -q -c feat/b");
    space.commit({ "b.txt": "b\n" }, "b");

    const { comparison, requests } = module(space, { pulls: [] });
    const made = await ok(comparison.compare(start));

    expect(requests).toHaveLength(1);
    expect(made).toMatchObject({ base: "main", commits: 1 });
  });

  it("asks GitHub nothing for a remote that is not GitHub's, or for a detached HEAD", async () => {
    const plain = workspace();

    plain.sh("git switch -q -c feat");
    plain.commit({ "f.txt": "f\n" });

    const first = module(plain, { pulls: [{ base: { ref: "other" } }] });

    expect(await ok(first.comparison.compare(start))).toMatchObject({ base: "main" });
    expect(first.requests).toHaveLength(0);

    const detached = workspace();

    onGitHub(detached);
    detached.sh("git switch -q -c feat");
    detached.commit({ "f.txt": "f\n" });
    detached.sh("git checkout -q --detach");

    const second = module(detached, { pulls: [{ base: { ref: "other" } }] });
    const made = await ok(second.comparison.compare(start));

    expect(second.requests).toHaveLength(0);
    expect(made).toMatchObject({ branch: null, base: "main", commits: 1 });
  });

  it("uses the default branch when GitHub refuses or answers a name it cannot use, and says in the log", async () => {
    const refused = workspace();

    onGitHub(refused);
    refused.sh("git switch -q -c feat");
    refused.commit({ "f.txt": "f\n" });

    const one = module(refused, { status: 403 });

    expect(await ok(one.comparison.compare(start))).toMatchObject({ base: "main" });
    expect(one.warnings.join("\n")).toContain("GitHub answered 403");

    const odd = workspace();

    onGitHub(odd);
    odd.sh("git switch -q -c feat");
    odd.commit({ "f.txt": "f\n" });

    const two = module(odd, { pulls: [{ base: { ref: "--upload-pack=x" } }] });

    expect(await ok(two.comparison.compare(start))).toMatchObject({ base: "main" });
    expect(two.warnings.join("\n")).toContain("not a usable name");
  });

  it("reads GitHub repos from a remote's URL, and branch names the Container may be given", () => {
    expect(githubRepoOf("https://github.com/acme/app.git")).toEqual({ owner: "acme", name: "app" });
    expect(githubRepoOf("git@github.com:acme/app.git")).toEqual({ owner: "acme", name: "app" });
    expect(githubRepoOf("ssh://git@github.com/acme/app")).toEqual({ owner: "acme", name: "app" });
    expect(githubRepoOf("https://x:y@github.com/acme/app/")).toEqual({
      owner: "acme",
      name: "app",
    });
    expect(githubRepoOf("https://gitlab.com/acme/app.git")).toBeUndefined();
    expect(githubRepoOf("https://github.com.evil.test/acme/app.git")).toBeUndefined();
    expect(githubRepoOf("/srv/git/app.git")).toBeUndefined();

    expect(isSafeBase("main")).toBe(true);
    expect(isSafeBase("release/1.2+hotfix")).toBe(true);
    expect(
      ["-x", "a b", "a..b", "a//b", "/a", "a/", "a.lock", "a;b", "a$(b)"].some(isSafeBase),
    ).toBe(false);
  });
});

describe("the Comparison module's kept list and Container use", () => {
  it("keeps the list by (merge-base, head), so reopening it with the Container stopped starts nothing", async () => {
    const space = workspace();

    space.sh("git switch -q -c feat");
    space.commit({ "a.txt": "a\n" });

    const { comparison, container } = module(space);

    // Nothing kept, the Container stopped, and the call may not start it.
    expect(
      await comparison.compare({ repo: "app", startContainer: false, fetch: false }),
    ).toMatchObject({ status: "error", error: { kind: "needs_container" } });
    expect(container.runs).toHaveLength(0);

    const first = await ok(comparison.compare(start));

    expect(container.runs).toHaveLength(1);
    expect(first.files.map((file) => file.path)).toEqual(["a.txt"]);

    // The Container idles out; opening it again asks the Container nothing.
    container.running = false;

    expect(await comparison.compare({ repo: "app", startContainer: false, fetch: false })).toEqual({
      status: "ok",
      comparison: first,
    });
    expect(container.runs).toHaveLength(1);
    expect(container.running).toBe(false);
  });

  it("runs the Container's command only for a call that may start it, and fetches only when asked", async () => {
    const space = workspace();

    space.sh("git switch -q -c feat");
    space.commit({ "a.txt": "a\n" });

    const { comparison, container } = module(space);

    await ok(comparison.compare(start));
    container.running = false;

    // A Refresh fetches again, which needs the Container: refused while it is stopped, kept list or not.
    expect(
      await comparison.compare({ repo: "app", startContainer: false, fetch: true }),
    ).toMatchObject({ status: "error", error: { kind: "needs_container", base: "main" } });

    await ok(comparison.compare({ repo: "app", startContainer: true, fetch: true }));
    expect(container.runs[1]).toContain("fetch=1");
    expect(container.runs[0]).toContain("fetch=0");
  });

  it("recomputes by itself when HEAD moves and the Container runs, without fetching the base again", async () => {
    const space = workspace();

    space.sh("git switch -q -c feat");

    const before = space.commit({ "a.txt": "a\n" });
    const { comparison, container } = module(space, { pulls: [{ base: { ref: "main" } }] });
    const first = await ok(comparison.compare(start));

    expect(first.head).toBe(before);

    const after = space.commit({ "b.txt": "b\n" });

    const again = await ok(
      comparison.compare({ repo: "app", startContainer: false, fetch: false }),
    );

    expect(again).toMatchObject({ head: after, commits: 2, mergeBase: first.mergeBase });
    expect(again.behind).toBeUndefined();
    expect(again.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    expect(container.runs[1]).toContain("fetch=0");
  });

  it("keeps the last list, marked with the HEAD it has not compared, while the Container is stopped", async () => {
    const space = workspace();

    space.sh("git switch -q -c feat");
    space.commit({ "a.txt": "a\n" });

    const { comparison, container } = module(space);
    const first = await ok(comparison.compare(start));

    container.running = false;

    const moved = space.commit({ "b.txt": "b\n" });

    const behind = await ok(
      comparison.compare({ repo: "app", startContainer: false, fetch: false }),
    );

    expect(behind).toEqual({ ...first, behind: moved });
    expect(container.runs).toHaveLength(1);
    expect(container.running).toBe(false);
  });

  it("looks the base up again when the branch changed, and reuses it while it did not", async () => {
    const space = workspace();

    onGitHub(space);
    space.sh("git switch -q -c feat/a");
    space.commit({ "a.txt": "a\n" }, "a");
    space.sh("git push -q origin feat/a");
    space.sh("git switch -q -c feat/b");
    space.commit({ "b.txt": "b\n" }, "b");

    const { comparison, requests } = module(space, { pulls: [{ base: { ref: "feat/a" } }] });

    await ok(comparison.compare(start));
    expect(requests).toHaveLength(1);

    space.commit({ "b2.txt": "b\n" }, "b2");
    await ok(comparison.compare({ repo: "app", startContainer: false, fetch: false }));
    expect(requests).toHaveLength(1);

    space.sh("git switch -q -c feat/c");
    space.commit({ "c.txt": "c\n" }, "c");
    expect(
      await ok(comparison.compare({ repo: "app", startContainer: false, fetch: false })),
    ).toMatchObject({ branch: "feat/c", base: "feat/a" });
    expect(requests).toHaveLength(2);
  });

  it("does not start a Container that stopped while GitHub was being asked", async () => {
    const space = workspace();

    onGitHub(space);
    space.sh("git switch -q -c feat");
    space.commit({ "a.txt": "a\n" });

    const { comparison, container } = module(space, {
      during: (each) => {
        each.running = false;
      },
    });

    container.running = true;

    expect(
      await comparison.compare({ repo: "app", startContainer: false, fetch: false }),
    ).toMatchObject({ status: "error", error: { kind: "needs_container" } });
    expect(container.runs).toHaveLength(0);
    expect(container.running).toBe(false);
  });

  it("does not point at a list too big to keep, so the pointer still names a list that is there", async () => {
    const space = workspace();

    space.sh("git switch -q -c feat");

    const small = space.commit({ "a.txt": "a\n" });
    const { comparison, container, store } = module(space);
    const first = await ok(comparison.compare(start));

    // 2,000 files under long paths: their list is over what is kept.
    const deep = `${"d".repeat(60)}/`.repeat(5);

    space.commit(
      Object.fromEntries(
        Array.from({ length: 2000 }, (_, index) => [`${deep}f${index}.txt`, "x\n"]),
      ),
      "many",
    );

    const big = await ok(comparison.compare({ ...start, repo: "app" }));

    expect(big.files).toHaveLength(2000);
    expect(store.get("cloudpid:comparison:app")).toMatchObject({ head: small });
    expect(first.head).toBe(small);

    // After the idle stop the last kept list is what is shown, marked, and nothing starts.
    container.running = false;

    const shown = await ok(
      comparison.compare({ repo: "app", startContainer: false, fetch: false }),
    );

    expect(shown).toMatchObject({ head: small, behind: big.head });
  });

  it("drops the oldest of the lists it keeps", async () => {
    const space = workspace();

    space.sh("git switch -q -c feat");

    const { comparison, store } = module(space);

    for (let step = 0; step <= KEPT_COMPARISONS; step++) {
      space.commit({ [`f${step}.txt`]: "x\n" });
      await ok(comparison.compare(start));
    }

    const lists = [...store.keys()].filter((key) =>
      /^cloudpid:comparison:app:[0-9a-f]{40}:/.test(key),
    );

    expect(lists).toHaveLength(KEPT_COMPARISONS);
  });

  it("answers each error state with its kind, and takes secrets out of git's message", async () => {
    const space = workspace();

    space.sh("git switch -q --orphan lonely");
    space.commit({ "x.txt": "x\n" }, "orphan");

    const { comparison } = module(space);

    expect(await comparison.compare(start)).toEqual({
      status: "error",
      error: { kind: "no_common_ancestor", message: "No common ancestor with main", base: "main" },
    });

    // A remote that fails with the token in its message.
    space.sh("git switch -q main");
    space.sh("git remote set-url origin https://ghp_secret@example.invalid/acme/app.git");

    const failed = await module(space).comparison.compare({ ...start, fetch: true });

    expect(failed.status).toBe("error");
    expect(JSON.stringify(failed)).not.toContain("ghp_secret");
  });
});

describe("the Comparison module's picker", () => {
  it("lists the repos with their HEADs, the Session's own first, and a detached HEAD without a branch", async () => {
    const space = workspace();

    space.sh("git switch -q -c feat");

    mkdirSync(join(space.root, "lib"));
    space.sh("git init -q -b trunk lib", space.root);
    space.sh(
      "git -c user.name=t -c user.email=t@e commit -q --allow-empty -m one",
      join(space.root, "lib"),
    );
    space.sh("git checkout -q --detach", join(space.root, "lib"));

    const { comparison } = module(space);
    const lib = space.sh("git rev-parse HEAD", join(space.root, "lib"));
    const app = space.sh("git rev-parse HEAD");

    expect(await comparison.sources("/workspace")).toEqual({
      repos: [
        { repo: "app", head: { commit: app, branch: "feat" } },
        { repo: "lib", head: { commit: lib, branch: null } },
      ],
    });
    expect((await comparison.sources("/workspace/lib/src")).repos.map((repo) => repo.repo)).toEqual(
      ["lib"],
    );
  });
});

describe("the Comparison module's contents", () => {
  /** `app` on `feat` with an edit, a rename and a new file; the Comparison made and the Container stopped. */
  const made = async () => {
    const space = workspace();

    space.sh("git switch -q -c feat");
    space.commit({ "keep.txt": `${lines(20, "keep")}added\n`, "new.txt": "fresh\n" });
    space.sh("git mv README.md DOCS.md");
    space.commit({ "DOCS.md": "hello\nworld\n" });

    const rig = module(space);
    const comparison = await ok(rig.comparison.compare(start));

    rig.container.running = false;

    return { space, ...rig, made: comparison };
  };

  it("reads both sides from the objects it has, starting nothing", async () => {
    const { comparison, container, made: list } = await made();
    const at = { repo: "app", mergeBase: list.mergeBase, head: list.head };

    const ask = (path: string, oldPath?: string) =>
      comparison.file(oldPath === undefined ? { ...at, path } : { ...at, path, oldPath });

    expect(await ask("keep.txt")).toEqual({
      old: { kind: "text", text: lines(20, "keep") },
      new: { kind: "text", text: `${lines(20, "keep")}added\n` },
    });
    expect(await ask("new.txt")).toEqual({ old: null, new: { kind: "text", text: "fresh\n" } });
    expect(await ask("DOCS.md", "README.md")).toEqual({
      old: { kind: "text", text: "hello\n" },
      new: { kind: "text", text: "hello\nworld\n" },
    });
    expect(container.runs).toHaveLength(1);
    expect(container.running).toBe(false);
  });

  it("falls back to the Container's git for an object the Workspace DO does not have, and never starts it", async () => {
    const { space, comparison, container, made: list } = await made();
    const newId = space.sh("git rev-parse HEAD:new.txt");

    // The Workspace DO has not got the object (it syncs in after the Container's command).
    space.sh(`rm -f .git/objects/${newId.slice(0, 2)}/${newId.slice(2)}`);

    const ask = () =>
      comparison.file({
        repo: "app",
        mergeBase: list.mergeBase,
        head: list.head,
        path: "new.txt",
      });

    await expect(ask()).rejects.toThrow("need the Container, which is stopped");
    expect(container.runs).toHaveLength(1);

    // Running, the Container's git reads it. The object is gone from this repo, so it reports it missing.
    container.running = true;
    await expect(ask()).rejects.toThrow("could not read");
    expect(container.runs).toHaveLength(2);
    expect(container.runs[1]).toContain("cat-file");
  });

  it("reads a side the list says is over 1 MiB, or binary, without the contents", async () => {
    const space = workspace();

    space.sh("git switch -q -c feat");
    space.commit({ "big.txt": "x\n".repeat(600_000) });
    space.commit({ "bin.dat": "a\0b" });

    const { comparison } = module(space);
    const list = await ok(comparison.compare(start));

    expect(list.files).toEqual([
      { path: "big.txt", status: "added", additions: 600_000, deletions: 0, tooLarge: true },
      { path: "bin.dat", status: "added", additions: null, deletions: null, binary: true },
    ]);

    const ask = (path: string) =>
      comparison.file({ repo: "app", mergeBase: list.mergeBase, head: list.head, path });

    expect(await ask("big.txt")).toEqual({
      old: null,
      new: { kind: "too_large", bytes: 1_200_000 },
    });
    expect(await ask("bin.dat")).toEqual({ old: null, new: { kind: "binary" } });
  });

  it("refuses a path outside the repo and ids that are not commits", async () => {
    const { comparison, made: list } = await made();
    const base = { repo: "app", mergeBase: list.mergeBase, head: list.head };

    await expect(comparison.file({ ...base, path: "../escape" })).rejects.toThrow("No such file");
    await expect(comparison.file({ ...base, path: ".git/config" })).rejects.toThrow("No such file");
    await expect(comparison.file({ ...base, head: "HEAD", path: "a" })).rejects.toThrow(
      "No such file",
    );
  });
});
