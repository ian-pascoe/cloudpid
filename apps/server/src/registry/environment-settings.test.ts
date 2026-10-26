// An Environment's Container settings as the Registry reads and saves them (docs/spec.md → Container settings): the size
// limit refuses a save with a larger size, and an Environment saved larger before it had a limit keeps its size.
import { DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { readEnvironmentSettings, writeEnvironmentSettings } from "./environment-settings.ts";

describe("saving an Environment's Container settings", () => {
  it("keeps the size limit as an override only when it differs from cpu-2, the default", () => {
    expect(
      Result.getOrThrow(writeEnvironmentSettings({ instance: "cpu-2", maxInstance: "cpu-2" })),
    ).toEqual({
      settings: { ...DEFAULT_CONTAINER_SETTINGS, instance: "cpu-2" },
      overrides: { instance: "cpu-2" },
    });
    expect(
      Result.getOrThrow(
        writeEnvironmentSettings({ instance: "standard-3", maxInstance: "standard-4" }),
      ).overrides,
    ).toEqual({ instance: "standard-3", maxInstance: "standard-4" });
  });

  it("refuses a size larger than the size limit, naming both", () => {
    const refused = writeEnvironmentSettings({ instance: "standard-3" });

    expect(Result.isFailure(refused)).toBe(true);
    expect(Result.isFailure(refused) ? refused.failure : "").toMatch(
      /standard-3 is larger than the size limit cpu-2/,
    );
  });
});

describe("saving an Environment's variables beside those kept for every Environment", () => {
  const variables = (count: number, prefix = "V") =>
    Record.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, "x"] as const));

  it("refuses variables that, with the ones kept for every Environment they do not override, are more than 50", () => {
    const refused = writeEnvironmentSettings({ variables: variables(46) }, variables(7, "E"));

    expect(refused).toEqual(
      Result.fail(
        "variables: with the 7 variables for every Environment it does not override, it would have 53: at most 50",
      ),
    );
  });

  it("takes exactly 50 in all, and counts a name both have once", () => {
    expect(
      Result.isSuccess(writeEnvironmentSettings({ variables: variables(43) }, variables(7, "E"))),
    ).toBe(true);
    expect(
      Result.isSuccess(writeEnvironmentSettings({ variables: variables(50) }, variables(50))),
    ).toBe(true);
  });

  it("keeps the variables saved as the Environment's own, without those kept for every Environment", () => {
    expect(
      Result.getOrThrow(writeEnvironmentSettings({ variables: { A: "1" } }, { B: "2" })).overrides,
    ).toEqual({ variables: { A: "1" } });
  });
});

describe("reading an Environment's Container settings", () => {
  it("raises the limit to the size of an Environment saved larger before it had one, reporting nothing", () => {
    expect(readEnvironmentSettings({ instance: "standard-4" })).toEqual({
      settings: {
        ...DEFAULT_CONTAINER_SETTINGS,
        instance: "standard-4",
        maxInstance: "standard-4",
      },
      overrides: { instance: "standard-4", maxInstance: "standard-4" },
    });
  });
});
