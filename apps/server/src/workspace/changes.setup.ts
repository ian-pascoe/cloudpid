// Vitest global set-up for the Changes tests: real git makes their repos in a temp directory, in Node, and hands them to
// the workerd tests as files (`inject("changesRepos")`), since workerd runs no git. The measured repos (1,000 to 20,000
// tracked files) are made only for the measurements (`CHANGES_BENCH=1`), and only their `.git` is handed over: the
// tests write the working tree from the same generator.
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off preferEffectRecord:off processEnv:off
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { TestProject } from "vitest/node";
import {
  BENCH_SIZES,
  benchEdit,
  benchEdited,
  benchFile,
  lines,
  REWRITE_LINES,
  type RepoFiles,
} from "./changes.repos.ts";

const env = {
  PATH: process.env.PATH ?? "",
  HOME: tmpdir(),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

type Content = string | Uint8Array;

/** Every file below `root` (`.git` included), but those `skip` names, base64. */
const collect = (root: string, skip: (path: string) => boolean): RepoFiles => {
  const files: Record<string, string> = {};

  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const full = join(directory, name);
      const path = relative(root, full);

      if (skip(path)) continue;

      if (statSync(full).isDirectory()) walk(full);
      else files[path] = readFileSync(full).toString("base64");
    }
  };

  walk(root);

  return files;
};

/**
 * A repo real git made: `head` committed on `main` (and packed), then the working tree changed by `change`. What is
 * handed over leaves out the paths `skip` names.
 */
const repo = (
  head: Readonly<Record<string, Content>>,
  change: (tree: {
    write: (path: string, content: Content) => void;
    remove: (path: string) => void;
  }) => void,
  skip: (path: string) => boolean = () => false,
): RepoFiles => {
  const dir = mkdtempSync(join(tmpdir(), "changes-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });

  const write = (path: string, content: Content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };

  git("init", "-q", "-b", "main");

  for (const [path, content] of Object.entries(head)) write(path, content);

  if (Object.keys(head).length > 0) {
    git("add", "-A");
    git("commit", "-q", "-m", "first");
    git("gc", "-q");
  }

  change({ write, remove: (path) => rmSync(join(dir, path)) });

  const files = collect(dir, skip);

  rmSync(dir, { recursive: true, force: true });

  return files;
};

/** The rewritten file: as many lines, every one changed and reordered. */
const rewritten = () =>
  Array.from(
    { length: REWRITE_LINES },
    (_, index) => `rewritten ${(index * 7919) % REWRITE_LINES} line\n`,
  ).join("");

const basic = () =>
  repo(
    {
      "keep.txt": "keep\n",
      "edit.txt": lines(10),
      "gone.txt": "gone\n",
      "same.txt": lines(30, "same"),
      "edited.txt": lines(30, "edited"),
      "logo.bin": new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]),
      "grows.txt": "small\n",
      "rewrite.txt": lines(REWRITE_LINES),
      // Tracked, but on a Container-only path (`/*/target`): the Workspace DO never holds it.
      "target/built.txt": "built\n",
      ".gitattributes":
        "*.gen.ts linguist-generated\nvendor/** linguist-vendored\nvendor/keep.js -linguist-vendored\n",
      ".gitignore": "out/\n",
      "gen/out.gen.ts": "a\n",
      "vendor/lib.js": "v\n",
      "vendor/keep.js": "k\n",
    },
    ({ write, remove }) => {
      write("edit.txt", lines(10).replace("line 1\n", "line one\n") + "line 10\n");
      remove("gone.txt");
      write("new.txt", "fresh\nfile\n");
      remove("same.txt");
      write("moved/same.txt", lines(30, "same"));
      remove("edited.txt");
      write("edited-moved.txt", `${lines(30, "edited")}one more\n`);
      write("logo.bin", new Uint8Array([137, 80, 78, 71, 0, 9, 9, 9, 9]));
      write("grows.txt", "x\n".repeat(512 * 1024 + 1));
      write("rewrite.txt", rewritten());
      write("out/ignored.js", "ignored\n");
      write("gen/out.gen.ts", "b\n");
      write("vendor/lib.js", "w\n");
      write("vendor/keep.js", "l\n");
    },
    (path) => path === "target",
  );

/** A repo whose `.gitattributes` has rules git applies when it compares, with a CRLF line ending git would ignore. */
const attributed = () =>
  repo({ ".gitattributes": "* text=auto eol=lf\n", "a.txt": "one\ntwo\n" }, ({ write }) => {
    write("a.txt", "one\r\ntwo\r\n");
  });

/** A repo of one committed file and no changes. */
const tiny = () => repo({ "README.md": "# tiny\n" }, () => {});

/** A repo of 600 tracked files, one of them edited: long enough a listing for other calls to come in during it. */
const many = () => {
  const head: Record<string, string> = {};

  for (let index = 0; index < 600; index++) {
    const [path, content] = benchFile(index);

    head[path] = content;
  }

  return repo(head, ({ write }) => {
    write(benchFile(0)[0], benchEdit(0));
  });
};

/** A measured repo of `count` tracked files, `BENCH_EDITED` of them edited: its `.git` alone. */
const bench = (count: number) => {
  const head: Record<string, string> = {};

  for (let index = 0; index < count; index++) {
    const [path, content] = benchFile(index);

    head[path] = content;
  }

  return repo(
    head,
    ({ write }) => {
      for (const index of benchEdited(count)) write(benchFile(index)[0], benchEdit(index));
    },
    (path) => path !== ".git" && !path.startsWith(".git/"),
  );
};

export default function setup(project: TestProject) {
  const measured =
    process.env.CHANGES_BENCH === "1"
      ? BENCH_SIZES.map((count) => [`bench-${count}`, bench(count)] as const)
      : [];

  project.provide("changesRepos", {
    basic: basic(),
    attributed: attributed(),
    tiny: tiny(),
    many: many(),
    ...Object.fromEntries(measured),
  });
}
