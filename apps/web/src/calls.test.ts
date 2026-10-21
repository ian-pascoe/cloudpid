import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { describe, expect, it } from "@effect/vitest";
import { callIn, replying } from "./calls.ts";

describe("calls", () => {
  it.effect("answers each of two overlapping calls with its own outcome", () =>
    Effect.gen(function* () {
      const gates = new Map([
        ["first", Deferred.makeUnsafe<void>()],
        ["second", Deferred.makeUnsafe<void>()],
      ]);

      const echo = Atom.fn(
        replying((name: string) =>
          Effect.gen(function* () {
            yield* Deferred.await(gates.get(name)!);

            if (name === "second") return yield* Effect.fail("refused");

            return `${name} done`;
          }),
        ),
        { concurrent: true },
      );

      const registry = AtomRegistry.make();

      registry.mount(echo);

      const first = callIn(registry, echo, "first");
      const second = callIn(registry, echo, "second");

      yield* Deferred.succeed(gates.get("second")!, undefined);

      expect(yield* Effect.promise(() => second)).toEqual(Exit.fail("refused"));

      yield* Deferred.succeed(gates.get("first")!, undefined);

      expect(yield* Effect.promise(() => first)).toEqual(Exit.succeed("first done"));
      registry.dispose();
    }),
  );

  it.effect("answers a call interrupted by the atom's unmount as interrupted", () =>
    Effect.gen(function* () {
      const waits = Atom.fn(
        replying(() => Effect.never),
        { concurrent: true },
      );

      const registry = AtomRegistry.make();
      const unmount = registry.mount(waits);
      const call = callIn(registry, waits, undefined);

      unmount();
      registry.dispose();

      expect(Exit.hasInterrupts(yield* Effect.promise(() => call))).toBe(true);
    }),
  );
});
