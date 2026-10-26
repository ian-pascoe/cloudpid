// An Environment's Container settings as the Registry reads and saves them (docs/spec.md → Container settings): the size
// limit refuses a save with a larger size, and an Environment saved larger before it had a limit keeps its size.
import { DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
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
