// An Environment's Container settings as the Registry reads and saves them (docs/architecture/container.md →
// Container settings): its Overrides over Global's, the size limit checked when the save changes the size or the limit, and an
// Environment saved larger before it had a limit keeping its size.
import { type ContainerSettings, DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import {
  patchEnvironmentSettings,
  readEnvironmentSettings,
  writeEnvironmentSettings,
} from "./environment-settings.ts";

const GLOBAL: ContainerSettings = DEFAULT_CONTAINER_SETTINGS;

describe("saving an Environment's Container settings", () => {
  it("keeps every field it is given as an Override, one equal to Global's too", () => {
    expect(
      Result.getOrThrow(
        writeEnvironmentSettings({}, { instance: "cpu-2", maxInstance: "cpu-2" }, GLOBAL),
      ),
    ).toEqual({
      settings: { ...DEFAULT_CONTAINER_SETTINGS, instance: "cpu-2" },
      global: GLOBAL,
      overrides: { instance: "cpu-2", maxInstance: "cpu-2" },
    });
  });

  it("refuses a size larger than the size limit in force, naming both", () => {
    const refused = writeEnvironmentSettings({}, { instance: "standard-3" }, GLOBAL);

    expect(Result.isFailure(refused) ? refused.failure : "").toMatch(
      /standard-3 is larger than the size limit cpu-2/,
    );
  });

  it("takes a size up to the limit it inherits from Global", () => {
    const global = { ...GLOBAL, maxInstance: "standard-4" } as const;

    expect(
      Result.getOrThrow(writeEnvironmentSettings({}, { instance: "standard-3" }, global)).settings,
    ).toEqual({ ...global, instance: "standard-3" });
  });

  it("checks the limit only when the save changes the size or the limit", () => {
    // Global's limit was lowered under this Environment's own size since it was saved: a save of its idle time stands.
    const global = { ...GLOBAL, maxInstance: "cpu-1" } as const;

    expect(
      Result.isSuccess(
        writeEnvironmentSettings(
          { instance: "cpu-2", maxInstance: "cpu-2" },
          { instance: "cpu-2", maxInstance: "cpu-2", idleMinutes: 9 },
          global,
        ),
      ),
    ).toBe(true);
  });
});

describe("patching an Environment's Overrides", () => {
  it("sets fields over the saved ones and leaves the others as they are", () => {
    expect(
      Result.getOrThrow(
        patchEnvironmentSettings({ idleMinutes: 5 }, { set: { setupScript: "make" } }, GLOBAL),
      ).overrides,
    ).toEqual({ idleMinutes: 5, setupScript: "make" });
  });

  it("resets a field, which then inherits Global's", () => {
    const global = { ...GLOBAL, idleMinutes: 15 };

    const state = Result.getOrThrow(
      patchEnvironmentSettings({ idleMinutes: 5 }, { reset: ["idleMinutes"] }, global),
    );

    expect(state.overrides).toEqual({});
    expect(state.settings.idleMinutes).toBe(15);
  });

  it("merges variables name by name and resets one by its path", () => {
    expect(
      Result.getOrThrow(
        patchEnvironmentSettings(
          { variables: { A: "1", B: "2" } },
          { set: { variables: { C: "3" } }, reset: ["variables.A"] },
          GLOBAL,
        ),
      ).overrides,
    ).toEqual({ variables: { B: "2", C: "3" } });
  });

  it("refuses a reset of what is no Container setting", () => {
    expect(patchEnvironmentSettings({}, { reset: ["model"] }, GLOBAL)).toEqual(
      Result.fail('reset: "model" is not a Container setting'),
    );
  });

  it("drops a saved Override that no longer resolves, which then inherits Global's", () => {
    expect(
      Result.getOrThrow(patchEnvironmentSettings({ idleMinutes: "5m" }, { set: {} }, GLOBAL))
        .overrides,
    ).toEqual({});
  });

  it("keeps the raised limit of an Environment saved larger before it had one when its size changes", () => {
    const state = Result.getOrThrow(
      patchEnvironmentSettings(
        { instance: "standard-4" },
        { set: { instance: "standard-3" } },
        GLOBAL,
      ),
    );

    expect(state.overrides).toEqual({ instance: "standard-3", maxInstance: "standard-4" });
    expect(state.settings.maxInstance).toBe("standard-4");
  });
});

describe("saving an Environment's variables beside Global's", () => {
  const variables = (count: number, prefix = "V") =>
    Record.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, "x"] as const));

  const withVariables = (count: number, prefix = "V"): ContainerSettings => ({
    ...GLOBAL,
    variables: variables(count, prefix),
  });

  it("refuses variables that, with the ones at Global they do not override, are more than 50", () => {
    expect(
      writeEnvironmentSettings({}, { variables: variables(46) }, withVariables(7, "E")),
    ).toEqual(
      Result.fail(
        "variables: with the 7 variables at Global it does not override, it would have 53: at most 50",
      ),
    );
  });

  it("takes exactly 50 in all, and counts a name both have once", () => {
    expect(
      Result.isSuccess(
        writeEnvironmentSettings({}, { variables: variables(43) }, withVariables(7, "E")),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        writeEnvironmentSettings({}, { variables: variables(50) }, withVariables(50)),
      ),
    ).toBe(true);
  });

  it("keeps the variables saved as the Environment's own, and resolves them over Global's", () => {
    const state = Result.getOrThrow(
      writeEnvironmentSettings(
        {},
        { variables: { A: "1" } },
        { ...GLOBAL, variables: { A: "g", B: "2" } },
      ),
    );

    expect(state.overrides).toEqual({ variables: { A: "1" } });
    expect(state.settings.variables).toEqual({ A: "1", B: "2" });
  });
});

describe("reading an Environment's Container settings", () => {
  it("raises the limit to the size of an Environment saved larger before it had one, reporting nothing", () => {
    expect(readEnvironmentSettings({ instance: "standard-4" }, GLOBAL)).toEqual({
      settings: {
        ...DEFAULT_CONTAINER_SETTINGS,
        instance: "standard-4",
        maxInstance: "standard-4",
      },
      global: GLOBAL,
      overrides: { instance: "standard-4" },
    });
  });

  it("inherits each field it has no Override of from Global", () => {
    const global = { ...GLOBAL, idleMinutes: 20, setupScript: "make" };

    expect(readEnvironmentSettings({ idleMinutes: 3 }, global).settings).toEqual({
      ...global,
      idleMinutes: 3,
    });
  });

  it("leaves out an Override that no longer resolves, saying why, and inherits Global's there", () => {
    const state = readEnvironmentSettings({ idleMinutes: "5m", instance: "cpu-2" }, GLOBAL);

    expect(state.overrides).toEqual({ instance: "cpu-2" });
    expect(state.settings.idleMinutes).toBe(GLOBAL.idleMinutes);
    expect(state.problem).toMatch(/idleMinutes/);
  });
});
