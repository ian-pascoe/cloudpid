// The Session's Viewed boxes over storage in memory: ticking and unticking, one box per file of a pull request, the reset a
// refresh of the pull request makes when a file's head blob changed or the file left it, and the limit. The sync to
// clients and the Fork rule run on a Session host, in workerd (`viewed.workerd.test.ts`).
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { type Comparison, MAX_VIEWED, type ViewedFile } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import type { AnnotationStorage } from "./annotations.ts";
import { makeViewedStore } from "./viewed.ts";

const memory = (): AnnotationStorage => {
  const values = new Map<string, unknown>();

  return {
    // SAFETY: each key holds what was put under it, which the caller names the type of.
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key, value) => {
      values.set(key, structuredClone(value));
    },
    delete: (key) => values.delete(key),
  };
};

const store = () => {
  const announced: Array<ReadonlyArray<ViewedFile>> = [];

  return {
    announced,
    viewed: makeViewedStore({
      storage: memory(),
      announce: (viewed) =>
        Effect.sync(() => {
          announced.push(viewed);
        }),
    }),
  };
};

const key = (path: string, pull = 7, repo = "app") => ({ repo, pull, path });

const pullComparison = (
  files: ReadonlyArray<{ path: string; blob?: string }>,
  overrides: Partial<Comparison> = {},
): Comparison => ({
  repo: "app",
  base: "main",
  branch: "topic",
  pull: { number: 7, title: "T", author: "dev", draft: false, state: "open" },
  mergeBase: "a".repeat(40),
  head: "b".repeat(40),
  commits: 1,
  files: files.map(({ path, blob }) => {
    const entry = { path, status: "modified", additions: 1, deletions: 0 } as const;

    return blob === undefined ? entry : { ...entry, blob };
  }),
  more: 0,
  ...overrides,
});

