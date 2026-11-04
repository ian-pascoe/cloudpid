// @effect-diagnostics preferEffectArray:off preferEffectRecord:off asyncFunction:off nodeBuiltinImport:off -- native array methods over plain values (the bundle carries no Effect runtime); native object methods over plain values; plain Promises, as pi's extension API and child processes give them; runs on node, on the owner's machine.
/**
 * `/cloudpid` against a stub endpoint (docs/architecture/mcp-endpoint.md → Session import → The working tree, The
 * `/cloudpid` command): cloudpid's own MCP handler over a fake `api`, a checkout with a bare remote, and pi's own
 * SessionManager. An import lands on its branch with its Carried Changes; the pushes, the slices and finish are checked
 * from both sides.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Predicate from "effect/Predicate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.ts";
import { ENDPOINT_OLDER, TOKEN_REJECTED } from "./endpoint.ts";
import { Refusal } from "./errors.ts";
import { type Deps, type Host, type ImportRecord, importSession, type Outcome } from "./flow.ts";
import { type Git, GitMissing, gitIn } from "./git.ts";
import { snapshotOf } from "./session.ts";
import { sha256Hex, fileBytes } from "./slices.ts";
import {
  type Checkout,
  ENDPOINT_URL,
  git,
  makeCheckout,
  makeSession,
  ORIGIN,
  receivedText,
  scriptedUi,
  type ScriptedUi,
  type Stub,
  stubEndpoint,
  type StubOptions,
} from "./stub.fixture.ts";

const ENV = {
  CLOUDPID_URL: ENDPOINT_URL,
  CLOUDPID_ACCESS_CLIENT_ID: "abc.access",
  CLOUDPID_ACCESS_CLIENT_SECRET: "s3cret",
};

let checkout: Checkout;
let cleanups: Array<() => void> = [];

beforeEach(() => {
  checkout = makeCheckout();
  cleanups = [checkout.cleanup];
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
});

const at = (...parts: ReadonlyArray<string>) => join(checkout.work, ...parts);

const commitFile = (name: string, message: string) => {
  writeFileSync(at(name), `${message}\n`);
  git(checkout.work, "add", name);
  git(checkout.work, "commit", "--quiet", "-m", message);
};

/** What a test sets up: the Session's other entries, the owner's answers, and what the host says. */
interface Setup {
  readonly stub?: StubOptions;
  readonly ui?: Parameters<typeof scriptedUi>[0];
  readonly instruction?: string;
  readonly idle?: boolean;
  readonly saved?: boolean;
  readonly env?: { readonly [name: string]: string | undefined };
  readonly marker?: boolean;
  /** Wraps the real git of each directory. */
  readonly git?: (real: Git) => Git;
  /** Pi's `appendEntry` throws. */
  readonly appendThrows?: boolean;
}

/** One `/cloudpid` run. */
const run = async (setup: Setup = {}) => {
  const stub: Stub = stubEndpoint(setup.stub);
  const session = makeSession();

  cleanups.push(session.cleanup);

  if (setup.marker === true) {
    session.manager.appendCustomEntry("cloudpid-import", {
      session: "earlier",
      url: "https://cloudpid.test/sessions/earlier",
      branch: "old",
      environment: "Default",
    });
  }

  const ui: ScriptedUi = scriptedUi(setup.ui ?? { confirm: [true, false] });
  const entries: Array<{ readonly type: string; readonly data: ImportRecord }> = [];

  const host: Host = {
    cwd: checkout.work,
    hasUI: true,
    isIdle: () => setup.idle ?? true,
    session: () => snapshotOf(session.manager),
    model: "anthropic/claude-sonnet",
    thinking: "high",
    ui,
    appendEntry: (type, data) => {
      if (setup.appendThrows === true) throw new Error("the session file is read-only");

      entries.push({ type, data });
    },
  };

  const wrap = setup.git;

  const deps: Deps = {
    env: setup.env ?? ENV,
    git: wrap === undefined ? gitIn : (cwd) => wrap(gitIn(cwd)),
    endpoint: (config: Config) => stub.endpoint(config),
    exists: (file) => (setup.saved ?? true) && existsSync(file),
  };

  const snapshot = snapshotOf(session.manager);

  let outcome: Outcome | undefined;
  let failure: Error | undefined;

  try {
    outcome = await importSession(host, setup.instruction ?? "", deps);
  } catch (error) {
    failure = error instanceof Error ? error : new Error("not an error");
  }

  return { stub, ui, entries, outcome, failure, text: snapshot.text };
};

