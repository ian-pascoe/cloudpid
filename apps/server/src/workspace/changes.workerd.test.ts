// Changes in the Workspace DO (docs/spec.md → Diffs and review → Changes), over repos real git made (`changes.setup.ts`)
// and written into a Workspace as computer's sync would. The test Worker has no Container: a listing that needs it
// either keeps the repo's last list, marked "may be out of date", or (allowed to start it) is counted and refused.
// @effect-diagnostics asyncFunction:off globalDate:off preferEffectArray:off preferEffectRecord:off
import { MAX_CHANGED_FILES } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, inject, it } from "vitest";
import { lines, REWRITE_LINES, type RepoFiles } from "./changes.repos.ts";
import { MAX_PACK_BYTES } from "./git.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

const repos = inject("changesRepos");

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

let made = 0;

/** A Workspace of its own, its Container never started. */
const workspace = (): DurableObjectStub<TestWorkspace> =>
  env.WORKSPACES.getByName(`changes-${Date.now()}-${made++}`);

/** Write repo `name`'s files into the Workspace as `/workspace/<as>`. */
const place = (stub: DurableObjectStub<TestWorkspace>, name: string, as: string = name) => {
  const files: RepoFiles = repos[name] ?? {};

  return stub.putFiles(Object.entries(files).map(([path, base64]) => [`/workspace/${as}/${path}`, bytesOf(base64)]));
};

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

