// How many composers of a conversation are mounted: a View's message is refused where none is (`app-view/shown-in.ts`).
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { describe, expect, it } from "vitest";
import { composerMountsAtom, countMount } from "./composer-mounts.ts";
import { conversationKey } from "./conversation.ts";

const ROOT = conversationKey("s1", undefined);
const THREAD = conversationKey("s1", 4);

describe("the composers mounted", () => {
  it("count each composer of a conversation while it is mounted, and no other conversation's", () => {
    const registry = AtomRegistry.make();

    expect(registry.get(composerMountsAtom(ROOT))).toBe(0);

    const first = countMount(registry, ROOT);
    const second = countMount(registry, ROOT);

    expect(registry.get(composerMountsAtom(ROOT))).toBe(2);
    expect(registry.get(composerMountsAtom(THREAD))).toBe(0);

    first();
    expect(registry.get(composerMountsAtom(ROOT))).toBe(1);
    second();
    expect(registry.get(composerMountsAtom(ROOT))).toBe(0);
  });
});
