import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, resolveLeniently, type Settings } from "./settings.ts";
import {
  OVERRIDE_FIELD_NAMES,
  overrideFieldPath,
  overrideFields,
  overrideValue,
  resolveOverrides,
  resolveOverridesLeniently,
  resetsOverride,
  withOverrideFields,
  withOverrides,
} from "./settings-overrides.ts";

const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const HAIKU = "anthropic/claude-haiku-5-5";

/** The settings an Environment with `overrides` resolves to over `global`, strictly. */
const environment = (global: Schema.Json, overrides: Schema.Json): Settings => {
  const result = resolveOverrides(global, overrides);

  if (Result.isFailure(result)) throw new Error(result.failure.message);

  return result.success;
};

const changed = (
  overrides: Schema.Json,
  change: { readonly set?: Schema.Json; readonly reset?: ReadonlyArray<string> },
  current: Settings = DEFAULT_SETTINGS,
): Schema.Json => {
  const result = withOverrides(overrides, change, current);

  if (Result.isFailure(result)) throw new Error(result.failure.message);

  return result.success;
};

describe("an Environment's settings", () => {
  it("inherit Global where the Environment overrides nothing", () => {
    const settings = environment({ model: SONNET, roles: { small: { model: OPUS } } }, {});

    expect(settings.model).toBe(SONNET);
    expect(settings.roles.small.model).toBe(OPUS);
    expect(settings.thinkingLevel).toBe(DEFAULT_SETTINGS.thinkingLevel);
  });

  it("take the Environment's Override over Global", () => {
    expect(environment({ model: SONNET }, { model: HAIKU }).model).toBe(HAIKU);
  });

  it("keep an Override equal to Global pinned when Global changes", () => {
    const overrides = { model: SONNET };

    expect(environment({ model: SONNET }, overrides).model).toBe(SONNET);
    expect(environment({ model: HAIKU }, overrides).model).toBe(SONNET);
  });

  it("override the Roles one by one, each with its model and hint", () => {
    const settings = environment(
      { roles: { large: { model: SONNET, hint: "Global large" } } },
      { roles: { small: { model: OPUS, hint: "pinned small" } } },
    );

    expect(settings.roles.small).toEqual({ model: OPUS, hint: "pinned small" });
    expect(settings.roles.large).toEqual({ model: SONNET, hint: "Global large" });
    expect(settings.roles.medium).toEqual(DEFAULT_SETTINGS.roles.medium);
  });

  it("override the extension options key by key", () => {
    const settings = environment(
      { extensions: { subagents: { readToolset: ["read"], maxSubagentDepth: 3 } } },
      { extensions: { subagents: { maxSubagentDepth: 1 }, web: { searchProvider: "exa" } } },
    );

    expect(settings.extensions).toEqual({
      subagents: { readToolset: ["read"], maxSubagentDepth: 1 },
      web: { searchProvider: "exa" },
    });
  });

  it("replace the offered tools as a whole", () => {
    expect(
      environment(
        { tools: { offered: ["read", "bash", "web_fetch"] } },
        { tools: { offered: ["read"] } },
      ).tools.offered,
    ).toEqual(["read"]);
  });

  it("override compaction setting by setting", () => {
    const settings = environment(
      { compaction: { enabled: false, reserveTokens: 1000 } },
      { compaction: { enabled: true } },
    );

    expect(settings.compaction.enabled).toBe(true);
    expect(settings.compaction.reserveTokens).toBe(1000);
  });

  it("take an Override of no spend limit over Global's limit", () => {
    expect(
      environment({ spendLimit: { perSession: 10 } }, { spendLimit: { perSession: null } })
        .spendLimit.perSession,
    ).toBeNull();
    expect(environment({ spendLimit: { perSession: 10 } }, {}).spendLimit.perSession).toBe(10);
  });

  it("offer a renamed tool an Environment's list names under its new name", () => {
    expect(
      environment({}, { tools: { offered: ["read", "restart_container"] } }).tools.offered,
    ).toEqual(["read", "container_restart"]);
  });

  it("refuse an Override the settings do not take, naming it", () => {
    const result = resolveOverrides({}, { model: "openai/gpt-1" });

    expect(Result.isFailure(result) && result.failure.message).toContain("model");
  });
});

