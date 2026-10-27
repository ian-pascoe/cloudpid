// The Run copies and the Run diff (docs/spec.md → Diffs and review → Run diff), over repos real git made in a temp
// directory: the Workspace DO's files are that directory (as `/workspace`), the Container is bash running the real
// scripts there, and what the module saves is checked with real git (`fsck`, `ls-tree`, `diff`). The same module over the
// Workspace DO's own files, in workerd, is covered by `runs.workerd.test.ts`.
// @effect-diagnostics asyncFunction:off globalDate:off nodeBuiltinImport:off preferEffectArray:off preferEffectRecord:off processEnv:off
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_CHANGE_SIDE_BYTES, MAX_RUN_COPY_FILES, WORKSPACE_ROOT } from "@cloudpid/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type ContainerOnly, type KeptChanges, WorkspaceChangesModule } from "./changes.ts";
import { type RunFiles, WorkspaceRunsModule } from "./runs.ts";

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

const SCOPE = "session-1";
const RUN = "run1abc";

/** A Workspace root holding repo `app`, `head` committed on `main`. */
const workspace = (head: Readonly<Record<string, string | Uint8Array>>) => {
  const root = mkdtempSync(join(tmpdir(), "runs-module-"));
  const dir = join(root, "app");

  roots.push(root);

  const write = (path: string, content: string | Uint8Array) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };

  const sh = (script: string, cwd = dir) => {
    const result = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env });

    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  /** Run git in the repo, failing the test when it fails. */
  const git = (script: string) => {
    const result = sh(`git ${script}`);

    if (result.exitCode !== 0) throw new Error(`git ${script}: ${result.stderr}`);

    return result.stdout;
  };

  mkdirSync(dir);
  sh("git init -q -b main");

  for (const [path, content] of Object.entries(head)) {
    write(path, content);
    // Committed files are made in the past, so a same-size edit's stat differs from the index's (racy git): in a
    // Workspace no stat matches git's anyway, as the Workspace DO's files have their own inodes.
    utimesSync(join(dir, path), new Date(), new Date(Date.now() - 100_000));
  }

  sh("git add -A && git commit -q -m first --allow-empty");

  const map = (path: string) => root + path.slice(WORKSPACE_ROOT.length);

  const files: RunFiles = {
    readFile: (path, options) => fsp.readFile(map(path), options ?? null),
    stat: (path) => fsp.stat(map(path)),
    lstat: (path) => fsp.lstat(map(path)),
    readdir: (path) => fsp.readdir(map(path)),
    readlink: (path) => fsp.readlink(map(path)),
    writeFile: (path, data) => fsp.writeFile(map(path), data),
    mkdir: (path, options) => fsp.mkdir(map(path), options),
    unlink: (path) => fsp.unlink(map(path)),
    rmdir: (path) => fsp.rmdir(map(path)),
  };

  return { root, dir, write, sh, git, files };
};

type Space = ReturnType<typeof workspace>;

