// docs/architecture/mcp-apps.md → App Views in the transcript (Remounting, Teardown). What asks the Views of a page to tear down
// before an unmount the page drives, without a DOM: the Views are stand-ins that count what they are told.
// @effect-diagnostics newPromise:off asyncFunction:off -- stand-ins that hold a promise open and let it go.
import { describe, expect, it, vi } from "vitest";
import type { AppPlace } from "./places.ts";
import { afterBranchTeardown, ViewRegistry } from "./teardown.ts";

/** A View that answers its teardown when `answer` is called. */
const view = (registry: ViewRegistry, callId: string, place: AppPlace = "card") => {
  let answer: () => void = () => undefined;

  const retire = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        answer = resolve;
      }),
  );

  const restart = vi.fn();
  const forget = registry.register({ callId, place, element: () => null, retire, restart });

  return { retire, restart, forget, answer: () => answer() };
};

describe("afterBranchTeardown", () => {
  it("tears down the Views whose call the branch drops, and unmounts after they have answered", async () => {
    const registry = new ViewRegistry();
    const dropped = view(registry, "gone");
    const action = vi.fn(() => Promise.resolve(true));

    afterBranchTeardown(new Set(["gone"]), action, registry);

    expect(dropped.retire).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();

    dropped.answer();
    await vi.waitFor(() => {
      expect(action).toHaveBeenCalledTimes(1);
    });
    expect(dropped.restart).not.toHaveBeenCalled();
  });

  it("leaves a View whose call the branch keeps alone: not torn down, not restarted", async () => {
    const registry = new ViewRegistry();
    const kept = view(registry, "kept");
    const dropped = view(registry, "gone");
    const action = vi.fn(() => Promise.resolve(true));

    afterBranchTeardown(new Set(["gone"]), action, registry);
    dropped.answer();
    await vi.waitFor(() => {
      expect(action).toHaveBeenCalled();
    });

    expect(kept.retire).not.toHaveBeenCalled();
    expect(kept.restart).not.toHaveBeenCalled();
  });

  it("leaves an App Pane's View alone, whatever the branch holds", async () => {
    const registry = new ViewRegistry();
    const pane = view(registry, "gone", "app-pane");
    const action = vi.fn(() => Promise.resolve(true));

    afterBranchTeardown(new Set(["gone"]), action, registry);

    await vi.waitFor(() => {
      expect(action).toHaveBeenCalledTimes(1);
    });
    expect(pane.retire).not.toHaveBeenCalled();
  });

  it("goes at once when no View is dropped", () => {
    const registry = new ViewRegistry();
    const action = vi.fn(() => Promise.resolve(true));

    view(registry, "kept");
    afterBranchTeardown(new Set(), action, registry);

    expect(action).toHaveBeenCalledTimes(1);
  });

  it("makes the Views it tore down again when the move did not happen", async () => {
    const registry = new ViewRegistry();
    const dropped = view(registry, "gone");
    const refused = vi.fn(() => Promise.resolve(false));

    afterBranchTeardown(new Set(["gone"]), refused, registry);
    dropped.answer();

    await vi.waitFor(() => {
      expect(dropped.restart).toHaveBeenCalledTimes(1);
    });

    const failed = view(registry, "other");
    const broke = vi.fn(() => Promise.reject(new Error("no")));

    afterBranchTeardown(new Set(["other"]), broke, registry);
    failed.answer();

    await vi.waitFor(() => {
      expect(failed.restart).toHaveBeenCalledTimes(1);
    });
  });
});
