// The `settings` extension (docs/spec.md → Agent changes), over fake Settings: what each tool shows and changes, the
// refusal of text that holds a Secret, the Settings read again after a change, and the Run's record of the changes.
// @effect-diagnostics asyncFunction:off
import {
  DEFAULT_OFFERED_TOOLS,
  DEFAULT_SETTINGS,
  overridesFrom,
  overridesWithFields,
  resolveSettings,
  type Settings,
  settingsFieldValue,
} from "@cloudpid/config";
import type { AgentChange } from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { AgentChangeLog, DeployCredentials, type RunChange } from "./environment.ts";
import { Redactions } from "./secrets/redaction.ts";
import { secretReference } from "./secrets/references.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";
import {
  type AppliedSettingsChange,
  SettingsAccess,
  SettingsAccessError,
  type SettingsAccessService,
  type SettingsApplied,
  type SettingsFieldChange,
  SettingsReload,
  SettingsTools,
} from "./settings.ts";
import { DEFAULT_TOOLSETS } from "./subagents.ts";
import { resolveTools } from "./subagents/toolsets.ts";

const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

const sameJson = Schema.toEquivalence(Schema.NullOr(Schema.Json));

/** The Settings over saved overrides, applying each change as the Registry would: the owner's strict resolution. */
const fakeSettings = (initial: Schema.Json = {}, problem?: string) => {
  let overrides = initial;

  const resolved = (): Settings => {
    const result = resolveSettings(overrides);

    if (Result.isFailure(result)) throw new Error(result.failure.message);

    return result.success;
  };

  const calls: Array<{
    changes: ReadonlyArray<SettingsFieldChange>;
    tool: string;
    reason: string;
  }> = [];

  const recorded: AgentChange[] = [];

  const service: SettingsAccessService = {
    get: Effect.sync(() => ({
      settings: resolved(),
      overrides: overridesFrom(resolved()),
      problem,
    })),
    change: ({ changes, author }) =>
      Effect.sync((): AppliedSettingsChange => {
        const before = resolved();

        const differing = Arr.filter(
          changes,
          (change) => !sameJson(settingsFieldValue(before, change.field), change.value),
        );

        if (differing.length === 0) return { status: "unchanged" };

        const next = resolveSettings(overridesWithFields(before, differing));

        if (Result.isFailure(next)) return { status: "rejected", message: next.failure.message };

        overrides = overridesFrom(next.success);
        calls.push({ changes, tool: author.tool, reason: author.reason });

        const made = Arr.map(differing, (change): AgentChange => ({
          id: recorded.length + 1,
          scope: "settings",
          at: 1_000,
          actor: "agent",
          session: "s-1",
          conversation: author.conversation,
          tool: author.tool,
          reason: author.reason,
          field: change.field,
          before: settingsFieldValue(before, change.field),
          after: settingsFieldValue(next.success, change.field),
          reverts: null,
          revertedBy: null,
        }));

        recorded.push(...made);

        return { status: "changed", changes: made };
      }),
  };

  return { service, calls, recorded, overrides: () => overrides };
};

/** Secrets that hold `values` as a Session would, redacting them as written and in their encodings. */
const heldSecrets = (values: Readonly<Record<string, string>>): SecretsService => {
  const redactions = new Redactions();

  for (const [name, value] of Record.toEntries(values)) redactions.hold(name, value);

  const used: Pick<SecretsService, "refresh" | "redact"> = {
    refresh: Effect.void,
    redact: (value) => redactions.redact(value),
  };

  // SAFETY: the tools use only `refresh` and `redact`.
  return used as SecretsService;
};

const toolsOver = async (
  settings: SettingsAccessService,
  {
    held = {},
    logged = [],
    reloaded = [],
    picked = { model: false, thinkingLevel: false },
  }: {
    held?: Readonly<Record<string, string>>;
    logged?: RunChange[];
    reloaded?: SettingsApplied[];
    picked?: SettingsApplied["picked"];
  } = {},
) => {
  const extension = await Effect.runPromise(
    SettingsTools.pipe(
      Effect.provideService(SettingsAccess, settings),
      Effect.provideService(SettingsReload, {
        apply: Effect.sync(() => {
          const applied = { picked };

          reloaded.push(applied);

          return applied;
        }),
      }),
      Effect.provideService(AgentChangeLog, {
        record: (change) =>
          Effect.sync(() => {
            logged.push(change);
          }),
      }),
      Effect.provideService(DeployCredentials, { values: [GITHUB_TOKEN] }),
      Effect.provideService(Secrets, heldSecrets(held)),
    ),
  );

  return (name: string): ToolRegistration => {
    const found = Arr.findFirst(extension.tools ?? [], (tool) => tool.name === name);

    return Option.getOrThrowWith(found, () => new Error(`no tool ${name}`));
  };
};

