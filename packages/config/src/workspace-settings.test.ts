import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  ignorePatternProblem,
  INSTANCE_TYPES,
  MAX_IGNORE_PATTERNS,
  resolveWorkspaceSettings,
  resolveWorkspaceSettingsLeniently,
  workspaceOverridesFrom,
  type WorkspaceSettings,
} from "./workspace-settings.ts";

const resolved = (overrides: Schema.Json): WorkspaceSettings => {
  const result = resolveWorkspaceSettings(overrides);

  if (Result.isFailure(result)) throw new Error(result.failure.message);

  return result.success;
};

const rejected = (overrides: Schema.Json): string => {
  const result = resolveWorkspaceSettings(overrides);

  if (Result.isSuccess(result)) throw new Error("Expected the overrides to be rejected");

  return result.failure.message;
};

describe("the defaults", () => {
  it("are standard-2 and a 15-minute idle stop, as the spec says", () => {
    expect(DEFAULT_WORKSPACE_SETTINGS).toEqual({
      instance: "standard-2",
      idleMinutes: 15,
      ignore: [],
    });
  });

  it("are what no overrides resolve to", () => {
    expect(resolved({})).toEqual(DEFAULT_WORKSPACE_SETTINGS);
  });
});

describe("resolveWorkspaceSettings", () => {
  it("gives each override over the default, and leaves the rest", () => {
    expect(resolved({ instance: "basic" })).toEqual({
      instance: "basic",
      idleMinutes: 15,
      ignore: [],
    });
    expect(resolved({ idleMinutes: 90 })).toEqual({
      instance: "standard-2",
      idleMinutes: 90,
      ignore: [],
    });
  });

  it("accepts every instance type Cloudflare Containers offers", () => {
    for (const instance of INSTANCE_TYPES) expect(resolved({ instance }).instance).toBe(instance);
  });

  it("rejects an instance type Cloudflare does not offer", () => {
    expect(rejected({ instance: "standard-9" })).toContain("instance");
  });

  it("rejects an idle time that is not a whole number of minutes between 1 and a day", () => {
    expect(rejected({ idleMinutes: 0 })).toContain("idleMinutes");
    expect(rejected({ idleMinutes: -5 })).toContain("idleMinutes");
    expect(rejected({ idleMinutes: 1.5 })).toContain("idleMinutes");
    expect(rejected({ idleMinutes: 1441 })).toContain("idleMinutes");
    expect(resolved({ idleMinutes: 1 }).idleMinutes).toBe(1);
    expect(resolved({ idleMinutes: 1440 }).idleMinutes).toBe(1440);
  });

  it("takes extra Container-only paths as computer's ignore patterns, from the mount's root or at any depth", () => {
    expect(
      resolved({ ignore: ["/data", "**/.gradle-cache", "/repo/*/out", "!/repo/node_modules"] })
        .ignore,
    ).toEqual(["/data", "**/.gradle-cache", "/repo/*/out", "!/repo/node_modules"]);
  });

  it("rejects a pattern computerd would refuse, so a bad one never stops a Container from starting", () => {
    for (const pattern of [
      "",
      "data",
      " /data",
      "/data ",
      "/a,b",
      "/a/{b,c}",
      "/a?",
      "/a[0]",
      "/a\\b",
      "/a//b",
      "/a/../b",
      "/./a",
      "/a**",
      "/**",
      "**",
      "/*",
      "/",
      "/workspace",
      "/workspace/data",
      `/${"a".repeat(256)}`,
    ]) {
      expect(ignorePatternProblem(pattern), pattern).toBeDefined();
      expect(rejected({ ignore: [pattern] })).toContain("ignore");
    }
  });

  it(`takes at most ${MAX_IGNORE_PATTERNS} patterns`, () => {
    const many = Array.from({ length: MAX_IGNORE_PATTERNS + 1 }, (_, i) => `/data-${i}`);

    expect(rejected({ ignore: many })).toContain("ignore");
    expect(resolved({ ignore: many.slice(1) }).ignore).toHaveLength(MAX_IGNORE_PATTERNS);
  });

  it("rejects a key it does not know, so a typo is not silently ignored", () => {
    expect(rejected({ idleMinute: 5 })).toContain("idleMinute");
  });

  it("lists every problem, one per line", () => {
    expect(rejected({ instance: "huge", idleMinutes: 0 }).split("\n")).toHaveLength(2);
  });
});

describe("workspaceOverridesFrom", () => {
  it("keeps only what differs from the defaults, so a setting left alone follows later defaults", () => {
    expect(workspaceOverridesFrom(DEFAULT_WORKSPACE_SETTINGS)).toEqual({});
    expect(
      workspaceOverridesFrom({ ...DEFAULT_WORKSPACE_SETTINGS, instance: "standard-4" }),
    ).toEqual({ instance: "standard-4" });
    expect(workspaceOverridesFrom({ ...DEFAULT_WORKSPACE_SETTINGS, idleMinutes: 5 })).toEqual({
      idleMinutes: 5,
    });
    expect(workspaceOverridesFrom({ ...DEFAULT_WORKSPACE_SETTINGS, ignore: ["/data"] })).toEqual({
      ignore: ["/data"],
    });
  });
});

describe("resolveWorkspaceSettingsLeniently", () => {
  it("drops a stale override and keeps the rest", () => {
    const { settings, dropped } = resolveWorkspaceSettingsLeniently({
      instance: "retired-9",
      idleMinutes: 30,
    });

    expect(settings).toEqual({ instance: "standard-2", idleMinutes: 30, ignore: [] });
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain("instance");
  });

  it("gives the defaults for overrides that are not an object", () => {
    expect(resolveWorkspaceSettingsLeniently("nonsense").settings).toEqual(
      DEFAULT_WORKSPACE_SETTINGS,
    );
  });
});