const remoteRef = (ref: string) =>
  git(checkout.remote, "for-each-ref", "--format=%(objectname)", ref);

/** The remote refuses every push of a branch. */
const refuseBranchPushes = () => {
  mkdirSync(join(checkout.remote, "hooks"), { recursive: true });
  writeFileSync(
    join(checkout.remote, "hooks", "pre-receive"),
    '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/heads/*) echo "no pushes" >&2; exit 1;; esac; done\n',
    { mode: 0o755 },
  );
};

const worktreeFingerprint = () => ({
  status: git(checkout.work, "status", "--porcelain=v1", "--ignored"),
  head: git(checkout.work, "rev-parse", "HEAD"),
});

describe("an import from a checkout on its own branch", () => {
  beforeEach(() => {
    git(checkout.work, "switch", "--quiet", "-c", "feature");
    commitFile("a.txt", "add a");
    // Uncommitted: a tracked edit, a new file, an ignored one.
    writeFileSync(at("tracked.txt"), "one\ntwo\n");
    writeFileSync(at("new file.txt"), "new\n");
    writeFileSync(at(".env"), "SECRET=1\n");
  });

  it("lands on its branch with its Carried Changes, and its slices and finish arrive", async () => {
    const before = worktreeFingerprint();

    const result = await run({
      stub: { maxSliceBytes: 256 },
      ui: { confirm: [true, true] },
      instruction: "run the tests",
    });

    expect(result.failure).toBeUndefined();
    expect(result.outcome).toMatchObject({ kind: "imported", branch: "feature", stashed: true });

    // begin: what the endpoint was asked.
    const [held, ...others] = result.stub.imports;

    expect(others).toEqual([]);
    expect(held?.request).toMatchObject({
      environment: "env-1",
      format: "pi-session-jsonl",
      size_bytes: fileBytes(result.text).length,
      title: "Flaky test",
      branch: "feature",
      model: "anthropic/claude-sonnet",
      thinking: "high",
      text: "run the tests",
    });
    expect(held?.request.via.client).toMatchObject({ name: "pi-cloudpid" });

    // The branch: pushed as it is, a fast-forward, and nothing but the commits.
    expect(remoteRef("refs/heads/feature")).toBe(git(checkout.work, "rev-parse", "HEAD"));

    // The Carried Changes: one commit on HEAD at the import's own ref, with the files as they were, and no `.env`.
    const carryRef = `refs/cloudpid/import/${held?.id ?? ""}`;
    const carried = remoteRef(carryRef);

    expect(carried).not.toBe("");
    expect(git(checkout.remote, "rev-list", "--parents", "-n", "1", carried)).toBe(
      `${carried} ${before.head}`,
    );
    expect(git(checkout.remote, "show", `${carried}:tracked.txt`)).toBe("one\ntwo");
    expect(git(checkout.remote, "show", `${carried}:new file.txt`)).toBe("new");
    expect(git(checkout.remote, "ls-tree", "-r", "--name-only", carried)).not.toContain(".env");

    // The slices: several, each where the last ended, and together the file; finish named its checksum.
    expect(held?.appends.length).toBeGreaterThan(3);
    expect(held?.appends.every(([, bytes]) => bytes <= 256)).toBe(true);
    expect(held?.appends.map(([offset]) => offset)).toEqual(
      (held?.appends ?? []).map((_slice, index) =>
        (held?.appends ?? []).slice(0, index).reduce((sum, [, bytes]) => sum + bytes, 0),
      ),
    );
    expect(receivedText(held ?? failure())).toBe(result.text);
    expect(held?.finished?.sha256).toBe(sha256Hex(fileBytes(result.text)));
    expect(held?.cancelled).toBe(false);

    // The token went as Access reads it, and the client as the endpoint shows it.
    for (const headers of result.stub.headers) {
      expect(headers.get("cf-access-client-id")).toBe("abc.access");
      expect(headers.get("cf-access-client-secret")).toBe("s3cret");
      expect(headers.get("x-cloudpid-client")).toMatch(/^pi-cloudpid\/\S+$/);
    }

    // What the owner was asked, before anything was sent.
    const [confirm] = result.ui.asked;

    expect(confirm?.kind).toBe("confirm");
    expect(confirm?.message).toContain("Environment: Default");
    expect(confirm?.message).toContain("Branch: feature");
    expect(confirm?.message).toContain("new on origin");
    expect(confirm?.message).toContain("1 commit: ");
    expect(confirm?.message).toContain("add a");
    expect(confirm?.message).toContain("2 files: ");
    expect(confirm?.message).toContain("new file.txt");
    expect(confirm?.message).toContain("tracked.txt");
    expect(confirm?.message).toContain("Model: anthropic/claude-sonnet, thinking high");
    expect(confirm?.message).toContain("Instruction: run the tests");

    // The stash, as offered; then the marker and the coming-back line.
    expect(git(checkout.work, "stash", "list")).toContain(
      `cloudpid: imported as https://cloudpid.test/sessions/${held?.id ?? ""}`,
    );
    expect(git(checkout.work, "status", "--porcelain")).toBe("");
    expect(existsSync(at(".env"))).toBe(true);
    expect(result.entries).toEqual([
      {
        type: "cloudpid-import",
        data: {
          session: held?.id,
          url: `https://cloudpid.test/sessions/${held?.id ?? ""}`,
          branch: "feature",
          environment: "Default",
        },
      },
    ]);

    const notice = result.ui.notices.at(-1);

    expect(notice?.type).toBe("info");
    expect(notice?.message).toContain(
      `cloudpid: imported: https://cloudpid.test/sessions/${held?.id ?? ""}`,
    );
    expect(notice?.message).toContain("custom:other 2");
    expect(notice?.message).toContain(
      "git switch feature && git pull --ff-only, then git stash drop",
    );
  });

  it("leaves the owner's index and work tree as they were when the stash is declined", async () => {
    git(checkout.work, "add", "tracked.txt");

    const before = worktreeFingerprint();
    const staged = git(checkout.work, "diff", "--cached", "--name-only");
    const result = await run({ ui: { confirm: [true, false] } });

    expect(result.outcome).toMatchObject({ kind: "imported", stashed: false });
    expect(worktreeFingerprint()).toEqual(before);
    expect(git(checkout.work, "diff", "--cached", "--name-only")).toBe(staged);
    expect(git(checkout.work, "stash", "list")).toBe("");
    expect(readFileSync(at("tracked.txt"), "utf8")).toBe("one\ntwo\n");
    expect(result.ui.notices.at(-1)?.message).toContain(
      "To come back: git switch feature && git pull --ff-only",
    );
    expect(result.ui.notices.at(-1)?.message).not.toContain("stash drop");
    // The upstream is set, so `git pull --ff-only` works on the branch it made.
    expect(git(checkout.work, "rev-parse", "--abbrev-ref", "feature@{upstream}")).toBe(
      "origin/feature",
    );
  });

  it("pushes as the upstream's name on origin when the local branch tracks another", async () => {
    git(checkout.work, "push", "--quiet", "origin", "feature:shared");
    git(checkout.work, "branch", "--set-upstream-to=origin/shared");
    commitFile("b.txt", "add b");

    const result = await run({ ui: { confirm: [true, false] } });

    expect(result.stub.imports[0]?.request.branch).toBe("shared");
    expect(remoteRef("refs/heads/shared")).toBe(git(checkout.work, "rev-parse", "HEAD"));
    expect(remoteRef("refs/heads/feature")).toBe("");
    expect(result.ui.notices.at(-1)?.message).toContain("git switch feature && git pull --ff-only");
  });

  it("pulls the branch it pushed when the local branch tracked origin's main", async () => {
    git(checkout.work, "branch", "--set-upstream-to=origin/main");
    commitFile("b.txt", "add b");

    const main = remoteRef("refs/heads/main");
    const result = await run({ ui: { confirm: [true, false] } });

    expect(result.stub.imports[0]?.request.branch).toBe("feature");
    expect(remoteRef("refs/heads/feature")).toBe(git(checkout.work, "rev-parse", "HEAD"));
    expect(remoteRef("refs/heads/main")).toBe(main);
    // The plain `git pull --ff-only` the owner is told to run pulls what was pushed, not main.
    expect(git(checkout.work, "rev-parse", "--abbrev-ref", "feature@{upstream}")).toBe(
      "origin/feature",
    );
    expect(result.ui.notices.at(-1)?.message).toContain("git switch feature && git pull --ff-only");
  });

  it("names the branch in the pull when it could not set the upstream", async () => {
    git(checkout.work, "branch", "--set-upstream-to=origin/main");

    const result = await run({
      ui: { confirm: [true, false] },
      git: (real) => (args, options) =>
        args[0] === "branch" && args.some((arg) => arg.startsWith("--set-upstream-to"))
          ? Promise.resolve({ code: 1, stdout: "", stderr: "no" })
          : real(args, options),
    });

    expect(result.outcome?.kind).toBe("imported");
    expect(git(checkout.work, "rev-parse", "--abbrev-ref", "feature@{upstream}")).toBe(
      "origin/main",
    );
    expect(result.ui.notices.at(-1)?.message).toContain(
      "git switch feature && git pull --ff-only origin feature",
    );
  });

  it("sends changes_carried only to an endpoint that declares it", async () => {
    const declared = await run({
      stub: { declaresChangesCarried: true },
      ui: { confirm: [true, false] },
    });

    expect(declared.stub.finishArguments).toHaveLength(1);
    expect(declared.stub.finishArguments[0]).toMatchObject({ changes_carried: true });

    const older = await run({ ui: { confirm: [true, false] } });

    expect(older.outcome?.kind).toBe("imported");
    expect(older.stub.finishArguments).toHaveLength(1);
    expect(Object.keys(older.stub.finishArguments[0] ?? {})).toEqual(["import_id", "sha256"]);
  });

  it("says changes_carried is false when there was nothing to carry", async () => {
    git(checkout.work, "stash", "push", "--include-untracked", "--quiet");

    const result = await run({ stub: { declaresChangesCarried: true } });

    expect(result.outcome?.kind).toBe("imported");
    expect(result.stub.finishArguments[0]).toMatchObject({ changes_carried: false });
  });

  it("keeps a finished import when what comes after it fails", async () => {
    const result = await run({ appendThrows: true, ui: { confirm: [true, true] } });
    const [held] = result.stub.imports;

    expect(result.failure).toBeUndefined();
    expect(result.outcome).toMatchObject({ kind: "imported", stashed: true });
    // Nothing was cancelled, and the carry ref the Workspace clones from is still there.
    expect(held?.finished).toBeDefined();
    expect(held?.cancelled).toBe(false);
    expect(remoteRef(`refs/cloudpid/import/${held?.id ?? ""}`)).not.toBe("");
    // The owner is told, and still given the URL.
    expect(result.ui.notices.map((notice) => notice.message)).toContainEqual(
      expect.stringContaining("could not record the import in this pi session"),
    );
    expect(result.ui.notices.at(-1)?.message).toContain("cloudpid: imported: https://");
  });

  it("is a fast-forward push when origin has the branch already", async () => {
    git(checkout.work, "push", "--quiet", "origin", "feature");
    commitFile("b.txt", "add b");

    const result = await run({ ui: { confirm: [true, false] } });

    expect(result.outcome?.kind).toBe("imported");
    expect(result.ui.asked[0]?.message).toContain("fast-forward push");
    expect(result.ui.asked[0]?.message).toContain("1 commit: ");
    expect(remoteRef("refs/heads/feature")).toBe(git(checkout.work, "rev-parse", "HEAD"));
  });

  it("refuses a diverged remote with 'pull first', before it begins or pushes anything", async () => {
    git(checkout.work, "push", "--quiet", "origin", "feature");

    const other = join(checkout.directory, "other");

    git(checkout.directory, "clone", "--quiet", checkout.remote, other);
    git(other, "config", "user.name", "Other");
    git(other, "config", "user.email", "other@example.test");
    git(other, "switch", "--quiet", "feature");
    writeFileSync(join(other, "theirs.txt"), "theirs\n");
    git(other, "add", "-A");
    git(other, "commit", "--quiet", "-m", "theirs");
    git(other, "push", "--quiet", "origin", "feature");
    commitFile("b.txt", "add b");

    const theirs = remoteRef("refs/heads/feature");
    const result = await run();

    expect(result.failure).toBeInstanceOf(Refusal);
    expect(result.failure?.message).toMatch(/pull first/);
    expect(result.stub.imports).toEqual([]);
    expect(remoteRef("refs/heads/feature")).toBe(theirs);
  });

  it("deletes a stale carry ref when there is nothing to carry", async () => {
    git(checkout.work, "stash", "push", "--include-untracked", "--quiet");
    git(checkout.work, "push", "--quiet", "origin", "HEAD:refs/cloudpid/import/stale");

    const result = await run({ stub: { carryRef: "refs/cloudpid/import/stale" } });

    expect(result.outcome?.kind).toBe("imported");
    expect(result.ui.asked[0]?.message).toContain("Carried changes: none");
    // Nothing to stash, so nothing was offered.
    expect(result.ui.asked).toHaveLength(1);
    expect(remoteRef("refs/cloudpid/import/stale")).toBe("");
  });

  it("resumes from where the endpoint says it is after an offset_mismatch", async () => {
    const result = await run({ stub: { maxSliceBytes: 200, mismatchAt: 3 } });
    const [held] = result.stub.imports;

    expect(result.outcome?.kind).toBe("imported");
    expect(receivedText(held ?? failure())).toBe(result.text);
    expect(held?.finished).toBeDefined();
  });

  it("says it is still importing when finish does not wait out the translation", async () => {
    const result = await run({
      stub: { status: "importing" },
      instruction: "go",
      ui: { confirm: [true, false] },
    });

    expect(result.outcome?.kind).toBe("importing");
    expect(result.ui.notices.at(-1)?.message).toContain(
      "still importing; it will start on your instruction when done: https://cloudpid.test/sessions/",
    );
    // It leaves the import to finish: no cancel.
    expect(result.stub.imports[0]?.cancelled).toBe(false);
  });

  it("goes on the Environment the owner picks when several have the Repo", async () => {
    const result = await run({
      stub: {
        environments: [
          { id: "env-1", name: "Default", urls: [ORIGIN] },
          { id: "env-2", name: "Docs", urls: ["git@github.com:Acme/App.git"] },
          { id: "env-3", name: "Other", urls: ["https://github.com/acme/other"] },
        ],
      },
      ui: {
        confirm: [true, false],
        select: [(options) => options.find((option) => option.startsWith("Docs")) ?? ""],
      },
    });

    expect(result.ui.asked[0]).toMatchObject({ kind: "select" });
    expect(result.ui.asked[0]?.message).toBe("Default (env-1)\nDocs (env-2)");
    expect(result.stub.imports[0]?.request.environment).toBe("env-2");
  });

  it("asks nothing of the endpoint, and pushes nothing, when the owner declines", async () => {
    const result = await run({ ui: { confirm: [false] } });

    expect(result.outcome).toEqual({ kind: "cancelled" });
    expect(result.stub.imports).toEqual([]);
    expect(remoteRef("refs/heads/feature")).toBe("");
  });

  it("asks before importing again over a marker, and goes on when the owner agrees", async () => {
    const declined = await run({ marker: true, ui: { confirm: [false] } });

    expect(declined.outcome).toEqual({ kind: "cancelled" });
    expect(declined.ui.asked[0]?.message).toBe(
      "already imported as https://cloudpid.test/sessions/earlier; import again as a new Session?",
    );
    expect(declined.stub.imports).toEqual([]);

    const again = await run({ marker: true, ui: { confirm: [true, true, false] } });

    expect(again.outcome?.kind).toBe("imported");
    expect(again.stub.imports).toHaveLength(1);
  });
});

