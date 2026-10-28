import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  compareInstances,
  containerInstance,
  DEFAULT_CONTAINER_SETTINGS,
  DEFAULT_EVERY_ENVIRONMENT_SETTINGS,
  everyEnvironmentOverridesFrom,
  ignorePatternProblem,
  INSTANCE_DESCRIPTIONS,
  INSTANCE_RESOURCES,
  INSTANCE_TYPES,
  instanceLimitProblem,
  MAX_IGNORE_PATTERNS,
  MAX_SCRIPT_BYTES,
  MAX_TOOLCHAINS_BYTES,
  MAX_VARIABLES,
  mergedVariablesProblem,
  resolveContainerSettings,
  resolveContainerSettingsLeniently,
  resolveEveryEnvironmentSettings,
  resolveEveryEnvironmentSettingsLeniently,
  containerOverridesFrom,
  currentFieldValue,
  currentInstanceName,
  isRenamedInstance,
  RENAMED_INSTANCE_TYPES,
  scriptProblem,
  toolchainsProblem,
  type ContainerSettings,
  type EveryEnvironmentSettings,
  variableNameProblem,
  withEveryEnvironmentVariables,
} from "./container-settings.ts";

const NONE = {
  maxInstance: "cpu-2",
  variables: {},
  setupScript: "",
  startScript: "",
  toolchains: "",
  spareWorkspace: true,
} as const;

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
  it("are the 1 vCPU / 3 GiB custom size and a 2-minute idle stop, as the spec says", () => {
    expect(DEFAULT_CONTAINER_SETTINGS).toEqual({
      instance: "cpu-1",
      maxInstance: "cpu-2",
      idleMinutes: 2,
      ignore: [],
      variables: {},
      setupScript: "",
      startScript: "",
      toolchains: "",
      spareWorkspace: true,
    });
  });

  it("are what no overrides resolve to", () => {
    expect(resolved({})).toEqual(DEFAULT_CONTAINER_SETTINGS);
  });
});

/** Whether `type` is one of the custom sizes rather than a Cloudflare name. */
const isCustom = (type: string): boolean => type.startsWith("cpu-") || type.startsWith("mem-");

describe("containerInstance", () => {
  it("passes a named instance type through", () => {
    for (const type of INSTANCE_TYPES) {
      if (!isCustom(type)) expect(containerInstance(type)).toBe(type);
    }
  });

  it.each([
    ["cpu-1", { vcpu: 1, memoryMib: 3072, diskMb: 12_000 }],
    ["cpu-2", { vcpu: 2, memoryMib: 6144, diskMb: 12_000 }],
    ["cpu-3", { vcpu: 3, memoryMib: 9216, diskMb: 12_000 }],
    ["mem-4", { vcpu: 1, memoryMib: 4096, diskMb: 12_000 }],
    ["mem-8", { vcpu: 1, memoryMib: 8192, diskMb: 12_000 }],
    ["mem-12", { vcpu: 2, memoryMib: 12_288, diskMb: 12_000 }],
  ] as const)("maps %s to %o", (type, resources) => {
    expect(containerInstance(type)).toEqual(resources);
  });

  it("names each cpu- size by its vCPU, at the least memory they allow, and each mem- size by its GiB", () => {
    for (const type of INSTANCE_TYPES) {
      const { vcpu, memoryMib } = INSTANCE_RESOURCES[type];

      if (type.startsWith("cpu-")) {
        expect(type).toBe(`cpu-${vcpu}`);
        expect(memoryMib).toBe(vcpu * 3072);
      }

      if (type.startsWith("mem-")) {
        expect(type).toBe(`mem-${memoryMib / 1024}`);
        expect(memoryMib).toBeGreaterThan(vcpu * 3072);
      }
    }
  });

  it("keeps every custom size within Cloudflare's custom instance limits", () => {
    for (const type of INSTANCE_TYPES) {
      const { vcpu, memoryMib, diskMb } = INSTANCE_RESOURCES[type];

      if (!isCustom(type)) continue;

      // 1 to 4 vCPU, at most 12 GiB memory and 20 GB disk, at least 3 GiB memory per vCPU.
      expect(vcpu).toBeGreaterThanOrEqual(1);
      expect(vcpu).toBeLessThanOrEqual(4);
      expect(memoryMib).toBeLessThanOrEqual(12_288);
      expect(diskMb).toBeLessThanOrEqual(20_000);
      expect(memoryMib).toBeGreaterThanOrEqual(vcpu * 3072);
    }
  });

  it("gives every custom size the same disk, so a snapshot or Build restores on any of them", () => {
    const disks = new Set<number>();

    for (const type of INSTANCE_TYPES) {
      if (isCustom(type)) disks.add(INSTANCE_RESOURCES[type].diskMb);
    }

    expect([...disks]).toEqual([12_000]);
  });

  it("orders the sizes by memory, then vCPU", () => {
    const ordered = [...INSTANCE_TYPES].sort(compareInstances);

    expect(ordered).toEqual([
      "lite",
      "basic",
      "cpu-1",
      "standard-1",
      "mem-4",
      "standard-2",
      "cpu-2",
      "mem-8",
      "standard-3",
      "cpu-3",
      "mem-12",
      "standard-4",
    ]);
    expect(ordered).toEqual(INSTANCE_TYPES);
    expect(compareInstances("cpu-2", "cpu-2")).toBe(0);
  });

  it("describes every instance type", () => {
    for (const type of INSTANCE_TYPES) expect(INSTANCE_DESCRIPTIONS[type]).not.toBe("");
    expect(INSTANCE_DESCRIPTIONS["cpu-1"]).toBe("1 vCPU, 3 GiB memory, 12 GB disk");
    expect(INSTANCE_DESCRIPTIONS["cpu-2"]).toBe("2 vCPU, 6 GiB memory, 12 GB disk");
    expect(INSTANCE_DESCRIPTIONS["cpu-3"]).toBe("3 vCPU, 9 GiB memory, 12 GB disk");
    expect(INSTANCE_DESCRIPTIONS["mem-4"]).toBe("1 vCPU, 4 GiB memory, 12 GB disk");
    expect(INSTANCE_DESCRIPTIONS["mem-8"]).toBe("1 vCPU, 8 GiB memory, 12 GB disk");
    expect(INSTANCE_DESCRIPTIONS["mem-12"]).toBe("2 vCPU, 12 GiB memory, 12 GB disk");
  });
});

