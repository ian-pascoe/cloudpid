// A Result Spill's file as the owner's preview reads it (`docs/architecture/mcp-in-a-session.md` → Resource links and
// embedded resources; `SessionHost.spill`): from the Workspace's own storage through the Session's lookup environment, which
// never reaches the Container (ADR-0018), at the path the extension's own `spillTo` wrote; any other path is no spill, and a
// file that cleanup removed is `missing`, so the card reads the resource by its URI instead.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import { PREVIEW_SLOT_OVER, spillTo } from "@cloudpid/extensions/mcp";
import { isMcpSpillPath, MAX_MCP_RESOURCE_PREVIEW_BYTES } from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestWorkspaceSession } from "./session.fixture.ts";
import { uniqueWorkspace } from "./session.workerd.helpers.ts";

/** Workspace `slug`'s environment as the MCP extension spills through it, over a stub of the caller's own. */
const workspaceOf = (slug: string) =>
  new ComputerExecutionEnv({
    workspace: env.WORKSPACES.getByName(slug),
    id: `computer:${slug}`,
    cwd: "/workspace",
  });

/** A Session on Workspace `slug`, and the Workspace's environment as the MCP extension spills through it. */
const withSpills = (slug: string) => {
  const stub = env.WORKSPACE_SESSIONS.get(env.WORKSPACE_SESSIONS.newUniqueId());
  const workspace = workspaceOf(slug);

  const spill = async (data: string | Uint8Array, suffix: string) => {
    const saved = await spillTo(workspace, BACKGROUND_CONTEXT)(data, suffix);

    if (!("path" in saved)) throw new Error(saved.reason);

    return saved.path;
  };

  // The read runs on a test clock that only the wait for the slot moves (`TestWorkspaceSession.spill`): a Workspace call
  // a loaded runner is slow to answer is never what times it out.
  const read = (
    path: string,
    held: Array<number> = [],
    slotAfterMs = 0,
    expandMs?: number,
    duringWait?: () => Promise<void>,
  ) =>
    runInDurableObject(stub, async (instance: TestWorkspaceSession) => {
      instance.bindWorkspace(slug);

      if (expandMs !== undefined) instance.expandTimeoutMs(expandMs);

      return instance.spill(path, held, slotAfterMs, duringWait);
    });

  return { spill, read, workspace };
};