const conversation: Pick<ToolExecutionApi, "conversationId"> = {
  conversationId: ROOT_CONVERSATION_ID,
};

// SAFETY: the tools read only the calling conversation from the invocation's API.
const api = conversation as ToolExecutionApi;

type Outcome = Awaited<ReturnType<ToolRegistration["execute"]>>;

const run = (tool: ToolRegistration, args: Readonly<Record<string, unknown>>): Promise<Outcome> =>
  // SAFETY: the arguments are the tool's JSON parameters.
  tool.execute(args as never, api, BACKGROUND_CONTEXT);

const text = (result: Outcome): string =>
  Arr.join(
    Arr.map(result.output ?? [], (part) => (part.type === "text" ? part.text : "")),
    "",
  );

/** The message a call fails with: a typed failure is an error result. */
const failure = async (call: Promise<Outcome>) => {
  const result = await call;

  expect(result.isError).toBe(true);

  return text(result);
};

describe("the settings tools", () => {
  it("are eight, and only the reads are kept from a rerun after an eviction", async () => {
    const tool = await toolsOver(fakeSettings().service);

    expect(
      Arr.map(
        [
          "settings_get",
          "settings_model_set",
          "settings_role_set",
          "settings_tool_offer",
          "settings_tool_defer",
          "settings_compaction_set",
          "settings_branch_summary_set",
          "settings_extension_set",
        ],
        (name) => tool(name).replay,
      ),
    ).toEqual(["safe", ...Arr.replicate("unsafe", 7)]);
  });

  it("have no tool for the Limits", async () => {
    const tool = await toolsOver(fakeSettings().service);

    expect(() => tool("settings_spend_limit_set")).toThrow();
    expect(() => tool("settings_subagent_depth_set")).toThrow();
  });

  it("are not granted to a subagent, inherited or by name", () => {
    const ceiling = ["bash", "settings_get", "settings_model_set"];

    expect(resolveTools(undefined, ceiling, DEFAULT_TOOLSETS)).toMatchObject({
      success: { tools: ["bash"] },
    });
    expect(resolveTools(["settings_get"], ceiling, DEFAULT_TOOLSETS)).toMatchObject({
      failure: expect.stringContaining(
        "settings_get is unknown or outside your capability ceiling",
      ),
    });
  });
});

describe("settings_get", () => {
  it("shows the resolved settings, marking the overrides, and the Limit as the user's", async () => {
    const tool = await toolsOver(
      fakeSettings({
        thinkingLevel: "low",
        roles: { small: { model: "anthropic/claude-sonnet-5-5" } },
        extensions: { subagents: { readToolset: ["read"] } },
      }).service,
    );

    const shown = text(await run(tool("settings_get"), {}));

    expect(shown).toContain("Default model: anthropic/claude-opus-5-5\n");
    expect(shown).toContain("Default thinking level: low (override)");
    expect(shown).toContain("small: anthropic/claude-sonnet-5-5 (override); hint:");
    expect(shown).toContain("medium: anthropic/claude-sonnet-5-5; hint:");
    expect(shown).toContain("enabled: true");
    expect(shown).toContain(`Offered tools`);
    expect(shown).toContain(Arr.join(DEFAULT_OFFERED_TOOLS, ", "));
    expect(shown).toContain("Spend limit per Session (US dollars): not set");
    // The Limits say which tool changes them, with the owner's Approval.
    expect(shown).toContain("settings_spend_limit_set changes it once the user approves");
    expect(shown).toContain("Subagent depth (levels of subagents below the root): 2.");
    expect(shown).toContain("subagents.readToolset = read");
  });

  it("says what is wrong with the saved overrides", async () => {
    const tool = await toolsOver(
      fakeSettings({}, "These saved overrides no longer apply:\nmodel: gone").service,
    );

    expect(text(await run(tool("settings_get"), {}))).toContain(
      "Saved overrides left out, as they no longer apply: These saved overrides no longer apply:\nmodel: gone",
    );
  });
});

