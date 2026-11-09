// This branch in the Workspace DO (docs/architecture/diffs-and-review.md → Comparisons), over a repo real git made and the
// Container's command real git ran on it (`comparison.setup.ts`), written into a Workspace as computer's sync would.
// The test Worker has no Container: a fake one answers the command with what real git printed, and is counted.
// @effect-diagnostics asyncFunction:off globalDate:off preferEffectArray:off preferEffectRecord:off
import { type Comparison } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, inject, it } from "vitest";
import type { RepoFiles } from "./changes.repos.ts";
import { lines } from "./changes.repos.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

const repos = inject("comparisonRepos");

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

let made = 0;

/** A Workspace of its own, its (fake) Container stopped. */
const workspace = (): DurableObjectStub<TestWorkspace> =>
  env.WORKSPACES.getByName(`comparison-${Date.now()}-${made++}`);

/** Write `files` into the Workspace as `/workspace/app`. */
const place = (stub: DurableObjectStub<TestWorkspace>, files: RepoFiles) =>
  stub.putFiles(
    Object.entries(files).map(([path, base64]) => [`/workspace/app/${path}`, bytesOf(base64)]),
  );

const compare = (
  stub: DurableObjectStub<TestWorkspace>,
  options: { startContainer?: boolean; fetch?: boolean } = {},
) =>
  stub.compare({
    repo: "app",
    startContainer: options.startContainer ?? false,
    fetch: options.fetch ?? false,
  });

const okOf = async (result: ReturnType<typeof compare>): Promise<Comparison> => {
  const made = await result;

  if (made.status !== "ok") throw new Error(`not ok: ${JSON.stringify(made.error)}`);

  return made.comparison;
};

/** The Workspace with the first head placed and its Comparison made, then the Container stopped. */
const compared = async () => {
  const stub = workspace();

  await place(stub, repos.first.files);
  await stub.fakeContainer({ running: false, outputs: [repos.first.stdout] });

  const list = await okOf(compare(stub, { startContainer: true }));

  await stub.fakeContainer({ running: false });

  return { stub, list };
};

describe("This branch in the Workspace DO", () => {
  it("lists the commits since the branch left its base, from what the Container's git printed", async () => {
    const { stub, list } = await compared();

    expect(list).toMatchObject({
      repo: "app",
      base: "main",
      branch: "feat",
      commits: 3,
      more: 0,
      mergeBase: expect.stringMatching(/^[0-9a-f]{40}$/),
      head: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(list.files).toEqual([
      { path: "DOCS.md", oldPath: "README.md", status: "renamed", additions: 1, deletions: 0 },
      { path: "bin.dat", status: "added", additions: null, deletions: null, binary: true },
      { path: "keep.txt", status: "modified", additions: 1, deletions: 0 },
      { path: "new.txt", status: "added", additions: 1, deletions: 0 },
    ]);

    const run = (await stub.fakeContainerState()).scripts;

    expect(run).toHaveLength(1);
    expect(run[0]).toContain(
      "git fetch --refmap= --no-write-fetch-head --no-auto-maintenance --no-tags",
    );
  });

  it("reads each file's two sides from the synced objects with readBlob, starting nothing", async () => {
    const { stub, list } = await compared();
    const at = { repo: "app", mergeBase: list.mergeBase, head: list.head };

    const ask = (path: string, oldPath?: string) =>
      stub.comparisonFile(oldPath === undefined ? { ...at, path } : { ...at, path, oldPath });

    expect(await ask("keep.txt")).toEqual({
      old: { kind: "text", text: lines(20, "keep") },
      new: { kind: "text", text: `${lines(20, "keep")}added\n` },
    });
    expect(await ask("new.txt")).toEqual({ old: null, new: { kind: "text", text: "fresh\n" } });
    expect(await ask("DOCS.md", "README.md")).toEqual({
      old: { kind: "text", text: "hello\n" },
      new: { kind: "text", text: "hello\nworld\n" },
    });
    expect(await ask("bin.dat")).toEqual({ old: null, new: { kind: "binary" } });
    expect((await stub.fakeContainerState()).scripts).toHaveLength(1);
    expect((await stub.liveStubs()).container).toBe(0);
  });
});
