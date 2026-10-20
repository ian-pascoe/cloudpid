// @effect-diagnostics asyncFunction:off
import { DEFAULT_WORKSPACE } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { cachedPlacement, type Placement } from "./workspace.ts";

const ROOT_OF_DEFAULT: Placement = { slug: DEFAULT_WORKSPACE, repo: null };

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
    const acme: Placement = { slug: "acme", repo: "pi" };
    const { placement, asked, kept } = setup("s1", () => Promise.resolve(acme));

    expect(await placement()).toEqual(acme);
    expect(await placement()).toEqual(acme);
    expect(asked).toEqual(["s1"]);
    expect(kept()).toEqual(acme);
  });

  it("answers from what is kept without asking", async () => {
    const acme: Placement = { slug: "acme", repo: null };

    const { placement, asked } = setup(
      "s1",
      () => Promise.resolve({ slug: "other", repo: null }),
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

    answer = { slug: "acme", repo: "pi" };

    expect(await placement()).toEqual({ slug: "acme", repo: "pi" });
    expect(asked).toEqual(["s1", "s1"]);
  });

  it("works at the root of the default Workspace for a Session whose name is unknown, without asking", async () => {
    const { placement, asked, kept } = setup(undefined, () =>
      Promise.resolve({ slug: "acme", repo: null }),
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
        : Promise.resolve({ slug: "acme", repo: null }),
    );

    await expect(placement()).rejects.toThrow("registry down");
    expect(kept()).toBeUndefined();

    fail = false;

    expect(await placement()).toEqual({ slug: "acme", repo: null });
    expect(asked).toEqual(["s1", "s1"]);
  });
});
