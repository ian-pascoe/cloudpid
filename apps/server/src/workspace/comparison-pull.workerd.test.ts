// Pull request Comparisons in the Workspace DO (docs/spec.md → Diffs and review → Comparisons), over a repo real git made and
// the Container's command real git ran on it (`comparison.setup.ts`), written into a Workspace as computer's sync would, with
// GitHub's API and the clock stubbed in the test Worker: the 60 s the list is kept, the "New commits" banner when the
// pull request's head moves, closed and merged, and the refs of pull requests no longer open. The Container is a fake that
// is counted, and never started by a call that may not start it.
// @effect-diagnostics asyncFunction:off globalDate:off preferEffectArray:off preferEffectRecord:off
import { type Comparison } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, inject, it } from "vitest";
import type { RepoFiles } from "./changes.repos.ts";
import { graphqlList, type JsonObject } from "./github-pulls.fixtures.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

const repos = inject("comparisonRepos");

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

let made = 0;

/** A Workspace of its own, its (fake) Container stopped. */
const workspace = (): DurableObjectStub<TestWorkspace> =>
  env.WORKSPACES.getByName(`comparison-pull-${Date.now()}-${made++}`);

/** `app`'s config: its remote is GitHub's `acme/app`, which the real repo's (a local bare repo) is not. */
const CONFIG =
  '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/acme/app.git\n';

/** Write `files` into the Workspace as `/workspace/app`, with the remote on GitHub. */
const place = async (stub: DurableObjectStub<TestWorkspace>, files: RepoFiles) => {
  await stub.putFiles(
    Object.entries(files).map(([path, base64]) => [`/workspace/app/${path}`, bytesOf(base64)]),
  );
  await stub.putFiles([["/workspace/app/.git/config", new TextEncoder().encode(CONFIG)]]);
};

/** GitHub's JSON for pull request 7 at `head`. */
const pullJson = (head: string, overrides: JsonObject = {}): JsonObject => ({
  number: 7,
  title: "Add the thing",
  state: "open",
  merged: false,
  draft: false,
  additions: 12,
  deletions: 3,
  changed_files: 4,
  updated_at: "2026-01-01T00:00:00Z",
  user: { login: "dev" },
  head: { sha: head, ref: "feat", repo: { full_name: "acme/app" } },
  base: { ref: "main" },
  ...overrides,
});

const PULL = "/repos/acme/app/pulls/7";

/** The picker's list is one GraphQL request. */
const LIST = "/graphql";

const listOf = (...pulls: JsonObject[]): JsonObject => graphqlList(pulls);

const compare = (
  stub: DurableObjectStub<TestWorkspace>,
  options: { startContainer?: boolean; fetch?: boolean } = {},
) =>
  stub.compare({
    repo: "app",
    pull: 7,
    startContainer: options.startContainer ?? false,
    fetch: options.fetch ?? false,
  });

const okOf = async (result: ReturnType<typeof compare>): Promise<Comparison> => {
  const done = await result;

  if (done.status !== "ok") throw new Error(`not ok: ${JSON.stringify(done.error)}`);

  return done.comparison;
};

/** Pull request 7 made into a Comparison with the Container started once, then the Container stopped. */
const compared = async () => {
  const stub = workspace();

  await place(stub, repos.first.files);
  await stub.setGithub({
    [PULL]: pullJson(repos.pull.head),
    [LIST]: listOf(pullJson(repos.pull.head)),
  });
  await stub.fakeContainer({ running: false, outputs: [repos.pull.stdout] });

  const list = await okOf(compare(stub, { startContainer: true }));

  await stub.fakeContainer({ running: false });

  return { stub, list };
};