describe("an import from the default branch or a detached HEAD", () => {
  beforeEach(() => {
    writeFileSync(at("new file.txt"), "new\n");
  });

  it("prompts for a name prefilled with a slug of the title, and runs git switch -c", async () => {
    const result = await run({ ui: { confirm: [true, false], editor: ["flaky-test-fix"] } });

    expect(result.outcome).toMatchObject({ kind: "imported", branch: "flaky-test-fix" });
    expect(result.ui.asked[0]).toMatchObject({ kind: "editor", message: "flaky-test" });
    expect(result.ui.asked[0]?.title).toContain("the default branch");
    expect(result.ui.asked[1]?.message).toContain("made here with git switch -c");
    expect(git(checkout.work, "branch", "--show-current")).toBe("flaky-test-fix");
    expect(remoteRef("refs/heads/flaky-test-fix")).toBe(git(checkout.work, "rev-parse", "HEAD"));
    expect(remoteRef("refs/heads/main")).toBe(git(checkout.work, "rev-parse", "HEAD"));
    // The Changes are still where they were.
    expect(readFileSync(at("new file.txt"), "utf8")).toBe("new\n");
    expect(result.stub.imports[0]?.request.branch).toBe("flaky-test-fix");
    expect(result.ui.notices.at(-1)?.message).toContain(
      "git switch flaky-test-fix && git pull --ff-only",
    );
  });

  it("says which branch the owner is on when the import fails after git switch -c", async () => {
    refuseBranchPushes();

    const result = await run({ ui: { confirm: [true, false], editor: ["flaky-test-fix"] } });

    expect(result.failure?.message).toMatch(/git push failed/);
    expect(result.stub.imports[0]?.cancelled).toBe(true);
    expect(git(checkout.work, "branch", "--show-current")).toBe("flaky-test-fix");
    expect(result.ui.notices.map((notice) => notice.message)).toContainEqual(
      expect.stringContaining("you are now on flaky-test-fix (was main); `git switch main`"),
    );
  });

  it("asks again for a name git refuses, or one that is the default branch, and gives up when the owner does", async () => {
    git(checkout.work, "branch", "exists");

    const result = await run({
      ui: { confirm: [true, false], editor: ["main", "exists", "bad name", "good"] },
    });

    expect(result.outcome).toMatchObject({ kind: "imported", branch: "good" });
    expect(result.ui.notices.map((notice) => notice.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("main is the default branch"),
        expect.stringContaining("exists already"),
        expect.stringContaining("not a branch name"),
      ]),
    );

    const gaveUp = await run({ ui: { editor: [undefined] } });

    expect(gaveUp.outcome).toEqual({ kind: "cancelled" });
    expect(gaveUp.stub.imports).toEqual([]);
  });

  it("does the same on a detached HEAD", async () => {
    git(checkout.work, "switch", "--quiet", "--detach");

    const result = await run({ ui: { confirm: [true, false], editor: ["from-detached"] } });

    expect(result.ui.asked[0]?.title).toContain("HEAD is detached");
    expect(result.outcome).toMatchObject({ kind: "imported", branch: "from-detached" });
    expect(git(checkout.work, "branch", "--show-current")).toBe("from-detached");
  });
});

