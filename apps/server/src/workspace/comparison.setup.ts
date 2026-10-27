// Vitest global set-up for the Comparison workerd tests: real git makes `app` (a branch with commits beyond a base that
// moved on), runs the Container's command on it in Node, and hands both to the workerd tests as files and text
// (`inject("comparisonRepos")`), since workerd runs no git.
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off preferEffectRecord:off processEnv:off
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { blobsScript, comparisonScript } from "@cloudpid/sandbox-image/comparison";
import type { TestProject } from "vitest/node";
import { collect } from "./changes.collect.ts";
import { lines } from "./changes.repos.ts";
import type { ComparisonRepos } from "./comparison.repos.ts";

const env = {
  PATH: process.env.PATH ?? "",
  HOME: tmpdir(),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

const made = (): ComparisonRepos => {
  const root = mkdtempSync(join(tmpdir(), "comparison-repo-"));
  const dir = join(root, "app");

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, stdio: "pipe" });

  const commit = (files: Readonly<Record<string, string>>, message: string) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }

    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
  };

  /** The Container's script for `/workspace/app`, run here on the temp root. */
  const run = (script: string): string => {
    const local = script.replace(/^dir=.*$/mu, `dir='${dir}'`);
    const result = spawnSync("bash", ["-c", local], { cwd: root, encoding: "utf8", env });

    if (result.status !== 0) throw new Error(`The command failed: ${result.stderr}`);

    return result.stdout;
  };

  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "-q", "origin.git", "app");
  commit({ "README.md": "hello\n", "keep.txt": lines(20, "keep") }, "first");
  git(dir, "push", "-q", "origin", "main");
  git(dir, "switch", "-q", "-c", "feat");
  commit({ "keep.txt": `${lines(20, "keep")}added\n`, "new.txt": "fresh\n" }, "edit");
  git(dir, "mv", "README.md", "DOCS.md");
  commit({ "DOCS.md": "hello\nworld\n" }, "rename");
  commit({ "bin.dat": "a\0b" }, "binary");

  // main moves on after the branch left it.
  git(dir, "switch", "-q", "main");
  commit({ "later.txt": "later\n" }, "later");
  git(dir, "push", "-q", "origin", "main");
  git(dir, "switch", "-q", "feat");

  const firstOut = run(comparisonScript({ repo: "app", fetch: true }));
  const first = { files: collect(dir, () => false), stdout: firstOut };

  const blobId = git(dir, "rev-parse", "HEAD:new.txt").toString().trim();
  const blobOut = run(blobsScript("app", [blobId], 1024 * 1024));

  const withoutBlob = collect(
    dir,
    (path) => path === `.git/objects/${blobId.slice(0, 2)}/${blobId.slice(2)}`,
  );

  commit({ "third.txt": "third\n" }, "third");

  const second = {
    files: collect(dir, () => false),
    stdout: run(comparisonScript({ repo: "app", fetch: false })),
  };

  rmSync(root, { recursive: true, force: true });

  return { first, second, withoutBlob, blob: { id: blobId, stdout: blobOut } };
};

export default function setup(project: TestProject) {
  project.provide("comparisonRepos", made());
}