describe("a pull request in the Workspace DO", () => {
  it("is compared by the Container's git with the pull request's own base, and its files carry their head blobs", async () => {
    const { stub, list } = await compared();

    expect(list).toMatchObject({
      repo: "app",
      base: "main",
      branch: "feat",
      head: repos.pull.head,
      commits: 3,
      pull: { number: 7, title: "Add the thing", author: "dev", draft: false, state: "open" },
    });
    expect(list.files.map((file) => file.path)).toEqual([
      "DOCS.md",
      "bin.dat",
      "keep.txt",
      "new.txt",
    ]);
    expect(list.files.every((file) => /^[0-9a-f]{40}$/.test(file.blob ?? ""))).toBe(true);

    const [script] = (await stub.fakeContainerState()).scripts;

    expect(script).toContain("pull=7");
    expect(script).toContain("+refs/pull/$pull/head:$pullref");
    expect(script).toContain("base='main'");
  });

  it("is kept by (merge-base, head): reopening it after the Container stopped starts nothing, and its files are read from the synced objects", async () => {
    const { stub, list } = await compared();

    expect(await compare(stub)).toEqual({ status: "ok", comparison: list });
    expect((await stub.fakeContainerState()).scripts).toHaveLength(1);
    expect((await stub.fakeContainerState()).running).toBe(false);
    expect(await stub.storageKeys("cloudpid:comparison-pull")).toEqual(
      expect.arrayContaining([
        `cloudpid:comparison-pull:app:${list.mergeBase}:${list.head}`,
        "cloudpid:comparison-pull-last:app:7",
      ]),
    );

    expect(
      await stub.comparisonFile({
        repo: "app",
        mergeBase: list.mergeBase,
        head: list.head,
        path: "new.txt",
      }),
    ).toEqual({ old: null, new: { kind: "text", text: "fresh\n" } });
    expect((await stub.liveStubs()).container).toBe(0);
  });

  it("shows the banner (behind) when the pull request's head moves, however the Container is, until the owner asks", async () => {
    const { stub, list } = await compared();

    await stub.setGithub({ [PULL]: pullJson(repos.pullMoved.head) });

    expect(await compare(stub)).toMatchObject({
      status: "ok",
      comparison: { head: list.head, behind: repos.pullMoved.head },
    });
    expect((await stub.fakeContainerState()).scripts).toHaveLength(1);

    // Even with the Container running: a pull request is never followed by itself.
    await stub.fakeContainer({ running: true });
    expect(await compare(stub)).toMatchObject({
      status: "ok",
      comparison: { behind: repos.pullMoved.head },
    });
    expect((await stub.fakeContainerState()).scripts).toHaveLength(1);

    // The owner's Refresh fetches it again.
    await place(stub, repos.second.files);
    await stub.fakeContainer({ running: false, outputs: [repos.pullMoved.stdout] });

    const fresh = await okOf(compare(stub, { startContainer: true, fetch: true }));

    expect(fresh).toMatchObject({ head: repos.pullMoved.head, commits: 4 });
    expect(fresh.behind).toBeUndefined();
    expect((await stub.fakeContainerState()).scripts).toHaveLength(2);
  });

  it("marks the last result closed or merged, and says so when there is none", async () => {
    const { stub, list } = await compared();

    await stub.setGithub({ [PULL]: pullJson(repos.pull.head, { state: "closed" }) });
    expect(await okOf(compare(stub))).toEqual({ ...list, pull: { ...list.pull, state: "closed" } });

    await stub.setGithub({ [PULL]: pullJson(repos.pull.head, { state: "closed", merged: true }) });
    expect(await okOf(compare(stub))).toMatchObject({ pull: { state: "merged" } });

    const none = workspace();

    await place(none, repos.first.files);
    await none.setGithub({ [PULL]: pullJson(repos.pull.head, { state: "closed", merged: true }) });
    expect(await compare(none)).toMatchObject({ status: "error", error: { kind: "pull_merged" } });
    expect((await none.fakeContainerState()).scripts).toEqual([]);
  });

  it("does not take a 404 for a refusal, and starts nothing", async () => {
    const stub = workspace();

    await place(stub, repos.first.files);
    await stub.setGithub({}, 404);
    expect(await compare(stub, { startContainer: true })).toMatchObject({
      status: "error",
      error: { kind: "failed" },
    });
    expect((await stub.fakeContainerState()).running).toBe(false);
  });

  it.each([401, 403])(
    "says GitHub refused the token on a %s, and starts nothing",
    async (status) => {
      const stub = workspace();

      await place(stub, repos.first.files);
      await stub.setGithub({}, status);
      expect(await compare(stub, { startContainer: true })).toMatchObject({
        status: "error",
        error: { kind: "github_refused", message: "GitHub refused the token" },
      });
      expect((await stub.fakeContainerState()).running).toBe(false);
    },
  );
});

