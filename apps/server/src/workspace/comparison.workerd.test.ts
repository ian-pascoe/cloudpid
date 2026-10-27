// This branch in the Workspace DO (docs/spec.md → Diffs and review → Comparisons), over a repo real git made and the
// Container's command real git ran on it (`comparison.setup.ts`), written into a Workspace as computer's sync would.
// The test Worker has no Container: a fake one answers the command with what real git printed, and is counted.
// @effect-diagnostics asyncFunction:off globalDate:off preferEffectArray:off preferEffectRecord:off
import { type Comparison, MAX_CHANGE_SIDE_BYTES } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, inject, it } from "vitest";
import type { RepoFiles } from "./changes.repos.ts";
import { lines } from "./changes.repos.ts";
import { MAX_PACK_BYTES } from "./git.ts";
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

  it("keeps the list by (merge-base, head): reopening it after the Container stopped starts nothing", async () => {
    const { stub, list } = await compared();
    const keys = await stub.storageKeys("cloudpid:comparison");

    expect(keys).toEqual(
      expect.arrayContaining([
        "cloudpid:comparison:app",
        `cloudpid:comparison:app:${list.mergeBase}:${list.head}`,
      ]),
    );

    expect(await compare(stub)).toEqual({ status: "ok", comparison: list });
    expect((await stub.fakeContainerState()).scripts).toHaveLength(1);
    expect((await stub.fakeContainerState()).running).toBe(false);
    expect((await stub.liveStubs()).container).toBe(0);
  });

  it("says it needs the Container when nothing is kept and the call may not start it", async () => {
    const stub = workspace();

    await place(stub, repos.first.files);

    expect(await compare(stub)).toMatchObject({
      status: "error",
      error: { kind: "needs_container" },
    });
    expect((await stub.fakeContainerState()).scripts).toEqual([]);
    expect((await stub.fakeContainerState()).running).toBe(false);
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

  it("falls back to the Container's git for an object the Workspace DO does not have, and never starts it", async () => {
    const stub = workspace();

    await place(stub, repos.withoutBlob);
    await stub.fakeContainer({ running: false, outputs: [repos.first.stdout] });

    const list = await okOf(compare(stub, { startContainer: true }));

    await stub.fakeContainer({ running: false });

    const ask = () =>
      stub.comparisonFile({
        repo: "app",
        mergeBase: list.mergeBase,
        head: list.head,
        path: "new.txt",
      });

    // Caught at once: a stub's rejected call left to `expect().rejects` is reported as unhandled too.
    const refused = await ask().then(
      () => undefined,
      (cause: unknown) => String(cause),
    );

    expect(refused).toMatch(/need the Container, which is stopped/);
    expect((await stub.fakeContainerState()).scripts).toHaveLength(1);

    // Running, the Container's git reads it (this fake answers with what real git printed for that blob).
    await stub.fakeContainer({ running: true, outputs: [repos.blob.stdout] });

    expect(await ask()).toEqual({ old: null, new: { kind: "text", text: "fresh\n" } });

    const scripts = (await stub.fakeContainerState()).scripts;

    expect(scripts).toHaveLength(2);
    expect(scripts[1]).toContain("cat-file");
    expect(scripts[1]).toContain(repos.blob.id);
  });

  it("answers an error, not an added file, for a commit it does not have when the list is not kept", async () => {
    const { stub, list } = await compared();

    const refused = await stub
      .comparisonFile({ repo: "app", mergeBase: "e".repeat(40), head: list.head, path: "new.txt" })
      .then(
        () => undefined,
        (cause: unknown) => String(cause),
      );

    expect(refused).toMatch(/no longer kept/);
    expect((await stub.fakeContainerState()).scripts).toHaveLength(1);
  });

  it("sends a repo whose packs are over 16 MB to the Container for contents", async () => {
    const { stub, list } = await compared();

    await stub.putFiles([
      ["/workspace/app/.git/objects/pack/pack-big.pack", new Uint8Array(MAX_PACK_BYTES + 1)],
    ]);

    const ask = () =>
      stub.comparisonFile({
        repo: "app",
        mergeBase: list.mergeBase,
        head: list.head,
        path: "new.txt",
      });

    const refused = await ask().then(
      () => undefined,
      (cause: unknown) => String(cause),
    );

    expect(refused).toMatch(/need the Container, which is stopped/);

    await stub.fakeContainer({ running: true, outputs: [repos.blob.stdout] });

    expect(await ask()).toEqual({ old: null, new: { kind: "text", text: "fresh\n" } });
    expect((await stub.fakeContainerState()).scripts).toHaveLength(2);
  });

  it("marks the last list when HEAD moved and the Container is stopped, and recomputes it when it runs", async () => {
    const { stub, list } = await compared();

    // The agent committed once more: the files sync in, HEAD moves.
    await place(stub, repos.second.files);

    const behind = await okOf(compare(stub));

    expect(behind).toEqual({ ...list, behind: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(behind.behind).not.toBe(list.head);
    expect((await stub.fakeContainerState()).scripts).toHaveLength(1);

    // The Container runs: recomputed by itself, without fetching the base again.
    await stub.fakeContainer({ running: true, outputs: [repos.second.stdout] });

    const again = await okOf(compare(stub));

    expect(again).toMatchObject({ head: behind.behind, commits: 4, mergeBase: list.mergeBase });
    expect(again.behind).toBeUndefined();
    expect(again.files.map((file) => file.path)).toContain("third.txt");

    const scripts = (await stub.fakeContainerState()).scripts;

    expect(scripts).toHaveLength(2);
    expect(scripts[1]).toContain("fetch=0");
  });

  it("lists the picker's repos with their HEADs without starting the Container", async () => {
    const stub = workspace();

    await place(stub, repos.first.files);

    expect(await stub.comparisonSources("/workspace")).toEqual({
      repos: [
        { repo: "app", head: { commit: expect.stringMatching(/^[0-9a-f]{40}$/), branch: "feat" } },
      ],
    });
    expect((await stub.liveStubs()).container).toBe(0);
    expect(MAX_CHANGE_SIDE_BYTES).toBe(1024 * 1024);
  });
});
