// The Container's side of the Run diff's copies: the script runs for real, under bash, with real git, in a throwaway root.
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off preferEffectRecord:off processEnv:off
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRunCopy, runCopyScript } from "@cloudpid/sandbox-image/runs";

const env = {
  PATH: process.env.PATH ?? "",
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const REF = "refs/cloudpid/runs/session-1/start";

/** The sizes the Workspace DO asks for, made small. */
const LIMITS = { maxStoredBytes: 1_024, maxHashedBytes: 4_096 };

/** A Workspace root with repo `app`, whose files are committed on `main`. */
const workspace = (files: Readonly<Record<string, string | Uint8Array>>) => {
  const root = mkdtempSync(join(tmpdir(), "run-copy-"));
  const dir = join(root, "app");

  roots.push(root);

  const sh = (script: string, cwd: string = dir) => {
    const result = spawnSync("bash", ["-c", script], {
      cwd,
      encoding: "utf8",
      env: {
        ...env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });

    if (result.status !== 0) throw new Error(`${script}: ${result.stderr}`);

    return result.stdout;
  };

  const write = (path: string, content: string | Uint8Array) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };

  mkdirSync(dir);
  sh("git init -q -b main");

  for (const [path, content] of Object.entries(files)) write(path, content);

  if (Object.keys(files).length > 0) sh("git add -A && git commit -q -m first");

  return {
    root,
    dir,
    sh,
    write,
    /** The copy the Container makes. */
    copy: (maxFiles = 2_000, ref = REF) =>
      parseRunCopy(sh(runCopyScript({ repo: "app", ref, maxFiles, ...LIMITS }, root), root)),
  };
};

describe("the Container's Run copy", () => {
  it("saves the working tree as a commit on HEAD under the hidden ref: edits, deletions and untracked files, not ignored ones", () => {
    const repo = workspace({
      "keep.txt": "keep\n",
      "edit.txt": "one\n",
      "gone.txt": "bye\n",
      ".gitignore": "out/\n",
    });

    repo.write("edit.txt", "two\n");
    repo.write("new dir/new.txt", "fresh\n");
    repo.write("out/built.js", "ignored\n");
    repo.sh("rm gone.txt");

    const head = repo.sh("git rev-parse HEAD").trim();
    const made = repo.copy();

    if (!made.ok) throw new Error(`not ok: ${JSON.stringify(made)}`);

    expect(made.files).toBe(3);
    expect(repo.sh(`git rev-parse '${REF}'`).trim()).toBe(made.commit);
    expect(repo.sh(`git rev-parse '${made.commit}^'`).trim()).toBe(head);
    expect(repo.sh(`git ls-tree -r --name-only '${made.commit}'`)).toBe(
      ".gitignore\nedit.txt\nkeep.txt\nnew dir/new.txt\n",
    );
    expect(repo.sh(`git show '${made.commit}:edit.txt'`)).toBe("two\n");
    expect(repo.sh("git fsck --strict --no-dangling 2>&1")).not.toContain("error");
  });

  it("never writes the shared index, refs/heads, the tree or the other hidden refs", () => {
    const repo = workspace({ "a.txt": "a\n" });

    repo.write("a.txt", "b\n");
    repo.write("new.txt", "new\n");
    repo.sh("git branch other && git update-ref refs/cloudpid/base/main HEAD");

    const index = readFileSync(join(repo.dir, ".git/index"));
    const refs = repo.sh("git for-each-ref --format='%(refname) %(objectname)'");

    expect(repo.copy().ok).toBe(true);
    expect(readFileSync(join(repo.dir, ".git/index")).equals(index)).toBe(true);
    expect(repo.sh("git status --porcelain")).toBe(" M a.txt\n?? new.txt\n");
    expect(readFileSync(join(repo.dir, "a.txt"), "utf8")).toBe("b\n");

    const after = repo.sh("git for-each-ref --format='%(refname) %(objectname)'");

    expect(after.split("\n").filter((line) => !line.startsWith(REF))).toEqual(refs.split("\n"));
    expect(repo.sh("git for-each-ref --format='%(refname)' refs/heads refs/remotes")).toBe(
      "refs/heads/main\nrefs/heads/other\n",
    );
  });

  it("saves a repo with no commit on the empty tree, with no parent", () => {
    const repo = workspace({});

    repo.write("first.txt", "hello\n");

    const made = repo.copy();

    if (!made.ok) throw new Error(`not ok: ${JSON.stringify(made)}`);

    expect(made.files).toBe(1);
    expect(repo.sh(`git rev-list --parents '${made.commit}'`).trim()).toBe(made.commit);
    expect(repo.sh(`git ls-tree -r --name-only '${made.commit}'`)).toBe("first.txt\n");
  });

  it("saves nothing, and says so, past the file limit", () => {
    const repo = workspace({ "a.txt": "a\n" });

    for (const name of ["x", "y", "z"]) repo.write(`${name}.txt`, name);

    expect(repo.copy(2)).toEqual({ ok: false, kind: "too_many", files: 3 });
    expect(repo.sh("git for-each-ref refs/cloudpid")).toBe("");
    expect(repo.copy(3).ok).toBe(true);
  });

  it("replaces the ref on a second copy, and keeps the old commit as an object", () => {
    const repo = workspace({ "a.txt": "a\n" });

    repo.write("a.txt", "b\n");

    const first = repo.copy();

    repo.write("a.txt", "c\n");

    const second = repo.copy();

    if (!first.ok || !second.ok) throw new Error("not ok");

    expect(second.commit).not.toBe(first.commit);
    expect(repo.sh(`git rev-parse '${REF}'`).trim()).toBe(second.commit);
    expect(repo.sh(`git show '${first.commit}:a.txt'`)).toBe("b\n");
  });

  it("keeps files with odd names whole", () => {
    const repo = workspace({ "a.txt": "a\n" });

    repo.write("odd 'name' $x.txt", "odd\n");

    const made = repo.copy();

    if (!made.ok) throw new Error("not ok");

    expect(repo.sh(`git ls-tree -r --name-only -z '${made.commit}' | tr '\\0' '\\n'`)).toBe(
      "a.txt\nodd 'name' $x.txt\n",
    );
  });

  it("falls back to its own identity when git has none", () => {
    const repo = workspace({ "a.txt": "a\n" });

    repo.write("a.txt", "b\n");

    // No identity in the environment or in git's configuration.
    const result = spawnSync(
      "bash",
      ["-c", runCopyScript({ repo: "app", ref: REF, maxFiles: 10, ...LIMITS }, repo.root)],
      {
        cwd: repo.root,
        encoding: "utf8",
        env,
      },
    );

    const made = parseRunCopy(result.stdout);

    if (!made.ok) throw new Error(`not ok: ${result.stdout}`);

    expect(repo.sh(`git log -1 --format='%an <%ae> / %cn <%ce>' '${made.commit}'`).trim()).toBe(
      "cloudpid <cloudpid@localhost> / cloudpid <cloudpid@localhost>",
    );
  });

  it("reports a repo that is not there, and refuses a ref or a limit it was not meant to take", () => {
    const repo = workspace({ "a.txt": "a\n" });

    expect(
      parseRunCopy(
        repo.sh(
          runCopyScript({ repo: "missing", ref: REF, maxFiles: 10, ...LIMITS }, repo.root),
          repo.root,
        ),
      ),
    ).toEqual({ ok: false, kind: "failed", message: "The repo is not on the Container" });
    expect(() =>
      runCopyScript({ repo: "app", ref: "refs/heads/main", maxFiles: 10, ...LIMITS }),
    ).toThrow("Not a Run copy ref");
    expect(() =>
      runCopyScript({
        repo: "app",
        ref: "refs/cloudpid/runs/../../heads/start",
        maxFiles: 10,
        ...LIMITS,
      }),
    ).toThrow("Not a Run copy ref");
    expect(() => runCopyScript({ repo: "app", ref: REF, maxFiles: Number.NaN, ...LIMITS })).toThrow(
      "Not a limit",
    );
    expect(() =>
      runCopyScript({ repo: "app", ref: REF, maxFiles: 1, ...LIMITS, timeoutSeconds: 0 }),
    ).toThrow("Not a time limit");
  });

  it("leaves a big or a binary file as HEAD has it, recording only its size and hash, and counts it", () => {
    const repo = workspace({ "keep.txt": "keep\n", "big.txt": "old\n", "pic.bin": "a\0b" });
    const big = "x".repeat(2_000);
    const huge = "y".repeat(5_000);
    const pic = Buffer.from([1, 2, 0, 3]);

    repo.write("keep.txt", "changed\n");
    repo.write("big.txt", big);
    repo.write("pic.bin", pic);
    repo.write("new.png", pic);
    repo.write("huge.txt", huge);

    const made = repo.copy();

    if (!made.ok) throw new Error(`not ok: ${JSON.stringify(made)}`);

    const blob = (text: string) =>
      repo.sh(`printf '%s' '${text}' | git hash-object --stdin`).trim();

    expect(made.files).toBe(5);
    expect(made.unstored).toEqual([
      { path: "new.png", size: 4, id: expect.stringMatching(/^[0-9a-f]{40}$/), binary: true },
      { path: "pic.bin", size: 4, id: expect.stringMatching(/^[0-9a-f]{40}$/), binary: true },
      { path: "big.txt", size: 2_000, id: blob(big), binary: false },
      { path: "huge.txt", size: 5_000, id: null, binary: false },
    ]);
    // HEAD's own versions stay in the tree; nothing of the others was stored, and the changed text was.
    expect(repo.sh(`git ls-tree -r --name-only '${made.commit}'`)).toBe(
      "big.txt\nkeep.txt\npic.bin\n",
    );
    expect(repo.sh(`git show '${made.commit}:big.txt'`)).toBe("old\n");
    expect(repo.sh(`git show '${made.commit}:keep.txt'`)).toBe("changed\n");
    expect(
      repo.sh(`git cat-file -e '${blob(big)}' 2>/dev/null && echo present || echo missing`).trim(),
    ).toBe("missing");
  });

  it("counts the files before it stores any, so a repo past the limit stores nothing", () => {
    const repo = workspace({ "a.txt": "a\n" });

    for (const name of ["x", "y", "z"]) repo.write(`${name}.txt`, `${name}-only-once-${name}\n`);

    const before = repo.sh("git count-objects -v | grep '^count:'").trim();

    expect(repo.copy(2)).toEqual({ ok: false, kind: "too_many", files: 3 });
    expect(repo.sh("git count-objects -v | grep '^count:'").trim()).toBe(before);
  });

  it("takes a staged change, a file that became a directory and a deleted one, as the working tree has them", () => {
    const repo = workspace({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });

    repo.write("a.txt", "staged\n");
    repo.sh("git add a.txt");
    repo.write("a.txt", "staged, then more\n");
    repo.sh("rm b.txt");
    repo.sh("rm c.txt && mkdir c.txt");
    repo.write("c.txt/inner.txt", "inner\n");

    const made = repo.copy();

    if (!made.ok) throw new Error(`not ok: ${JSON.stringify(made)}`);

    expect(repo.sh(`git ls-tree -r --name-only '${made.commit}'`)).toBe("a.txt\nc.txt/inner.txt\n");
    expect(repo.sh(`git show '${made.commit}:a.txt'`)).toBe("staged, then more\n");
  });

  it("sees a same-size edit made in the instant the index was written, as git does: the copy keeps the index's time", () => {
    const repo = workspace({ "a.txt": "one\n", "b.txt": "b\n" });

    // The stat data git compares is the size and the second only, and the file is edited to the same size and put back to
    // its time, with the index dated the same second: a racily clean entry, which only the index's own time tells apart.
    repo.sh(
      "git config core.checkStat minimal && touch -d @1700000000 a.txt && git update-index --refresh",
    );
    repo.write("a.txt", "two\n");
    repo.sh("touch -d @1700000000 a.txt .git/index");

    const made = repo.copy();

    if (!made.ok) throw new Error(`not ok: ${JSON.stringify(made)}`);

    expect(repo.sh(`git show '${made.commit}:a.txt'`)).toBe("two\n");
    expect(made.files).toBe(1);
  });

  it("starts from a copy of the repo's index, which keeps the stat data, and not from `read-tree`", () => {
    const files: Record<string, string> = {};

    for (let index = 0; index < 30; index += 1) files[`f${index}.txt`] = `file ${index}\n`;

    const repo = workspace(files);

    repo.sh("sleep 1 && git update-index --refresh -q");
    repo.write("f3.txt", "changed\n");

    // git traces the index it reads: a private index built by `read-tree` would hold no stat data.
    const trace = join(repo.root, "trace.txt");
    const script = runCopyScript({ repo: "app", ref: REF, maxFiles: 10, ...LIMITS }, repo.root);

    const result = spawnSync("bash", ["-c", script], {
      cwd: repo.root,
      encoding: "utf8",
      env: { ...env, GIT_TRACE: trace },
    });

    expect(parseRunCopy(result.stdout).ok).toBe(true);

    const traced = readFileSync(trace, "utf8");

    expect(traced).not.toContain("read-tree");
    expect(traced).toContain("update-index");
  });

  it("stops itself after its time limit and writes no ref", () => {
    const repo = workspace({ "a.txt": "a\n" });

    repo.write("a.txt", "b\n");

    const slow = runCopyScript(
      { repo: "app", ref: REF, maxFiles: 10, ...LIMITS, timeoutSeconds: 1 },
      repo.root,
    );

    // A git that sleeps before it does anything, first on the PATH.
    const bin = join(repo.root, "bin");

    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/bash\nsleep 3\n`, { mode: 0o755 });

    const result = spawnSync("bash", ["-c", slow], {
      cwd: repo.root,
      encoding: "utf8",
      env: { ...env, PATH: `${bin}:${env.PATH}` },
    });

    expect(parseRunCopy(result.stdout)).toMatchObject({ ok: false, kind: "failed" });
    expect(repo.sh("git for-each-ref refs/cloudpid")).toBe("");
  });

  it("takes output that stops short for a failure", () => {
    expect(parseRunCopy("")).toEqual({
      ok: false,
      kind: "failed",
      message: "The Container's copy stopped short",
    });
  });
});
