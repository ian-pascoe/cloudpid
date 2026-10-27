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
  isEnvironmentsPath,
  isDraftPath,
  SETTINGS_PATH,
  sessionIdOf,
  sessionPath,
  ENVIRONMENTS_PATH,
  DRAFT_PATH,
  withPaneParams,
  agentIdOf,
  pageOf,
  subagentPath,
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

describe("Subagent page paths", () => {
  it("round-trip a Session ID and an agent's canonical ID, encoded", () => {
    const path = subagentPath("s 1", "agent-1.reviewer");

    expect(path).toBe("/sessions/s%201/agents/agent-1.reviewer");
    expect(agentIdOf(path)).toBe("agent-1.reviewer");
    expect(agentIdOf(subagentPath("a", "agent-2/odd name"))).toBe("agent-2/odd name");
  });

  it("show their Session, as the page is of one of its subagents", () => {
    expect(sessionIdOf(subagentPath("abc", "agent-1"))).toBe("abc");
    expect(sessionIdOf("/sessions/abc/agents/agent-1/")).toBe("abc");
    expect(agentIdOf("/sessions/abc/agents/agent-1/")).toBe("agent-1");
  });

  it("name no subagent on any other path", () => {
    expect(agentIdOf(sessionPath("abc"))).toBeUndefined();
    expect(agentIdOf("/sessions/abc/agents")).toBeUndefined();
    expect(agentIdOf("/sessions/abc/agents/")).toBeUndefined();
    expect(agentIdOf("/sessions/abc/agents/a/b")).toBeUndefined();
    expect(sessionIdOf("/sessions/abc/agents/a/b")).toBeUndefined();
    expect(agentIdOf(SETTINGS_PATH)).toBeUndefined();
  });

  it("are a page of their own kind", () => {
    expect(pageOf(subagentPath("abc", "agent-1"))).toEqual({
      kind: "subagent",
      sessionId: "abc",
      agentId: "agent-1",
    });
    expect(pageOf(sessionPath("abc"))).toEqual({ kind: "session", sessionId: "abc" });
  });

  it("keep a path that cannot be decoded from showing anything", () => {
    expect(pageOf("/sessions/abc/agents/%E0%A4%A")).toEqual({ kind: "empty" });
    expect(pageOf("/sessions/%E0%A4%A")).toEqual({ kind: "empty" });
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

describe("the Environments path", () => {
  it("shows the Environments, and no Session or settings", () => {
    expect(isEnvironmentsPath(ENVIRONMENTS_PATH)).toBe(true);
    expect(isEnvironmentsPath("/environments/")).toBe(true);
    expect(isEnvironmentsPath("/environments/x")).toBe(false);
    expect(isEnvironmentsPath("/sessions/environments")).toBe(false);
    expect(sessionIdOf(ENVIRONMENTS_PATH)).toBeUndefined();
    expect(isSettingsPath(ENVIRONMENTS_PATH)).toBe(false);
  });
});

describe("the draft path", () => {
  it("shows the draft, and no Session, settings or Environments", () => {
    expect(isDraftPath(DRAFT_PATH)).toBe(true);
    expect(isDraftPath("/new/")).toBe(true);
    expect(isDraftPath("/new/x")).toBe(false);
    expect(isDraftPath("/sessions/new")).toBe(false);
    expect(sessionIdOf(DRAFT_PATH)).toBeUndefined();
    expect(isSettingsPath(DRAFT_PATH)).toBe(false);
    expect(isEnvironmentsPath(DRAFT_PATH)).toBe(false);
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

    registry.set(pathAtom, ENVIRONMENTS_PATH);
    expect(registry.get(pageAtom)).toEqual({ kind: "environments" });

    registry.set(pathAtom, DRAFT_PATH);
    expect(registry.get(pageAtom)).toEqual({ kind: "draft" });

    browser.back();
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
    expect(paneParamsOf("")).toEqual({ keys: [], shown: undefined, hidden: false });
    expect(paneParamsOf("?pane=tasks")).toEqual({
      keys: ["tasks"],
      shown: undefined,
      hidden: false,
    });
    expect(paneParamsOf("?pane=tasks&pane=terminal:1&shown=terminal:1")).toEqual({
      keys: ["tasks", "terminal:1"],
      shown: "terminal:1",
      hidden: false,
    });
  });

  it("say the area is hidden with `panes=hidden`", () => {
    expect(paneParamsOf("?pane=tasks&panes=hidden").hidden).toBe(true);
    expect(paneParamsOf("?pane=tasks&panes=shown").hidden).toBe(false);
    expect(withPaneParams("", { keys: ["tasks"], shown: "tasks", hidden: true })).toBe(
      "?pane=tasks&panes=hidden",
    );
    // Nothing to hide without a Pane.
    expect(withPaneParams("?panes=hidden", { keys: [], shown: undefined, hidden: true })).toBe("");
  });

  it("read a key whether its colon is escaped or not", () => {
    expect(paneParamsOf("?pane=live-view%3Aabc&pane=terminal:1").keys).toEqual([
      "live-view:abc",
      "terminal:1",
    ]);
  });

  it("are written with the colon as it is, and `shown` only when it is not the first", () => {
    expect(withPaneParams("", { keys: ["tasks"], shown: "tasks", hidden: false })).toBe(
      "?pane=tasks",
    );
    expect(
      withPaneParams("", { keys: ["tasks", "terminal:1"], shown: "tasks", hidden: false }),
    ).toBe("?pane=tasks&pane=terminal:1");
    expect(
      withPaneParams("", { keys: ["tasks", "terminal:1"], shown: "terminal:1", hidden: false }),
    ).toBe("?pane=tasks&pane=terminal:1&shown=terminal:1");
  });

  it("are written encoded when a key holds more than letters", () => {
    expect(withPaneParams("", { keys: ["live-view:a b&c"], shown: undefined, hidden: false })).toBe(
      "?pane=live-view:a%20b%26c",
    );
    expect(paneParamsOf("?pane=live-view:a%20b%26c").keys).toEqual(["live-view:a b&c"]);
  });

  it("are replaced in a query that has other parameters, which stay", () => {
    expect(
      withPaneParams("?x=1&pane=old&shown=old&panes=hidden&y=two", {
        keys: ["tasks"],
        shown: "tasks",
        hidden: false,
      }),
    ).toBe("?x=1&y=two&pane=tasks");
  });

  it("leave no query when none is left", () => {
    const none = { keys: [], shown: undefined, hidden: false };

    expect(withPaneParams("?pane=tasks&shown=tasks", none)).toBe("");
    expect(withPaneParams("?pane=tasks&x=1", none)).toBe("?x=1");
  });
});