describe("a Result Spill read for a preview", () => {
  it("is the file the extension wrote, at the path it wrote it, read from the Workspace", async () => {
    const { spill, read } = withSpills(uniqueWorkspace());
    const path = await spill(new Uint8Array([137, 80, 78, 71, 0, 255]), ".png");

    // The extension's path is the shape the Session reads.
    expect(isMcpSpillPath(path)).toBe(true);
    expect(await read(path)).toEqual({ kind: "base64", base64: btoa("\x89PNG\x00\xff") });
  });

  it("is missing once cleanup removed it", async () => {
    const { spill, read, workspace } = withSpills(uniqueWorkspace());
    const path = await spill("# gone", ".txt");

    getOrThrow(await workspace.remove(path, { force: true }, BACKGROUND_CONTEXT));

    expect(await read(path)).toEqual({ kind: "missing" });
  });

  it("reads no other path, whatever the client names: a file that is not a spill is missing", async () => {
    const { read, workspace } = withSpills(uniqueWorkspace());

    getOrThrow(
      await workspace.createDir(
        "/workspace/.cloudpid/tmp/tmp-x",
        { recursive: true },
        BACKGROUND_CONTEXT,
      ),
    );
    getOrThrow(
      await workspace.writeFile(
        "/workspace/.cloudpid/tmp/tmp-x/other.txt",
        "private",
        BACKGROUND_CONTEXT,
      ),
    );
    getOrThrow(await workspace.writeFile("/workspace/notes.md", "private", BACKGROUND_CONTEXT));

    for (const path of [
      "/workspace/.cloudpid/tmp/tmp-x/other.txt",
      "/workspace/notes.md",
      "/workspace/.cloudpid/tmp/tmp-x/../../../notes.md",
      "/etc/passwd",
    ]) {
      expect(await read(path)).toEqual({ kind: "missing" });
    }
  });

  it("follows no symbolic link: not at the file, and not at a directory of its path", async () => {
    const slug = uniqueWorkspace();
    const { spill, read, workspace } = withSpills(slug);
    const path = await spill("# the real one", ".txt");
    const directory = path.slice(0, path.lastIndexOf("/"));
    const name = path.slice(path.lastIndexOf("/") + 1);

    getOrThrow(await workspace.writeFile("/workspace/secret.txt", "private", BACKGROUND_CONTEXT));

    // The file is a link to a file outside the tmp directory.
    await env.WORKSPACES.getByName(slug).putSymlink(
      `${directory}-link/${name}`,
      "/workspace/secret.txt",
    );
    expect(await read(`${directory}-link/${name}`)).toEqual({ kind: "missing" });

    // A spill's own path, its file now a link.
    getOrThrow(await workspace.remove(path, { force: true }, BACKGROUND_CONTEXT));
    await env.WORKSPACES.getByName(slug).putSymlink(path, "/workspace/secret.txt");
    expect(await read(path)).toEqual({ kind: "missing" });

    // A spill's own name in a directory that is a link to another that holds one.
    const other = await spill("# elsewhere", ".txt");
    const otherDirectory = other.slice(0, other.lastIndexOf("/"));
    const linked = "/workspace/.cloudpid/tmp/tmp-linked";

    await env.WORKSPACES.getByName(slug).putSymlink(linked, otherDirectory);
    expect(await read(`${linked}/${other.slice(other.lastIndexOf("/") + 1)}`)).toEqual({
      kind: "missing",
    });
  });

  it("is a file only: a directory at a spill's path is missing", async () => {
    const { read, workspace } = withSpills(uniqueWorkspace());
    const path = "/workspace/.cloudpid/tmp/tmp-d1/mcp-d2.txt";

    getOrThrow(await workspace.createDir(path, { recursive: true }, BACKGROUND_CONTEXT));
    expect(await read(path)).toEqual({ kind: "missing" });
  });

  it("asks for the decode slot only for a file over its size, with that size", async () => {
    const { spill, read } = withSpills(uniqueWorkspace());
    const small = await spill(new Uint8Array(1024), ".bin");
    const large = await spill(new Uint8Array(PREVIEW_SLOT_OVER + 5), ".bin");

    const slots = async (path: string) => {
      const held: Array<number> = [];

      await read(path, held);

      return held;
    };

    expect(await slots(small)).toEqual([]);
    expect(await slots(large)).toEqual([PREVIEW_SLOT_OVER + 5]);
  });

  it("asks for the slot from a preview's 1 MiB, so the reads in flight of a socket never add up", async () => {
    const { spill, read } = withSpills(uniqueWorkspace());
    const between = await spill(new Uint8Array(PREVIEW_SLOT_OVER + 5), ".bin");
    const held: Array<number> = [];

    expect(await read(between, held)).toMatchObject({ kind: "base64" });
    expect(held).toEqual([PREVIEW_SLOT_OVER + 5]);
  });

  it("does not count the wait for the slot in the Workspace's time limit: other previews' reads are not its fault", async () => {
    const { spill, read } = withSpills(uniqueWorkspace());
    const path = await spill(new Uint8Array(PREVIEW_SLOT_OVER + 5), ".bin");

    // The Workspace's limit is 1 s here, and the slot comes after 1.5 s of the read's clock.
    expect(await read(path, [], 1500, 1000)).toMatchObject({ kind: "base64" });
  });

  it("reads the file it opened when cleanup removes it during the wait for the slot", async () => {
    const slug = uniqueWorkspace();
    const { spill, read } = withSpills(slug);
    const path = await spill(new Uint8Array(PREVIEW_SLOT_OVER + 5), ".bin");

    // Run in the Session, which reaches the Workspace through a stub of its own.
    const removed = async () => {
      getOrThrow(await workspaceOf(slug).remove(path, { force: true }, BACKGROUND_CONTEXT));
    };

    // The file was opened before the wait, so the wait outliving the file does not take it from the read.
    expect(await read(path, [], 0, undefined, removed)).toMatchObject({
      kind: "base64",
      base64: btoa("\0".repeat(PREVIEW_SLOT_OVER + 5)),
    });
    expect(await read(path)).toEqual({ kind: "missing" });
  });

  it("is too large past a preview's bytes, which it does not read", async () => {
    const { spill, read } = withSpills(uniqueWorkspace());
    const path = await spill(new Uint8Array(MAX_MCP_RESOURCE_PREVIEW_BYTES + 1), ".bin");

    expect(await read(path)).toEqual({ kind: "too_large" });
  });
});