/** The Runs module over `space`, with its Container (bash on the temp root) running or not. */
const runs = (space: Space, options: { readonly containerOnly?: ContainerOnly } = {}) => {
  const kept = new Map<string, KeptChanges>();
  const store = new Map<string, unknown>();

  const scripts: string[] = [];
  const container = { running: false, runs: 0, scripts };

  const run = async (script: string) => {
    container.runs++;
    container.scripts.push(script);

    // The scripts the Workspace DO runs, for `/workspace`, run on the temp root instead.
    const local = script
      .replace(/^root=.*$/mu, `root='${space.root}'`)
      .replace(/^dir='\/workspace\/(.*)'$/mu, `dir='${space.root}/$1'`)
      // The Run copy is one quoted command: its `dir` is inside the quotes.
      .replace("dir='\\''/workspace/", `dir='\\''${space.root}/`);

    return space.sh(local, space.root);
  };

  const changes = new WorkspaceChangesModule({
    files: () => space.files,
    containerOnly: async () => options.containerOnly ?? (() => false),
    running: () => container.running,
    run,
    kept: {
      load: async (repo) => kept.get(repo),
      save: async (repo, list) => {
        kept.set(repo, list);
      },
    },
    warn: () => {},
  });

  let clock = 1_700_000_000_000;

  const module = new WorkspaceRunsModule({
    files: () => space.files,
    changes,
    containerOnly: async () => options.containerOnly ?? (() => false),
    running: () => container.running,
    run,
    store: {
      // SAFETY: the module reads back what it put under the key, which the test's store kept as it was.
      get: async <A>(key: string) => store.get(key) as A | undefined,
      put: async (key, value) => {
        // As the Workspace DO's storage does: a copy, not the caller's object.
        store.set(key, structuredClone(value));
      },
      delete: async (key) => {
        store.delete(key);
      },
      keys: async (prefix) => [...store.keys()].filter((key) => key.startsWith(prefix)),
    },
    warn: () => {},
    now: () => (clock += 1_000),
  });

  const start = (run = RUN, keep: string[] = []) =>
    module.start({
      scope: SCOPE,
      run,
      conversationId: 1,
      firstCall: "call_1",
      directory: "/workspace/app",
      keep,
    });

  const end = (run = RUN, keep: string[] = []) =>
    module.end({ scope: SCOPE, run, until: 12, keep });

  const paths = async () =>
    ((await module.diff(SCOPE))?.repos[0]?.files ?? []).map(
      (file) => `${(file.status[0] ?? "").toUpperCase()} ${file.path}`,
    );

  return { module, container, store, start, end, paths, kept };
};

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join("");

const startOf = (space: Space) => space.git(`rev-parse refs/cloudpid/runs/${SCOPE}/start`).trim();
const endOf = (space: Space) => space.git(`rev-parse refs/cloudpid/runs/${SCOPE}/end`).trim();

