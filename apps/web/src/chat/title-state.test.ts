// @effect-diagnostics preferEffectArray:off -- a fake rename recording what it saved in a native array.

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { settledFailureOf } from "../registry.ts";
import { settled } from "../registry.testing.ts";
import { type Rename, saveTitleAtom, titleDraftAtom } from "./title-state.ts";

/** A rename of a Session titled `current` that refuses `refused`, and the titles it saved. */
const renaming = (current: string) => {
  const saved: string[] = [];

  const rename: Rename = {
    current,
    save: (title) => {
      if (title === "refused") return Promise.resolve("No such session.");

      saved.push(title);

      return Promise.resolve(null);
    },
  };

  return { rename, saved };
};

const typing = (registry: AtomRegistry.AtomRegistry, draft: string) => {
  registry.mount(saveTitleAtom("s1"));
  registry.set(titleDraftAtom("s1"), draft);
};

describe("renaming a Session in place", () => {
  it.effect("saves the trimmed title and closes the field", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const { rename, saved } = renaming("Old");

      typing(registry, "  New  ");
      registry.set(saveTitleAtom("s1"), rename);
      yield* settled(registry, saveTitleAtom("s1"));

      expect(saved).toEqual(["New"]);
      expect(registry.get(titleDraftAtom("s1"))).toBe(null);
    }),
  );

  it.effect("only closes the field for a blank or unchanged title", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const { rename, saved } = renaming("Old");

      typing(registry, " Old ");
      registry.set(saveTitleAtom("s1"), rename);
      yield* settled(registry, saveTitleAtom("s1"));

      typing(registry, "   ");
      registry.set(saveTitleAtom("s1"), rename);
      yield* settled(registry, saveTitleAtom("s1"));

      expect(saved).toEqual([]);
      expect(registry.get(titleDraftAtom("s1"))).toBe(null);
    }),
  );

  it.effect("keeps the field open, saying why, when the save is refused, until reset", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const { rename } = renaming("Old");

      typing(registry, "refused");
      registry.set(saveTitleAtom("s1"), rename);

      expect(settledFailureOf(yield* settled(registry, saveTitleAtom("s1")))).toBe(
        "No such session.",
      );
      expect(registry.get(titleDraftAtom("s1"))).toBe("refused");

      registry.set(saveTitleAtom("s1"), Atom.Reset);

      expect(settledFailureOf(registry.get(saveTitleAtom("s1")))).toBe(null);
    }),
  );

  it.effect("saves nothing once the field is closed, as when it blurs on closing", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const { rename, saved } = renaming("Old");

      typing(registry, "New");
      registry.set(titleDraftAtom("s1"), null);
      registry.set(saveTitleAtom("s1"), rename);
      yield* settled(registry, saveTitleAtom("s1"));

      expect(saved).toEqual([]);
    }),
  );
});
