// The Container's side of Changes: the scripts run for real, under bash, with real git, in a throwaway root.
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off preferEffectRecord:off processEnv:off
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changesScript,
  headBlobScript,
  parseChanges,
  parseHeadBlob,
} from "@cloudpid/sandbox-image/changes";

const env = {
  PATH: process.env.PATH ?? "",
  HOME: tmpdir(),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** A Workspace root with repo `app`, whose files are committed on `main`. */
const workspace = (files: Readonly<Record<string, string | Uint8Array>>) => {
  const root = mkdtempSync(join(tmpdir(), "changes-"));
  const dir = join(root, "app");

  const sh = (script: string, cwd: string = root) => {
    const result = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env });

    if (result.status !== 0) throw new Error(`${script}: ${result.stderr}`);

    return result.stdout;
  };

  const write = (path: string, content: string | Uint8Array) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };

  mkdirSync(dir);
  sh("git init -q -b main", dir);

  for (const [path, content] of Object.entries(files)) write(path, content);

  if (Object.keys(files).length > 0) sh("git add -A && git commit -q -m first", dir);

  return {
    root,
    dir,
    write,
    remove: (path: string) => rmSync(join(dir, path)),
    sh,
    list: (repos: readonly string[] = ["app"]) => parseChanges(sh(changesScript(repos, root))),
  };
};

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join("");

describe("the Container's Changes listing", () => {
  it("lists additions, edits, deletions and renames (edited ones too) with git's counts", () => {
    const repo = workspace({
      "edit.txt": "one\ntwo\nthree\n",
      "gone.txt": "bye\n",
      "same.txt": lines(20),
      "moved.txt": lines(20, "moved"),
    });

    repo.write("edit.txt", "one\n2\nthree\nfour\n");
    repo.remove("gone.txt");
    repo.remove("same.txt");
    repo.write("dir/same name.txt", lines(20));
    repo.remove("moved.txt");
    repo.write("moved-and-edited.txt", `${lines(20, "moved")}one more\n`);
    repo.write("new.txt", "fresh\n");

    expect(repo.list()).toEqual([
      {
        repo: "app",
        files: [
          {
            path: "dir/same name.txt",
            oldPath: "same.txt",
            status: "renamed",
            additions: 0,
            deletions: 0,
            binary: false,
            oldBytes: lines(20).length,
          },
          {
            path: "edit.txt",
            status: "modified",
            additions: 2,
            deletions: 1,
            binary: false,
            oldBytes: 14,
          },
          {
            path: "gone.txt",
            status: "deleted",
            additions: 0,
            deletions: 1,
            binary: false,
            oldBytes: 4,
          },
          {
            path: "moved-and-edited.txt",
            oldPath: "moved.txt",
            status: "renamed",
            additions: 1,
            deletions: 0,
            binary: false,
            oldBytes: lines(20, "moved").length,
          },
          {
            path: "new.txt",
            status: "added",
            additions: 1,
            deletions: 0,
            binary: false,
            oldBytes: null,
          },
        ],
      },
    ]);
  });

  it("never writes the shared index, and leaves untracked files untracked", () => {
    const repo = workspace({ "a.txt": "a\n" });

    repo.write("a.txt", "b\n");
    repo.write("new.txt", "new\n");
    // Stat-only drift: what makes a plain `git diff` rewrite the index.
    repo.sh("touch a.txt", repo.dir);

    const before = readFileSync(join(repo.dir, ".git/index"));

    expect(repo.list()[0]).toMatchObject({ files: [{ path: "a.txt" }, { path: "new.txt" }] });
    expect(readFileSync(join(repo.dir, ".git/index")).equals(before)).toBe(true);
    expect(repo.sh("git status --porcelain", repo.dir)).toBe(" M a.txt\n?? new.txt\n");
  });

  it("lists a same-size edit made in the instant the index was written, as git does: the copy keeps the index's time", () => {
    const repo = workspace({ "a.txt": "one\n", "b.txt": "b\n" });

    // The stat data git compares is the size and the second only, and the file is edited to the same size and put back to
    // its time, with the index dated the same second: a racily clean entry, which only the index's own time tells apart.
    repo.sh(
      "git config core.checkStat minimal && touch -d @1700000000 a.txt && git update-index --refresh",
      repo.dir,
    );
    repo.write("a.txt", "two\n");
    repo.sh("touch -d @1700000000 a.txt .git/index", repo.dir);

    expect(repo.list()[0]).toMatchObject({ files: [{ path: "a.txt", status: "modified" }] });
  });

  it("marks what git takes for binary, with no counts, and leaves ignored files out", () => {
    const repo = workspace({
      "logo.png": new Uint8Array([137, 80, 0, 1, 2]),
      ".gitignore": "out/\n",
    });

    repo.write("logo.png", new Uint8Array([137, 80, 0, 9, 9, 9]));
    repo.write("out/built.js", "ignored\n");

    expect(repo.list()[0]).toEqual({
      repo: "app",
      files: [
        {
          path: "logo.png",
          status: "modified",
          additions: null,
          deletions: null,
          binary: true,
          oldBytes: 5,
        },
      ],
    });
  });

  it("compares a repo with no commit with the empty tree, and lists each repo apart", () => {
    const empty = workspace({});

    empty.write("first.txt", "hello\n");
    mkdirSync(join(empty.root, "other"));
    empty.sh("git init -q -b main", join(empty.root, "other"));

    expect(empty.list(["app", "other", "missing"])).toEqual([
      {
        repo: "app",
        files: [
          {
            path: "first.txt",
            status: "added",
            additions: 1,
            deletions: 0,
            binary: false,
            oldBytes: null,
          },
        ],
      },
      { repo: "other", files: [] },
      { repo: "missing", error: expect.stringContaining("missing") },
    ]);
  });

  it("compares with a commit instead of HEAD when given one (a Run's start copy), and refuses what is not an id", () => {
    const repo = workspace({ "a.txt": "a\n", "b.txt": "b\n" });

    repo.write("a.txt", "a2\n");

    // The start copy: the working tree as it is now, saved as a commit.
    const start = repo
      .sh(
        "export GIT_INDEX_FILE=$(mktemp -u) && git add -A && git commit-tree -p HEAD -m copy $(git write-tree)",
        repo.dir,
      )
      .trim();

    repo.write("b.txt", "b2\n");
    repo.write("new.txt", "fresh\n");
    repo.sh("git add -A && git commit -q -m second", repo.dir);
    repo.write("a.txt", "a3\n");

    const files = (listing: ReturnType<typeof parseChanges>) =>
      listing.flatMap((each) => ("files" in each ? each.files.map((file) => file.path) : []));

    // Against HEAD only a.txt differs; against the start copy, what the Run did: a commit hides nothing.
    expect(files(repo.list())).toEqual(["a.txt"]);
    expect(files(parseChanges(repo.sh(changesScript(["app"], repo.root, start))))).toEqual([
      "a.txt",
      "b.txt",
      "new.txt",
    ]);
    expect(() => changesScript(["app"], repo.root, "HEAD; rm -rf /")).toThrow("Not a commit id");
  });

  it("takes a listing cut off midway for an error", () => {
    expect(parseChanges("repo\tapp\nraw\t\n")).toEqual([
      { repo: "app", error: "The Container's listing stopped short" },
    ]);
  });
});

