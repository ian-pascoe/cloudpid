// The Session's Changes: one listing for every watcher, and the tool wrap that lists them again after an agent's
// writes in the Session's own Workspace. The socket side is covered in workerd (`sockets.workerd.test.ts`).
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferEffectArray:off
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { WorkspaceChanges } from "@cloudpid/protocol";
import { describe, expect, it, vi } from "vitest";
import { ChangesBroadcast, type ChangesUpdate, changesRefreshingTools } from "./changes.ts";

const listed = (path: string): WorkspaceChanges => ({
  repos: [
    {
      repo: "app",
      head: { commit: null, branch: "main" },
      files: [{ path, status: "added", additions: 1, deletions: 0 }],
      more: 0,
      stale: false,
    },
  ],
});

describe("the Changes broadcast", () => {
  it("folds the refreshes asked for while one runs into one more, manual if any was", async () => {
    let release: () => void = () => {};
    const calls: boolean[] = [];

    const broadcast = new ChangesBroadcast(
      {
        list: async (startContainer) => {
          calls.push(startContainer);
          await new Promise<void>((resolve) => {
            release = resolve;
          });

          return listed(`${calls.length}.ts`);
        },
        file: async () => ({ old: null, new: null }),
      },
      { warn: () => {} },
    );

    const updates: ChangesUpdate[] = [];

    broadcast.subscribe((update) => updates.push(update));

    const first = broadcast.refresh(false);
    const second = broadcast.refresh(false);
    const third = broadcast.refresh(true);

    await vi.waitFor(() => expect(calls).toEqual([false]));
    release();
    await vi.waitFor(() => expect(calls).toEqual([false, true]));
    release();
    await Promise.all([first, second, third]);

    expect(calls).toEqual([false, true]);
    expect(
      updates.map((update) => update.kind === "changes" && update.message.repos[0]?.files[0]?.path),
    ).toEqual(["1.ts", "2.ts"]);

    // A new watcher is sent the last list at once.
    const late: ChangesUpdate[] = [];

    broadcast.subscribe((update) => late.push(update));
    expect(late).toHaveLength(1);
  });
});

/** A tool `name` that does nothing. */
const tool = (name: string): ToolRegistration =>
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the wrap reads only `name` and calls `execute`, which the fake has.
  ({
    name,
    description: name,
    parameters: {},
    execute: async () => ({ content: [{ type: "text", text: "done" }] }),
  }) as unknown as ToolRegistration;

/** Subagent `1`, whose conversation is 7. */
const SUBAGENT = { id: "1", parent: "root", conversationId: 7 };

const SUBAGENT_WORKSPACE = { id: "w", branch: "b", object: "ws:w", directory: "/workspace" };

/** What a call of conversation `conversationId` reads of the Subagents document. */
const api = (conversationId: number, workspace: boolean) =>
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the wrap reads only `conversationId` and `snapshot`, which the fake answers.
  ({
    conversationId,
    snapshot: async () => ({
      agents: { "1": workspace ? { ...SUBAGENT, workspace: SUBAGENT_WORKSPACE } : SUBAGENT },
      conversations: { "7": "1" },
      tombstones: [],
      nextIndex: {},
      waiters: {},
    }),
  }) as unknown as ToolExecutionApi;

describe("the writing tools' wrap", () => {
  const wrapped = (written: () => void, watched = true) => {
    const extension = changesRefreshingTools([tool("write"), tool("read"), tool("bash")], {
      watched: () => watched,
      written,
    });

    return new Map(
      (extension.wraps ?? []).flatMap((wrap) =>
        "tool" in wrap ? [[wrap.tool, wrap] as const] : [],
      ),
    );
  };

  it("wraps only the tools that write", () => {
    expect([...wrapped(() => {}).keys()]).toEqual(["write", "bash"]);
  });

  it("lists the Changes again after a call in the Session's Workspace, and not in a Subagent Workspace", async () => {
    const written = vi.fn();
    const write = wrapped(written).get("write");

    if (write === undefined || !("tool" in write)) throw new Error("write is not wrapped");

    const run = write.wrap(tool("write"));
    // SAFETY: the wrap only hands the context on, to the fake tool and the fake document read, which ignore it.
    const context = {} as never;

    // The root agent's, and a subagent's that works in the Session's Workspace.
    await run.execute({}, api(1, false), context);
    await run.execute({}, api(7, false), context);
    await vi.waitFor(() => expect(written).toHaveBeenCalledTimes(2));

    // A subagent's in a Subagent Workspace of its own.
    await run.execute({}, api(7, true), context);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(written).toHaveBeenCalledTimes(2);
  });

  it("reads nothing while no client watches the Changes", async () => {
    const written = vi.fn();
    const write = wrapped(written, false).get("write");

    if (write === undefined || !("tool" in write)) throw new Error("write is not wrapped");

    const read = vi.fn();
    const counted: ToolExecutionApi = { ...api(1, false), snapshot: read };
    // SAFETY: as above, the wrap only hands the context on.
    const context = {} as never;

    await write.wrap(tool("write")).execute({}, counted, context);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(read).not.toHaveBeenCalled();
    expect(written).not.toHaveBeenCalled();
  });
});