describe("settings_model_set", () => {
  it("changes the default model and thinking level, records both, and reads the Settings again", async () => {
    const settings = fakeSettings();
    const logged: RunChange[] = [];
    const reloaded: SettingsApplied[] = [];
    const tool = await toolsOver(settings.service, { logged, reloaded });

    const result = await run(tool("settings_model_set"), {
      model: "anthropic/claude-sonnet-5-5",
      thinking_level: "low",
      reason: "The task is small",
    });

    expect(result.isError).not.toBe(true);
    expect(settings.overrides()).toEqual({
      model: "anthropic/claude-sonnet-5-5",
      thinkingLevel: "low",
    });
    expect(settings.calls[0]).toMatchObject({
      tool: "settings_model_set",
      reason: "The task is small",
    });
    expect(text(result)).toContain(
      "default model: it was anthropic/claude-opus-5-5, and is anthropic/claude-sonnet-5-5 now",
    );
    expect(text(result)).toContain("default thinking level: it was high, and is low now");
    expect(text(result)).toContain(
      "This Session follows the defaults, so its next request uses them",
    );
    expect(logged).toEqual([
      { tool: "settings_model_set", field: "model" },
      { tool: "settings_model_set", field: "thinkingLevel" },
    ]);
    expect(reloaded).toHaveLength(1);
    expect(result.details).toMatchObject({
      agentChanges: [
        {
          field: "model",
          before: "anthropic/claude-opus-5-5",
          after: "anthropic/claude-sonnet-5-5",
        },
        { field: "thinkingLevel", before: "high", after: "low" },
      ],
    });
  });

  it("says a Session that picked its own model keeps it", async () => {
    const tool = await toolsOver(fakeSettings().service, {
      picked: { model: true, thinkingLevel: false },
    });

    const result = await run(tool("settings_model_set"), {
      model: "anthropic/claude-haiku-5-5",
      reason: "r",
    });

    expect(text(result)).toContain("This Session picked its own model, which it keeps");
  });

  it("needs a model, a thinking level, or both", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    expect(await failure(run(tool("settings_model_set"), { reason: "r" }))).toContain(
      "Give a model, a thinking level, or both",
    );
    expect(settings.calls).toEqual([]);
  });

  it("says so of a default that already has the value, and records and reloads nothing", async () => {
    const logged: RunChange[] = [];
    const reloaded: SettingsApplied[] = [];
    const tool = await toolsOver(fakeSettings().service, { logged, reloaded });

    const result = await run(tool("settings_model_set"), { thinking_level: "high", reason: "r" });

    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("already has these values");
    expect(logged).toEqual([]);
    expect(reloaded).toEqual([]);
  });
});

describe("settings_role_set", () => {
  it("changes a role's model, leaving its hint", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    const result = await run(tool("settings_role_set"), {
      role: "small",
      model: "anthropic/claude-sonnet-5-5",
      reason: "Haiku missed too much",
    });

    expect(settings.overrides()).toEqual({
      roles: { small: { model: "anthropic/claude-sonnet-5-5" } },
    });
    expect(text(result)).toContain(
      "model of the small role: it was anthropic/claude-haiku-5-5, and is anthropic/claude-sonnet-5-5 now",
    );
  });

  it("changes the hint with it", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    await run(tool("settings_role_set"), {
      role: "large",
      model: "anthropic/claude-opus-5-5",
      hint: "Use for reviews",
      reason: "r",
    });

    expect(settings.overrides()).toEqual({ roles: { large: { hint: "Use for reviews" } } });
    expect(settings.recorded).toHaveLength(1);
  });

  it("refuses a hint that holds a Secret", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service, { held: { KEY: "sk-live-0123456789" } });

    expect(
      await failure(
        run(tool("settings_role_set"), {
          role: "large",
          model: "anthropic/claude-opus-5-5",
          hint: "key is sk-live-0123456789",
          reason: "r",
        }),
      ),
    ).toContain("holds the value of a Secret");
    expect(settings.calls).toEqual([]);
  });
});