describe("the Run copies", () => {
  it("saves each repo's tree before the Run, as valid git objects on HEAD: edits, deletions and new files, not ignored ones", async () => {
    const space = workspace({
      ".gitignore": "out/\n",
      "keep.txt": "keep\n",
      "src/edit.txt": "one\n",
      "src/gone.txt": "bye\n",
      "src/deep/deeper/x.txt": "x\n",
    });

    const head = space.git("rev-parse HEAD").trim();

    space.write("src/edit.txt", "two\n");
    space.write("new dir/new.txt", "fresh\n");
    space.write("out/built.js", "ignored\n");
    await fsp.rm(join(space.dir, "src/gone.txt"));
    await fsp.rm(join(space.dir, "src/deep"), { recursive: true });

    const { start } = runs(space);
    const run = await start();

    expect(run).toMatchObject({
      run: RUN,
      conversationId: 1,
      firstCall: "call_1",
      endedAt: null,
      until: null,
      repos: [{ repo: "app", start: startOf(space), end: null }],
    });
    expect(space.git(`rev-parse '${startOf(space)}^'`).trim()).toBe(head);
    expect(space.git(`ls-tree -r --name-only '${startOf(space)}'`)).toBe(
      ".gitignore\nkeep.txt\nnew dir/new.txt\nsrc/edit.txt\n",
    );
    expect(space.git(`show '${startOf(space)}:src/edit.txt'`)).toBe("two\n");
    // Real git takes every object it wrote for sound.
    expect(space.sh("git fsck --strict --no-dangling").exitCode).toBe(0);
    // What the copy took leaves the repo as it was: the index, the branch and the tree.
    expect(space.git("status --porcelain")).toContain(" M src/edit.txt");
    expect(space.git("rev-parse HEAD").trim()).toBe(head);
    expect(space.git("for-each-ref --format='%(refname)'").trim().split("\n")).toEqual([
      `refs/cloudpid/runs/${SCOPE}/start`,
      "refs/heads/main",
    ]);
  });

  it("copies a repo with no commit onto the empty tree, a file that replaced a directory, and symbolic links", async () => {
    const space = workspace({ "dir/a.txt": "a\n", "target.txt": "t\n" });

    // `dir` becomes a file; a new link points at target.txt.
    await fsp.rm(join(space.dir, "dir"), { recursive: true });
    space.write("dir", "now a file\n");
    await fsp.symlink("target.txt", join(space.dir, "link"));

    const { start } = runs(space);

    await start();

    expect(
      space
        .git(`ls-tree -r '${startOf(space)}'`)
        .split("\n")
        .filter(Boolean),
    ).toEqual([
      expect.stringMatching(/^100644 blob [0-9a-f]{40}\tdir$/u),
      expect.stringMatching(/^120000 blob [0-9a-f]{40}\tlink$/u),
      expect.stringMatching(/^100644 blob [0-9a-f]{40}\ttarget.txt$/u),
    ]);
    expect(space.git(`show '${startOf(space)}:link'`)).toBe("target.txt");
    expect(space.sh("git fsck --strict --no-dangling").exitCode).toBe(0);

    // A repo with no commit at all.
    const empty = workspace({});

    await fsp.rm(join(empty.dir, ".git"), { recursive: true });
    empty.sh("git init -q -b main");
    empty.write("first.txt", "hello\n");

    await runs(empty).start();

    expect(empty.git(`rev-list --parents '${startOf(empty)}'`).trim()).toBe(startOf(empty));
    expect(empty.git(`ls-tree -r --name-only '${startOf(empty)}'`)).toBe("first.txt\n");
    expect(empty.sh("git fsck --strict --no-dangling").exitCode).toBe(0);
  });

  it("records the big and binary files of a repo the Container copies, and lists them as changes only while they differ from the copy", async () => {
    const space = workspace({ ".gitattributes": "* text=auto eol=lf\n", "a.txt": "one\n" });

    space.write("a.txt", "two\n");
    space.write("big.txt", lines(MAX_CHANGE_SIDE_BYTES / 8));
    space.write("logo.png", new Uint8Array([137, 80, 0, 1, 2]));

    const { start, container, store, paths } = runs(space);

    container.running = true;
    await start();

    // SAFETY: the module put a repo's record under this key.
    const record = store.get(`cloudpid:run:${SCOPE}:repo:app`) as {
      start: { unstored: Array<{ path: string; binary: boolean }> };
    };

    const unstored = record.start.unstored.toSorted((a, b) => (a.path < b.path ? -1 : 1));

    expect(unstored.map(({ path, binary }) => [path, binary])).toEqual([
      ["big.txt", false],
      ["logo.png", true],
    ]);
    expect(space.git(`ls-tree -r --name-only '${startOf(space)}'`)).toBe(".gitattributes\na.txt\n");

    // As the copy has them they are not the Run's changes; the Run's own edit is.
    space.write("a.txt", "three\n");
    expect(await paths()).toEqual(["M a.txt"]);

    space.write("logo.png", new Uint8Array([137, 80, 0, 1, 2, 3]));
    expect(await paths()).toEqual(["M a.txt", expect.stringMatching(/ logo\.png$/u)]);
  });

  it("keeps an executable file executable and records binary and big files by size and hash, not as blobs", async () => {
    const space = workspace({
      "run.sh": "#!/bin/sh\necho 1\n",
      "keep.png": new Uint8Array([1, 2, 0, 3]),
    });

    space.sh(
      "chmod +x run.sh && git add -A && git update-index --chmod=+x run.sh && git commit -q -m x",
    );
    space.write("run.sh", "#!/bin/sh\necho 2\n");
    space.write("logo.png", new Uint8Array([137, 80, 0, 1, 2]));
    space.write("keep.png", new Uint8Array([9, 9, 0, 9]));
    space.write("big.txt", lines(MAX_CHANGE_SIDE_BYTES / 8));
    space.write("small.txt", "small\n");

    const { start, store } = runs(space);

    await start();

    expect(space.git(`ls-tree -r '${startOf(space)}'`)).toContain("100755 blob");
    // The tree holds the stored files only: a new binary or big file is absent, a changed one keeps HEAD's blob.
    expect(space.git(`ls-tree -r --name-only '${startOf(space)}'`)).toBe(
      "keep.png\nrun.sh\nsmall.txt\n",
    );
    expect(space.git(`show '${startOf(space)}:keep.png'`)).toBe("\u0001\u0002\u0000\u0003");

    // SAFETY: the module put a repo's record under this key.
    const record = store.get(`cloudpid:run:${SCOPE}:repo:app`) as {
      start: { unstored: unknown[] };
    };

    expect(record.start.unstored).toEqual(
      [
        {
          path: "big.txt",
          size: lines(MAX_CHANGE_SIDE_BYTES / 8).length,
          id: expect.stringMatching(/^[0-9a-f]{40}$/u),
          binary: false,
        },
        { path: "keep.png", size: 4, id: expect.stringMatching(/^[0-9a-f]{40}$/u), binary: true },
        { path: "logo.png", size: 5, id: expect.stringMatching(/^[0-9a-f]{40}$/u), binary: true },
      ].toSorted((a, b) => (a.path < b.path ? -1 : 1)),
    );
    expect(space.sh("git fsck --strict --no-dangling").exitCode).toBe(0);
  });

  it("is not captured past 2,000 changed files, and nothing is saved for it", async () => {
    const space = workspace({ "a.txt": "a\n" });

    mkdirSync(join(space.dir, "many"));

    for (let index = 0; index <= MAX_RUN_COPY_FILES; index++) {
      writeFileSync(join(space.dir, `many/f${index}.txt`), `${index}\n`);
    }

    const { start, paths } = runs(space);

    expect(await start()).toMatchObject({
      repos: [{ repo: "app", start: null, end: null, notCaptured: "too_many_files" }],
    });
    expect(space.git("for-each-ref refs/cloudpid")).toBe("");
    // It has no Run diff, but it is still the Session's last Run.
    expect(await paths()).toEqual([]);
  });

  it("is copied by the Container's git when the repo needs it and the Container runs, and 'not captured' when it is stopped, which starts nothing", async () => {
    const space = workspace({ ".gitattributes": "* text=auto eol=lf\n", "a.txt": "one\n" });

    space.write("a.txt", "two\n");

    const { start, end, container, paths } = runs(space);

    expect(await start()).toMatchObject({
      repos: [{ repo: "app", start: null, notCaptured: "container_stopped" }],
    });
    expect(container.runs).toBe(0);

    // A Run that started while it ran is copied by its git, and listed by it.
    container.running = true;

    const second = await start("run2abc");
    const first = startOf(space);

    expect(second.repos[0]).toMatchObject({ repo: "app", start: first });
    expect(container.runs).toBe(1);
    expect(space.git(`show '${first}:a.txt'`)).toBe("two\n");

    space.write("a.txt", "three\n");
    space.write("b.txt", "new\n");

    expect(await paths()).toEqual(["M a.txt", "A b.txt"]);

    // The Container stopped before the end: its last list is shown "may be out of date", and the end is not captured.
    container.running = false;
    expect(await end("run2abc")).toMatchObject({
      endedAt: expect.any(Number),
      repos: [{ repo: "app", start: first, end: null, notCaptured: "container_stopped" }],
    });
    expect(container.runs).toBe(2);
  });
});