describe("the Container's HEAD side of a file", () => {
  it("prints the blob as committed, only its size when it is over the limit, and nothing when HEAD has none", () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 10]);
    const repo = workspace({ "a b.bin": bytes, "big.txt": lines(100) });

    repo.write("a b.bin", "changed");

    expect(parseHeadBlob(repo.sh(headBlobScript("app", "a b.bin", 1024, repo.root)))).toEqual({
      bytes: 5,
      blob: bytes,
    });
    expect(parseHeadBlob(repo.sh(headBlobScript("app", "big.txt", 100, repo.root)))).toEqual({
      bytes: lines(100).length,
    });
    expect(parseHeadBlob(repo.sh(headBlobScript("app", "nope.txt", 100, repo.root)))).toBeNull();
  });

  it("prints the side at a commit when given one, and refuses what is not an id", () => {
    const repo = workspace({ "a.txt": "first\n" });
    const first = repo.sh("git rev-parse HEAD", repo.dir).trim();

    repo.write("a.txt", "second\n");
    repo.sh("git commit -q -am second", repo.dir);

    const at = (commit: string) =>
      parseHeadBlob(repo.sh(headBlobScript("app", "a.txt", 1024, repo.root, commit)));

    expect(at(first)?.blob).toEqual(new TextEncoder().encode("first\n"));
    expect(parseHeadBlob(repo.sh(headBlobScript("app", "a.txt", 1024, repo.root)))?.bytes).toBe(7);
    expect(() => headBlobScript("app", "a.txt", 1024, repo.root, "--all")).toThrow(
      "Not a commit id",
    );
  });
});
