import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  containerInstance,
  DEFAULT_CONTAINER_SETTINGS,
  ignorePatternProblem,
  INSTANCE_DESCRIPTIONS,
  INSTANCE_TYPES,
  MAX_IGNORE_PATTERNS,
  MAX_SCRIPT_BYTES,
  MAX_TOOLCHAINS_BYTES,
  MAX_VARIABLES,
  resolveContainerSettings,
  resolveContainerSettingsLeniently,
  containerOverridesFrom,
  scriptProblem,
  toolchainsProblem,
  type ContainerSettings,
  variableNameProblem,
} from "./container-settings.ts";

const NONE = { variables: {}, setupScript: "", startScript: "", toolchains: "" };

const resolved = (overrides: Schema.Json): ContainerSettings => {
  const result = resolveContainerSettings(overrides);

  if (Result.isFailure(result)) throw new Error(result.failure.message);

  return result.success;
};

const rejected = (overrides: Schema.Json): string => {
  const result = resolveContainerSettings(overrides);

  if (Result.isSuccess(result)) throw new Error("Expected the overrides to be rejected");

  return result.failure.message;
};

describe("the defaults", () => {
  it("are the 2 vCPU / 6 GiB custom size and a 5-minute idle stop, as the spec says", () => {
    expect(DEFAULT_CONTAINER_SETTINGS).toEqual({
      instance: "custom-2",
      idleMinutes: 5,
      ignore: [],
      variables: {},
      setupScript: "",
      startScript: "",
      toolchains: "",
    });
  });

  it("are what no overrides resolve to", () => {
    expect(resolved({})).toEqual(DEFAULT_CONTAINER_SETTINGS);
  });
});

describe("containerInstance", () => {
  it("passes a named instance type through", () => {
    for (const type of INSTANCE_TYPES) {
      if (!type.startsWith("custom-")) expect(containerInstance(type)).toBe(type);
    }
  });

  it("maps custom-2 to 2 vCPU, 6 GiB memory and 12 GB disk", () => {
    expect(containerInstance("custom-2")).toEqual({ vcpu: 2, memoryMib: 6144, diskMb: 12_000 });
  });

  it("describes every instance type", () => {
    for (const type of INSTANCE_TYPES) expect(INSTANCE_DESCRIPTIONS[type]).not.toBe("");
    expect(INSTANCE_DESCRIPTIONS["custom-2"]).toBe("2 vCPU, 6 GiB memory, 12 GB disk");
  });
});

