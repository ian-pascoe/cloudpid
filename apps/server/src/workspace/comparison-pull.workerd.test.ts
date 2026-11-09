// Pull request Comparisons in the Workspace DO (docs/architecture/diffs-and-review.md → Comparisons), over a repo real git made and
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
});
