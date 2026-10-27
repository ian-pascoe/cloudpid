// The Session's Changes: one listing for every watcher of a Workspace, one broadcast per Workspace, and the tool wrap
// that lists them again after an agent's writes in its Workspace. The socket side is covered in workerd
// (`sockets.workerd.test.ts`).
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferEffectArray:off strictEffectProvide:off
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { WorkspaceChanges } from "@cloudpid/protocol";
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import {
  ChangesBroadcast,
  type ChangesSource,
  type ChangesUpdate,
  changesRefreshingTools,
  SessionChanges,
  sessionChangesLayer,
} from "./changes.ts";

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

describe("the Changes of each Workspace", () => {
  /** A source that lists `name`'s files, counting its listings and the files asked of it. */
  const source = (name: string, counts: Map<string, number>, asked: string[]): ChangesSource => ({
    list: async () => {
      counts.set(name, (counts.get(name) ?? 0) + 1);

      return listed(`${name}.ts`);
    },
    file: async (query) => {
      asked.push(`${name}:${query.path}`);

      return { old: null, new: null };
    },
  });

  const OTHER_WORKSPACE = { id: "v", branch: "c", object: "ws:v", directory: "/workspace" };

  it("lists a Subagent Workspace apart from the Session's, once for all its watchers", async () => {
    const counts = new Map<string, number>();
    const asked: string[] = [];

    const program = Effect.gen(function* () {
      const changes = yield* SessionChanges;

      /** The first `n` updates a watcher of `workspace` gets, as paths. */
      const take = (workspace: typeof SUBAGENT_WORKSPACE | undefined, n: number) =>
        changes.updates(workspace).pipe(
          Stream.take(n),
          Stream.map((update) =>
            update.kind === "changes" ? update.message.repos[0]?.files[0]?.path : update.message,
          ),
          Stream.runCollect,
          Effect.forkChild,
        );

      const session = yield* take(undefined, 1);
      const first = yield* take(SUBAGENT_WORKSPACE, 1);
      const second = yield* take({ ...SUBAGENT_WORKSPACE }, 1);
      const other = yield* take(OTHER_WORKSPACE, 1);

      const seen = yield* Effect.all([
        Fiber.join(session),
        Fiber.join(first),
        Fiber.join(second),
        Fiber.join(other),
      ]);

      yield* changes.file(SUBAGENT_WORKSPACE, { repo: "app", path: "a.ts" });
      yield* changes.file(undefined, { repo: "app", path: "b.ts" });

      return seen;
    });

    const seen = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          sessionChangesLayer({
            session: source("session", counts, asked),
            subagent: (workspace) => source(workspace.object, counts, asked),
          }),
        ),
      ),
    );

    expect(seen).toEqual([["session.ts"], ["ws:w.ts"], ["ws:w.ts"], ["ws:v.ts"]]);
    // The two watchers of one Workspace started a listing each, the second folded into one more after the first.
    expect(counts.get("ws:w")).toBeLessThanOrEqual(2);
    expect(counts.get("session")).toBe(1);
    expect(asked).toEqual(["ws:w:a.ts", "session:b.ts"]);
  });
});

describe("the writing tools' wrap", () => {
  const wrapped = (
    written: (workspace: typeof SUBAGENT_WORKSPACE | undefined) => void,
    watched = true,
  ) => {
    const extension = changesRefreshingTools([tool("write"), tool("read"), tool("bash")], {
      watched: () => watched,
      written,
      writtenSomewhere: () => {},
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

  it("lists again the Changes of the Workspace the calling conversation works in", async () => {
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

    // A subagent's in a Subagent Workspace of its own: that Workspace's.
    await run.execute({}, api(7, true), context);
    await vi.waitFor(() => expect(written).toHaveBeenCalledTimes(3));
    expect(written.mock.calls).toEqual([[undefined], [undefined], [SUBAGENT_WORKSPACE]]);
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
