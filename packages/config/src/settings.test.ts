import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OFFERED_TOOLS,
  DEFAULT_SETTINGS,
  extensionField,
  overridesFrom,
  overridesWithFields,
  resolveLeniently,
  resolveSettings,
  settingsFieldPath,
  settingsFieldValue,
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

  it("offer the core coding tools, code mode and tool_search, and leave every other tool deferred", () => {
    expect(DEFAULT_SETTINGS.tools.offered).toEqual(DEFAULT_OFFERED_TOOLS);
    expect(DEFAULT_SETTINGS.tools.offered).toEqual(
      expect.arrayContaining([
        "read",
        "write",
        "edit",
        "bash",
        "ls",
        "find",
        "grep",
        "codemode",
        "tool_search",
        "secret_ask",
      ]),
    );
    expect(DEFAULT_SETTINGS.tools.offered).not.toContain("web_fetch");
    expect(DEFAULT_SETTINGS.tools.offered).not.toContain("browser");
    expect(DEFAULT_SETTINGS.tools.offered).not.toContain("subagent");
  });

  it("leave the spend limit off", () => {
    expect(DEFAULT_SETTINGS.spendLimit).toEqual({ perSession: null });
  });

  it("offer only models the proxy serves", () => {
    expect(SUPPORTED_MODELS).toContain(DEFAULT_SETTINGS.model);
  });
});