describe("settings_tool_offer and settings_tool_defer", () => {
  it("offers a tool by adding one entry to the list", async () => {
    const settings = fakeSettings();
    const logged: RunChange[] = [];
    const tool = await toolsOver(settings.service, { logged });

    const result = await run(tool("settings_tool_offer"), { pattern: "web_fetch", reason: "r" });

    expect(settings.overrides()).toEqual({
      tools: { offered: [...DEFAULT_OFFERED_TOOLS, "web_fetch"] },
    });
    expect(text(result)).toContain("Offered web_fetch");
    expect(logged).toEqual([{ tool: "settings_tool_offer", field: "tools.offered" }]);
  });

  it("says so of an entry the list has", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    const result = await run(tool("settings_tool_offer"), { pattern: "bash", reason: "r" });

    expect(text(result)).toContain("bash is among the offered tools already");
    expect(settings.calls).toEqual([]);
  });

  it("refuses an entry that is not a name or a pattern, with the owner's message", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    const message = await failure(
      run(tool("settings_tool_offer"), { pattern: "Web Fetch", reason: "r" }),
    );

    expect(message).toContain("Nothing was saved:");
    expect(message).toContain("tools.offered");
    expect(settings.calls).toEqual([]);
  });

  it("defers a tool by removing its entry", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    const result = await run(tool("settings_tool_defer"), { pattern: "grep", reason: "r" });

    expect(settings.overrides()).toEqual({
      tools: { offered: Arr.filter(DEFAULT_OFFERED_TOOLS, (name) => name !== "grep") },
    });
    expect(text(result)).toContain("Deferred grep");
  });

  it("says tool_search stays offered whatever the list says", async () => {
    const tool = await toolsOver(fakeSettings().service);

    const result = await run(tool("settings_tool_defer"), { pattern: "tool_search", reason: "r" });

    expect(text(result)).toContain("tool_search stays offered whatever the list says");
  });

  it("says an entry the list lacks is not deferred, naming the pattern that offers the tool", async () => {
    const settings = fakeSettings({ tools: { offered: ["read", "context_*"] } });
    const tool = await toolsOver(settings.service);

    const result = await run(tool("settings_tool_defer"), {
      pattern: "context_notes",
      reason: "r",
    });

    expect(text(result)).toContain('no entry "context_notes"');
    expect(text(result)).toContain("offered by context_*");
    expect(settings.calls).toEqual([]);
  });
});

describe("settings_compaction_set", () => {
  it("changes the settings given, and leaves the others", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    const result = await run(tool("settings_compaction_set"), {
      enabled: false,
      reserve_tokens: 20_000,
      reason: "r",
    });

    expect(settings.overrides()).toEqual({ compaction: { enabled: false, reserveTokens: 20_000 } });
    expect(text(result)).toContain("compaction enabled: it was true, and is false now");
    expect(text(result)).toContain("compaction reserveTokens: it was 16384, and is 20000 now");
  });

  it("needs at least one setting", async () => {
    const tool = await toolsOver(fakeSettings().service);

    expect(await failure(run(tool("settings_compaction_set"), { reason: "r" }))).toContain(
      "Give at least one",
    );
  });

  it("refuses a value the settings do not take with the owner's message, and records nothing", async () => {
    const settings = fakeSettings();
    const logged: RunChange[] = [];
    const tool = await toolsOver(settings.service, { logged });

    const message = await failure(
      run(tool("settings_compaction_set"), { reserve_tokens: -5, reason: "r" }),
    );

    expect(message).toMatch(/^Nothing was saved: compaction\.reserveTokens: /);
    expect(settings.recorded).toEqual([]);
    expect(logged).toEqual([]);
  });
});

describe("settings_branch_summary_set", () => {
  it("changes whether the prompt is skipped", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    const result = await run(tool("settings_branch_summary_set"), {
      skip_prompt: true,
      reason: "r",
    });

    expect(settings.overrides()).toEqual({ branchSummary: { skipPrompt: true } });
    expect(text(result)).toContain("it was false, and is true now");
  });
});