describe("branch_taken", () => {
  beforeEach(() => {
    git(checkout.work, "switch", "--quiet", "-c", "feature");
    commitFile("a.txt", "add a");
  });

  it("offers removing the Workspace then retrying, a new name, or cancel, with the warning", async () => {
    const taken = ["feature"];

    const result = await run({
      stub: { taken },
      ui: {
        confirm: [true, false],
        select: [
          (options) => {
            // The owner removes the Workspace in the UI, then retries.
            taken.length = 0;

            return options[0] ?? "";
          },
        ],
      },
    });

    const select = result.ui.asked.find((asked) => asked.kind === "select");

    expect(select?.title).toContain("Earlier work (idle) https://cloudpid.test/sessions/s-1");
    expect(select?.title).toContain("deletes its Sessions");
    expect(select?.message.split("\n")).toHaveLength(3);
    expect(result.outcome).toMatchObject({ kind: "imported", branch: "feature" });
  });

  it("takes a new branch name and makes it here", async () => {
    const result = await run({
      stub: { taken: ["feature"] },
      ui: {
        confirm: [true, false],
        select: [(options) => options[1] ?? ""],
        editor: ["feature-2"],
      },
    });

    expect(result.outcome).toMatchObject({ kind: "imported", branch: "feature-2" });
    expect(result.ui.asked.find((asked) => asked.kind === "editor")?.message).toBe("feature-2");
    expect(result.stub.imports).toHaveLength(1);
    expect(result.stub.imports[0]?.request.branch).toBe("feature-2");
    expect(git(checkout.work, "branch", "--show-current")).toBe("feature-2");
    expect(remoteRef("refs/heads/feature-2")).toBe(git(checkout.work, "rev-parse", "HEAD"));
    expect(remoteRef("refs/heads/feature")).toBe("");
  });

  it("cancels without pushing anything", async () => {
    const result = await run({
      stub: { taken: ["feature"] },
      ui: { confirm: [true], select: [(options) => options[2] ?? ""] },
    });

    expect(result.outcome).toEqual({ kind: "cancelled" });
    expect(result.stub.imports).toEqual([]);
    expect(remoteRef("refs/heads/feature")).toBe("");
  });
});