describe("the sizes renamed from custom- to cpu-", () => {
  it("name each old size by the new one with the same resources", () => {
    expect(Record.keys(RENAMED_INSTANCE_TYPES)).toEqual(["custom-1", "custom-2", "custom-3"]);

    for (const [old, now] of Record.toEntries(RENAMED_INSTANCE_TYPES)) {
      expect(now).toBe(old.replace("custom-", "cpu-"));
      expect(INSTANCE_TYPES).toContain(now);
      expect(INSTANCE_TYPES).not.toContain(old);
    }
  });

  it("read an old name as its new one, and any other name as it is", () => {
    expect(currentInstanceName("custom-2")).toBe("cpu-2");
    expect(currentInstanceName("mem-8")).toBe("mem-8");
    expect(currentInstanceName("standard-2")).toBe("standard-2");
    expect(isRenamedInstance("custom-3")).toBe(true);
    expect(isRenamedInstance("cpu-3")).toBe(false);
    expect(isRenamedInstance("toString")).toBe(false);
  });

  it("rename the value of a size field only", () => {
    expect(currentFieldValue("instance", "custom-1")).toBe("cpu-1");
    expect(currentFieldValue("maxInstance", "custom-3")).toBe("cpu-3");
    expect(currentFieldValue("maxInstance", null)).toBeNull();
    expect(currentFieldValue("setupScript", "custom-1")).toBe("custom-1");
  });

  it("resolve saved settings that name an old size, strictly and leniently", () => {
    const saved = { instance: "custom-2", maxInstance: "custom-3" };

    expect(resolved(saved)).toMatchObject({ instance: "cpu-2", maxInstance: "cpu-3" });
    expect(resolveContainerSettingsLeniently(saved)).toEqual({
      settings: { ...DEFAULT_CONTAINER_SETTINGS, instance: "cpu-2", maxInstance: "cpu-3" },
      dropped: [],
    });
  });

  it("keep an old default out of the overrides, so it follows the default as it did", () => {
    expect(
      containerOverridesFrom(resolved({ instance: "custom-1", maxInstance: "custom-2" })),
    ).toEqual({});
  });
});

