import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  navigate,
  pageAtom,
  pathAtom,
  sessionIdAtom,
  isSettingsPath,
  isWorkspacesPath,
  SETTINGS_PATH,
  sessionIdOf,
  sessionPath,
  WORKSPACES_PATH,
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

describe("the Workspaces path", () => {
  it("shows the Workspaces, and no Session or settings", () => {
    expect(isWorkspacesPath(WORKSPACES_PATH)).toBe(true);
    expect(isWorkspacesPath("/workspaces/")).toBe(true);
    expect(isWorkspacesPath("/workspaces/x")).toBe(false);
    expect(isWorkspacesPath("/sessions/workspaces")).toBe(false);
    expect(sessionIdOf(WORKSPACES_PATH)).toBeUndefined();
    expect(isSettingsPath(WORKSPACES_PATH)).toBe(false);
  });
});

/** A window whose history the test drives: `navigate` and the back button both reach `pathAtom`. */
const stubWindow = (pathname: string) => {
  const page = Object.assign(new EventTarget(), {
    location: { pathname },
    history: {
      pushState: (_state: null, _title: string, path: string) => {
        page.location.pathname = path;
      },
    },
  });

  vi.stubGlobal("window", page);
  vi.stubGlobal("PopStateEvent", class extends Event {});

  return {
    back: (path: string) => {
      page.location.pathname = path;
      page.dispatchEvent(new Event("popstate"));
    },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the page's path", () => {
  it("follows navigate and the browser's back and forward buttons", () => {
    const history = stubWindow("/");
    const registry = AtomRegistry.make();

    registry.mount(pathAtom);
    expect(registry.get(pathAtom)).toBe("/");

    navigate(sessionPath("a"));
    expect(registry.get(sessionIdAtom)).toBe("a");

    registry.set(pathAtom, SETTINGS_PATH);
    expect(registry.get(pageAtom)).toEqual({ kind: "settings" });

    history.back("/sessions/a");
    expect(registry.get(pageAtom)).toEqual({ kind: "session", sessionId: "a" });

    history.back(WORKSPACES_PATH);
    expect(registry.get(pageAtom)).toEqual({ kind: "workspaces" });

    history.back("/");
    expect(registry.get(pageAtom)).toEqual({ kind: "empty" });
  });
});
