// @effect-diagnostics asyncFunction:off
import { describe, expect, it } from "vitest";
import {
  cachedPlacement,
  type Placement,
  readyPlacement,
  WORKSPACE_CHECKED_FOR,
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