describe("the Viewed boxes", () => {
  it("tick and untick a file of a pull request, each announced, and keep the pull requests apart", async () => {
    const { viewed, announced } = store();

    await Effect.runPromise(viewed.set(key("a.ts"), "blob-a"));
    await Effect.runPromise(viewed.set(key("b.ts"), "blob-b"));
    await Effect.runPromise(viewed.set(key("a.ts", 8), "blob-8"));
    await Effect.runPromise(viewed.set(key("a.ts", 7, "lib"), "blob-lib"));

    expect(await Effect.runPromise(viewed.list)).toEqual([
      { repo: "app", pull: 7, path: "a.ts", blob: "blob-a" },
      { repo: "app", pull: 7, path: "b.ts", blob: "blob-b" },
      { repo: "app", pull: 8, path: "a.ts", blob: "blob-8" },
      { repo: "lib", pull: 7, path: "a.ts", blob: "blob-lib" },
    ]);
    expect(announced).toHaveLength(4);

    await Effect.runPromise(viewed.set(key("a.ts"), null));

    expect(
      (await Effect.runPromise(viewed.list)).map(
        (each) => `${each.repo}#${each.pull} ${each.path}`,
      ),
    ).toEqual(["app#7 b.ts", "app#8 a.ts", "lib#7 a.ts"]);
    expect(announced).toHaveLength(5);

    // Nothing changed, nothing announced: the same tick again, an untick of a box that is not there.
    await Effect.runPromise(viewed.set(key("b.ts"), "blob-b"));
    await Effect.runPromise(viewed.set(key("zzz.ts"), null));
    expect(announced).toHaveLength(5);
  });

  it("takes a new blob in place of the old one when the file is ticked again", async () => {
    const { viewed } = store();

    await Effect.runPromise(viewed.set(key("a.ts"), "one"));
    await Effect.runPromise(viewed.set(key("a.ts"), "two"));

    expect(await Effect.runPromise(viewed.list)).toEqual([
      { repo: "app", pull: 7, path: "a.ts", blob: "two" },
    ]);
  });

  it("refuses a box past the limit, and never an untick", async () => {
    const { viewed } = store();

    // Spread over pull requests of 100 files each, as a Session's would be.
    for (let at = 0; at < MAX_VIEWED; at++) {
      await Effect.runPromise(viewed.set(key(`f${at}.ts`, 1 + Math.floor(at / 100)), "blob"));
    }

    const refused = await Effect.runPromise(viewed.set(key("extra.ts"), "blob").pipe(Effect.flip));

    expect(refused.message).toMatch(/at most 5000 Viewed boxes/);

    // A box already there is edited past it, and any is unticked.
    await Effect.runPromise(viewed.set(key("f0.ts", 1), "newer"));
    await Effect.runPromise(viewed.set(key("f1.ts", 1), null));
    expect(await Effect.runPromise(viewed.list)).toHaveLength(MAX_VIEWED - 1);
  });

  it("refuses a box past the characters the paths may take, and never an untick", async () => {
    const { viewed } = store();
    const long = "p".repeat(4_000);

    // Each box is about 4,000 characters, so 225 of them fill the limit, far below MAX_VIEWED.
    let ticked = 0;
    let refused: string | undefined;

    while (refused === undefined && ticked < MAX_VIEWED) {
      const failure = await Effect.runPromise(
        viewed.set(key(`${long}${ticked}`, 1 + Math.floor(ticked / 100)), "blob").pipe(Effect.flip),
      ).catch(() => undefined);

      if (failure === undefined) ticked++;
      else refused = failure.message;
    }

    expect(ticked).toBeLessThan(MAX_VIEWED);
    expect(refused).toMatch(/characters of paths/);
    expect(await Effect.runPromise(viewed.list)).toHaveLength(ticked);

    await Effect.runPromise(viewed.set(key(`${long}0`, 1), null));
    expect(await Effect.runPromise(viewed.list)).toHaveLength(ticked - 1);
  });

  describe("on a refresh of the pull request", () => {
    it("untick the files whose head blob changed or that left the pull request, and keep the rest", async () => {
      const { viewed, announced } = store();

      await Effect.runPromise(viewed.set(key("same.ts"), "s1"));
      await Effect.runPromise(viewed.set(key("changed.ts"), "c1"));
      await Effect.runPromise(viewed.set(key("gone.ts"), "g1"));
      await Effect.runPromise(viewed.set(key("other.ts", 8), "o1"));

      const before = announced.length;

      await Effect.runPromise(
        viewed.reset(
          pullComparison([
            { path: "same.ts", blob: "s1" },
            { path: "changed.ts", blob: "c2" },
          ]),
        ),
      );

      expect(
        (await Effect.runPromise(viewed.list)).map((each) => `${each.pull} ${each.path}`),
      ).toEqual(["7 same.ts", "8 other.ts"]);
      expect(announced).toHaveLength(before + 1);

      // A refresh that changes nothing says nothing.
      await Effect.runPromise(viewed.reset(pullComparison([{ path: "same.ts", blob: "s1" }])));
      expect(announced).toHaveLength(before + 1);
    });

    it("leaves a file past the list's cap alone, since only a whole list says it left", async () => {
      const { viewed } = store();

      await Effect.runPromise(viewed.set(key("far.ts"), "f1"));
      await Effect.runPromise(viewed.reset(pullComparison([], { more: 3 })));

      expect(await Effect.runPromise(viewed.list)).toHaveLength(1);
    });

    it("changes nothing for a list marked behind, or the branch's Comparison", async () => {
      const { viewed } = store();

      await Effect.runPromise(viewed.set(key("a.ts"), "a1"));

      const changed = [{ path: "a.ts", blob: "a2" }];

      await Effect.runPromise(viewed.reset(pullComparison(changed, { behind: "c".repeat(40) })));

      const { pull: _pull, ...ofBranch } = pullComparison(changed);

      await Effect.runPromise(viewed.reset(ofBranch));

      expect(await Effect.runPromise(viewed.list)).toHaveLength(1);
    });

    it.each((["merged", "closed"] as const).map((state) => [state]))(
      "drops all of a pull request's boxes when it comes back %s, and no other pull request's",
      async (state) => {
        const { viewed, announced } = store();

        await Effect.runPromise(viewed.set(key("a.ts"), "a1"));
        await Effect.runPromise(viewed.set(key("b.ts"), "b1"));
        await Effect.runPromise(viewed.set(key("a.ts", 8), "o1"));

        const before = announced.length;

        const done = pullComparison([{ path: "a.ts", blob: "a1" }], {
          pull: { number: 7, title: "T", author: "dev", draft: false, state },
        });

        await Effect.runPromise(viewed.reset(done));

        expect(
          (await Effect.runPromise(viewed.list)).map((each) => `${each.pull} ${each.path}`),
        ).toEqual(["8 a.ts"]);
        expect(announced).toHaveLength(before + 1);

        // Again: nothing is left to drop, and nothing is announced.
        await Effect.runPromise(viewed.reset(done));
        expect(announced).toHaveLength(before + 1);
      },
    );
  });
});