describe("the Run copies the Session gave up waiting for", () => {
  it("are not captured when the first write did not wait: the Run ends without copying again", async () => {
    const space = workspace({ "a.txt": "a\n" });
    const { module, start } = runs(space);

    await start();
    space.write("a.txt", "b\n");

    const ended = await module.end({ scope: SCOPE, run: RUN, until: 3, missed: true, keep: [] });

    expect(ended).toMatchObject({
      endedAt: expect.any(Number),
      repos: [{ repo: "app", end: null, notCaptured: "failed" }],
    });
    expect(ended?.empty).toBeUndefined();
    expect(space.sh(`git rev-parse refs/cloudpid/runs/${SCOPE}/end`).exitCode).not.toBe(0);
    expect(await module.diff(SCOPE)).toMatchObject({ live: false, repos: [] });
  });

  it("are stamped with the time the Session gave", async () => {
    const space = workspace({ "a.txt": "a\n" });
    const { module } = runs(space);

    const started = await module.start({
      scope: SCOPE,
      run: RUN,
      conversationId: 1,
      firstCall: "call_1",
      startedAt: 42,
      directory: "/workspace/app",
      keep: [],
    });

    expect(started.startedAt).toBe(42);
  });
});

describe("an ended Run", () => {
  it("is empty when it changed no file in any repo, and not when it changed one", async () => {
    const space = workspace({ "a.txt": "a\n" });
    const { start, end } = runs(space);

    expect((await start()).empty).toBeUndefined();
    expect((await end())?.empty).toBe(true);

    await start("run2abc");
    space.write("a.txt", "b\n");
    expect((await end("run2abc"))?.empty).toBeUndefined();
  });
});