describe("resolveContainerSettings", () => {
  it("gives each override over the default, and leaves the rest", () => {
    expect(resolved({ instance: "basic" })).toEqual({
      instance: "basic",
      idleMinutes: 5,
      ignore: [],
      ...NONE,
    });
    expect(resolved({ idleMinutes: 90 })).toEqual({
      instance: "custom-2",
      idleMinutes: 90,
      ignore: [],
      ...NONE,
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

  it("takes variables by name, a value holding anything but NUL", () => {
    expect(
      resolved({ variables: { NODE_ENV: "test", _private2: "a=b c\n'\"$x" } }).variables,
    ).toEqual({ NODE_ENV: "test", _private2: "a=b c\n'\"$x" });
  });

  it("rejects a variable name a shell could not export", () => {
    for (const name of ["", "1ABC", "A-B", "A B", "É", "A=B", "a".repeat(129)]) {
      expect(variableNameProblem(name), name).toBeDefined();
      expect(rejected({ variables: { [name]: "x" } })).toContain("variables");
    }

    expect(variableNameProblem("a".repeat(128))).toBeUndefined();
  });

  it("refuses the names the Container sets itself, saying they are reserved", () => {
    for (const name of [
      "PATH",
      "HOME",
      "PWD",
      "SHELL",
      "USER",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "MISE_GLOBAL_CONFIG_FILE",
      "MISE_TRUSTED_CONFIG_PATHS",
      "MISE_YES",
      "GIT_TERMINAL_PROMPT",
      "TURBO_CACHE_DIR",
      "BASH_ENV",
      "CLOUDPID_GIT_NAME",
      "CLOUDPID_",
    ]) {
      expect(variableNameProblem(name), name).toContain("reserved");
      expect(rejected({ variables: { [name]: "x" } })).toContain("reserved");
    }

    expect(variableNameProblem("MISE_ENV")).toBeUndefined();
    expect(variableNameProblem("cloudpid_x")).toBeUndefined();
  });

  it("rejects a variable value with a NUL or longer than 4096 characters", () => {
    expect(rejected({ variables: { A: "a\u0000b" } })).toContain("variables");
    expect(rejected({ variables: { A: "a".repeat(4097) } })).toContain("variables");
    expect(resolved({ variables: { A: "a".repeat(4096) } }).variables.A).toHaveLength(4096);
  });

  it(`takes at most ${MAX_VARIABLES} variables`, () => {
    const many = Record.fromEntries(
      Array.from({ length: MAX_VARIABLES + 1 }, (_, i) => [`V${i}`, "x"]),
    );

    expect(rejected({ variables: many })).toContain("variables");

    const { V0: _, ...fewer } = many;

    expect(Record.keys(resolved({ variables: fewer }).variables)).toHaveLength(MAX_VARIABLES);
  });

  it("takes a Setup Script and a Start Script as bash source", () => {
    expect(resolved({ setupScript: "pnpm install\n", startScript: "docker start db\n" })).toEqual({
      ...DEFAULT_CONTAINER_SETTINGS,
      setupScript: "pnpm install\n",
      startScript: "docker start db\n",
    });
  });

  it(`rejects a script over ${MAX_SCRIPT_BYTES / 1024} KiB of UTF-8`, () => {
    expect(resolved({ setupScript: "a".repeat(MAX_SCRIPT_BYTES) }).setupScript).toHaveLength(
      MAX_SCRIPT_BYTES,
    );
    expect(rejected({ setupScript: "a".repeat(MAX_SCRIPT_BYTES + 1) })).toContain("setupScript");
    // Three bytes each: under the limit in characters, over it in bytes.
    expect(rejected({ startScript: "€".repeat(MAX_SCRIPT_BYTES / 2) })).toContain("startScript");
    expect(scriptProblem("€".repeat(MAX_SCRIPT_BYTES / 3))).toBeUndefined();
    expect(scriptProblem("€".repeat(MAX_SCRIPT_BYTES / 2))).toBe("is longer than 64 KiB");
  });

  it(`takes Toolchains as a mise.toml of at most ${MAX_TOOLCHAINS_BYTES / 1024} KiB of UTF-8, with no NUL`, () => {
    const toml = '[tools]\nnode = "22.20.0"\n';

    expect(resolved({ toolchains: toml })).toEqual({
      ...DEFAULT_CONTAINER_SETTINGS,
      toolchains: toml,
    });
    expect(resolved({ toolchains: "a".repeat(MAX_TOOLCHAINS_BYTES) }).toolchains).toHaveLength(
      MAX_TOOLCHAINS_BYTES,
    );
    expect(rejected({ toolchains: "a".repeat(MAX_TOOLCHAINS_BYTES + 1) })).toContain("toolchains");
    expect(toolchainsProblem("€".repeat(MAX_TOOLCHAINS_BYTES / 2))).toBe("is longer than 16 KiB");
    expect(rejected({ toolchains: "a\u0000b" })).toContain("toolchains");
  });

  it("rejects a script with a NUL, which bash cannot read", () => {
    expect(rejected({ setupScript: "a\u0000b" })).toContain("setupScript");
  });

  it("rejects a key it does not know, so a typo is not silently ignored", () => {
    expect(rejected({ idleMinute: 5 })).toContain("idleMinute");
  });

  it("lists every problem, one per line", () => {
    expect(rejected({ instance: "huge", idleMinutes: 0 }).split("\n")).toHaveLength(2);
  });
});

describe("containerOverridesFrom", () => {
  it("keeps only what differs from the defaults, so a setting left alone follows later defaults", () => {
    expect(containerOverridesFrom(DEFAULT_CONTAINER_SETTINGS)).toEqual({});
    expect(
      containerOverridesFrom({ ...DEFAULT_CONTAINER_SETTINGS, instance: "standard-4" }),
    ).toEqual({
      instance: "standard-4",
    });
    // standard-2 was the default: an Environment that picks it now keeps it as an override.
    expect(
      containerOverridesFrom({ ...DEFAULT_CONTAINER_SETTINGS, instance: "standard-2" }),
    ).toEqual({
      instance: "standard-2",
    });
    expect(containerOverridesFrom({ ...DEFAULT_CONTAINER_SETTINGS, idleMinutes: 15 })).toEqual({
      idleMinutes: 15,
    });
    expect(containerOverridesFrom({ ...DEFAULT_CONTAINER_SETTINGS, ignore: ["/data"] })).toEqual({
      ignore: ["/data"],
    });
    expect(
      containerOverridesFrom({
        ...DEFAULT_CONTAINER_SETTINGS,
        variables: { A: "1" },
        setupScript: "pnpm install\n",
      }),
    ).toEqual({ variables: { A: "1" }, setupScript: "pnpm install\n" });
    expect(
      containerOverridesFrom({ ...DEFAULT_CONTAINER_SETTINGS, startScript: "make up\n" }),
    ).toEqual({ startScript: "make up\n" });
    expect(
      containerOverridesFrom({ ...DEFAULT_CONTAINER_SETTINGS, toolchains: "[tools]\n" }),
    ).toEqual({ toolchains: "[tools]\n" });
  });
});

describe("resolveContainerSettingsLeniently", () => {
  it("drops a stale override and keeps the rest", () => {
    const { settings, dropped } = resolveContainerSettingsLeniently({
      instance: "retired-9",
      idleMinutes: 30,
    });

    expect(settings).toEqual({ instance: "custom-2", idleMinutes: 30, ignore: [], ...NONE });
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain("instance");
  });

  it("drops every stale override, however many, and keeps the rest", () => {
    const { settings, dropped } = resolveContainerSettingsLeniently({
      instance: "retired-9",
      idleMinutes: 0,
      ignore: ["data"],
      variables: { PATH: "/bin" },
      setupScript: "a\u0000",
      startScript: "make up\n",
    });

    expect(settings).toEqual({ ...DEFAULT_CONTAINER_SETTINGS, startScript: "make up\n" });
    expect(dropped).toHaveLength(5);
  });

  it("gives the defaults for overrides that are not an object", () => {
    expect(resolveContainerSettingsLeniently("nonsense").settings).toEqual(
      DEFAULT_CONTAINER_SETTINGS,
    );
  });
});