describe("resolveContainerSettings", () => {
  it("gives each override over the default, and leaves the rest", () => {
    expect(resolved({ instance: "basic" })).toEqual({
      instance: "basic",
      idleMinutes: 2,
      ignore: [],
      ...NONE,
    });
    expect(resolved({ idleMinutes: 90 })).toEqual({
      instance: "cpu-1",
      idleMinutes: 90,
      ignore: [],
      ...NONE,
    });
  });

  it("accepts every instance type Cloudflare Containers offers", () => {
    for (const instance of INSTANCE_TYPES) expect(resolved({ instance }).instance).toBe(instance);
  });

  it("takes any instance type as the size limit, and rejects one Cloudflare does not offer", () => {
    for (const maxInstance of INSTANCE_TYPES) {
      expect(resolved({ maxInstance }).maxInstance).toBe(maxInstance);
    }

    expect(rejected({ maxInstance: "huge" })).toMatch(/^maxInstance: /);
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

  it("takes the Spare Workspace on or off, and nothing but a boolean", () => {
    expect(resolved({ spareWorkspace: false }).spareWorkspace).toBe(false);
    expect(resolved({ spareWorkspace: true }).spareWorkspace).toBe(true);
    expect(rejected({ spareWorkspace: "off" })).toContain("spareWorkspace");
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
    expect(
      containerOverridesFrom({ ...DEFAULT_CONTAINER_SETTINGS, maxInstance: "standard-4" }),
    ).toEqual({ maxInstance: "standard-4" });
    expect(
      containerOverridesFrom({ ...DEFAULT_CONTAINER_SETTINGS, spareWorkspace: false }),
    ).toEqual({ spareWorkspace: false });
  });
});

describe("instanceLimitProblem", () => {
  it("accepts a size up to the size limit", () => {
    expect(instanceLimitProblem({ instance: "cpu-2", maxInstance: "cpu-2" })).toBeUndefined();
    expect(instanceLimitProblem(DEFAULT_CONTAINER_SETTINGS)).toBeUndefined();
    // standard-1 has more memory than cpu-1, though fewer vCPU.
    expect(instanceLimitProblem({ instance: "cpu-1", maxInstance: "standard-1" })).toBeUndefined();
  });

  it("refuses a size above the size limit, naming both", () => {
    const problem = instanceLimitProblem({ instance: "standard-3", maxInstance: "cpu-2" });

    expect(problem).toMatch(/standard-3/);
    expect(problem).toMatch(/cpu-2/);
    expect(instanceLimitProblem({ instance: "standard-1", maxInstance: "cpu-1" })).toMatch(
      /standard-1.*cpu-1/,
    );
  });
});

describe("resolveContainerSettingsLeniently", () => {
  it("drops a stale override and keeps the rest", () => {
    const { settings, dropped } = resolveContainerSettingsLeniently({
      instance: "retired-9",
      idleMinutes: 30,
    });

    expect(settings).toEqual({ instance: "cpu-1", idleMinutes: 30, ignore: [], ...NONE });
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain("instance");
  });

  it("drops a Spare Workspace switch that is not a boolean, which leaves the spare on", () => {
    const { settings, dropped } = resolveContainerSettingsLeniently({
      spareWorkspace: "no",
      idleMinutes: 30,
    });

    expect(settings).toMatchObject({ spareWorkspace: true, idleMinutes: 30 });
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain("spareWorkspace");
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

  it("raises the size limit to the size of an Environment saved larger before it had one, and reports nothing", () => {
    expect(resolveContainerSettingsLeniently({ instance: "standard-4" })).toEqual({
      settings: {
        ...DEFAULT_CONTAINER_SETTINGS,
        instance: "standard-4",
        maxInstance: "standard-4",
      },
      dropped: [],
    });
    expect(resolveContainerSettingsLeniently({ instance: "standard-2" }).settings.maxInstance).toBe(
      "cpu-2",
    );
  });

  it("gives the defaults for overrides that are not an object", () => {
    expect(resolveContainerSettingsLeniently("nonsense").settings).toEqual(
      DEFAULT_CONTAINER_SETTINGS,
    );
  });
});

const variables = (count: number, prefix = "V"): Record<string, string> =>
  Record.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, "x"]));

const resolvedEvery = (overrides: Schema.Json): EveryEnvironmentSettings => {
  const result = resolveEveryEnvironmentSettings(overrides);

  if (Result.isFailure(result)) throw new Error(result.failure.message);

  return result.success;
};

const rejectedEvery = (overrides: Schema.Json): string => {
  const result = resolveEveryEnvironmentSettings(overrides);

  if (Result.isSuccess(result)) throw new Error("Expected the overrides to be rejected");

  return result.failure.message;
};

describe("EveryEnvironmentSettings", () => {
  it("has no variables by default, which is what no overrides resolve to", () => {
    expect(DEFAULT_EVERY_ENVIRONMENT_SETTINGS).toEqual({ variables: {} });
    expect(resolvedEvery({})).toEqual(DEFAULT_EVERY_ENVIRONMENT_SETTINGS);
  });

  it("takes variables under an Environment's rules", () => {
    expect(resolvedEvery({ variables: { EMAIL: "a@b.c" } }).variables).toEqual({
      EMAIL: "a@b.c",
    });

    for (const name of ["PATH", "CLOUDPID_X", "1A"]) {
      expect(rejectedEvery({ variables: { [name]: "x" } }), name).toContain("variables");
    }

    expect(rejectedEvery({ variables: { A: "a".repeat(4097) } })).toContain("variables");
    expect(rejectedEvery({ variables: { A: "a\u0000b" } })).toContain("variables");
    expect(rejectedEvery({ variables: variables(MAX_VARIABLES + 1) })).toContain("variables");
    expect(resolvedEvery({ variables: variables(MAX_VARIABLES) }).variables).toEqual(
      variables(MAX_VARIABLES),
    );
  });

  it("refuses a key it does not know when it is saved, and drops only that key when it is read", () => {
    expect(rejectedEvery({ idleMinutes: 5 })).toContain("idleMinutes");
    expect(
      resolveEveryEnvironmentSettingsLeniently({ idleMinutes: 5, variables: { A: "1" } }),
    ).toEqual({
      settings: { variables: { A: "1" } },
      dropped: [expect.stringContaining("idleMinutes")],
    });
    expect(
      resolveEveryEnvironmentSettingsLeniently({ variables: { PATH: "/bin" } }).settings,
    ).toEqual(DEFAULT_EVERY_ENVIRONMENT_SETTINGS);
    expect(resolveEveryEnvironmentSettingsLeniently("nonsense").settings).toEqual(
      DEFAULT_EVERY_ENVIRONMENT_SETTINGS,
    );
  });

  it("keeps only what differs from the defaults, so no variables is {}", () => {
    expect(everyEnvironmentOverridesFrom(DEFAULT_EVERY_ENVIRONMENT_SETTINGS)).toEqual({});
    expect(everyEnvironmentOverridesFrom({ variables: { A: "1" } })).toEqual({
      variables: { A: "1" },
    });
  });
});

describe("mergedVariablesProblem", () => {
  it("passes at exactly the limit and counts a name both have once", () => {
    expect(mergedVariablesProblem(variables(30), variables(20, "W"))).toBeUndefined();
    expect(mergedVariablesProblem(variables(50), variables(50))).toBeUndefined();
    expect(mergedVariablesProblem(variables(40), variables(20))).toBeUndefined();
  });

  it("says how many of the variables for every Environment it does not override push it past the limit", () => {
    expect(mergedVariablesProblem(variables(46), variables(7, "W"))).toBe(
      "with the 7 variables for every Environment it does not override, it would have 53: at most 50",
    );
    expect(mergedVariablesProblem(variables(50), { W: "1" })).toContain("the 1 variable for");
  });
});

describe("withEveryEnvironmentVariables", () => {
  it("puts the variables for every Environment under the Environment's own", () => {
    const settings = { ...DEFAULT_CONTAINER_SETTINGS, variables: { A: "own", B: "own" } };

    expect(withEveryEnvironmentVariables(settings, { A: "every", C: "every" })).toEqual({
      ...settings,
      variables: { A: "own", B: "own", C: "every" },
    });
  });

  it("answers the settings themselves for no variables for every Environment, so a Build's key stays", () => {
    const settings = { ...DEFAULT_CONTAINER_SETTINGS, variables: { A: "own" } };

    expect(withEveryEnvironmentVariables(settings, {})).toBe(settings);
  });

  it(`keeps at most ${MAX_VARIABLES}, the Environment's own first and the others by name`, () => {
    const settings = { ...DEFAULT_CONTAINER_SETTINGS, variables: variables(48) };
    const merged = withEveryEnvironmentVariables(settings, { Z: "1", Y: "1", X: "1" });

    expect(Record.keys(merged.variables)).toHaveLength(MAX_VARIABLES);
    expect(merged.variables).toEqual({ ...variables(48), X: "1", Y: "1" });
  });
});
