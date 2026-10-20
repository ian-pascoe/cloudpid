// @effect-diagnostics asyncFunction:off
import { DEFAULT_WORKSPACE } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { cachedSlug } from "./workspace.ts";

/** A `cachedSlug` over an in-memory cache, and the names its lookup was asked for. */
const setup = (
  name: string | undefined,
  answer: (name: string) => Promise<string | null>,
  initial?: string,
) => {
  let kept = initial;
  const asked: string[] = [];

  const slug = cachedSlug({
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

  return { slug, asked, kept: () => kept };
};

describe("cachedSlug", () => {
  it("asks the Registry once for a listed Session, and keeps the answer", async () => {
    const { slug, asked, kept } = setup("s1", () => Promise.resolve("acme"));

    expect(await slug()).toBe("acme");
    expect(await slug()).toBe("acme");
    expect(asked).toEqual(["s1"]);
    expect(kept()).toBe("acme");
  });

  it("answers from what is kept without asking", async () => {
    const { slug, asked } = setup("s1", () => Promise.resolve("other"), "acme");

    expect(await slug()).toBe("acme");
    expect(asked).toEqual([]);
  });

  it("works on the default Workspace for a Session the Registry does not list, and asks again", async () => {
    let answer: string | null = null;
    const { slug, asked, kept } = setup("s1", () => Promise.resolve(answer));

    expect(await slug()).toBe(DEFAULT_WORKSPACE);
    expect(kept()).toBeUndefined();

    answer = "acme";

    expect(await slug()).toBe("acme");
    expect(asked).toEqual(["s1", "s1"]);
  });

  it("works on the default Workspace for a Session whose name is unknown, without asking", async () => {
    const { slug, asked, kept } = setup(undefined, () => Promise.resolve("acme"));

    expect(await slug()).toBe(DEFAULT_WORKSPACE);
    expect(asked).toEqual([]);
    expect(kept()).toBeUndefined();
  });

  it("fails when the lookup does, keeps nothing, and asks again", async () => {
    let fail = true;

    const { slug, asked, kept } = setup("s1", () =>
      fail ? Promise.reject(new Error("registry down")) : Promise.resolve("acme"),
    );

    await expect(slug()).rejects.toThrow("registry down");
    expect(kept()).toBeUndefined();

    fail = false;

    expect(await slug()).toBe("acme");
    expect(asked).toEqual(["s1", "s1"]);
  });
});
