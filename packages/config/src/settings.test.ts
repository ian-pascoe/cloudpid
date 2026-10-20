import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  overridesFrom,
  resolveSettings,
  SUPPORTED_MODELS,
  type Settings,
} from "./settings.ts";

const resolved = (overrides: Schema.Json): Settings => {
  const result = resolveSettings(overrides);

  if (Result.isFailure(result)) throw new Error(result.failure.message);

  return result.success;
};

const rejected = (overrides: Schema.Json): string => {
  const result = resolveSettings(overrides);

  if (Result.isSuccess(result)) throw new Error("Expected the overrides to be rejected");

  return result.failure.message;
};

describe("the defaults", () => {
  it("run Opus at high thinking, as the spec says", () => {
    expect(DEFAULT_SETTINGS.model).toBe("anthropic/claude-opus-5-5");
    expect(DEFAULT_SETTINGS.thinkingLevel).toBe("high");
  });

  it("give each role the model and hint of the local pi settings", () => {
    expect(DEFAULT_SETTINGS.roles.small.model).toBe("anthropic/claude-haiku-5-5");
    expect(DEFAULT_SETTINGS.roles.medium.model).toBe("anthropic/claude-sonnet-5-5");
    expect(DEFAULT_SETTINGS.roles.large.model).toBe("anthropic/claude-opus-5-5");
    expect(DEFAULT_SETTINGS.roles.xlarge.model).toBe("anthropic/claude-fable-5-1");
    expect(DEFAULT_SETTINGS.roles.small.hint).toContain("Cheap and fast");
    expect(DEFAULT_SETTINGS.roles.xlarge.hint).toContain("Most capable");
  });

  it("keep compaction on, with pi-durable's thresholds", () => {
    expect(DEFAULT_SETTINGS.compaction).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      backgroundTokens: 32_768,
    });
  });

  it("offer only models the proxy serves", () => {
    expect(SUPPORTED_MODELS).toContain(DEFAULT_SETTINGS.model);
  });
});

describe("resolving overrides", () => {
  it("gives the defaults for no overrides", () => {
    expect(resolved({})).toEqual(DEFAULT_SETTINGS);
  });

  it("applies an override and leaves every other setting at its default", () => {
    const settings = resolved({ model: "anthropic/claude-sonnet-5-5" });

    expect(settings.model).toBe("anthropic/claude-sonnet-5-5");
    expect(settings.thinkingLevel).toBe("high");
    expect(settings.roles).toEqual(DEFAULT_SETTINGS.roles);
  });

  it("merges nested overrides into the nested defaults", () => {
    const settings = resolved({
      compaction: { enabled: false },
      roles: { small: { model: "anthropic/claude-sonnet-5-5" } },
    });

    expect(settings.compaction).toEqual({ ...DEFAULT_SETTINGS.compaction, enabled: false });
    expect(settings.roles.small).toEqual({
      model: "anthropic/claude-sonnet-5-5",
      hint: DEFAULT_SETTINGS.roles.small.hint,
    });
    expect(settings.roles.large).toEqual(DEFAULT_SETTINGS.roles.large);
  });

  it("carries extension options", () => {
    expect(resolved({ extensions: { web: { searchProvider: "exa" } } }).extensions).toEqual({
      web: { searchProvider: "exa" },
    });
  });
});

describe("rejecting overrides", () => {
  it("names the setting and what it may be, for a model the proxy does not serve", () => {
    const message = rejected({ model: "anthropic/claude-nope" });

    expect(message).toContain("model");
    expect(message).toContain("anthropic/claude-opus-5-5");
  });

  it("names a nested setting by its path", () => {
    expect(rejected({ compaction: { reserveTokens: -5 } })).toContain("compaction.reserveTokens");
    expect(rejected({ roles: { small: { model: "nope" } } })).toContain("roles.small.model");
  });

  it("rejects a misspelt setting instead of ignoring it", () => {
    expect(rejected({ thinkinglevel: "low" })).toContain("thinkinglevel");
  });

  it("rejects a thinking level pi does not have", () => {
    expect(rejected({ thinkingLevel: "extreme" })).toContain("thinkingLevel");
  });

  it("reports every problem at once, one per line", () => {
    const lines = rejected({ thinkingLevel: "extreme", compaction: { reserveTokens: 0 } }).split(
      "\n",
    );

    expect(lines).toHaveLength(2);
  });

  it("rejects overrides that are not an object", () => {
    expect(rejected("high")).not.toBe("");
    expect(rejected(null)).not.toBe("");
  });
});

describe("overrides from settings", () => {
  it("is empty for the defaults", () => {
    expect(overridesFrom(DEFAULT_SETTINGS)).toEqual({});
  });

  it("keeps only what differs from the defaults, so later default changes still apply", () => {
    const settings = resolved({
      thinkingLevel: "low",
      compaction: { enabled: false },
      roles: { medium: { hint: "Mine" } },
    });

    expect(overridesFrom(settings)).toEqual({
      thinkingLevel: "low",
      compaction: { enabled: false },
      roles: { medium: { hint: "Mine" } },
    });
  });

  it("resolves back to the settings it came from", () => {
    const settings = resolved({
      model: "anthropic/claude-haiku-5-5",
      roles: { xlarge: { model: "anthropic/claude-opus-5-5" } },
      extensions: { web: { searchProvider: "parallel" } },
    });

    expect(resolved(overridesFrom(settings))).toEqual(settings);
  });
});