describe("the spend limit", () => {
  it("is a positive amount in USD per Session, or null for none", () => {
    expect(resolved({ spendLimit: { perSession: 12.5 } }).spendLimit.perSession).toBe(12.5);
    expect(resolved({ spendLimit: { perSession: null } }).spendLimit.perSession).toBeNull();
    expect(rejected({ spendLimit: { perSession: 0 } })).toContain("spendLimit.perSession");
    expect(rejected({ spendLimit: { perSession: -3 } })).toContain("spendLimit.perSession");
  });

  it("is saved only when it differs from the default", () => {
    expect(overridesFrom(resolved({ spendLimit: { perSession: null } }))).toEqual({});
    expect(overridesFrom(resolved({ spendLimit: { perSession: 5 } }))).toEqual({
      spendLimit: { perSession: 5 },
    });
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

  it("replaces the offered tools as a whole, so a tool taken out of the list is deferred", () => {
    const settings = resolved({ tools: { offered: ["read", "codemode", "web_*"] } });

    expect(settings.tools.offered).toEqual(["read", "codemode", "web_*"]);
    expect(resolved({ tools: { offered: [] } }).tools.offered).toEqual([]);
  });

  it("saves restart_container in the offered tools as container_restart, its new name", () => {
    const settings = resolved({ tools: { offered: ["restart_container"] } });

    expect(settings.tools.offered).toEqual(["container_restart"]);
    expect(overridesFrom(settings)).toEqual({ tools: { offered: ["container_restart"] } });
  });

  it("rejects an offered tool that is not a snake_case name or pattern, so a typo is not saved", () => {
    for (const entry of ["", " read", "Read", "web fetch", "read,bash"]) {
      expect(rejected({ tools: { offered: ["bash", entry] } })).toContain("tools.offered");
    }
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

  it("keeps a changed offered set, and drops it once it is the default again", () => {
    const settings = resolved({ tools: { offered: ["read", "web_fetch"] } });

    expect(overridesFrom(settings)).toEqual({ tools: { offered: ["read", "web_fetch"] } });
    expect(overridesFrom({ ...settings, tools: { offered: [...DEFAULT_OFFERED_TOOLS] } })).toEqual(
      {},
    );
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

describe("resolving stale overrides leniently", () => {
  it("is the strict resolution when every override resolves", () => {
    const overrides = { thinkingLevel: "low", roles: { small: { hint: "Mine" } } } as const;

    expect(resolveLeniently(overrides)).toEqual({ settings: resolved(overrides), dropped: [] });
  });

  it("drops only the override that no longer resolves, and keeps its siblings", () => {
    const { settings, dropped } = resolveLeniently({
      model: "anthropic/retired-model",
      thinkingLevel: "low",
      compaction: { enabled: false, reserveTokens: -1 },
      roles: { xlarge: { model: "anthropic/retired-model", hint: "Mine" } },
    });

    expect(settings.model).toBe(DEFAULT_SETTINGS.model);
    expect(settings.thinkingLevel).toBe("low");
    expect(settings.compaction).toEqual({ ...DEFAULT_SETTINGS.compaction, enabled: false });
    expect(settings.roles.xlarge).toEqual({ model: "anthropic/claude-fable-5-1", hint: "Mine" });
    expect(dropped).toHaveLength(3);
    expect(Arr.join(dropped, "\n")).toContain("model:");
    expect(Arr.join(dropped, "\n")).toContain("compaction.reserveTokens");
    expect(Arr.join(dropped, "\n")).toContain("roles.xlarge.model");
  });

  it("drops a setting a release no longer has", () => {
    const { settings, dropped } = resolveLeniently({ retiredSetting: true, thinkingLevel: "low" });

    expect(settings.thinkingLevel).toBe("low");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain("retiredSetting");
  });

  it("drops a saved offered list that has a bad element whole, and keeps every other override", () => {
    const { settings, dropped } = resolveLeniently({
      model: "anthropic/claude-sonnet-5-5",
      thinkingLevel: "low",
      tools: { offered: ["read", "Bad Name", "bash"] },
    });

    expect(settings.model).toBe("anthropic/claude-sonnet-5-5");
    expect(settings.thinkingLevel).toBe("low");
    expect(settings.tools.offered).toEqual(DEFAULT_OFFERED_TOOLS);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain("tools.offered");
  });

  it("reads restart_container in a saved offered list as container_restart, its new name, with no problem", () => {
    expect(resolveLeniently({ tools: { offered: ["read", "restart_container", "bash"] } })).toEqual(
      {
        settings: {
          ...DEFAULT_SETTINGS,
          tools: { offered: ["read", "container_restart", "bash"] },
        },
        dropped: [],
      },
    );
    expect(
      resolveLeniently({ tools: { offered: ["restart_container", "container_restart"] } }).settings
        .tools.offered,
    ).toEqual(["container_restart"]);
  });

  it("gives the defaults for overrides that are not an object", () => {
    const { settings, dropped } = resolveLeniently("high");

    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(dropped).toHaveLength(1);
  });
});

describe("the fields of the settings", () => {
  it("names a setting by its dotted path, an extension's option by extension and key", () => {
    expect(settingsFieldPath("model")).toEqual(["model"]);
    expect(settingsFieldPath("roles.small.model")).toEqual(["roles", "small", "model"]);
    expect(settingsFieldPath(extensionField("web", "searchProvider"))).toEqual([
      "extensions",
      "web",
      "searchProvider",
    ]);
    // An option's key may hold dots; the extension's name may not.
    expect(settingsFieldPath("extensions.web.a.b")).toEqual(["extensions", "web", "a.b"]);
  });

  it("refuses what is not a setting", () => {
    expect(settingsFieldPath("bogus")).toBeUndefined();
    expect(settingsFieldPath("")).toBeUndefined();
    expect(settingsFieldPath("roles..model")).toBeUndefined();
    expect(settingsFieldPath("extensions")).toBeUndefined();
    expect(settingsFieldPath("extensions.web")).toBeUndefined();
  });

  it("reads a field's value from the settings, null where there is none", () => {
    const settings = resolved({
      thinkingLevel: "low",
      extensions: { web: { searchProvider: "parallel" } },
    });

    expect(settingsFieldValue(settings, "thinkingLevel")).toBe("low");
    expect(settingsFieldValue(settings, "model")).toBe(DEFAULT_SETTINGS.model);
    expect(settingsFieldValue(settings, "roles.small.model")).toBe("anthropic/claude-haiku-5-5");
    expect(settingsFieldValue(settings, "tools.offered")).toEqual([...DEFAULT_OFFERED_TOOLS]);
    expect(settingsFieldValue(settings, "extensions.web.searchProvider")).toBe("parallel");
    expect(settingsFieldValue(settings, "extensions.web.missing")).toBeNull();
    expect(settingsFieldValue(settings, "spendLimit.perSession")).toBeNull();
    expect(settingsFieldValue(settings, "bogus")).toBeNull();
  });
});

describe("overrides with fields", () => {
  it("gives the field its value over what the settings override already", () => {
    const settings = resolved({ thinkingLevel: "low" });

    expect(
      overridesWithFields(settings, [
        { field: "compaction.enabled", value: false },
        { field: "roles.small.model", value: "anthropic/claude-sonnet-5-5" },
      ]),
    ).toEqual({
      thinkingLevel: "low",
      compaction: { enabled: false },
      roles: { small: { model: "anthropic/claude-sonnet-5-5" } },
    });
  });

  it("adds an extension's option, and takes it away with null, with its extension once it has none", () => {
    const added = overridesWithFields(DEFAULT_SETTINGS, [
      { field: "extensions.web.searchProvider", value: "exa" },
      { field: "extensions.notes.level", value: 2 },
    ]);

    expect(added).toEqual({
      extensions: { web: { searchProvider: "exa" }, notes: { level: 2 } },
    });

    expect(
      overridesWithFields(resolved(added), [
        { field: "extensions.web.searchProvider", value: null },
      ]),
    ).toEqual({ extensions: { notes: { level: 2 } } });
  });

  it("does not mutate the settings it is given", () => {
    const settings = resolved({ extensions: { web: { searchProvider: "exa" } } });

    overridesWithFields(settings, [{ field: "extensions.web.searchProvider", value: null }]);

    expect(settings.extensions).toEqual({ web: { searchProvider: "exa" } });
  });

  it("resolves to settings where the fields have their values", () => {
    const next = resolved(
      overridesWithFields(DEFAULT_SETTINGS, [
        { field: "tools.offered", value: ["read", "web_fetch"] },
        { field: "branchSummary.skipPrompt", value: true },
      ]),
    );

    expect(next.tools.offered).toEqual(["read", "web_fetch"]);
    expect(next.branchSummary.skipPrompt).toBe(true);
  });
});
