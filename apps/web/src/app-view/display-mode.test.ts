// docs/architecture/mcp-apps.md → App Panes (Modes).
/* oxlint-disable anti-slop/no-unknown-parameters -- a View's own `params`, as a case sends them */
// @effect-diagnostics asyncFunction:off -- the handler answers a promise.
import { describe, expect, it, vi } from "vitest";
import { displayModeHandler, displayOf, isFullscreen, modeOfPlace } from "./display-mode.ts";

const context = { signal: new AbortController().signal };

describe("a View's request for a display mode", () => {
  it("is `fullscreen` only in an App Pane", () => {
    expect(modeOfPlace("app-pane")).toBe("fullscreen");
    expect(modeOfPlace("card")).toBe("inline");
    expect(modeOfPlace("subagent-pane")).toBe("inline");
    expect(modeOfPlace("subagent-page")).toBe("inline");
  });

  it("moves a card's View to an App Pane for `fullscreen`, answering the mode it will be in", async () => {
    const move = vi.fn();

    await expect(
      displayModeHandler("card", move)({ mode: "fullscreen" }, context),
    ).resolves.toEqual({
      mode: "fullscreen",
    });
    expect(move).toHaveBeenCalledWith("fullscreen");
  });

  it("moves an App Pane's View back to its card for `inline`", async () => {
    const move = vi.fn();

    await expect(
      displayModeHandler("app-pane", move)({ mode: "inline" }, context),
    ).resolves.toEqual({
      mode: "inline",
    });
    expect(move).toHaveBeenCalledWith("inline");
  });

  it("answers the mode it is in, and moves nothing, for the mode it is in already", async () => {
    const move = vi.fn();

    await expect(displayModeHandler("card", move)({ mode: "inline" }, context)).resolves.toEqual({
      mode: "inline",
    });
    await expect(
      displayModeHandler("app-pane", move)({ mode: "fullscreen" }, context),
    ).resolves.toEqual({ mode: "fullscreen" });
    expect(move).not.toHaveBeenCalled();
  });

  it("refuses `pip`, and anything it does not know, with the current mode", async () => {
    const move = vi.fn();
    const handler = displayModeHandler("card", move);

    await expect(handler({ mode: "pip" }, context)).resolves.toEqual({ mode: "inline" });
    await expect(handler({ mode: 3 }, context)).resolves.toEqual({ mode: "inline" });
    await expect(handler(undefined, context)).resolves.toEqual({ mode: "inline" });
    expect(move).not.toHaveBeenCalled();
  });
});

describe("what a place gives the View it shows", () => {
  const insets = { top: 1, right: 2, bottom: 3, left: 4 };

  it("fixes both axes of an App Pane's View and flexes a card's height, from the one place that says which is which", () => {
    expect(isFullscreen("app-pane")).toBe(true);
    expect(isFullscreen("subagent-pane")).toBe(false);
    expect(displayOf("card", { height: 500, mobile: false, insets: () => insets })).toEqual({
      mode: "inline",
      height: undefined,
      safeAreaInsets: undefined,
    });
    expect(displayOf("app-pane", { height: 500, mobile: false, insets: () => insets })).toEqual({
      mode: "fullscreen",
      height: 500,
      safeAreaInsets: undefined,
    });
  });

  it("gives the safe-area insets only to an App Pane on a phone, which is a sheet there", () => {
    expect(
      displayOf("app-pane", { height: 500, mobile: true, insets: () => insets }),
    ).toMatchObject({
      safeAreaInsets: insets,
    });
    expect(displayOf("card", { height: 500, mobile: true, insets: () => insets })).toMatchObject({
      safeAreaInsets: undefined,
    });
  });
});
