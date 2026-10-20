import { describe, expect, it } from "vitest";
import {
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
