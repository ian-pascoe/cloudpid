import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubWindow } from "./router.testing.ts";
import {
  navigate,
  pageAtom,
  paneParamsOf,
  pathAtom,
  replaceSearch,
  searchAtom,
  sessionIdAtom,
  isSettingsPath,
  isMachinesPath,
  SETTINGS_PATH,
  sessionIdOf,
  sessionPath,
  MACHINES_PATH,
  withPaneParams,
} from "./router.ts";

describe("Session paths", () => {
  it("round-trip a Session ID", () => {
    expect(sessionIdOf(sessionPath("0198f0a2-7b1c-7000-8000-000000000001"))).toBe(
      "0198f0a2-7b1c-7000-8000-000000000001",
    );
  });

  it("are the only paths that show a Session", () => {
    expect(sessionIdOf("/")).toBeUndefined();
    expect(sessionIdOf("/sessions")).toBeUndefined();
    expect(sessionIdOf("/sessions/abc/socket")).toBeUndefined();
    expect(sessionIdOf("/sessions/abc/")).toBe("abc");
  });
});

describe("the settings path", () => {
  it("shows the settings, and no Session", () => {
    expect(isSettingsPath(SETTINGS_PATH)).toBe(true);
    expect(isSettingsPath("/settings/")).toBe(true);
    expect(isSettingsPath("/settings/x")).toBe(false);
    expect(isSettingsPath("/sessions/settings")).toBe(false);
    expect(sessionIdOf(SETTINGS_PATH)).toBeUndefined();
  });
});

describe("the Machines path", () => {
  it("shows the Machines, and no Session or settings", () => {
    expect(isMachinesPath(MACHINES_PATH)).toBe(true);
    expect(isMachinesPath("/machines/")).toBe(true);
    expect(isMachinesPath("/machines/x")).toBe(false);
    expect(isMachinesPath("/sessions/machines")).toBe(false);
    expect(sessionIdOf(MACHINES_PATH)).toBeUndefined();
    expect(isSettingsPath(MACHINES_PATH)).toBe(false);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the page's path", () => {
  it("follows navigate and the browser's back and forward buttons", () => {
    const browser = stubWindow("/");
    const registry = AtomRegistry.make();

    registry.mount(pathAtom);
    expect(registry.get(pathAtom)).toBe("/");

    navigate(sessionPath("a"));
    expect(registry.get(sessionIdAtom)).toBe("a");

    registry.set(pathAtom, SETTINGS_PATH);
    expect(registry.get(pageAtom)).toEqual({ kind: "settings" });

    browser.back();
    expect(registry.get(pageAtom)).toEqual({ kind: "session", sessionId: "a" });

    browser.forward();
    expect(registry.get(pageAtom)).toEqual({ kind: "settings" });

    registry.set(pathAtom, MACHINES_PATH);
    expect(registry.get(pageAtom)).toEqual({ kind: "machines" });

    browser.back();
    browser.back();
    browser.back();
    expect(registry.get(pageAtom)).toEqual({ kind: "empty" });
  });

  it("ignores the query", () => {
    stubWindow("/sessions/a?pane=tasks");
    const registry = AtomRegistry.make();

    registry.mount(pathAtom);

    expect(registry.get(pathAtom)).toBe("/sessions/a");
    expect(registry.get(sessionIdAtom)).toBe("a");
  });

  it("drops the query when the page moves, as the Panes belong to one Session", () => {
    const browser = stubWindow("/sessions/a?pane=tasks");

    navigate(sessionPath("b"));

    expect(browser.history()).toEqual({
      entries: ["/sessions/a?pane=tasks", "/sessions/b"],
      at: 1,
    });
  });
});

describe("the page's query", () => {
  it("follows replaceSearch and the browser's back and forward buttons", () => {
    const browser = stubWindow("/sessions/a");
    const registry = AtomRegistry.make();

    registry.mount(searchAtom);
    expect(registry.get(searchAtom)).toBe("");

    navigate("/sessions/a?x=1");
    expect(registry.get(searchAtom)).toBe("?x=1");

    replaceSearch("?pane=tasks");
    expect(registry.get(searchAtom)).toBe("?pane=tasks");

    registry.set(searchAtom, "?pane=tasks&x=1");
    expect(registry.get(searchAtom)).toBe("?pane=tasks&x=1");

    browser.back();
    expect(registry.get(searchAtom)).toBe("");
    browser.forward();
    expect(registry.get(searchAtom)).toBe("?pane=tasks&x=1");
  });

  it("replaces the history entry instead of adding one, and keeps the path", () => {
    const browser = stubWindow("/sessions/a");

    replaceSearch("?pane=tasks");
    replaceSearch("?pane=tasks&pane=terminal:1");

    expect(browser.history()).toEqual({
      entries: ["/sessions/a?pane=tasks&pane=terminal:1"],
      at: 0,
    });
  });

  it("holds what is written without a window", () => {
    const registry = AtomRegistry.make();

    registry.set(searchAtom, "?pane=tasks");

    expect(registry.get(searchAtom)).toBe("?pane=tasks");
  });
});

describe("the Pane parameters of a query", () => {
  it("are the repeated `pane` values in order, and the `shown` one", () => {
    expect(paneParamsOf("")).toEqual({ keys: [], shown: undefined });
    expect(paneParamsOf("?pane=tasks")).toEqual({ keys: ["tasks"], shown: undefined });
    expect(paneParamsOf("?pane=tasks&pane=terminal:1&shown=terminal:1")).toEqual({
      keys: ["tasks", "terminal:1"],
      shown: "terminal:1",
    });
  });

  it("read a key whether its colon is escaped or not", () => {
    expect(paneParamsOf("?pane=live-view%3Aabc&pane=terminal:1").keys).toEqual([
      "live-view:abc",
      "terminal:1",
    ]);
  });

  it("are written with the colon as it is, and `shown` only when it is not the first", () => {
    expect(withPaneParams("", { keys: ["tasks"], shown: "tasks" })).toBe("?pane=tasks");
    expect(withPaneParams("", { keys: ["tasks", "terminal:1"], shown: "tasks" })).toBe(
      "?pane=tasks&pane=terminal:1",
    );
    expect(withPaneParams("", { keys: ["tasks", "terminal:1"], shown: "terminal:1" })).toBe(
      "?pane=tasks&pane=terminal:1&shown=terminal:1",
    );
  });

  it("are written encoded when a key holds more than letters", () => {
    expect(withPaneParams("", { keys: ["live-view:a b&c"], shown: undefined })).toBe(
      "?pane=live-view:a%20b%26c",
    );
    expect(paneParamsOf("?pane=live-view:a%20b%26c").keys).toEqual(["live-view:a b&c"]);
  });

  it("are replaced in a query that has other parameters, which stay", () => {
    expect(
      withPaneParams("?x=1&pane=old&shown=old&y=two", { keys: ["tasks"], shown: "tasks" }),
    ).toBe("?x=1&y=two&pane=tasks");
  });

  it("leave no query when none is left", () => {
    expect(withPaneParams("?pane=tasks&shown=tasks", { keys: [], shown: undefined })).toBe("");
    expect(withPaneParams("?pane=tasks&x=1", { keys: [], shown: undefined })).toBe("?x=1");
  });
});
