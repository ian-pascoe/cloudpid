// @effect-diagnostics asyncFunction:off
import { describe, expect, it } from "vitest";
import type { SubagentsState } from "@cloudpid/extensions/subagents";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  cachedPlacement,
  type Placement,
  readyPlacement,
  sessionWorkspace,
  WORKSPACE_CHECKED_FOR,
  type WorkspaceNamespace,
  workspacePlacement,
  workspaceReadiness,
} from "./workspace.ts";

const UNLISTED: Placement = { workspace: null, object: "ws:unlisted", directory: "/workspace" };

const IN_PI = workspacePlacement("0a1b2c3d", "/workspace/pi");

/** A `cachedPlacement` over an in-memory cache, and the names its lookup was asked for. */
const setup = (
  name: string | undefined,
  answer: (name: string) => Promise<Placement | null>,
  initial?: Placement,
) => {
  let kept = initial;
  const asked: string[] = [];

  const placement = cachedPlacement({
    name,
    get: () => kept,
    put: (value) => {
      kept = value;
    },
    lookup: (id) => {
      asked.push(id);

      return answer(id);
    },
  });

  return { placement, asked, kept: () => kept };
};

describe("cachedPlacement", () => {
  it("asks the Registry once for a listed Session, and keeps its Workspace and directory", async () => {
    const { placement, asked, kept } = setup("s1", () => Promise.resolve(IN_PI));

    expect(await placement()).toEqual(IN_PI);
    expect(await placement()).toEqual(IN_PI);
    expect(asked).toEqual(["s1"]);
    expect(kept()).toEqual(IN_PI);
  });

  it("answers from what is kept without asking", async () => {
    const { placement, asked } = setup(
      "s1",
      () => Promise.resolve(workspacePlacement("ffffffff", "/workspace")),
      IN_PI,
    );

    expect(await placement()).toEqual(IN_PI);
    expect(asked).toEqual([]);
  });

  it("works at the root of a Workspace of its own for a Session the Registry does not list, and asks again", async () => {
    let answer: Placement | null = null;
    const { placement, asked, kept } = setup("s1", () => Promise.resolve(answer));

    expect(await placement()).toEqual(UNLISTED);
    expect(kept()).toBeUndefined();

    answer = IN_PI;

    expect(await placement()).toEqual(IN_PI);
    expect(asked).toEqual(["s1", "s1"]);
  });

  it("works at the root for a Session whose name is unknown, without asking", async () => {
    const { placement, asked, kept } = setup(undefined, () => Promise.resolve(IN_PI));

    expect(await placement()).toEqual(UNLISTED);
    expect(asked).toEqual([]);
    expect(kept()).toBeUndefined();
  });

  it("fails when the lookup does, keeps nothing, and asks again", async () => {
    let fail = true;

    const { placement, asked, kept } = setup("s1", () =>
      fail ? Promise.reject(new Error("registry down")) : Promise.resolve(IN_PI),
    );

    await expect(placement()).rejects.toThrow("registry down");
    expect(kept()).toBeUndefined();

    fail = false;

    expect(await placement()).toEqual(IN_PI);
    expect(asked).toEqual(["s1", "s1"]);
  });
});

describe("workspacePlacement", () => {
  it("works in the Workspace's own object", () => {
    expect(IN_PI).toEqual({
      workspace: "0a1b2c3d",
      object: "ws:0a1b2c3d",
      directory: "/workspace/pi",
    });
  });
});

