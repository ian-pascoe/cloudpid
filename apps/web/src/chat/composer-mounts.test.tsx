// @vitest-environment happy-dom
// The hook a composer counts itself mounted with: one while it is mounted, none once it is gone.
import { RegistryContext } from "@effect/atom-react";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { composerMountsAtom, useComposerMounted } from "./composer-mounts.ts";
import { conversationKey } from "./conversation.ts";

const ROOT = conversationKey("s1", undefined);

const Probe = () => {
  useComposerMounted(ROOT);

  return null;
};

describe("useComposerMounted", () => {
  it("counts the composer while it is mounted, and no longer once it unmounts", () => {
    // @ts-expect-error -- React's act environment flag, which happy-dom does not set.
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;

    const registry = AtomRegistry.make();
    const root = createRoot(document.createElement("div"));

    act(() => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <Probe />
        </RegistryContext.Provider>,
      );
    });
    expect(registry.get(composerMountsAtom(ROOT))).toBe(1);

    act(() => {
      root.unmount();
    });
    expect(registry.get(composerMountsAtom(ROOT))).toBe(0);
  });
});
