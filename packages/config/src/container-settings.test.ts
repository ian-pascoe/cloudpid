import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  compareInstances,
  containerInstance,
  DEFAULT_CONTAINER_SETTINGS,
  containerPatchBetween,
  ignorePatternProblem,
  INSTANCE_DESCRIPTIONS,
  INSTANCE_RESOURCES,
  INSTANCE_TYPES,
  instanceLimitProblem,
  isContainerField,
  MAX_IGNORE_PATTERNS,
  MAX_SCRIPT_BYTES,
  MAX_TOOLCHAINS_BYTES,
  MAX_VARIABLES,
  mergedVariablesProblem,
  resolveContainerSettings,
  resolveContainerSettingsLeniently,
  patchContainerOverrides,
  resolveContainerOverrides,
  resolveContainerOverridesLeniently,
  resolveEnvironmentContainerSettings,
  containerOverridesFrom,
  currentFieldValue,
  currentInstanceName,
  isRenamedInstance,
  RENAMED_INSTANCE_TYPES,
  scriptProblem,
  toolchainsProblem,
  type ContainerSettings,
  type ContainerSettingsOverrides,
  variableNameProblem,
  withGlobalVariables,
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

const overridesOf = (overrides: Schema.Json): ContainerSettingsOverrides => {
  const result = resolveContainerOverrides(overrides);

  if (Result.isFailure(result)) throw new Error(result.failure.message);

  return result.success;
};

const GLOBAL: ContainerSettings = {
  ...DEFAULT_CONTAINER_SETTINGS,
  instance: "standard-2",
  maxInstance: "standard-3",
  idleMinutes: 10,
  ignore: ["/global"],
  variables: { A: "global", C: "global" },
  setupScript: "echo global",
  toolchains: '[tools]\nnode = "22"',
};

describe("an Environment's Container settings over Global", () => {
  it("inherit every field the Environment does not override", () => {
    expect(resolveEnvironmentContainerSettings(GLOBAL, {})).toEqual(GLOBAL);
  });

  it("take each field the Environment overrides whole: its list and its script replace Global's", () => {
    expect(
      resolveEnvironmentContainerSettings(GLOBAL, {
        idleMinutes: 30,
        ignore: ["/own"],
        setupScript: "",
        spareWorkspace: false,
      }),
    ).toEqual({
      ...GLOBAL,
      idleMinutes: 30,
      ignore: ["/own"],
      setupScript: "",
      spareWorkspace: false,
    });
  });

  it("keep an override equal to Global, so a change of Global does not reach it", () => {
    const overrides = { idleMinutes: 10 };

    expect(resolveEnvironmentContainerSettings(GLOBAL, overrides).idleMinutes).toBe(10);
    expect(
      resolveEnvironmentContainerSettings({ ...GLOBAL, idleMinutes: 60 }, overrides).idleMinutes,
    ).toBe(10);
  });

  it("merge the variables by name, the Environment's own winning", () => {
    expect(
      resolveEnvironmentContainerSettings(GLOBAL, { variables: { A: "own", B: "own" } }).variables,
    ).toEqual({ A: "own", B: "own", C: "global" });
  });

  it(`keep at most ${MAX_VARIABLES} variables, the Environment's own first`, () => {
    const merged = resolveEnvironmentContainerSettings(
      { ...GLOBAL, variables: { Z: "1", Y: "1", X: "1" } },
      { variables: variables(48) },
    );

    expect(merged.variables).toEqual({ ...variables(48), X: "1", Y: "1" });
  });

  it("raise the size limit to the size once merged, for an Environment saved larger before it had a limit", () => {
    expect(
      resolveEnvironmentContainerSettings(DEFAULT_CONTAINER_SETTINGS, { instance: "standard-3" }),
    ).toMatchObject({ instance: "standard-3", maxInstance: "standard-3" });
    expect(
      resolveEnvironmentContainerSettings(GLOBAL, { instance: "standard-3" }).maxInstance,
    ).toBe("standard-3");
    expect(
      resolveEnvironmentContainerSettings(GLOBAL, { maxInstance: "standard-4" }),
    ).toMatchObject({ instance: "standard-2", maxInstance: "standard-4" });
  });

  it("resolve as they did before Global held them while Global is at the defaults", () => {
    const stored: ReadonlyArray<Schema.Json> = [
      {},
      { instance: "custom-2" },
      { instance: "standard-4" },
      { spareWorkspace: false, idleMinutes: 30 },
      { ignore: ["/data"], setupScript: "x", startScript: "y", toolchains: "z" },
      { variables: { A: "own" }, idleMinutes: "5m", retired: true },
    ];

    for (const overrides of stored) {
      const { overrides: kept } = resolveContainerOverridesLeniently(overrides);

      expect(
        resolveEnvironmentContainerSettings(
          { ...DEFAULT_CONTAINER_SETTINGS, variables: { A: "g", C: "g" } },
          kept,
        ),
        JSON.stringify(overrides),
      ).toEqual(
        withGlobalVariables(resolveContainerSettingsLeniently(overrides).settings, {
          A: "g",
          C: "g",
        }),
      );
    }
  });
});