describe("readyPlacement", () => {
  /** A `readyPlacement` of `placed` over a fake clock: the Workspaces it readied, and how to move the clock. */
  const setup = (placed: Placement, prepare: () => Promise<void> = () => Promise.resolve()) => {
    let time = 1_000;
    const prepared: string[] = [];

    const ready = readyPlacement({
      placement: () => Promise.resolve(placed),
      prepare: (workspace) => {
        prepared.push(workspace);

        return prepare();
      },
      now: () => time,
    });

    return {
      ready,
      prepared,
      advance: (by: number) => {
        time += by;
      },
    };
  };

  it("readies nothing for a Session nobody lists", async () => {
    const { ready, prepared } = setup(UNLISTED);

    expect(await ready()).toEqual(UNLISTED);
    expect(prepared).toEqual([]);
  });

  it("readies the Workspace once for callers at once, and again once the check is old", async () => {
    const { ready, prepared, advance } = setup(IN_PI);

    expect(await Promise.all([ready(), ready()])).toEqual([IN_PI, IN_PI]);
    expect(prepared).toEqual(["0a1b2c3d"]);

    advance(WORKSPACE_CHECKED_FOR - 1);
    await ready();
    expect(prepared).toHaveLength(1);

    advance(1);
    await ready();
    expect(prepared).toHaveLength(2);
  });

  it("fails while the Workspace cannot be readied, and tries again at the next call", async () => {
    let fail = true;

    const { ready, prepared } = setup(IN_PI, () =>
      fail ? Promise.reject(new Error("fatal: repository not found")) : Promise.resolve(),
    );

    await expect(ready()).rejects.toThrow("repository not found");

    fail = false;

    expect(await ready()).toEqual(IN_PI);
    expect(prepared).toHaveLength(2);
  });
});

describe("sessionWorkspace", () => {
  const CHILD_WORKSPACE = {
    id: "9f9f9f9f",
    branch: "cloudpid/9f9f9f9f",
    object: "ws:9f9f9f9f",
    directory: "/workspace/pi",
  };

  /** Agent `impl` (conversation 5) in a Subagent Workspace of its own, and `impl.1` (conversation 6), sharing it. */
  const state: Pick<SubagentsState, "conversations"> & {
    readonly agents: Record<string, { readonly parent: string; readonly workspace?: unknown }>;
  } = {
    agents: {
      impl: { parent: "root", workspace: CHILD_WORKSPACE },
      "impl.1": { parent: "impl" },
    },
    conversations: { "5": "impl", "6": "impl.1" },
  };

  const conversation = (id: number) => ({
    // SAFETY: a conversation ID is a number; these name the conversations of `state`.
    conversationId: id as ConversationId,
    // SAFETY: the Session's Workspace reads only the Subagents document.
    read: { snapshot: async () => state } as never,
    context: BACKGROUND_CONTEXT,
  });

  const setUp = () => {
    const stopped: string[] = [];
    const prepared: string[] = [];

    const namespace: WorkspaceNamespace = {
      // SAFETY: the Container's calls are the only ones made of the stubs.
      getByName: (object: string) =>
        ({
          stopContainer: async () => {
            stopped.push(object);

            return { wasRunning: true };
          },
        }) as never,
    };

    const workspace = sessionWorkspace({
      namespace,
      placement: async () => IN_PI,
      prepare: async (id) => {
        prepared.push(id);
      },
    });

    return { workspace, stopped, prepared };
  };

  it("stops the Container of the calling conversation's Workspace: a subagent's own, a shared grandchild's parent's, else the Session's", async () => {
    const { workspace, stopped } = setUp();

    for (const id of [5, 6, 1]) {
      await workspace.container.restart({ fresh: false, target: conversation(id) });
    }

    expect(stopped).toEqual(["ws:9f9f9f9f", "ws:9f9f9f9f", IN_PI.object]);
  });

  it("readies nothing to stop a Container, which may be what no longer answers", async () => {
    const { workspace, prepared } = setUp();

    await workspace.container.restart({ fresh: true, target: conversation(5) });

    expect(prepared).toEqual([]);
  });
});

describe("workspaceReadiness", () => {
  it("counts each Workspace apart: a Subagent Workspace is readied on its own first use", async () => {
    const prepared: string[] = [];

    const ready = workspaceReadiness({
      prepare: async (id) => {
        prepared.push(id);
      },
      now: () => 0,
    });

    await Promise.all([ready("0a1b2c3d"), ready("9f9f9f9f"), ready("9f9f9f9f")]);
    await ready("0a1b2c3d");

    expect(prepared).toEqual(["0a1b2c3d", "9f9f9f9f"]);
  });
});
