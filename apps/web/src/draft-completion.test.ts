// @effect-diagnostics preferEffectArray:off -- in-memory fakes recording what they were asked in native arrays.

import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { draftCompleteAtom, readingOldWorker } from "./draft-completion.ts";
import { RegistryClient } from "./registry.ts";
import { fakeRegistryLayer, settled } from "./registry.testing.ts";

const OK = { status: "ok", values: ["acme"], hasMore: false } as const;

describe("the draft composer's completions", () => {
  it.effect("ask the Registry for the server's suggestions, in the draft's Environment", () =>
    Effect.gen(function* () {
      const asked: unknown[] = [];

      const registry = AtomRegistry.make({
        initialValues: [
          Atom.initialValue(
            RegistryClient.runtime.layer,
            fakeRegistryLayer({
              draftComplete: (payload) =>
                Effect.sync(() => {
                  asked.push(payload);

                  return OK;
                }),
            }),
          ),
        ],
      });

      registry.mount(draftCompleteAtom);

      const ask = yield* settled(registry, draftCompleteAtom);

      expect(AsyncResult.isSuccess(ask)).toBe(true);

      if (!AsyncResult.isSuccess(ask)) return;

      const payload = {
        environment: "work",
        server: "linear",
        ref: { type: "ref/prompt", name: "review" } as const,
        argument: { name: "owner", value: "ac" },
      };

      expect(yield* ask.value(payload)).toEqual(OK);
      expect(asked).toEqual([payload]);
    }),
  );

  it.effect("read a Worker from before the RPC, which answers a defect, as unsupported", () =>
    Effect.gen(function* () {
      expect(yield* readingOldWorker(Effect.die("Unknown request tag: draftComplete"))).toEqual({
        status: "unsupported",
        values: [],
        hasMore: false,
      });
      expect(
        yield* readingOldWorker(Effect.die(new Error("Unknown request tag: draftComplete"))),
      ).toMatchObject({ status: "unsupported" });
    }),
  );

  it.effect("leave every other failure to the form, which says suggestions are unavailable", () =>
    Effect.gen(function* () {
      const exit = yield* readingOldWorker(Effect.die("boom")).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty)).toContain("boom");
    }),
  );
});
