// The Run copies and the Run diff in the Workspace DO (docs/architecture/diffs-and-review.md → Run diff), over repos real git
// made (`changes.setup.ts`) and written into a Workspace as computer's sync would. The copies are written by
// isomorphic-git through the Workspace DO's own files, so these tests are the proof that its writes (`mkdir`, `writeFile`)
// work over computer's provider. The test Worker has no Container: a fake one counts what is asked of it.
// @effect-diagnostics asyncFunction:off globalDate:off preferEffectArray:off preferEffectRecord:off
import { env } from "cloudflare:workers";
import { describe, expect, inject, it } from "vitest";
import type { RepoFiles } from "./changes.repos.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

const repos = inject("changesRepos");

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

const SCOPE = "session-a";

let made = 0;

/** A Workspace of its own, its Container never started. */
const workspace = (): DurableObjectStub<TestWorkspace> =>
  env.WORKSPACES.getByName(`runs-${Date.now()}-${made++}`);

/** Write repo `name`'s files into the Workspace as `/workspace/<name>`. */
const place = (stub: DurableObjectStub<TestWorkspace>, name: string) => {
  const files: RepoFiles = repos[name] ?? {};

  return stub.putFiles(
    Object.entries(files).map(([path, base64]) => [`/workspace/${name}/${path}`, bytesOf(base64)]),
  );
};

const start = (stub: DurableObjectStub<TestWorkspace>, name: string, run = "run1abc", keep = []) =>
  stub.runStart({
    scope: SCOPE,
    run,
    conversationId: 1,
    firstCall: "call_1",
    directory: `/workspace/${name}`,
    keep,
  });

const text = async (stub: DurableObjectStub<TestWorkspace>, path: string) =>
  new TextDecoder().decode(await stub.fileBytes(path));

describe("the Workspace DO's Run copies", () => {
  it("copies a repo before the Run through its own files, and shows only what the Run changes", async () => {
    const stub = workspace();

    await place(stub, "basic");

    const run = await start(stub, "basic");

    expect(run).toMatchObject({
      run: "run1abc",
      endedAt: null,
      repos: [{ repo: "basic", start: expect.stringMatching(/^[0-9a-f]{40}$/), end: null }],
    });

    // The ref is a file of the repo, which the Container's git would read.
    expect(
      (await text(stub, `/workspace/basic/.git/refs/cloudpid/runs/${SCOPE}/start`)).trim(),
    ).toBe(run.repos[0]?.start);

    // Before the Run the repo already differed from HEAD (basic): none of that is the Run's.
    expect((await stub.runDiff(SCOPE))?.repos[0]?.files).toEqual([]);

    await stub.putFiles([
      ["/workspace/basic/edit.txt", "edited by the run\n"],
      ["/workspace/basic/brand-new.txt", "new\n"],
      ["/workspace/basic/keep.txt", "kept, changed\n"],
    ]);

    const diff = await stub.runDiff(SCOPE);

    expect(diff).toMatchObject({ run: "run1abc", live: true });
    expect(diff?.repos[0]?.files.map((file) => `${file.status} ${file.path}`)).toEqual([
      "added brand-new.txt",
      "modified edit.txt",
      "modified keep.txt",
    ]);
    expect(await stub.runFile({ scope: SCOPE, repo: "basic", path: "keep.txt" })).toEqual({
      old: { kind: "text", text: "keep\n" },
      new: { kind: "text", text: "kept, changed\n" },
    });
    // The side before the Run is the working tree as it was then (edit.txt differed from HEAD already).
    expect(await stub.runFile({ scope: SCOPE, repo: "basic", path: "edit.txt" })).toMatchObject({
      old: { kind: "text", text: expect.stringContaining("line one") },
      new: { kind: "text", text: "edited by the run\n" },
    });
    expect((await stub.fakeContainerState()).scripts).toEqual([]);
  });

  it("freezes the diff at the Run's end, and replaces the Run when the next one starts", async () => {
    const stub = workspace();

    await place(stub, "tiny");
    await start(stub, "tiny");
    await stub.putFiles([["/workspace/tiny/README.md", "# changed\n"]]);

    const ended = await stub.runEnd({ scope: SCOPE, run: "run1abc", until: 9, keep: [] });

    expect(ended).toMatchObject({
      endedAt: expect.any(Number),
      until: 9,
      repos: [{ repo: "tiny", end: expect.stringMatching(/^[0-9a-f]{40}$/) }],
    });

    // Later edits are not the Run's.
    await stub.putFiles([["/workspace/tiny/README.md", "# changed again\n"]]);

    expect((await stub.runDiff(SCOPE))?.repos[0]?.files).toEqual([
      { path: "README.md", status: "modified", additions: 1, deletions: 1 },
    ]);
    expect(await stub.runFile({ scope: SCOPE, repo: "tiny", path: "README.md" })).toEqual({
      old: { kind: "text", text: "# tiny\n" },
      new: { kind: "text", text: "# changed\n" },
    });

    await start(stub, "tiny", "run2abc");

    expect((await stub.runDiff(SCOPE))?.run).toBe("run2abc");
    expect((await stub.runDiff(SCOPE))?.repos[0]?.files).toEqual([]);
    expect(stub.storageKeys("cloudpid:run:")).toEqual(
      expect.not.arrayContaining([expect.stringContaining(":kept:")]),
    );
  });

  it("copies a repo with nothing committed, and leaves a Workspace with no repo without a Run diff", async () => {
    const stub = workspace();

    expect(await stub.runDiff(SCOPE)).toBeNull();
    expect(await start(stub, "nothing")).toMatchObject({ repos: [] });
    expect(await stub.runDiff(SCOPE)).toMatchObject({ run: "run1abc", live: true, repos: [] });
  });

  it("does not copy a repo it would need the Container for while the Container is stopped, and starts nothing", async () => {
    const stub = workspace();

    await place(stub, "attributed");
    await stub.fakeContainer({ running: false });

    expect(await start(stub, "attributed")).toMatchObject({
      repos: [{ repo: "attributed", start: null, notCaptured: "container_stopped" }],
    });
    expect((await stub.fakeContainerState()).scripts).toEqual([]);
    expect((await stub.fakeContainerState()).running).toBe(false);
    expect((await stub.liveStubs()).container).toBe(0);
  });
});