describe("the Run diff", () => {
  it("is the start copy against the working tree while the Run is live, never against HEAD", async () => {
    const space = workspace({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });

    // Uncommitted work from before the Run: part of the start copy, not of the Run's diff.
    space.write("a.txt", "a before\n");

    const { start, paths, module } = runs(space);

    await start();
    expect(await paths()).toEqual([]);

    space.write("b.txt", "b during\n");
    space.write("a.txt", "a during\n");
    space.write("new.txt", "new\n");
    await fsp.rm(join(space.dir, "c.txt"));

    expect(await paths()).toEqual(["M a.txt", "M b.txt", "D c.txt", "A new.txt"]);
    expect(await module.diff(SCOPE)).toMatchObject({
      run: RUN,
      live: true,
      repos: [{ repo: "app", stale: false, head: { branch: "main" } }],
    });

    // Its contents: the start copy's side, and the working tree's.
    expect(await module.file({ scope: SCOPE, repo: "app", path: "a.txt" })).toEqual({
      old: { kind: "text", text: "a before\n" },
      new: { kind: "text", text: "a during\n" },
    });
    expect(await module.file({ scope: SCOPE, repo: "app", path: "new.txt" })).toEqual({
      old: null,
      new: { kind: "text", text: "new\n" },
    });
    expect(await module.file({ scope: SCOPE, repo: "app", path: "c.txt" })).toEqual({
      old: { kind: "text", text: "c\n" },
      new: null,
    });
  });

  it("hides nothing when the agent commits, or switches branch, during the Run", async () => {
    const space = workspace({ "a.txt": "a\n", "b.txt": "b\n" });

    space.git("branch other");

    const { start, paths, end, module } = runs(space);

    await start();

    // Work, then commit it: against HEAD the repo is clean again, against the start copy it is all there.
    space.write("a.txt", "a2\n");
    space.write("new.txt", "new\n");
    space.git("add -A");
    space.git("commit -q -m during");
    expect(space.git("status --porcelain")).toBe("");
    expect(await paths()).toEqual(["M a.txt", "A new.txt"]);

    // A switch to a branch that has none of it: the working tree is the other branch's, and the Run's changes show as the
    // difference between the start copy and what the tree holds now.
    space.git("switch -q other");
    space.write("b.txt", "b2\n");
    expect(await paths()).toEqual(["M b.txt"]);

    space.git("switch -q main");
    space.write("b.txt", "b2\n");

    const ended = await end();

    expect(ended?.repos[0]).toMatchObject({ start: startOf(space), end: endOf(space) });
    expect(await paths()).toEqual(["M a.txt", "M b.txt", "A new.txt"]);
    expect(await module.file({ scope: SCOPE, repo: "app", path: "a.txt" })).toEqual({
      old: { kind: "text", text: "a\n" },
      new: { kind: "text", text: "a2\n" },
    });
    // Real git agrees on what the Run changed.
    expect(space.git(`diff --name-status '${startOf(space)}' '${endOf(space)}'`)).toBe(
      "M\ta.txt\nM\tb.txt\nA\tnew.txt\n",
    );
  });

  it("is frozen at the Run's end: later changes to the files change nothing, in the list or in a file's sides", async () => {
    const space = workspace({ "a.txt": "a\n", "b.txt": "b\n" });
    const { start, end, paths, module } = runs(space);

    await start();
    space.write("a.txt", "a during\n");

    const ended = await end();

    expect(ended).toMatchObject({ endedAt: expect.any(Number), until: 12, firstCall: "call_1" });
    expect(await paths()).toEqual(["M a.txt"]);

    space.write("a.txt", "after the run\n");
    space.write("b.txt", "also after\n");
    await fsp.rm(join(space.dir, "a.txt"));

    expect(await paths()).toEqual(["M a.txt"]);
    expect(await module.diff(SCOPE)).toMatchObject({ live: false, repos: [{ stale: false }] });
    expect(await module.file({ scope: SCOPE, repo: "app", path: "a.txt" })).toEqual({
      old: { kind: "text", text: "a\n" },
      new: { kind: "text", text: "a during\n" },
    });

    // Ending twice, or a Run that is not the latest, changes nothing.
    expect(await end()).toEqual(ended);
    expect(await end("other1abc")).toBeNull();
  });

  it("shows a binary or big file as such, hides one the Run did not touch, and shows one it changed or removed", async () => {
    const space = workspace({ "old.png": new Uint8Array([1, 0, 1]) });

    // Before the Run: a binary and a big file already differ from HEAD.
    space.write("old.png", new Uint8Array([2, 0, 2]));
    space.write("art.png", new Uint8Array([5, 0, 5]));
    space.write("big.txt", lines(MAX_CHANGE_SIDE_BYTES / 8));
    space.write("gone.png", new Uint8Array([7, 0, 7]));

    const { start, end, paths, module } = runs(space);

    await start();
    expect(await paths()).toEqual([]);

    space.write("old.png", new Uint8Array([3, 0, 3]));
    await fsp.rm(join(space.dir, "gone.png"));
    space.write("new.png", new Uint8Array([4, 0, 4]));
    space.write("big.txt", `${lines(MAX_CHANGE_SIDE_BYTES / 8)}more\n`);

    expect(await paths()).toEqual(["M big.txt", "D gone.png", "A new.png", "M old.png"]);

    const diff = await module.diff(SCOPE);

    expect(diff?.repos[0]?.files).toEqual([
      expect.objectContaining({ path: "big.txt", tooLarge: true }),
      expect.objectContaining({ path: "gone.png", status: "deleted", binary: true }),
      expect.objectContaining({ path: "new.png", status: "added", binary: true }),
      expect.objectContaining({ path: "old.png", status: "modified", binary: true }),
    ]);
    expect(await module.file({ scope: SCOPE, repo: "app", path: "old.png" })).toEqual({
      old: { kind: "binary" },
      new: { kind: "binary" },
    });
    expect(await module.file({ scope: SCOPE, repo: "app", path: "big.txt" })).toEqual({
      old: { kind: "too_large", bytes: lines(MAX_CHANGE_SIDE_BYTES / 8).length },
      new: { kind: "too_large", bytes: lines(MAX_CHANGE_SIDE_BYTES / 8).length + 5 },
    });

    // Ended, the same list, from the copies.
    await end();
    expect(await paths()).toEqual(["M big.txt", "D gone.png", "A new.png", "M old.png"]);
    expect(await module.file({ scope: SCOPE, repo: "app", path: "old.png" })).toEqual({
      old: { kind: "binary" },
      new: { kind: "binary" },
    });
  });
});

