// @effect-diagnostics preferEffectArray:off asyncFunction:off nodeBuiltinImport:off -- native array methods over plain values (the bundle carries no Effect runtime); plain Promises, as pi's extension API and child processes give them; runs on node, on the owner's machine.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  branchNameProblem,
  checkoutOf,
  commitCarry,
  defaultBranchOf,
  deleteRemoteRef,
  gitIn,
  GitMissing,
  headOf,
  planPush,
  pushBranch,
  pushCarry,
  readCarry,
  stashAll,
  switchNew,
} from "./git.ts";
import { git, makeCheckout, type Checkout } from "./stub.fixture.ts";

let checkout: Checkout;

beforeEach(() => {
  checkout = makeCheckout();
});

afterEach(() => {
  checkout.cleanup();
});

const at = (...parts: ReadonlyArray<string>) => join(checkout.work, ...parts);

/** What the owner's checkout is, to see that nothing of it changed: the index file, the work tree's status. */
const fingerprint = () => ({
  index: createHash("sha256")
    .update(readFileSync(at(".git", "index")))
    .digest("hex"),
  status: git(checkout.work, "status", "--porcelain=v1", "--ignored", "-z"),
  head: git(checkout.work, "rev-parse", "HEAD"),
  branches: git(checkout.work, "branch", "--list"),
});

/** Uncommitted Changes of every kind: staged, unstaged, deleted, untracked, and ignored. */
const makeChanges = () => {
  writeFileSync(at("tracked.txt"), "one\ntwo\n");
  writeFileSync(at("staged.txt"), "staged\n");
  git(checkout.work, "add", "staged.txt");
  writeFileSync(at("untracked.txt"), "new\n");
  mkdirSync(at("src"));
  writeFileSync(at("src", "deep file.ts"), "export {};\n");
  writeFileSync(at(".env"), "SECRET=1\n");
  writeFileSync(at("local.env"), "SECRET=2\n");
  mkdirSync(at("build"));
  writeFileSync(at("build", "out.js"), "x\n");
  rmSync(at("README.md"));
};

describe("running git", () => {
  it("fails as GitMissing when git cannot be started", async () => {
    const missing = gitIn(join(checkout.directory, "gone"))(["status"]);

    await expect(missing).rejects.toBeInstanceOf(GitMissing);
    await expect(missing).rejects.toThrow(/it is not installed, or not on PATH/);
  });

  it("has git's own answer for a failed command", async () => {
    const result = await gitIn(checkout.work)(["rev-parse", "--verify", "nope"]);

    expect(result.code).not.toBe(0);
  });
});

describe("the checkout", () => {
  it("finds the repo's root and the origin as its config has it, not as insteadOf rewrites it", async () => {
    mkdirSync(at("sub"));

    const found = await checkoutOf(gitIn(at("sub")));

    expect(found?.root).toBe(git(checkout.work, "rev-parse", "--show-toplevel"));
    expect(found?.origin).toBe("https://github.com/acme/app.git");
  });

  it("is none outside a repo, and has no origin in a repo that has none", async () => {
    expect(await checkoutOf(gitIn(checkout.directory))).toBeUndefined();

    git(checkout.work, "remote", "remove", "origin");

    expect((await checkoutOf(gitIn(checkout.work)))?.origin).toBeUndefined();
  });

  it("reads the HEAD, the branch and its upstream's name on origin", async () => {
    git(checkout.work, "switch", "--quiet", "-c", "local-name");
    git(checkout.work, "push", "--quiet", "origin", "local-name:remote-name");
    git(checkout.work, "branch", "--set-upstream-to=origin/remote-name");

    const head = await headOf(gitIn(checkout.work));

    expect(head.branch).toBe("local-name");
    expect(head.upstream).toBe("remote-name");
    expect(head.commit).toBe(git(checkout.work, "rev-parse", "HEAD"));

    git(checkout.work, "switch", "--quiet", "--detach");

    expect(await headOf(gitIn(checkout.work))).toMatchObject({
      branch: undefined,
      upstream: undefined,
    });
  });

  it("finds the default branch from origin/HEAD, else from the remote", async () => {
    const head = await headOf(gitIn(checkout.work));

    expect(await defaultBranchOf(gitIn(checkout.work), head)).toBe("main");

    git(checkout.work, "remote", "set-head", "origin", "--delete");

    expect(await defaultBranchOf(gitIn(checkout.work), head)).toBe("main");
  });

  it("says why a branch name will not do", async () => {
    git(checkout.work, "branch", "taken");

    const run = gitIn(checkout.work);

    expect(await branchNameProblem(run, "fine/name")).toBeUndefined();
    expect(await branchNameProblem(run, "taken")).toMatch(/exists already/);
    expect(await branchNameProblem(run, "no spaces")).toMatch(/not a branch name/);
    expect(await branchNameProblem(run, "bad..name")).toMatch(/not a branch name/);
  });
});

