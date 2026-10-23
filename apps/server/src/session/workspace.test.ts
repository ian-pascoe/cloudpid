// @effect-diagnostics asyncFunction:off
import { DEFAULT_MACHINE } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import { describe, expect, it } from "vitest";
import {
  cachedPlacement,
  earlyStartOnSubmit,
  lookupDirectory,
  type Placement,
  placementDirectory,
  readyPlacement,
  WORKTREE_CHECKED_FOR,
} from "./workspace.ts";

const ROOT_OF_DEFAULT: Placement = { machine: DEFAULT_MACHINE, repo: null, worktree: null };

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
  it("asks the Registry once for a listed Session, and keeps the Workspace and the repo", async () => {
    const acme: Placement = { machine: "acme", repo: "pi", worktree: null };
    const { placement, asked, kept } = setup("s1", () => Promise.resolve(acme));

    expect(await placement()).toEqual(acme);
    expect(await placement()).toEqual(acme);
    expect(asked).toEqual(["s1"]);
    expect(kept()).toEqual(acme);
  });

  it("answers from what is kept without asking", async () => {
    const acme: Placement = { machine: "acme", repo: null, worktree: null };

    const { placement, asked } = setup(
      "s1",
      () => Promise.resolve({ machine: "other", repo: null, worktree: null }),
      acme,
    );

    expect(await placement()).toEqual(acme);
    expect(asked).toEqual([]);
  });

  it("works at the root of the default Workspace for a Session the Registry does not list, and asks again", async () => {
    let answer: Placement | null = null;
    const { placement, asked, kept } = setup("s1", () => Promise.resolve(answer));

    expect(await placement()).toEqual(ROOT_OF_DEFAULT);
    expect(kept()).toBeUndefined();

    answer = { machine: "acme", repo: "pi", worktree: null };

    expect(await placement()).toEqual({ machine: "acme", repo: "pi", worktree: null });
    expect(asked).toEqual(["s1", "s1"]);
  });

  it("works at the root of the default Workspace for a Session whose name is unknown, without asking", async () => {
    const { placement, asked, kept } = setup(undefined, () =>
      Promise.resolve({ machine: "acme", repo: null, worktree: null }),
    );

    expect(await placement()).toEqual(ROOT_OF_DEFAULT);
    expect(asked).toEqual([]);
    expect(kept()).toBeUndefined();
  });

  it("fails when the lookup does, keeps nothing, and asks again", async () => {
    let fail = true;

    const { placement, asked, kept } = setup("s1", () =>
      fail
        ? Promise.reject(new Error("registry down"))
        : Promise.resolve({ machine: "acme", repo: null, worktree: null }),
    );

    await expect(placement()).rejects.toThrow("registry down");
    expect(kept()).toBeUndefined();

    fail = false;

    expect(await placement()).toEqual({ machine: "acme", repo: null, worktree: null });
    expect(asked).toEqual(["s1", "s1"]);
  });
});

describe("placementDirectory", () => {
  it("is the Session's worktree, else its repo's main checkout, else the Machine's root", () => {
    const worktree = { id: "0a1b2c3d", branch: "cloudpid/0a1b2c3d" };

    expect(placementDirectory({ machine: "acme", repo: "pi", worktree })).toBe(
      "/workspace/.worktrees/pi/0a1b2c3d",
    );
    expect(placementDirectory({ machine: "acme", repo: "pi", worktree: null })).toBe(
      "/workspace/pi",
    );
    expect(placementDirectory(ROOT_OF_DEFAULT)).toBe("/workspace");
  });
});

describe("lookupDirectory", () => {
  const worktree = { id: "0a1b2c3d", branch: "cloudpid/0a1b2c3d" };

  it("is the Session's worktree once it is made, and its repo's main checkout until then", async () => {
    const asked: string[] = [];

    const made = (answer: boolean) => (directory: string) => {
      asked.push(directory);

      return Promise.resolve(answer);
    };

    const placed: Placement = { machine: "acme", repo: "pi", worktree };

    expect(await lookupDirectory(placed, made(true))).toBe("/workspace/.worktrees/pi/0a1b2c3d");
    expect(await lookupDirectory(placed, made(false))).toBe("/workspace/pi");
    expect(asked).toEqual([
      "/workspace/.worktrees/pi/0a1b2c3d",
      "/workspace/.worktrees/pi/0a1b2c3d",
    ]);
  });

  it("asks nothing of a Session without a worktree", async () => {
    const made = () => Promise.reject(new Error("not asked"));

    expect(await lookupDirectory({ machine: "acme", repo: "pi", worktree: null }, made)).toBe(
      "/workspace/pi",
    );
    expect(await lookupDirectory(ROOT_OF_DEFAULT, made)).toBe("/workspace");
  });
});

describe("readyPlacement", () => {
  const IN_WORKTREE: Placement = {
    machine: "acme",
    repo: "pi",
    worktree: { id: "0a1b2c3d", branch: "fix/build" },
  };

  /** A `readyPlacement` of `placed` over a fake clock: the worktrees it prepared, and how to move the clock. */
  const setup = (placed: Placement, prepare: () => Promise<void> = () => Promise.resolve()) => {
    let time = 1_000;
    const prepared: string[] = [];

    const ready = readyPlacement({
      placement: () => Promise.resolve(placed),
      prepare: (machine, worktree) => {
        prepared.push(`${machine}:${worktree.repo}/${worktree.id}@${worktree.branch}`);

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

  it("prepares no worktree for a Session in a main checkout or at the root", async () => {
    for (const placed of [ROOT_OF_DEFAULT, { machine: "acme", repo: "pi", worktree: null }]) {
      const { ready, prepared } = setup(placed);

      expect(await ready()).toEqual(placed);
      expect(prepared).toEqual([]);
    }
  });

  it("prepares the worktree once for callers at once, and again once the check is old", async () => {
    const { ready, prepared, advance } = setup(IN_WORKTREE);

    expect(await Promise.all([ready(), ready()])).toEqual([IN_WORKTREE, IN_WORKTREE]);
    expect(prepared).toEqual(["acme:pi/0a1b2c3d@fix/build"]);

    advance(WORKTREE_CHECKED_FOR - 1);
    await ready();
    expect(prepared).toHaveLength(1);

    advance(1);
    await ready();
    expect(prepared).toHaveLength(2);
  });

  it("fails while the worktree cannot be made, and tries again at the next call", async () => {
    let fail = true;

    const { ready, prepared } = setup(IN_WORKTREE, () =>
      fail ? Promise.reject(new Error("fatal: invalid reference")) : Promise.resolve(),
    );

    await expect(ready()).rejects.toThrow("invalid reference");

    fail = false;

    expect(await ready()).toEqual(IN_WORKTREE);
    expect(prepared).toHaveLength(2);
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