describe("an Environment's Overrides", () => {
  it("keep exactly the fields saved, one equal to the default too", () => {
    expect(overridesOf({ instance: "cpu-1", ignore: [], spareWorkspace: true })).toEqual({
      instance: "cpu-1",
      ignore: [],
      spareWorkspace: true,
    });
  });

  it("are checked by each setting's rules when saved, one problem per line", () => {
    const refused = resolveContainerOverrides({ idleMinutes: 0, instance: "huge", other: 1 });

    const lines = Result.isFailure(refused) ? refused.failure.message.split("\n") : [];

    expect(lines).toHaveLength(3);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("idleMinutes"),
        expect.stringContaining("instance"),
        expect.stringContaining("other"),
      ]),
    );
  });

  it("drop only what no longer resolves when read, and keep a renamed size under its name now", () => {
    expect(
      resolveContainerOverridesLeniently({
        instance: "custom-2",
        idleMinutes: "5m",
        startScript: "",
      }),
    ).toEqual({
      overrides: { instance: "cpu-2", startScript: "" },
      dropped: [expect.stringContaining("idleMinutes")],
    });
    expect(resolveContainerOverridesLeniently("nonsense")).toEqual({
      overrides: {},
      dropped: ["not an object"],
    });
  });
});

describe("patching Overrides", () => {
  const current = { idleMinutes: 30, variables: { A: "1", B: "2" } };

  it("sets fields one by one, and variables name by name", () => {
    expect(
      patchContainerOverrides(current, { set: { ignore: ["/x"], variables: { B: "3", C: "4" } } }),
    ).toEqual(
      Result.succeed({ idleMinutes: 30, ignore: ["/x"], variables: { A: "1", B: "3", C: "4" } }),
    );
  });

  it("resets a field, a variable by its field path, or every variable", () => {
    expect(patchContainerOverrides(current, { reset: ["idleMinutes", "variables.A"] })).toEqual(
      Result.succeed({ variables: { B: "2" } }),
    );
    expect(patchContainerOverrides(current, { reset: ["variables.A", "variables.B"] })).toEqual(
      Result.succeed({ idleMinutes: 30 }),
    );
    expect(patchContainerOverrides(current, { reset: ["variables"] })).toEqual(
      Result.succeed({ idleMinutes: 30 }),
    );
  });

  it("refuses a reset of what is not a Container setting, and a field both set and reset", () => {
    expect(patchContainerOverrides(current, { reset: ["model"] })).toEqual(
      Result.fail('reset: "model" is not a Container setting'),
    );
    expect(
      patchContainerOverrides(current, { set: { variables: { A: "x" } }, reset: ["variables.A"] }),
    ).toEqual(Result.fail('reset: "variables.A" is also set'));
    expect(
      patchContainerOverrides(current, { set: { idleMinutes: 5 }, reset: ["idleMinutes"] }),
    ).toEqual(Result.fail('reset: "idleMinutes" is also set'));
  });
});

describe("isContainerField", () => {
  it("names a Container setting or one variable, as an Agent change names them", () => {
    expect(isContainerField("idleMinutes")).toBe(true);
    expect(isContainerField("variables.API_URL")).toBe(true);
    expect(isContainerField("variables.")).toBe(false);
    // All the variables at once is a reset's path, not a field one change names.
    expect(isContainerField("variables")).toBe(false);
    expect(isContainerField("model")).toBe(false);
    expect(isContainerField("repos.app")).toBe(false);
  });
});

describe("the patch between two sets of settings", () => {
  it("sets each field that differs and each variable added or changed, and resets each variable taken out", () => {
    const before = { ...DEFAULT_CONTAINER_SETTINGS, ignore: ["/a"], variables: { A: "1", B: "2" } };

    expect(containerPatchBetween(before, before)).toEqual({});
    expect(
      containerPatchBetween(before, {
        ...before,
        idleMinutes: 9,
        ignore: ["/a", "/b"],
        variables: { A: "1", B: "3", C: "4" },
      }),
    ).toEqual({ set: { idleMinutes: 9, ignore: ["/a", "/b"], variables: { B: "3", C: "4" } } });
    expect(containerPatchBetween(before, { ...before, variables: { B: "2" } })).toEqual({
      reset: ["variables.A"],
    });
  });
});

describe("mergedVariablesProblem", () => {
  it("passes at exactly the limit and counts a name both have once", () => {
    expect(mergedVariablesProblem(variables(30), variables(20, "W"))).toBeUndefined();
    expect(mergedVariablesProblem(variables(50), variables(50))).toBeUndefined();
    expect(mergedVariablesProblem(variables(40), variables(20))).toBeUndefined();
  });

  it("says how many of the variables at Global it does not override push it past the limit", () => {
    expect(mergedVariablesProblem(variables(46), variables(7, "W"))).toBe(
      "with the 7 variables at Global it does not override, it would have 53: at most 50",
    );
    expect(mergedVariablesProblem(variables(50), { W: "1" })).toContain("the 1 variable at");
  });
});

describe("withGlobalVariables", () => {
  it("puts the variables at Global under the Environment's own", () => {
    const settings = { ...DEFAULT_CONTAINER_SETTINGS, variables: { A: "own", B: "own" } };

    expect(withGlobalVariables(settings, { A: "every", C: "every" })).toEqual({
      ...settings,
      variables: { A: "own", B: "own", C: "every" },
    });
  });

  it("answers the settings themselves for no variables at Global, so a Build's key stays", () => {
    const settings = { ...DEFAULT_CONTAINER_SETTINGS, variables: { A: "own" } };

    expect(withGlobalVariables(settings, {})).toBe(settings);
  });

  it(`keeps at most ${MAX_VARIABLES}, the Environment's own first and the others by name`, () => {
    const settings = { ...DEFAULT_CONTAINER_SETTINGS, variables: variables(48) };
    const merged = withGlobalVariables(settings, { Z: "1", Y: "1", X: "1" });

    expect(Record.keys(merged.variables)).toHaveLength(MAX_VARIABLES);
    expect(merged.variables).toEqual({ ...variables(48), X: "1", Y: "1" });
  });
});