describe("settings_extension_set", () => {
  it("sets one option of one extension, and takes it away with null", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    const set = await run(tool("settings_extension_set"), {
      extension: "subagents",
      key: "readToolset",
      value: ["read", "grep"],
      reason: "r",
    });

    expect(settings.overrides()).toEqual({
      extensions: { subagents: { readToolset: ["read", "grep"] } },
    });
    expect(text(set)).toContain("subagents.readToolset");
    expect(text(set)).toContain("next subagent started");

    await run(tool("settings_extension_set"), {
      extension: "subagents",
      key: "readToolset",
      value: null,
      reason: "r",
    });

    expect(settings.overrides()).toEqual({});
  });

  it("refuses the subagent depth, which is a Limit, pointing to settings_subagent_depth_set", async () => {
    const settings = fakeSettings();
    const logged: RunChange[] = [];
    const tool = await toolsOver(settings.service, { logged });

    expect(
      await failure(
        run(tool("settings_extension_set"), {
          extension: "subagents",
          key: "maxSubagentDepth",
          value: 5,
          reason: "r",
        }),
      ),
    ).toContain("settings_subagent_depth_set");
    expect(settings.calls).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("refuses a toolset that is not a list of names, which the extension would ignore with its other options", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    expect(
      await failure(
        run(tool("settings_extension_set"), {
          extension: "subagents",
          key: "readToolset",
          value: "read",
          reason: "r",
        }),
      ),
    ).toContain("is a list of tool names");
    expect(settings.calls).toEqual([]);
  });

  it("saves an option no extension is known to read, saying only an extension that reads it is affected", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    const result = await run(tool("settings_extension_set"), {
      extension: "notes",
      key: "level",
      value: 2,
      reason: "r",
    });

    expect(settings.overrides()).toEqual({ extensions: { notes: { level: 2 } } });
    expect(text(result)).toContain("Only an extension that reads notes.level is affected");
  });

  it("refuses a value that holds a Secret, in any depth", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service, { held: { KEY: "sk-live-0123456789" } });

    expect(
      await failure(
        run(tool("settings_extension_set"), {
          extension: "notes",
          key: "auth",
          value: { nested: ["sk-live-0123456789"] },
          reason: "r",
        }),
      ),
    ).toContain("holds the value of a Secret");
    expect(settings.calls).toEqual([]);
  });
});

describe("a reason", () => {
  it("that holds a Secret's value or the GitHub token is refused, since it is kept as written", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service, { held: { KEY: "sk-live-0123456789" } });

    expect(
      await failure(
        run(tool("settings_model_set"), {
          thinking_level: "low",
          reason: "uses sk-live-0123456789",
        }),
      ),
    ).toContain("holds the value of a Secret");
    expect(
      await failure(
        run(tool("settings_branch_summary_set"), { skip_prompt: true, reason: GITHUB_TOKEN }),
      ),
    ).toContain("GitHub token");
    expect(settings.calls).toEqual([]);
  });

  it("that holds a Secret Reference is refused, held or not, since the Settings would hold its text", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service, { held: { KEY: "sk-live-0123456789" } });

    for (const name of ["KEY", "OTHER"]) {
      expect(
        await failure(
          run(tool("settings_branch_summary_set"), {
            skip_prompt: true,
            reason: `because of ${secretReference(name)}`,
          }),
        ),
      ).toContain("holds a Secret Reference");
    }

    expect(settings.calls).toEqual([]);
  });

  it("may name a reference an escape keeps as written", async () => {
    const tool = await toolsOver(fakeSettings().service);

    const result = await run(tool("settings_branch_summary_set"), {
      skip_prompt: true,
      reason: `the form is \\${secretReference("KEY")}`,
    });

    expect(result.isError).not.toBe(true);
  });
});

describe("saved overrides that no longer applied", () => {
  it("are said to be forgotten by the write, which keeps what resolves", async () => {
    const service: SettingsAccessService = {
      ...fakeSettings().service,
      change: () =>
        Effect.succeed({
          status: "changed",
          changes: [],
          dropped: "These saved overrides no longer apply and are ignored:\nmodel: gone",
        }),
    };

    const tool = await toolsOver(service);

    const result = await run(tool("settings_branch_summary_set"), {
      skip_prompt: true,
      reason: "r",
    });

    expect(text(result)).toContain("saving has forgotten them");
    expect(text(result)).toContain("model: gone");
  });
});

describe("a failure to reach the Settings", () => {
  it("is what the model sees, and records nothing", async () => {
    const failing: SettingsAccessService = {
      get: Effect.die("unused"),
      change: () => Effect.fail(SettingsAccessError.make({ message: "Registry down" })),
    };

    const logged: RunChange[] = [];
    const tool = await toolsOver(failing, { logged });

    expect(
      await failure(run(tool("settings_branch_summary_set"), { skip_prompt: true, reason: "r" })),
    ).toContain("Registry down");
    expect(logged).toEqual([]);
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("are what the fake starts from", () => {
    expect(DEFAULT_SETTINGS.model).toBe("anthropic/claude-opus-5-5");
  });
});
