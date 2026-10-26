// @effect-diagnostics preferEffectArray:off -- the fakes record what they were asked in native arrays.
import type { ChangeEntry, ChangeFile } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ChangeFileQuery } from "../session/atoms.ts";
import { lineUp } from "./line-up.ts";
import { fileLoader, type WantedFile } from "./loader.ts";
import { paneFilesOf, type PaneFile } from "./pane-files.ts";

const entry = (path: string, additions = 1): ChangeEntry => ({
  path,
  status: "modified",
  additions,
  deletions: 1,
});

const filesOf = (entries: readonly ChangeEntry[]): readonly PaneFile[] =>
  paneFilesOf([
    { repo: "web", head: { commit: "abc", branch: "main" }, files: entries, more: 0, stale: false },
  ]);

const wanted = (files: readonly PaneFile[], listing = 1, inView = false): WantedFile[] =>
  files.map((file) => ({ file, signature: file.signature, listing, inView }));

/** A Session whose `change_file` answers each ask when the test says, recording the asks. */
const fakeSession = () => {
  const asks: { readonly path: string; readonly answer: Deferred.Deferred<ChangeFile> }[] = [];
  const interrupted: string[] = [];

  const changeFile = (query: ChangeFileQuery) =>
    Effect.suspend(() => {
      const answer = Deferred.makeUnsafe<ChangeFile>();

      asks.push({ path: query.path, answer });

      return Deferred.await(answer).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted.push(query.path);
          }),
        ),
      );
    });

  const answer = (path: string, oldText: string, newText: string) =>
    Deferred.succeed(asks.findLast((ask) => ask.path === path)!.answer, {
      old: { kind: "text", text: oldText },
      new: { kind: "text", text: newText },
    });

  return { asks, interrupted, changeFile, answer };
};

const services = (session: ReturnType<typeof fakeSession>) => ({
  changeFile: session.changeFile,
  lineUp: (request: Parameters<typeof lineUp>[0]) => Effect.sync(() => lineUp(request)),
});

const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));

describe("the Diff pane's loader", () => {
  it.effect("loads at most 4 files at once, the first wanted first, and the next as one ends", () =>
    Effect.gen(function* () {
      const session = fakeSession();
      const loader = yield* fileLoader(services(session));
      const files = filesOf(["a", "b", "c", "d", "e", "f"].map((name) => entry(`${name}.ts`)));

      yield* loader.want(wanted(files));
      yield* settle;
      expect(session.asks.map((ask) => ask.path)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
      expect((yield* SubscriptionRef.get(loader.loads)).loading.size).toBe(4);

      yield* session.answer("b.ts", "x\n", "y\n");
      yield* settle;

      const loads = yield* SubscriptionRef.get(loader.loads);

      expect(loads.loaded.get("web/b.ts")?.contents.kind).toBe("ready");
      expect(session.asks.map((ask) => ask.path)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops a load whose file is no longer wanted", () =>
    Effect.gen(function* () {
      const session = fakeSession();
      const loader = yield* fileLoader(services(session));
      const files = filesOf([entry("a.ts"), entry("b.ts")]);

      yield* loader.want(wanted(files));
      yield* settle;
      yield* loader.want(wanted(files.slice(1)));
      yield* settle;

      expect(session.interrupted).toEqual(["a.ts"]);
      expect((yield* SubscriptionRef.get(loader.loads)).loading).toEqual(new Set(["web/b.ts"]));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "asks again after a new list only for a changed file, or one in view, and keeps the drawing of the same text",
    () =>
      Effect.gen(function* () {
        const session = fakeSession();
        const loader = yield* fileLoader(services(session));
        const first = filesOf([entry("a.ts"), entry("b.ts"), entry("c.ts")]);

        yield* loader.want(wanted(first));
        yield* settle;

        for (const path of ["a.ts", "b.ts", "c.ts"]) yield* session.answer(path, "x\n", "y\n");

        yield* settle;

        const drawn = (yield* SubscriptionRef.get(loader.loads)).loaded.get("web/b.ts")?.contents;
        // A new list: a.ts changed, b.ts is the same and in view, c.ts is the same and out of view.
        const second = filesOf([entry("a.ts", 2), entry("b.ts"), entry("c.ts")]);

        yield* loader.want([
          { file: second[0]!, signature: second[0]!.signature, listing: 2, inView: false },
          { file: second[1]!, signature: second[1]!.signature, listing: 2, inView: true },
          { file: second[2]!, signature: second[2]!.signature, listing: 2, inView: false },
        ]);
        yield* settle;
        expect(session.asks.slice(3).map((ask) => ask.path)).toEqual(["a.ts", "b.ts"]);

        yield* session.answer("b.ts", "x\n", "y\n");
        yield* settle;
        expect((yield* SubscriptionRef.get(loader.loads)).loaded.get("web/b.ts")?.contents).toBe(
          drawn,
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "shows why a file could not be loaded, and does not ask again for the same change",
    () =>
      Effect.gen(function* () {
        const session = fakeSession();

        const loader = yield* fileLoader({
          ...services(session),
          changeFile: () => Effect.fail({ message: "the Container is stopped" }),
        });

        const files = filesOf([entry("a.ts")]);

        yield* loader.want(wanted(files));
        yield* settle;
        yield* loader.want(wanted(files));
        yield* settle;

        expect((yield* SubscriptionRef.get(loader.loads)).loaded.get("web/a.ts")?.contents).toEqual(
          {
            kind: "failed",
            message: "the Container is stopped",
          },
        );
      }).pipe(Effect.scoped),
  );
});
