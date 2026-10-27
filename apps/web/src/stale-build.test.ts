import { describe, expect, it } from "vitest";
import {
  handlePreloadError,
  installStaleBuildReload,
  parseStamp,
  RELOAD_GAP_MS,
  staleBuildAction,
  type StaleBuildPage,
} from "./stale-build.ts";

describe("parseStamp", () => {
  it("reads a time, and nothing else", () => {
    expect(parseStamp("1700000000000")).toBe(1_700_000_000_000);
    expect(parseStamp(null)).toBeNull();
    expect(parseStamp(undefined)).toBeNull();
    expect(parseStamp("")).toBeNull();
    expect(parseStamp("  ")).toBeNull();
    expect(parseStamp("soon")).toBeNull();
    expect(parseStamp("Infinity")).toBeNull();
  });
});

describe("staleBuildAction", () => {
  const now = 1_000_000;

  it("reloads when no reload was made", () => {
    expect(staleBuildAction({ lastReloadAt: null, now, unsentText: false })).toBe("reload");
  });

  it("does not reload again within the gap, and does at its end", () => {
    expect(staleBuildAction({ lastReloadAt: now - 1, now, unsentText: false })).toBe("ask");
    expect(staleBuildAction({ lastReloadAt: now, now, unsentText: false })).toBe("ask");
    expect(
      staleBuildAction({ lastReloadAt: now - RELOAD_GAP_MS + 1, now, unsentText: false }),
    ).toBe("ask");
    expect(staleBuildAction({ lastReloadAt: now - RELOAD_GAP_MS, now, unsentText: false })).toBe(
      "reload",
    );
  });

  it("does not reload on a clock that went back", () => {
    expect(staleBuildAction({ lastReloadAt: now + 5_000, now, unsentText: false })).toBe("ask");
  });

  it("asks rather than reload over unsent text", () => {
    expect(staleBuildAction({ lastReloadAt: null, now, unsentText: true })).toBe("ask");
  });
});

/** A page that records what it was told, with its stamp in memory. */
const fakePage = (
  options: { stamp?: string | null; unsentText?: boolean; storageOff?: boolean; now?: number } = {},
) => {
  const state = {
    stamp: options.stamp ?? null,
    reloads: 0,
    prevented: 0,
    listeners: new Set<(event: { preventDefault: () => void }) => void>(),
  };

  const page: StaleBuildPage = {
    now: () => options.now ?? 5_000_000,
    readStamp: () => {
      if (options.storageOff === true) throw new Error("storage is off");

      return state.stamp;
    },
    writeStamp: (value) => {
      if (options.storageOff === true) throw new Error("storage is off");

      state.stamp = value;
    },
    unsentText: () => options.unsentText ?? false,
    reload: () => {
      state.reloads += 1;
    },
    onPreloadError: (listener) => {
      state.listeners.add(listener);

      return () => {
        state.listeners.delete(listener);
      };
    },
  };

  const fire = () => {
    const event = {
      preventDefault: () => {
        state.prevented += 1;
      },
    };

    for (const listener of state.listeners) listener(event);
  };

  return { page, state, fire };
};

describe("handlePreloadError", () => {
  it("reloads once, takes the error over and stamps the time", () => {
    const { page, state } = fakePage();
    const event = { preventDefault: () => (state.prevented += 1) };

    expect(handlePreloadError(page)(event)).toBe("reload");
    expect(state.reloads).toBe(1);
    expect(state.prevented).toBe(1);
    expect(state.stamp).toBe("5000000");
  });

  it("leaves the error to throw when a reload was just made", () => {
    const { page, state } = fakePage({ stamp: "4990000" });
    const event = { preventDefault: () => (state.prevented += 1) };

    expect(handlePreloadError(page)(event)).toBe("ask");
    expect(state.reloads).toBe(0);
    expect(state.prevented).toBe(0);
  });

  it("reloads again once the gap has passed", () => {
    const { page, state } = fakePage({ stamp: String(5_000_000 - RELOAD_GAP_MS) });

    expect(handlePreloadError(page)({ preventDefault: () => undefined })).toBe("reload");
    expect(state.reloads).toBe(1);
  });

  it("leaves the error to throw over unsent text", () => {
    const { page, state } = fakePage({ unsentText: true });
    const event = { preventDefault: () => (state.prevented += 1) };

    expect(handlePreloadError(page)(event)).toBe("ask");
    expect(state.reloads).toBe(0);
    expect(state.prevented).toBe(0);
  });

  it("never reloads where the stamp cannot be kept", () => {
    const { page, state } = fakePage({ storageOff: true });
    const event = { preventDefault: () => (state.prevented += 1) };

    expect(handlePreloadError(page)(event)).toBe("ask");
    expect(state.reloads).toBe(0);
    expect(state.prevented).toBe(0);
  });
});

describe("installStaleBuildReload", () => {
  it("cannot loop: a second failure right after the reload does not reload", () => {
    const { page, state, fire } = fakePage();

    installStaleBuildReload(page);
    fire();
    fire();

    expect(state.reloads).toBe(1);
    expect(state.prevented).toBe(1);
  });

  it("stops listening when undone", () => {
    const { page, state, fire } = fakePage();

    installStaleBuildReload(page)();
    fire();

    expect(state.reloads).toBe(0);
  });
});
