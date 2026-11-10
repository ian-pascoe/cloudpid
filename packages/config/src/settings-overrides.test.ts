import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { resolveMcpServerSet } from "./mcp-server-set.ts";
import { DEFAULT_SETTINGS, resolveLeniently, type Settings } from "./settings.ts";
import {
  OVERRIDE_FIELD_NAMES,
  overrideFieldPath,
  overrideFields,
  overrideInherited,
  overrideValue,
  overridesPatchBetween,
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

  it("refuse an Override the settings do not take, naming it", () => {
    const result = resolveOverrides({}, { model: "gpt-1" });

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
      "instructions: not an Override: an Environment's Instructions add to the Global ones, and are saved on their own",
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
      "instructions: not an Override: an Environment's Instructions add to the Global ones, and are saved on their own",
    ]);
    expect(overrideFields({ instructions: "Mine.", model: SONNET })).toEqual(["model"]);
  });
});

describe("resolving an Environment's stale Overrides leniently", () => {
  it("drops only the Override that no longer resolves, which then follows Global", () => {
    const { settings, overrides, dropped } = resolveOverridesLeniently(
      { model: SONNET },
      { model: "claude-retired-1", thinkingLevel: "low", retired: true },
    );

    expect(settings.model).toBe(SONNET);
    expect(settings.thinkingLevel).toBe("low");
    expect(overrides).toEqual({ thinkingLevel: "low" });
    expect(dropped).toHaveLength(2);
  });

  it("drops a stale Role whole, which then follows Global", () => {
    const { settings } = resolveOverridesLeniently(
      { roles: { small: { model: SONNET } } },
      { roles: { small: { model: "claude-retired-1", hint: "old" } } },
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
      roles: { small: { model: OPUS }, medium: { model: "claude-retired-1" } },
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
    for (const field of OVERRIDE_FIELD_NAMES) {
      if (!field.startsWith("extensions.")) {
        expect(overrideFieldPath(field.replace("<name>", "linear"))).toBeDefined();
      }
    }
  });

  it("are reset, not overridden, by null only for an extension's option or an MCP server's key", () => {
    expect(resetsOverride("extensions.subagents.readToolset", null)).toBe(true);
    expect(resetsOverride("extensions.subagents.readToolset", ["read"])).toBe(false);
    expect(resetsOverride("spendLimit.perSession", null)).toBe(false);
    expect(resetsOverride("mcp.servers.files.enabled", null)).toBe(true);
    expect(resetsOverride("mcp.servers.files.toolExposure", null)).toBe(true);
    expect(resetsOverride("mcp.servers.files.enabled", false)).toBe(false);
  });

  it("inherit an MCP server's key unless an Override holds it, and never inside the Environment's own entry", () => {
    const adjusted = { mcp: { servers: { files: { enabled: false } } } };
    const own = { mcp: { servers: { files: { command: "node" } } } };

    expect(overrideInherited({}, "mcp.servers.files.enabled")).toBe(true);
    expect(overrideInherited(adjusted, "mcp.servers.files.enabled")).toBe(false);
    expect(overrideInherited(adjusted, "mcp.servers.files.exposure")).toBe(true);
    // The entry replaces Global's whole: a key it does not write reads as its default, not as Global's.
    expect(overrideInherited(own, "mcp.servers.files.enabled")).toBe(false);
    expect(overrideInherited(own, "mcp.servers.other.enabled")).toBe(true);
    expect(overrideInherited({ model: SONNET }, "model")).toBe(false);
    expect(overrideInherited({}, "model")).toBe(true);
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

describe("the change between two sets of an Environment's Overrides", () => {
  it("sets each field added or changed, whole, and resets each taken out", () => {
    expect(
      overridesPatchBetween(
        {
          model: SONNET,
          roles: { small: { model: OPUS, hint: "h" }, large: { model: OPUS, hint: "l" } },
          spendLimit: { perSession: 5 },
        },
        {
          model: SONNET,
          roles: { small: { model: HAIKU, hint: "h" }, large: { model: OPUS, hint: "l" } },
          thinkingLevel: "low",
          extensions: { subagents: { maxSubagentDepth: 3 } },
        },
      ),
    ).toEqual({
      set: {
        roles: { small: { model: HAIKU, hint: "h" } },
        thinkingLevel: "low",
        extensions: { subagents: { maxSubagentDepth: 3 } },
      },
      reset: ["spendLimit.perSession"],
    });
  });

  it("keeps an Override of no spend limit as a value, and is empty when nothing changed", () => {
    expect(overridesPatchBetween({}, { spendLimit: { perSession: null } })).toEqual({
      set: { spendLimit: { perSession: null } },
    });
    expect(overridesPatchBetween({ model: SONNET }, { model: SONNET })).toEqual({});
  });
});

describe("an Environment's MCP servers", () => {
  const LINEAR = {
    url: "https://mcp.linear.app/mcp",
    headers: { Authorization: "Bearer ${TOKEN}" },
  };

  const LOCAL = { command: "node", args: ["server.js"] };

  /** The MCP server entries of an Environment's settings, as written. */
  const servers = (global: Schema.Json, overrides: Schema.Json) =>
    environment(global, overrides).mcp.servers;

  describe("as Override fields", () => {
    it("are an entry whole, and each key of an adjustment", () => {
      expect(overrideFieldPath("mcp.servers.linear")).toEqual(["mcp", "servers", "linear"]);

      for (const key of ["enabled", "exposure", "toolExposure"]) {
        expect(overrideFieldPath(`mcp.servers.linear.${key}`)).toEqual([
          "mcp",
          "servers",
          "linear",
          key,
        ]);
      }
    });

    it("are not a field for another key of an entry, a section, or a name that is not one", () => {
      for (const field of [
        "mcp",
        "mcp.servers",
        "mcp.autoEnableCodemode",
        "mcp.servers.linear.url",
        "mcp.servers.linear.enabled.x",
        "mcp.servers.my server.enabled",
        `mcp.servers.${"n".repeat(65)}`,
      ]) {
        expect(overrideFieldPath(field)).toBeUndefined();
      }
    });

    it("are listed in the fields to reset", () => {
      expect(OVERRIDE_FIELD_NAMES).toEqual(
        expect.arrayContaining([
          "mcp.servers.<name>",
          "mcp.servers.<name>.enabled",
          "mcp.servers.<name>.exposure",
          "mcp.servers.<name>.toolExposure",
        ]),
      );
    });

    it("are read from the Overrides: an entry as one, an adjustment key by key", () => {
      const overrides = {
        model: SONNET,
        mcp: {
          servers: {
            own: LOCAL,
            linear: { enabled: false, toolExposure: { "a*": "hidden" } },
          },
        },
      };

      expect(overrideFields(overrides)).toEqual([
        "model",
        "mcp.servers.own",
        "mcp.servers.linear.enabled",
        "mcp.servers.linear.toolExposure",
      ]);
      expect(Option.getOrNull(overrideValue(overrides, "mcp.servers.own"))).toEqual(LOCAL);
      expect(Option.getOrNull(overrideValue(overrides, "mcp.servers.linear.toolExposure"))).toEqual(
        {
          "a*": "hidden",
        },
      );
      expect(Option.isNone(overrideValue(overrides, "mcp.servers.linear.exposure"))).toBe(true);
    });
  });

  describe("resolved over Global", () => {
    it("inherit Global's entries", () => {
      expect(servers({ mcp: { servers: { linear: LINEAR } } }, {})).toEqual({ linear: LINEAR });
    });

    it("take an entry of their own, which replaces Global's of that name whole", () => {
      const own = { command: "node", args: ["mine.js"] };

      expect(
        servers(
          { mcp: { servers: { linear: { ...LINEAR, timeout: 5 }, other: LOCAL } } },
          {
            mcp: { servers: { linear: own, extra: LOCAL } },
          },
        ),
      ).toEqual({ linear: own, other: LOCAL, extra: LOCAL });
    });

    it("apply an adjustment over the server it adjusts: `{ ...base, ...value }`", () => {
      expect(
        servers(
          {
            mcp: {
              servers: { linear: { ...LINEAR, exposure: "direct", toolExposure: { a: "direct" } } },
            },
          },
          { mcp: { servers: { linear: { enabled: false, toolExposure: { b: "hidden" } } } } },
        ).linear,
      ).toEqual({
        ...LINEAR,
        exposure: "direct",
        enabled: false,
        toolExposure: { b: "hidden" },
      });
    });

    it("keep an adjustment of a server Global does not have: its base may be a Repo's", () => {
      expect(servers({}, { mcp: { servers: { fromRepo: { enabled: false } } } })).toEqual({
        fromRepo: { enabled: false },
      });
    });

    it("refuse a name that clashes with one of Global's in case or in `-`/`_`", () => {
      const result = resolveOverrides(
        { mcp: { servers: { "my-linear": LINEAR } } },
        { mcp: { servers: { My_Linear: LOCAL } } },
      );

      expect(Result.isFailure(result) && result.failure.message).toBe(
        'mcp.servers.My_Linear: clashes with "my-linear": names that differ only in case or in - and _ are one server',
      );
    });

    it("refuse an entry that does not decode, and an adjustment that carries a definition key", () => {
      const bad = resolveOverrides({}, { mcp: { servers: { x: { command: "a", auth: "b" } } } });
      const adjust = resolveOverrides({}, { mcp: { servers: { x: { timeout: 3 } } } });

      expect(Result.isFailure(bad) && bad.failure.message).toMatch(/^mcp\.servers\.x\.auth: /);
      expect(Result.isFailure(adjust) && adjust.failure.message).toMatch(
        /^mcp\.servers\.x\.timeout: /,
      );
    });

    it("are bounded to 50 servers of their own, with their adjustments left out of the count", () => {
      const own = (count: number) =>
        Record.fromEntries(Arr.makeBy(count, (i): [string, Schema.Json] => [`s${i}`, LOCAL]));

      const adjustments = Record.fromEntries(
        Arr.makeBy(10, (i): [string, Schema.Json] => [`a${i}`, { enabled: false }]),
      );

      expect(
        Result.isSuccess(
          resolveOverrides(
            { mcp: { servers: own(50) } },
            {
              mcp: {
                servers: Record.union(
                  Record.map(own(50), (_, key) => ({ ...LOCAL, args: [key] })),
                  adjustments,
                  (l) => l,
                ),
              },
            },
          ),
        ),
      ).toBe(true);

      const over = resolveOverrides({}, { mcp: { servers: own(51) } });

      expect(Result.isFailure(over) && over.failure.message).toBe(
        "mcp.servers.s50: is over the 50 MCP servers a Scope may have",
      );
    });
  });

  describe("changed field by field", () => {
    it("set an adjustment key over the others, and an entry over an adjustment", () => {
      const adjusted = changed(
        { mcp: { servers: { linear: { enabled: false } } } },
        { set: { mcp: { servers: { linear: { exposure: "hidden" } } } } },
      );

      expect(adjusted).toEqual({
        mcp: { servers: { linear: { enabled: false, exposure: "hidden" } } },
      });
      expect(changed(adjusted, { set: { mcp: { servers: { linear: LOCAL } } } })).toEqual({
        mcp: { servers: { linear: LOCAL } },
      });
    });

    it("reset an adjustment key, and the adjustment with its last key", () => {
      const overrides = { mcp: { servers: { linear: { enabled: false, exposure: "hidden" } } } };
      const one = changed(overrides, { reset: ["mcp.servers.linear.enabled"] });

      expect(one).toEqual({ mcp: { servers: { linear: { exposure: "hidden" } } } });
      expect(changed(one, { reset: ["mcp.servers.linear.exposure"] })).toEqual({});
      expect(
        changed(overrides, {
          reset: ["mcp.servers.linear.enabled", "mcp.servers.linear.exposure"],
        }),
      ).toEqual({});
    });

    it("reset an entry whole", () => {
      expect(
        changed(
          { model: SONNET, mcp: { servers: { own: LOCAL, other: LOCAL } } },
          { reset: ["mcp.servers.own"] },
        ),
      ).toEqual({ model: SONNET, mcp: { servers: { other: LOCAL } } });
    });

    it("are given field by field", () => {
      const result = withOverrideFields(
        {},
        [
          { field: "mcp.servers.linear.enabled", value: false },
          { field: "mcp.servers.own", value: LOCAL },
        ],
        DEFAULT_SETTINGS,
      );

      expect(Result.isSuccess(result) && result.success).toEqual({
        mcp: { servers: { linear: { enabled: false }, own: LOCAL } },
      });
      expect(
        Result.isFailure(
          withOverrideFields(
            {},
            [{ field: "mcp.servers.linear.url", value: "x" }],
            DEFAULT_SETTINGS,
          ),
        ),
      ).toBe(true);
    });

    it("make a patch that sets what differs and resets what is gone, by field", () => {
      expect(
        overridesPatchBetween(
          { mcp: { servers: { linear: { enabled: false, exposure: "hidden" }, own: LOCAL } } },
          { mcp: { servers: { linear: { enabled: false, exposure: "direct" }, new: LOCAL } } },
        ),
      ).toEqual({
        set: { mcp: { servers: { linear: { exposure: "direct" }, new: LOCAL } } },
        reset: ["mcp.servers.own"],
      });
    });
  });

  describe("read leniently", () => {
    it("drop an entry that no longer decodes, which then follows Global", () => {
      const read = resolveOverridesLeniently(
        { mcp: { servers: { linear: LINEAR } } },
        {
          model: SONNET,
          mcp: { servers: { linear: { command: "x", auth: "y" }, good: LOCAL } },
        },
      );

      expect(read.settings.mcp.servers).toEqual({ linear: LINEAR, good: LOCAL });
      expect(read.overrides).toEqual({ model: SONNET, mcp: { servers: { good: LOCAL } } });
      expect(read.dropped).toEqual([expect.stringMatching(/^mcp\.servers\.linear\.auth: /)]);
      expect(read.mcpProblems).toEqual([
        {
          source: "environment",
          name: "linear",
          keys: ["auth"],
          message: expect.any(String),
          reset: [],
        },
      ]);
    });

    it("drop a key of an adjustment that no longer applies, and keep the others", () => {
      const read = resolveOverridesLeniently(
        {},
        { mcp: { servers: { linear: { enabled: false, exposure: "visible" } } } },
      );

      expect(read.overrides).toEqual({ mcp: { servers: { linear: { enabled: false } } } });
    });

    it("drop the servers over 50", () => {
      const own = Record.fromEntries(
        Arr.makeBy(51, (i): [string, Schema.Json] => [`s${i}`, LOCAL]),
      );

      const read = resolveOverridesLeniently({}, { mcp: { servers: own } });

      expect(Record.size(read.settings.mcp.servers)).toBe(50);
      expect(read.dropped).toEqual([
        "mcp.servers.s50: is over the 50 MCP servers a Scope may have",
      ]);
    });

    it("let the Environment's own name win over a twin of it in Global, as the set does", () => {
      const read = resolveOverridesLeniently(
        { mcp: { servers: { Linear: LINEAR } } },
        { mcp: { servers: { linear: LOCAL } } },
      );

      expect(read.settings.mcp.servers).toEqual({ linear: LOCAL });
      expect(read.overrides).toEqual({ mcp: { servers: { linear: LOCAL } } });
      expect(read.dropped).toEqual([
        expect.stringMatching(/^mcp\.servers\.Linear: is left out: .*"linear"/),
      ]);
      // Structured, it is Global's entry that is left out, not an Override of the Environment's.
      expect(read.mcpProblems).toEqual([
        {
          source: "global",
          name: "Linear",
          keys: [],
          message: expect.stringMatching(/^is left out: .*"linear"/),
          reset: [],
        },
      ]);
      // The set the McpHost is handed says the same.
      expect(
        Arr.map(
          resolveMcpServerSet({ mcp: { servers: { Linear: LINEAR } } }, read.overrides, []).servers,
          ({ name }) => name,
        ),
      ).toEqual(["linear"]);
    });

    it("say Global's own left-out entries structured too, in Global's layer", () => {
      const read = resolveLeniently({
        mcp: { servers: { linear: { command: "x", auth: "y" }, good: LOCAL } },
      });

      expect(read.settings.mcp.servers).toEqual({ good: LOCAL });
      expect(read.mcpProblems).toEqual([
        {
          source: "global",
          name: "linear",
          keys: ["auth"],
          message: expect.any(String),
          reset: [],
        },
      ]);
      expect(resolveLeniently({}).mcpProblems).toEqual([]);
    });

    it("still refuse the clash on a save", () => {
      const saved = resolveOverrides(
        { mcp: { servers: { Linear: LINEAR } } },
        { mcp: { servers: { linear: LOCAL } } },
      );

      expect(Result.isFailure(saved)).toBe(true);
    });
  });
});