describe("the picker's pull requests in the Workspace DO", () => {
  const sourcesOf = async (stub: DurableObjectStub<TestWorkspace>) => {
    const { repos: listed } = await stub.comparisonSources("/workspace", true);

    return listed[0]?.pulls;
  };

  it("keeps the list for 60 s, then asks GitHub again, and never starts the Container", async () => {
    const stub = workspace();

    await place(stub, repos.first.files);
    await stub.setGithub({
      [LIST]: listOf(pullJson(repos.pull.head)),
      [PULL]: pullJson(repos.pull.head),
    });
    await stub.setClock(1_000_000);

    const first = await sourcesOf(stub);

    expect(first).toMatchObject({
      status: "ok",
      fetchedAt: 1_000_000,
      pulls: [
        {
          number: 7,
          title: "Add the thing",
          author: "dev",
          draft: false,
          additions: 12,
          deletions: 3,
          changedFiles: 4,
          head: repos.pull.head,
          // The checked-out branch is `feat`, and the pull request is from it.
          thisBranch: true,
        },
      ],
    });

    const asked = (await stub.githubRequests()).length;

    await stub.setClock(1_059_999);
    expect(await sourcesOf(stub)).toEqual(first);
    expect(await stub.githubRequests()).toHaveLength(asked);

    await stub.setClock(1_060_000);
    expect(await sourcesOf(stub)).toMatchObject({ fetchedAt: 1_060_000 });
    expect((await stub.githubRequests()).length).toBeGreaterThan(asked);

    expect((await stub.fakeContainerState()).running).toBe(false);
    expect((await stub.liveStubs()).container).toBe(0);
  });

  it("lists none unless asked, and says a remote that is not GitHub's has no pull requests", async () => {
    const stub = workspace();

    // The repo as real git made it: its remote is a local path.
    await stub.putFiles(
      Object.entries(repos.first.files).map(([path, base64]) => [
        `/workspace/app/${path}`,
        bytesOf(base64),
      ]),
    );

    const plain = await stub.comparisonSources("/workspace");

    expect(plain.repos[0]).not.toHaveProperty("pulls");
    expect((await stub.comparisonSources("/workspace", true)).repos[0]?.pulls).toEqual({
      status: "error",
      kind: "no_github",
      message: "Pull requests need a GitHub remote",
    });
  });

  it("deletes the ref of a pull request that is no longer open, when the Container runs, and starts nothing for it", async () => {
    const { stub } = await compared();

    await stub.setClock(2_000_000);
    await stub.setGithub({ [LIST]: listOf() });

    // Stopped: the ref waits, and nothing is started.
    expect(await sourcesOf(stub)).toMatchObject({ status: "ok", pulls: [] });
    expect((await stub.fakeContainerState()).scripts).toHaveLength(1);
    expect((await stub.fakeContainerState()).running).toBe(false);

    // Running at the next opening: `git update-ref -d` on that ref alone, and no gc.
    await stub.fakeContainer({ running: true });
    await stub.setClock(2_100_000);
    await sourcesOf(stub);

    const scripts = (await stub.fakeContainerState()).scripts;

    expect(scripts).toHaveLength(2);
    expect(scripts[1]).toContain("drop='7'");
    expect(scripts[1]).toContain('git update-ref -d "refs/cloudpid/pr/$n"');
    expect(scripts[1]).not.toMatch(/\bgc\b/u);
    expect(scripts[1]).not.toContain("fetch");

    // Done once: the next opening finds nothing to delete.
    await stub.setClock(2_200_000);
    await sourcesOf(stub);
    expect((await stub.fakeContainerState()).scripts).toHaveLength(2);
  });
});