describe("the carry", () => {
  it("is every uncommitted change, tracked and untracked, and never an ignored file", async () => {
    makeChanges();

    const run = gitIn(checkout.work);
    const head = git(checkout.work, "rev-parse", "HEAD");
    const carry = await readCarry(run, head);

    expect(carry?.files.toSorted()).toEqual([
      "README.md",
      "src/deep file.ts",
      "staged.txt",
      "tracked.txt",
      "untracked.txt",
    ]);

    const commit = await commitCarry(run, carry ?? { tree: "", files: [] }, head, "feature");

    // One commit on HEAD, by the owner, holding the Changes as they are on disk.
    expect(git(checkout.work, "rev-list", "--parents", "-n", "1", commit)).toBe(
      `${commit} ${head}`,
    );
    expect(git(checkout.work, "log", "-1", "--format=%an <%ae>|%s", commit)).toBe(
      "Owner <owner@example.test>|cloudpid: uncommitted changes carried to feature",
    );
    expect(git(checkout.work, "show", `${commit}:tracked.txt`)).toBe("one\ntwo");
    expect(git(checkout.work, "show", `${commit}:untracked.txt`)).toBe("new");
    expect(git(checkout.work, "show", `${commit}:src/deep file.ts`)).toBe("export {};");
    expect(git(checkout.work, "ls-tree", "-r", "--name-only", commit).split("\n")).not.toContain(
      "README.md",
    );
    // Ignored files stay where they are: no `.env`.
    expect(git(checkout.work, "ls-tree", "-r", "--name-only", commit)).not.toMatch(/\.env|build\//);
  });

  it("leaves the owner's index, work tree, status and branches as they were", async () => {
    makeChanges();

    const before = fingerprint();
    const run = gitIn(checkout.work);
    const head = before.head;
    const carry = await readCarry(run, head);

    await commitCarry(run, carry ?? { tree: "", files: [] }, head, "feature");

    expect(fingerprint()).toEqual(before);
    expect(readFileSync(at("tracked.txt"), "utf8")).toBe("one\ntwo\n");
    expect(readFileSync(at(".env"), "utf8")).toBe("SECRET=1\n");
    // The staged file is still staged and the rest is not.
    expect(git(checkout.work, "diff", "--cached", "--name-only")).toBe("staged.txt");
  });

  it("is none when there is nothing to carry (ignored files are not Changes)", async () => {
    writeFileSync(at(".env"), "SECRET=1\n");

    const head = git(checkout.work, "rev-parse", "HEAD");

    expect(await readCarry(gitIn(checkout.work), head)).toBeUndefined();
  });

  it("falls back to cloudpid's name and email when the owner has none", async () => {
    git(checkout.work, "config", "--unset", "user.name");
    git(checkout.work, "config", "--unset", "user.email");
    writeFileSync(at("untracked.txt"), "new\n");

    const run = gitIn(checkout.work);
    const head = git(checkout.work, "rev-parse", "HEAD");
    const carry = await readCarry(run, head);
    const commit = await commitCarry(run, carry ?? { tree: "", files: [] }, head, "feature");

    expect(git(checkout.work, "log", "-1", "--format=%an <%ae>", commit)).toBe(
      "cloudpid <cloudpid@users.noreply.github.com>",
    );
  });

  it("is force-pushed to its ref with hooks off, and deleted from it again", async () => {
    // A hook that fails every push: it must not run.
    mkdirSync(at(".git", "hooks"), { recursive: true });
    writeFileSync(at(".git", "hooks", "pre-push"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(at("untracked.txt"), "new\n");

    const run = gitIn(checkout.work);
    const head = git(checkout.work, "rev-parse", "HEAD");
    const carry = await readCarry(run, head);
    const first = await commitCarry(run, carry ?? { tree: "", files: [] }, head, "feature");
    const ref = "refs/cloudpid/import/abc";

    await pushCarry(run, first, ref);

    expect(git(checkout.remote, "rev-parse", ref)).toBe(first);

    // A second push of different Changes replaces it (force), not an error.
    writeFileSync(at("untracked.txt"), "newer\n");

    const second = await commitCarry(
      run,
      (await readCarry(run, head)) ?? { tree: "", files: [] },
      head,
      "feature",
    );

    await pushCarry(run, second, ref);

    expect(git(checkout.remote, "rev-parse", ref)).toBe(second);
    expect(await deleteRemoteRef(run, ref)).toBe(true);
    expect(git(checkout.remote, "for-each-ref", ref)).toBe("");
    expect(await deleteRemoteRef(run, ref)).toBe(false);
  });
});

describe("the branch push", () => {
  const commitFile = (name: string, message: string) => {
    writeFileSync(at(name), `${message}\n`);
    git(checkout.work, "add", name);
    git(checkout.work, "commit", "--quiet", "-m", message);
  };

  it("plans a new branch as the commits origin has no branch for", async () => {
    git(checkout.work, "switch", "--quiet", "-c", "feature");
    commitFile("a.txt", "add a");
    commitFile("b.txt", "add b");

    const run = gitIn(checkout.work);
    const plan = await planPush(run, git(checkout.work, "rev-parse", "HEAD"), "feature");

    expect(plan.remote).toBeUndefined();
    expect(plan.count).toBe(2);
    expect(plan.commits.map((line) => line.slice(8))).toEqual(["add b", "add a"]);
    expect(plan.behind).toBe(false);
  });

  it("plans a fast-forward as the commits past origin's, and nothing when origin has HEAD", async () => {
    git(checkout.work, "switch", "--quiet", "-c", "feature");
    commitFile("a.txt", "add a");
    git(checkout.work, "push", "--quiet", "origin", "feature");
    commitFile("b.txt", "add b");

    const run = gitIn(checkout.work);
    const head = git(checkout.work, "rev-parse", "HEAD");
    const plan = await planPush(run, head, "feature");

    expect(plan).toMatchObject({ count: 1, behind: false });
    expect(plan.remote).toBe(git(checkout.work, "rev-parse", "origin/feature"));

    await pushBranch(run, head, "feature");

    expect(git(checkout.remote, "rev-parse", "refs/heads/feature")).toBe(head);
    expect(await planPush(run, head, "feature")).toMatchObject({
      count: 0,
      behind: false,
      remote: head,
    });
  });

  it("refuses a remote that has commits this checkout lacks, ahead or diverged, and pushes nothing", async () => {
    git(checkout.work, "switch", "--quiet", "-c", "feature");
    commitFile("a.txt", "add a");
    git(checkout.work, "push", "--quiet", "origin", "feature");

    // Someone else pushes to the branch from another clone.
    const other = join(checkout.directory, "other");

    git(checkout.directory, "clone", "--quiet", checkout.remote, other);
    git(other, "config", "user.name", "Other");
    git(other, "config", "user.email", "other@example.test");
    git(other, "switch", "--quiet", "feature");
    writeFileSync(join(other, "theirs.txt"), "theirs\n");
    git(other, "add", "-A");
    git(other, "commit", "--quiet", "-m", "theirs");
    git(other, "push", "--quiet", "origin", "feature");

    const run = gitIn(checkout.work);
    const behind = git(checkout.work, "rev-parse", "HEAD");

    // Ahead of us (we have not fetched it): behind.
    expect(await planPush(run, behind, "feature")).toMatchObject({ behind: true });

    // Diverged: we have a commit they lack.
    commitFile("b.txt", "add b");

    const diverged = git(checkout.work, "rev-parse", "HEAD");

    expect(await planPush(run, diverged, "feature")).toMatchObject({ behind: true });
    await expect(pushBranch(run, diverged, "feature")).rejects.toThrow(/pull first/);
    expect(git(checkout.remote, "log", "-1", "--format=%s", "refs/heads/feature")).toBe("theirs");
  });

  it("switches to a new branch from HEAD, keeping the Changes where they are", async () => {
    writeFileSync(at("untracked.txt"), "new\n");
    writeFileSync(at("tracked.txt"), "changed\n");

    await switchNew(gitIn(checkout.work), "fresh");

    expect(git(checkout.work, "branch", "--show-current")).toBe("fresh");
    expect(readFileSync(at("tracked.txt"), "utf8")).toBe("changed\n");
    expect(readFileSync(at("untracked.txt"), "utf8")).toBe("new\n");
  });

  it("stashes the Changes with the untracked files in the message the owner is told", async () => {
    writeFileSync(at("untracked.txt"), "new\n");
    writeFileSync(at("tracked.txt"), "changed\n");

    await stashAll(gitIn(checkout.work), "cloudpid: imported as https://x.test/sessions/1");

    expect(git(checkout.work, "stash", "list")).toContain(
      "cloudpid: imported as https://x.test/sessions/1",
    );
    expect(git(checkout.work, "status", "--porcelain")).toBe("");
  });
});