describe("a failed import", () => {
  beforeEach(() => {
    git(checkout.work, "switch", "--quiet", "-c", "feature");
    commitFile("a.txt", "add a");
    writeFileSync(at("new file.txt"), "new\n");
  });

  it("cancels the import and takes the carry ref off when the push fails", async () => {
    refuseBranchPushes();

    const result = await run();
    const [held] = result.stub.imports;

    expect(result.failure?.message).toMatch(/git push failed/);
    expect(held?.cancelled).toBe(true);
    expect(held?.appends).toEqual([]);
    expect(remoteRef("refs/heads/feature")).toBe("");
    expect(remoteRef(`refs/cloudpid/import/${held?.id ?? ""}`)).toBe("");
    // Nothing was stashed or marked.
    expect(git(checkout.work, "stash", "list")).toBe("");
    expect(result.entries).toEqual([]);
  });

  it("cancels the import when finish refuses the file", async () => {
    // A stub whose bytes differ from what was sent: the checksum is refused.
    const stub = stubEndpoint();
    const original = stub.fetch;
    let corrupted = false;

    const corrupting = (url: string | URL, init?: RequestInit) => {
      const body = Predicate.isString(init?.body) ? init.body : "";

      if (!corrupted && body.includes("session_import_append")) {
        corrupted = true;

        return original(url, {
          ...init,
          body: body.replace("Fix the flaky test", "Fix the flaky TEST"),
        });
      }

      return original(url, init);
    };

    const session = makeSession();

    cleanups.push(session.cleanup);

    const ui = scriptedUi({ confirm: [true, false] });

    const deps: Deps = {
      env: ENV,
      git: gitIn,
      endpoint: async (config) =>
        (await import("./endpoint.ts")).connectEndpoint(config, {
          fetch: corrupting,
          sleep: () => Promise.resolve(),
        }),
      exists: existsSync,
    };

    const host: Host = {
      cwd: checkout.work,
      hasUI: true,
      isIdle: () => true,
      session: () => snapshotOf(session.manager),
      model: undefined,
      thinking: undefined,
      ui,
      appendEntry: () => undefined,
    };

    await expect(importSession(host, "", deps)).rejects.toThrow(/sha256/);
    expect(stub.imports).toHaveLength(1);
    expect(stub.imports[0]?.cancelled).toBe(true);
    expect(stub.imports[0]?.finished).toBeUndefined();
    expect(remoteRef(`refs/cloudpid/import/${stub.imports[0]?.id ?? ""}`)).toBe("");
  });
});