describe("the Run kept", () => {
  it("is the latest writing Run only: the next replaces it, refs and storage", async () => {
    const space = workspace({ "a.txt": "a\n" });
    const { start, end, module, store } = runs(space);

    space.write("a.txt", "one\n");
    await start("run1abc");
    await end("run1abc");

    const first = startOf(space);

    space.write("a.txt", "two\n");

    const second = await start("run2abc");

    expect(second.run).toBe("run2abc");
    expect(startOf(space)).not.toBe(first);
    expect(space.sh(`git rev-parse refs/cloudpid/runs/${SCOPE}/end`).exitCode).not.toBe(0);
    expect((await module.diff(SCOPE))?.run).toBe("run2abc");
    expect([...store.keys()].filter((key) => key.includes(":kept:"))).toEqual([]);
    expect(space.git("for-each-ref --format='%(refname)' refs/cloudpid").trim()).toBe(
      `refs/cloudpid/runs/${SCOPE}/start`,
    );
  });

  it("is kept while drafts name it, and forgotten once they do not", async () => {
    const space = workspace({ "a.txt": "a\n" });
    const { start, end, module, store } = runs(space);

    space.write("a.txt", "one\n");
    await start("run1abc");
    await end("run1abc");

    const first = { start: startOf(space), end: endOf(space) };

    // The next Run starts while a draft still names the first.
    space.write("a.txt", "two\n");
    await start("run2abc", ["run1abc"]);

    expect((await module.diff(SCOPE))?.run).toBe("run2abc");
    expect(space.git(`rev-parse refs/cloudpid/runs/${SCOPE}/kept/run1abc/start`).trim()).toBe(
      first.start,
    );
    expect(space.git(`rev-parse refs/cloudpid/runs/${SCOPE}/kept/run1abc/end`).trim()).toBe(
      first.end,
    );
    expect(space.git(`show '${first.end}:a.txt'`)).toBe("one\n");
    expect([...store.keys()].filter((key) => key.includes(":kept:run1abc"))).not.toEqual([]);

    // Still named when the second ends, and a third starts: kept.
    await end("run2abc", ["run1abc"]);
    await start("run3abc", ["run1abc"]);
    expect(space.git(`rev-parse refs/cloudpid/runs/${SCOPE}/kept/run1abc/end`).trim()).toBe(
      first.end,
    );
    expect(
      space.sh(`git rev-parse refs/cloudpid/runs/${SCOPE}/kept/run2abc/start`).exitCode,
    ).not.toBe(0);

    // Sent or deleted: the next Run forgets it.
    await end("run3abc", []);
    expect(
      space.sh(`git rev-parse refs/cloudpid/runs/${SCOPE}/kept/run1abc/start`).exitCode,
    ).not.toBe(0);
    expect([...store.keys()].filter((key) => key.includes(":kept:"))).toEqual([]);
  });

  it("starts the same Run once: a replayed call finds it, and bad ids are refused", async () => {
    const space = workspace({ "a.txt": "a\n" });
    const { start, module, container } = runs(space);

    const first = await start();

    space.write("a.txt", "changed after\n");

    expect(await start()).toEqual(first);
    expect(container.runs).toBe(0);
    await expect(start("../../x")).rejects.toThrow("Not a Run");
    await expect(
      module.start({
        scope: "a/b",
        run: RUN,
        conversationId: 1,
        firstCall: "c",
        directory: "/workspace",
        keep: [],
      }),
    ).rejects.toThrow("Not a Run");
    await expect(module.file({ scope: SCOPE, repo: "app", path: "../x" })).rejects.toThrow(
      "No such file",
    );
  });
});