describe("the Instructions at an Environment", () => {
  it("are Global's: they add up (ADR-0027), so an Environment does not override them", () => {
    expect(environment({ instructions: "Global rules." }, {}).instructions).toBe("Global rules.");
    expect(OVERRIDE_FIELD_NAMES).not.toContain("instructions");
    expect(overrideFieldPath("instructions")).toBeUndefined();
  });

  it("are refused as an Override, by a save and by a change", () => {
    const saved = resolveOverrides({}, { instructions: "Mine." });

    expect(Result.isFailure(saved) && saved.failure.message).toBe(
      "instructions: not an Override: an Environment's Instructions add to the Global ones, and are not kept yet",
    );

    const set = withOverrides({}, { set: { instructions: "Mine." } }, DEFAULT_SETTINGS);

    expect(Result.isFailure(set) && set.failure.message).toContain("instructions: not an Override");

    const field = withOverrideFields(
      {},
      [{ field: "instructions", value: "Mine." }],
      DEFAULT_SETTINGS,
    );

    expect(Result.isFailure(field) && field.failure.message).toContain("instructions");

    const reset = withOverrides({}, { reset: ["instructions"] }, DEFAULT_SETTINGS);

    expect(Result.isFailure(reset)).toBe(true);
  });

  it("are left out of Overrides that hold them, which then show Global's", () => {
    const { settings, overrides, dropped } = resolveOverridesLeniently(
      { instructions: "Global rules." },
      { instructions: "Mine.", model: SONNET },
    );

    expect(settings.instructions).toBe("Global rules.");
    expect(settings.model).toBe(SONNET);
    expect(overrides).toEqual({ model: SONNET });
    expect(dropped).toEqual([
      "instructions: not an Override: an Environment's Instructions add to the Global ones, and are not kept yet",
    ]);
    expect(overrideFields({ instructions: "Mine.", model: SONNET })).toEqual(["model"]);
  });
});

describe("resolving an Environment's stale Overrides leniently", () => {
  it("drops only the Override that no longer resolves, which then follows Global", () => {
    const { settings, overrides, dropped } = resolveOverridesLeniently(
      { model: SONNET },
      { model: "anthropic/claude-retired-1", thinkingLevel: "low", retired: true },
    );

    expect(settings.model).toBe(SONNET);
    expect(settings.thinkingLevel).toBe("low");
    expect(overrides).toEqual({ thinkingLevel: "low" });
    expect(dropped).toHaveLength(2);
  });

  it("drops a stale Role whole, which then follows Global", () => {
    const { settings } = resolveOverridesLeniently(
      { roles: { small: { model: SONNET } } },
      { roles: { small: { model: "anthropic/claude-retired-1", hint: "old" } } },
    );

    expect(settings.roles.small).toEqual({
      model: SONNET,
      hint: DEFAULT_SETTINGS.roles.small.hint,
    });
  });

  it("gives Global for Overrides that are not an object", () => {
    const { settings, dropped } = resolveOverridesLeniently({ model: SONNET }, "high");

    expect(settings.model).toBe(SONNET);
    expect(dropped).toHaveLength(1);
  });

  it("resolves an Environment with no Overrides exactly as Global resolved before Environments had any", () => {
    // Stored before Overrides existed: a Global document with a value a release dropped among the good ones.
    const before = {
      model: SONNET,
      thinkingLevel: "minimal",
      roles: { small: { model: OPUS }, medium: { model: "anthropic/claude-retired-1" } },
      tools: { offered: ["read", "restart_container"] },
      spendLimit: { perSession: 4 },
      extensions: { subagents: { maxSubagentDepth: 3 } },
    };

    for (const overrides of [{}, null]) {
      const { settings, global } = resolveOverridesLeniently(before, overrides ?? {});

      expect(settings).toEqual(resolveLeniently(before).settings);
      expect(global).toEqual(resolveLeniently(before).settings);
    }
  });
});

