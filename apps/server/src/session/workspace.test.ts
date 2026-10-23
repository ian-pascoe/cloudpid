// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import { describe, expect, it, vi } from "vitest";
import {
  cachedPlacement,
  earlyStartOnSubmit,
  type Placement,
  readyPlacement,
  sessionWorkspace,
  WORKSPACE_CHECKED_FOR,
  type WorkspaceNamespace,
  workspacePlacement,
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
  const setup = (
    placed: Placement,
    prepare: (handedOver: () => void) => Promise<void> = () => Promise.resolve(),
  ) => {
    let time = 1_000;
    const prepared: string[] = [];

    const { ready, handedOver } = readyPlacement({
      placement: () => Promise.resolve(placed),
      prepare: (workspace, handed) => {
        prepared.push(workspace);

        return prepare(handed);
      },
      now: () => time,
    });

    return {
      ready,
      handedOver,
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

  it("answers the hand-over before the clones, from the readying that ready() then joins", async () => {
    const clones = Promise.withResolvers<void>();

    const { ready, handedOver, prepared } = setup(IN_PI, async (handed) => {
      handed();
      await clones.promise;
    });

    expect(await handedOver()).toEqual(IN_PI);

    const readied = ready();

    clones.resolve();
    expect(await readied).toEqual(IN_PI);
    expect(prepared).toEqual(["0a1b2c3d"]);
  });

  it("answers the hand-over at once once a readying has made it, without readying again", async () => {
    const { ready, handedOver, prepared, advance } = setup(IN_PI, async (handed) => {
      handed();
    });

    await ready();
    advance(WORKSPACE_CHECKED_FOR);

    expect(await handedOver()).toEqual(IN_PI);
    expect(prepared).toHaveLength(1);
  });

  it("answers the hand-over of a readying that had nothing to hand over once it is done", async () => {
    const { handedOver, prepared } = setup(IN_PI);

    expect(await handedOver()).toEqual(IN_PI);
    expect(prepared).toEqual(["0a1b2c3d"]);
  });

  it("fails the hand-over when the readying fails before it, and tries again at the next call", async () => {
    let fail = true;

    const { handedOver, prepared } = setup(IN_PI, async (handed) => {
      if (fail) throw new Error("the Registry is unreachable");

      handed();
    });

    await expect(handedOver()).rejects.toThrow("the Registry is unreachable");

    fail = false;

    expect(await handedOver()).toEqual(IN_PI);
    expect(prepared).toHaveLength(2);
  });

  it("hands nothing over for a Session nobody lists", async () => {
    const { handedOver, prepared } = setup(UNLISTED);

    expect(await handedOver()).toEqual(UNLISTED);
    expect(prepared).toEqual([]);
  });
});

describe("the early start of a Session's Workspace", () => {
  /** A Workspace DO namespace whose stubs only start their Container early, which `events` records. */
  const namespaceOf = (events: string[]): WorkspaceNamespace =>
    // SAFETY: the early start reaches only `startContainerEarly` of the namespace's stub.
    ({
      getByName: (object: string) => ({
        startContainerEarly: async () => {
          events.push(`early start of ${object}`);
        },
      }),
    }) as WorkspaceNamespace;

  /** A `sessionWorkspace` in `IN_PI` whose readying hands over, then clones once `clones` resolves; what happened, in order. */
  const setup = () => {
    const events: string[] = [];
    const clones = Promise.withResolvers<void>();

    const workspace = sessionWorkspace({
      namespace: namespaceOf(events),
      placement: () => Promise.resolve(IN_PI),
      prepare: async (id, handedOver) => {
        events.push(`registry lookup for ${id}`);
        await Promise.resolve();
        events.push("hand-over");
        handedOver();
        await clones.promise;
        events.push("clones");
      },
    });

    return { workspace, events, clones };
  };

  it("starts the Container once the readying has handed the Workspace its settings, without waiting for the clones", async () => {
    const { workspace, events, clones } = setup();

    await workspace.startContainerEarly();

    expect(events).toEqual([
      "registry lookup for 0a1b2c3d",
      "hand-over",
      `early start of ${IN_PI.object}`,
    ]);

    clones.resolve();

    await vi.waitFor(() => {
      expect(events.at(-1)).toBe("clones");
    });
  });

  it("starts the Container at once for a later message, while the first readying still clones", async () => {
    const { workspace, events } = setup();

    await workspace.startContainerEarly();
    await workspace.startContainerEarly();

    expect(events).toEqual([
      "registry lookup for 0a1b2c3d",
      "hand-over",
      `early start of ${IN_PI.object}`,
      `early start of ${IN_PI.object}`,
    ]);
  });

  it("starts no Container when the readying fails before the hand-over", async () => {
    const events: string[] = [];

    const workspace = sessionWorkspace({
      namespace: namespaceOf(events),
      placement: () => Promise.resolve(IN_PI),
      prepare: () => Promise.reject(new Error("the Registry is unreachable")),
    });

    await expect(workspace.startContainerEarly()).rejects.toThrow("the Registry is unreachable");
    expect(events).toEqual([]);
  });
});

describe("earlyStartOnSubmit", () => {
  /** Run the early start for a message over `startContainerEarly`: whether it succeeded, and the levels it logged. */
  const run = async (startContainerEarly: () => Promise<void>) => {
    const logged: string[] = [];

    const collector = Logger.make((options) => {
      logged.push(options.logLevel);
    });

    const exit = await Effect.runPromiseExit(
      earlyStartOnSubmit({ startContainerEarly }).pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([collector])),
      ),
    );

    return { succeeded: Exit.isSuccess(exit), logged };
  };

  it("asks the Workspace once and logs nothing when the request lands", async () => {
    let asked = 0;

    const outcome = await run(async () => {
      asked++;
    });

    expect(outcome).toEqual({ succeeded: true, logged: [] });
    expect(asked).toBe(1);
  });

  it("succeeds with a warning when the request is rejected", async () => {
    expect(await run(() => Promise.reject(new Error("unreachable")))).toEqual({
      succeeded: true,
      logged: ["Warn"],
    });
  });

  it("succeeds with a warning when the request throws before it is made", async () => {
    expect(
      await run(() => {
        throw new Error("no binding");
      }),
    ).toEqual({ succeeded: true, logged: ["Warn"] });
  });
});