describe("refusals", () => {
  beforeEach(() => {
    git(checkout.work, "switch", "--quiet", "-c", "feature");
  });

  it("refuses unless pi is idle, the Session is saved and the owner can answer", async () => {
    const busy = await run({ idle: false });

    expect(busy.failure).toBeInstanceOf(Refusal);
    expect(busy.failure?.message).toMatch(/still working/);

    const unsaved = await run({ saved: false });

    expect(unsaved.failure?.message).toMatch(/not saved yet/);
    expect(unsaved.stub.imports).toEqual([]);
  });

  it("refuses with setup steps when the service token or the URL is not set", async () => {
    const result = await run({ env: { CLOUDPID_URL: ENDPOINT_URL } });

    expect(result.failure).toBeInstanceOf(Refusal);
    expect(result.failure?.message).toContain(
      "CLOUDPID_ACCESS_CLIENT_ID, CLOUDPID_ACCESS_CLIENT_SECRET not set",
    );
    expect(result.failure?.message).toContain("local-agent-token");
    expect(result.stub.headers).toEqual([]);
  });

  it.each([401, 403, 302])(
    "says the service token was rejected or expired for a %i",
    async (httpStatus) => {
      const result = await run({ stub: { httpStatus } });

      expect(result.failure).toBeInstanceOf(Refusal);
      expect(result.failure?.message).toBe(TOKEN_REJECTED);
      expect(result.failure?.message).toMatch(
        /^service token rejected or expired: run `local-agent-token`/,
      );
    },
  );

  it("refuses an endpoint that lacks the import tools", async () => {
    const result = await run({ stub: { operations: ["environments"] } });

    expect(result.failure).toBeInstanceOf(Refusal);
    expect(result.failure?.message).toContain(ENDPOINT_OLDER);
    expect(result.failure?.message).toContain("session_import_begin");
    expect(result.stub.imports).toEqual([]);
  });

  it("refuses when no Environment has the Repo", async () => {
    const result = await run({
      stub: {
        environments: [{ id: "e", name: "Elsewhere", urls: ["https://github.com/acme/other"] }],
      },
    });

    expect(result.failure?.message).toContain("add this Repo to an Environment first");
    expect(result.failure?.message).toContain("https://github.com/acme/app");
  });

  it("refuses a checkout with no origin, and a directory that is no checkout", async () => {
    git(checkout.work, "remote", "remove", "origin");

    const noOrigin = await run();

    expect(noOrigin.failure?.message).toMatch(/no `origin`/);
    expect(noOrigin.failure?.message).toContain("add this Repo to an Environment first");

    const outside = join(checkout.directory, "outside");

    mkdirSync(outside);

    const stub = stubEndpoint();
    const session = makeSession();

    cleanups.push(session.cleanup);

    await expect(
      importSession(
        {
          cwd: outside,
          hasUI: true,
          isIdle: () => true,
          session: () => snapshotOf(session.manager),
          model: undefined,
          thinking: undefined,
          ui: scriptedUi({}),
          appendEntry: () => undefined,
        },
        "",
        { env: ENV, git: gitIn, endpoint: stub.endpoint, exists: existsSync },
      ),
    ).rejects.toThrow(/not in a git repository: .*add this Repo to an Environment first/);
  });

  it("refuses, as for a Repo with no Environment, when git cannot be run", async () => {
    const result = await run({
      git: () => () =>
        Promise.reject(
          new GitMissing("could not run git in /x: it is not installed, or not on PATH"),
        ),
    });

    expect(result.failure).toBeInstanceOf(Refusal);
    expect(result.failure?.message).toContain("it is not installed, or not on PATH");
    expect(result.failure?.message).toContain("add this Repo to an Environment first");
    expect(result.stub.headers).toEqual([]);
  });

  it("matches the Environment on the URL git resolves when the configured one matches none", async () => {
    // `url.<base>.insteadOf` in the owner's config: `origin` is written one way and cloned another.
    const mirror = "https://mirror.example/acme/app.git";

    git(checkout.work, "config", "remote.origin.url", mirror);
    git(checkout.work, "config", `url.${checkout.remote}.insteadOf`, mirror);

    const unresolved = await run();

    expect(unresolved.failure?.message).toContain("add this Repo to an Environment first");
    expect(unresolved.failure?.message).toContain("https://mirror.example/acme/app");

    const resolved = await run({
      ui: { confirm: [true, false] },
      git: (real) => (args, options) =>
        args.join(" ") === "remote get-url origin"
          ? Promise.resolve({ code: 0, stdout: `${ORIGIN}\n`, stderr: "" })
          : real(args, options),
    });

    expect(resolved.failure).toBeUndefined();
    expect(resolved.outcome?.kind).toBe("imported");
  });

  it("refuses a repo with no commit", async () => {
    const fresh = join(checkout.directory, "fresh");

    mkdirSync(fresh);
    git(fresh, "init", "--quiet", "--initial-branch=main");
    git(fresh, "config", "remote.origin.url", ORIGIN);

    const stub = stubEndpoint();
    const session = makeSession();

    cleanups.push(session.cleanup);

    await expect(
      importSession(
        {
          cwd: fresh,
          hasUI: true,
          isIdle: () => true,
          session: () => snapshotOf(session.manager),
          model: undefined,
          thinking: undefined,
          ui: scriptedUi({}),
          appendEntry: () => undefined,
        },
        "",
        { env: ENV, git: gitIn, endpoint: stub.endpoint, exists: existsSync },
      ),
    ).rejects.toThrow(/no commit yet/);
  });
});

const failure = (): never => {
  throw new Error("the stub held no import");
};