describe("the fields an Environment overrides", () => {
  it("are a Role whole, an extension's option by key and every other setting by itself", () => {
    expect(
      overrideFields({
        model: SONNET,
        roles: { small: { model: OPUS, hint: "h" } },
        compaction: { enabled: false, reserveTokens: 10 },
        tools: { offered: ["read"] },
        spendLimit: { perSession: null },
        branchSummary: { skipPrompt: true },
        extensions: { subagents: { maxSubagentDepth: 1, "a.b": 2 } },
      }),
    ).toEqual([
      "model",
      "roles.small",
      "compaction.enabled",
      "compaction.reserveTokens",
      "tools.offered",
      "spendLimit.perSession",
      "branchSummary.skipPrompt",
      "extensions.subagents.maxSubagentDepth",
      "extensions.subagents.a.b",
    ]);
  });

  it("name their keys, and refuse what is not one", () => {
    expect(overrideFieldPath("roles.small")).toEqual(["roles", "small"]);
    expect(overrideFieldPath("extensions.subagents.a.b")).toEqual([
      "extensions",
      "subagents",
      "a.b",
    ]);
    expect(overrideFieldPath("spendLimit.perSession")).toEqual(["spendLimit", "perSession"]);
    expect(overrideFieldPath("roles.small.model")).toBeUndefined();
    expect(overrideFieldPath("roles.tiny")).toBeUndefined();
    expect(overrideFieldPath("compaction")).toBeUndefined();
    expect(overrideFieldPath("extensions.subagents")).toBeUndefined();
    expect(overrideFieldPath("bogus")).toBeUndefined();
  });

  it("read an Override, none where the field inherits", () => {
    const overrides = {
      spendLimit: { perSession: null },
      roles: { small: { model: OPUS, hint: "h" } },
    };

    expect(overrideValue(overrides, "spendLimit.perSession")).toEqual(Option.some(null));
    expect(overrideValue(overrides, "roles.small")).toEqual(
      Option.some({ model: OPUS, hint: "h" }),
    );
    expect(overrideValue(overrides, "model")).toEqual(Option.none());
  });

  it("are listed by name, each one a field", () => {
    expect(OVERRIDE_FIELD_NAMES).toContain("model");
    expect(OVERRIDE_FIELD_NAMES).toContain("roles.small");
    expect(OVERRIDE_FIELD_NAMES).toContain("compaction.enabled");
    expect(OVERRIDE_FIELD_NAMES).toContain("tools.offered");
    expect(OVERRIDE_FIELD_NAMES).toContain("extensions.<extension>.<key>");

    for (const field of OVERRIDE_FIELD_NAMES) {
      if (!field.startsWith("extensions.")) expect(overrideFieldPath(field)).toBeDefined();
    }
  });

  it("are reset, not overridden, by null only for an extension's option", () => {
    expect(resetsOverride("extensions.subagents.readToolset", null)).toBe(true);
    expect(resetsOverride("extensions.subagents.readToolset", ["read"])).toBe(false);
    expect(resetsOverride("spendLimit.perSession", null)).toBe(false);
  });
});

describe("changing an Environment's Overrides", () => {
  it("sets fields one by one over those it has, and keeps the rest", () => {
    expect(
      changed(
        { model: SONNET, compaction: { enabled: false } },
        { set: { thinkingLevel: "low", compaction: { reserveTokens: 100 } } },
      ),
    ).toEqual({
      model: SONNET,
      thinkingLevel: "low",
      compaction: { enabled: false, reserveTokens: 100 },
    });
  });

  it("keeps a Role whole, filling what the change leaves out from the Role in force", () => {
    const current = environment({}, { roles: { small: { model: SONNET, hint: "mine" } } });

    expect(changed({}, { set: { roles: { small: { model: OPUS } } } }, current)).toEqual({
      roles: { small: { model: OPUS, hint: "mine" } },
    });
  });

  it("keeps an Override of no spend limit, and resets an extension option given null", () => {
    expect(
      changed(
        { extensions: { web: { searchProvider: "exa" } } },
        {
          set: { spendLimit: { perSession: null }, extensions: { web: { searchProvider: null } } },
        },
      ),
    ).toEqual({ spendLimit: { perSession: null } });
  });

  it("resets a field by removing its Override, and an emptied section with it", () => {
    expect(
      changed(
        {
          model: SONNET,
          roles: { small: { model: OPUS, hint: "h" } },
          extensions: { web: { a: 1 } },
        },
        { reset: ["roles.small", "extensions.web.a", "thinkingLevel"] },
      ),
    ).toEqual({ model: SONNET });
  });

  it("takes changes field by field, as the agent's tools give them", () => {
    const result = withOverrideFields(
      { model: SONNET, spendLimit: { perSession: 5 } },
      [
        { field: "roles.small", value: { model: OPUS } },
        { field: "extensions.web.a.b", value: 1 },
        { field: "model", reset: true },
      ],
      DEFAULT_SETTINGS,
    );

    expect(result).toEqual(
      Result.succeed({
        spendLimit: { perSession: 5 },
        roles: { small: { model: OPUS, hint: DEFAULT_SETTINGS.roles.small.hint } },
        extensions: { web: { "a.b": 1 } },
      }),
    );
    expect(
      Result.isFailure(
        withOverrideFields({}, [{ field: "compaction", value: {} }], DEFAULT_SETTINGS),
      ),
    ).toBe(true);
  });

  it("refuses to reset what is not a field", () => {
    const result = withOverrides({}, { reset: ["roles.small.model"] }, DEFAULT_SETTINGS);

    expect(Result.isFailure(result) && result.failure.message).toContain("roles.small.model");
  });
});