describe("the Workspace DO's Changes", () => {
  it("lists a repo's files against HEAD as real git left them, with counts, renames, flags and caps", async () => {
    const stub = workspace();

    await place(stub, "basic");

    const index = await stub.fileBytes("/workspace/basic/.git/index");
    const listed = await stub.changes({ directory: "/workspace/basic", startContainer: false });

    expect(listed.repos).toEqual([
      {
        repo: "basic",
        head: { commit: expect.stringMatching(/^[0-9a-f]{40}$/), branch: "main" },
        more: 0,
        stale: false,
        files: [
          { path: "edit.txt", status: "modified", additions: 2, deletions: 1 },
          // Renamed and edited: a deletion and an addition, as the blobs differ.
          { path: "edited-moved.txt", status: "added", additions: 31, deletions: 0 },
          { path: "edited.txt", status: "deleted", additions: 0, deletions: 30 },
          { path: "gen/out.gen.ts", status: "modified", additions: 1, deletions: 1, generated: true },
          { path: "gone.txt", status: "deleted", additions: 0, deletions: 1 },
          // Over 1 MiB: listed, with no counts the Workspace DO could know without reading it all.
          { path: "grows.txt", status: "modified", additions: null, deletions: null, tooLarge: true },
          { path: "logo.bin", status: "modified", additions: null, deletions: null, binary: true },
          // Renamed with the same blob: paired.
          { path: "moved/same.txt", oldPath: "same.txt", status: "renamed", additions: 0, deletions: 0 },
          { path: "new.txt", status: "added", additions: 2, deletions: 0 },
          // Too many changes to line up in a second: whole-file numbers, "≈".
          {
            path: "rewrite.txt",
            status: "modified",
            additions: REWRITE_LINES,
            deletions: REWRITE_LINES,
            approximate: true,
          },
          { path: "vendor/keep.js", status: "modified", additions: 1, deletions: 1, vendored: false },
          { path: "vendor/lib.js", status: "modified", additions: 1, deletions: 1, vendored: true },
          // Not `target/built.txt`: tracked, but on a Container-only path, so the Workspace DO never holds it. Nor the
          // ignored `out/ignored.js`.
        ],
      },
    ]);

    // Never written, though every file's stat differs from what real git recorded.
    expect(sameBytes(await stub.fileBytes("/workspace/basic/.git/index"), index)).toBe(true);
    expect((await stub.liveStubs()).container).toBe(0);
  });

  it("answers a file's two sides: text, binary, too large, or none", async () => {
    const stub = workspace();

    await place(stub, "basic");

    const index = await stub.fileBytes("/workspace/basic/.git/index");

    expect(await stub.changeFile({ repo: "basic", path: "edit.txt" })).toEqual({
      old: { kind: "text", text: lines(10) },
      new: { kind: "text", text: `${lines(10).replace("line 1\n", "line one\n")}line 10\n` },
    });
    expect(await stub.changeFile({ repo: "basic", path: "moved/same.txt", oldPath: "same.txt" })).toEqual({
      old: { kind: "text", text: lines(30, "same") },
      new: { kind: "text", text: lines(30, "same") },
    });
    expect(await stub.changeFile({ repo: "basic", path: "logo.bin" })).toEqual({
      old: { kind: "binary" },
      new: { kind: "binary" },
    });
    expect(await stub.changeFile({ repo: "basic", path: "grows.txt" })).toEqual({
      old: { kind: "text", text: "small\n" },
      new: { kind: "too_large", bytes: 2 * (512 * 1024 + 1) },
    });
    expect(await stub.changeFile({ repo: "basic", path: "gone.txt" })).toEqual({
      old: { kind: "text", text: "gone\n" },
      new: null,
    });
    expect(await stub.changeFile({ repo: "basic", path: "new.txt" })).toEqual({
      old: null,
      new: { kind: "text", text: "fresh\nfile\n" },
    });
    // Caught at once: a stub's rejected call left to `expect().rejects` is reported as unhandled too.
    const refused = (path: string) => stub.changeFile({ repo: "basic", path }).then(() => undefined, (cause: unknown) => String(cause));

    expect(await refused("../escape")).toMatch(/No such file/);
    expect(await refused(".git/config")).toMatch(/No such file/);

    expect(sameBytes(await stub.fileBytes("/workspace/basic/.git/index"), index)).toBe(true);
  });

  it("covers every repo from the Workspace's root, and stops at 2,000 files across them", async () => {
    const stub = workspace();

    await place(stub, "tiny", "cap-a");
    await place(stub, "tiny", "cap-b");

    const untracked = (repo: string, count: number) =>
      Array.from({ length: count }, (_, index) => [`/workspace/${repo}/new/${String(index).padStart(4, "0")}.txt`, `${index}\n`] as const);

    await stub.putFiles([...untracked("cap-a", 1_500), ...untracked("cap-b", 600)]);

    const listed = await stub.changes({ directory: "/workspace", startContainer: false });

    expect(listed.repos.map(({ repo, files, more }) => ({ repo, files: files.length, more }))).toEqual([
      { repo: "cap-a", files: 1_500, more: 0 },
      { repo: "cap-b", files: MAX_CHANGED_FILES - 1_500, more: 100 },
    ]);
    expect(listed.repos[1]?.files[0]).toEqual({ path: "new/0000.txt", status: "added", additions: 1, deletions: 0 });
  });

  it("sends a repo with .gitattributes rules git applies to the Container, and never starts it on its own", async () => {
    const stub = workspace();

    await place(stub, "attributed");

    // The Container is stopped: the repo keeps its last list (none yet), "may be out of date".
    expect(await stub.changes({ directory: "/workspace/attributed", startContainer: false })).toEqual({
      repos: [
        {
          repo: "attributed",
          head: { commit: expect.stringMatching(/^[0-9a-f]{40}$/), branch: "main" },
          files: [],
          more: 0,
          stale: true,
        },
      ],
    });
    expect((await stub.liveStubs()).container).toBe(0);

    // The owner's Refresh may start it: the listing goes to the Container, which this test Worker refuses.
    const refreshed = await stub.changes({ directory: "/workspace/attributed", startContainer: true });

    expect((await stub.liveStubs()).container).toBe(1);
    expect(refreshed.repos[0]).toMatchObject({ stale: true, error: expect.stringContaining("no Container") });
  });

  it("sends a repo whose packs are over 16 MB to the Container", async () => {
    const stub = workspace();

    await place(stub, "tiny");
    await stub.putFiles([["/workspace/tiny/.git/objects/pack/pack-big.pack", new Uint8Array(MAX_PACK_BYTES + 1)]]);

    expect((await stub.changes({ directory: "/workspace/tiny", startContainer: false })).repos).toEqual([
      expect.objectContaining({ repo: "tiny", stale: true, files: [] }),
    ]);
    expect((await stub.liveStubs()).container).toBe(0);
  });
});
