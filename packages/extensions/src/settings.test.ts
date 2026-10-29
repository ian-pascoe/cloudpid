// The `settings` extension (docs/architecture/agent-changes.md), over fake Settings at two Scopes (ADR-0027): what each
// tool shows and changes at Global and at an Environment, the refusal of text that holds a Secret, the Settings read
// again after a change, whether a change reaches this Session, and the Run's record of the changes.
// @effect-diagnostics asyncFunction:off
import {
  DEFAULT_OFFERED_TOOLS,
  DEFAULT_SETTINGS,
  overrideFields,
  overridesFrom,
  resolveOverridesLeniently,
  type Settings,
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
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { AgentChangeLog, DeployCredentials, type RunChange } from "./environment.ts";
import { Redactions } from "./secrets/redaction.ts";
import { secretReference } from "./secrets/references.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";
import {
  type AppliedSettingsChange,
  GLOBAL_SETTINGS_SCOPE,
  SettingsAccess,
  SettingsAccessError,
  type SettingsAccessService,
  type SettingsApplied,
  type SettingsFieldChange,
  SettingsReload,
  SettingsTools,
  type SettingsView,
} from "./settings.ts";
import {
  changeGlobalSettings,
  changeSettingsOverrides,
  resolvedGlobal,
} from "./settings.fixture.ts";
import { DEFAULT_TOOLSETS } from "./subagents.ts";
import { resolveTools } from "./subagents/toolsets.ts";

const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

/** An Environment as the fake holds it: its name, its Overrides and what was left out of them. */
type FakeEnvironment = { name: string; overrides: Schema.Json; problem?: string };

/** What a fake starts from beside Global's overrides. */
type FakeStart = {
  /** Why some of Global's saved overrides were left out. */
  readonly problem?: string;
  /** The Environments by id; "default" (Default) and "env-a" (A), with no Overrides, by default. */
  readonly environments?: Readonly<Record<string, FakeEnvironment>>;
  /** The Session's own Environment. */
  readonly own?: string | null;
};

/**
 * The Settings at two Scopes, applying each change as the Registry would: Global's overrides with the owner's strict
 * resolution, an Environment's Overrides field by field, kept even when equal to Global's.
 */
const fakeSettings = (
  initial: Schema.Json = {},
  {
    problem,
    environments = {
      default: { name: "Default", overrides: {} },
      "env-a": { name: "A", overrides: {} },
    },
    own = "default",
  }: FakeStart = {},
) => {
  let overrides = initial;
  const held: Record<string, FakeEnvironment> = structuredClone({ ...environments });

  const resolved = (): Settings => resolvedGlobal(overrides);

  const calls: Array<{
    scope: string;
    changes: ReadonlyArray<SettingsFieldChange>;
    tool: string;
    reason: string;
  }> = [];

  const recorded: AgentChange[] = [];

  const missing = (id: string) =>
    SettingsAccessError.make({ message: `No Environment has the id ${JSON.stringify(id)}.` });

  const record = (
    change: Omit<AgentChange, "id" | "at" | "actor" | "session" | "reverts" | "revertedBy">,
  ) => {
    const made: AgentChange = {
      id: recorded.length + 1,
      at: 1_000,
      actor: "agent",
      session: "s-1",
      reverts: null,
      revertedBy: null,
      ...change,
    };

    recorded.push(made);

    return made;
  };

  const changeGlobal = (
    changes: ReadonlyArray<SettingsFieldChange>,
    author: { conversation: number; tool: string; reason: string },
  ): AppliedSettingsChange => {
    const changed = changeGlobalSettings(overrides, changes, (made) =>
      record({ ...made, ...author }),
    );

    overrides = changed.global;

    return changed.answer;
  };

  const changeEnvironment = (
    id: string,
    environment: FakeEnvironment,
    changes: ReadonlyArray<SettingsFieldChange>,
    author: { conversation: number; tool: string; reason: string },
  ): AppliedSettingsChange => {
    const changed = changeSettingsOverrides(overrides, environment.overrides, id, changes, (made) =>
      record({ ...made, ...author }),
    );

    environment.overrides = changed.overrides;

    return changed.answer;
  };

  const service: SettingsAccessService = {
    get: (scope) =>
      Effect.suspend((): Effect.Effect<SettingsView, SettingsAccessError> => {
        if (scope === GLOBAL_SETTINGS_SCOPE) {
          const overriddenIn: Record<string, Array<{ id: string; name: string }>> = {};

          for (const [id, { name, overrides: own }] of Record.toEntries(held)) {
            for (const field of overrideFields(own)) {
              overriddenIn[field] = [...(overriddenIn[field] ?? []), { id, name }];
            }
          }

          return Effect.succeed({
            scope: GLOBAL_SETTINGS_SCOPE,
            settings: resolved(),
            overrides: overridesFrom(resolved()),
            overriddenIn,
            problem,
          });
        }

        const environment = held[scope];

        if (environment === undefined) return Effect.fail(missing(scope));

        const lenient = resolveOverridesLeniently(overrides, environment.overrides);

        return Effect.succeed({
          scope,
          name: environment.name,
          settings: lenient.settings,
          overrides: lenient.overrides,
          global: lenient.global,
          problem: environment.problem,
        });
      }),
    own: Effect.succeed(own),
    change: ({ scope, changes, author }) =>
      Effect.suspend(() => {
        const environment = held[scope];

        if (scope !== GLOBAL_SETTINGS_SCOPE && environment === undefined) {
          return Effect.fail(missing(scope));
        }

        const answer =
          environment === undefined
            ? changeGlobal(changes, author)
            : changeEnvironment(scope, environment, changes, author);

        if (answer.status === "changed") {
          calls.push({ scope, changes, tool: author.tool, reason: author.reason });
        }

        return Effect.succeed(answer);
      }),
  };

  return {
    service,
    calls,
    recorded,
    overrides: () => overrides,
    /** Environment `id`'s Overrides now. */
    environment: (id: string) => held[id]?.overrides,
  };
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

const NAMES = [
  "settings_get",
  "settings_model_set",
  "settings_role_set",
  "settings_tool_offer",
  "settings_tool_defer",
  "settings_compaction_set",
  "settings_branch_summary_set",
  "settings_extension_set",
];

/** The line of `shown` that starts with `start`, after its indent. */
const lineOf = (shown: string, start: string): string | undefined =>
  Option.getOrUndefined(
    Arr.findFirst(shown.split("\n"), (line) => line.trimStart().startsWith(start)),
  );

describe("the settings tools", () => {
  it("are eight, and only the reads are kept from a rerun after an eviction", async () => {
    const tool = await toolsOver(fakeSettings().service);

    expect(Arr.map(NAMES, (name) => tool(name).replay)).toEqual([
      "safe",
      ...Arr.replicate("unsafe", 7),
    ]);
  });

  it("each require a scope, which has no default", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    for (const name of NAMES) {
      expect(tool(name).parameters).toMatchObject({ required: expect.arrayContaining(["scope"]) });
    }

    const result = await run(tool("settings_branch_summary_set"), {
      skip_prompt: true,
      reason: "r",
    });

    expect(result.isError).toBe(true);
    expect(settings.calls).toEqual([]);
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
  it("shows the Global settings, each from the default or Global, and the Limit as the user's", async () => {
    const tool = await toolsOver(
      fakeSettings({
        thinkingLevel: "low",
        roles: { small: { model: "anthropic/claude-sonnet-5-5" } },
        extensions: { subagents: { readToolset: ["read"] } },
      }).service,
    );

    const shown = text(await run(tool("settings_get"), { scope: "*" }));

    expect(shown).toContain('Global Settings (scope "*")');
    expect(shown).toContain("Default model: anthropic/claude-opus-5-5 (default)\n");
    expect(shown).toContain("Default thinking level: low (Global)");
    expect(lineOf(shown, "small:")).toMatch(
      /^ {2}small: anthropic\/claude-sonnet-5-5; hint: .* \(Global\)$/,
    );
    expect(lineOf(shown, "medium:")).toMatch(
      /^ {2}medium: anthropic\/claude-sonnet-5-5; hint: .* \(default\)$/,
    );
    expect(shown).toContain("enabled: true (default)");
    expect(shown).toContain(`Offered tools`);
    expect(shown).toContain(Arr.join(DEFAULT_OFFERED_TOOLS, ", "));
    expect(shown).toContain("Spend limit per Session (US dollars): not set (default)");
    // The Limits say which tool changes them, with the owner's Approval.
    expect(shown).toContain("settings_spend_limit_set changes it once the user approves");
    expect(shown).toContain("Subagent depth (levels of subagents below the root): 2 (default).");
    expect(shown).toContain("subagents.readToolset: read (Global)");
    expect(shown).toContain("settings_reset");
    // The Session's own Environment, whose Settings it runs with.
    expect(shown).toContain('its own Environment (id default): settings_get with scope "default"');
  });

  it("names at Global the Environments that override each field", async () => {
    const tool = await toolsOver(
      fakeSettings(
        { model: "anthropic/claude-sonnet-5-5" },
        {
          environments: {
            default: { name: "Default", overrides: {} },
            "env-a": { name: "A", overrides: { model: "anthropic/claude-haiku-5-5" } },
            "env-b": { name: "B", overrides: { model: "anthropic/claude-sonnet-5-5" } },
          },
        },
      ).service,
    );

    const shown = text(await run(tool("settings_get"), { scope: "*" }));

    expect(shown).toContain(
      'Default model: anthropic/claude-sonnet-5-5 (Global; overridden in "A" (env-a), "B" (env-b))',
    );
    expect(shown).toContain("Default thinking level: high (default)\n");
  });

  it("shows an Environment's settings, each overridden with the Global value it replaces, or inherited", async () => {
    const tool = await toolsOver(
      fakeSettings(
        { model: "anthropic/claude-sonnet-5-5" },
        {
          environments: {
            default: { name: "Default", overrides: {} },
            "env-a": {
              name: "A",
              overrides: {
                thinkingLevel: "low",
                roles: { small: { model: "anthropic/claude-opus-5-5", hint: "Pinned" } },
              },
            },
          },
          own: "env-a",
        },
      ).service,
    );

    const result = await run(tool("settings_get"), { scope: "env-a" });
    const shown = text(result);

    expect(shown).toContain('Settings of Environment "A" (env-a)');
    expect(shown).toContain("This Session runs in this Environment");
    expect(shown).toContain("Default thinking level: low (overridden; Global: high)");
    expect(shown).toContain("Default model: anthropic/claude-sonnet-5-5 (inherited from Global)");
    expect(lineOf(shown, "small:")).toMatch(
      /^ {2}small: anthropic\/claude-opus-5-5; hint: Pinned \(overridden; Global: anthropic\/claude-haiku-5-5; hint: .*\)$/,
    );
    expect(result.details).toEqual({ scope: "env-a", problem: null });
  });

  it("says an Environment's settings are not the ones this Session runs with, when they are another's", async () => {
    const tool = await toolsOver(fakeSettings().service);

    expect(text(await run(tool("settings_get"), { scope: "env-a" }))).toContain(
      "This Session runs with the Settings of its own Environment (id default), not these.",
    );
  });

  it("fails for an id no Environment has", async () => {
    const tool = await toolsOver(fakeSettings().service);

    expect(await failure(run(tool("settings_get"), { scope: "nope" }))).toContain(
      'No Environment has the id "nope"',
    );
  });

  it("shows the Instructions whole, Global's at an Environment too, and the tool that changes them", async () => {
    const tool = await toolsOver(
      fakeSettings({ instructions: "Answer in French.\nBe terse." }).service,
    );

    const global = text(await run(tool("settings_get"), { scope: "*" }));

    expect(global).toContain(
      "Instructions (every conversation's model is shown them from the start of its Context Window, before the Project instructions, which win where the two disagree; settings_instructions_set changes them once the user approves): 2 lines, 27 bytes of UTF-8 (Global; at most 64 KiB)\n<instructions>\nAnswer in French.\nBe terse.\n</instructions>",
    );

    const environment = text(await run(tool("settings_get"), { scope: "env-a" }));

    expect(environment).toContain(
      "2 lines, 27 bytes of UTF-8 (Global's: an Environment has no Instructions of its own yet)\n<instructions>\nAnswer in French.\nBe terse.\n</instructions>",
    );

    const none = await toolsOver(fakeSettings().service);

    expect(text(await run(none("settings_get"), { scope: "*" }))).toContain(
      "settings_instructions_set changes them once the user approves): none (default)",
    );
  });

  it("says what is wrong with the saved overrides", async () => {
    const tool = await toolsOver(
      fakeSettings({}, { problem: "These saved overrides no longer apply:\nmodel: gone" }).service,
    );

    expect(text(await run(tool("settings_get"), { scope: "*" }))).toContain(
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
      scope: "*",
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
      scope: "*",
      model: "anthropic/claude-haiku-5-5",
      reason: "r",
    });

    expect(text(result)).toContain("This Session picked its own model, which it keeps");
  });

  it("needs a model, a thinking level, or both", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    expect(await failure(run(tool("settings_model_set"), { scope: "*", reason: "r" }))).toContain(
      "Give a model, a thinking level, or both",
    );
    expect(settings.calls).toEqual([]);
  });

  it("says so of a default that already has the value, and records and reloads nothing", async () => {
    const logged: RunChange[] = [];
    const reloaded: SettingsApplied[] = [];
    const tool = await toolsOver(fakeSettings().service, { logged, reloaded });

    const result = await run(tool("settings_model_set"), {
      scope: "*",
      thinking_level: "high",
      reason: "r",
    });

    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("already has these values");
    expect(logged).toEqual([]);
    expect(reloaded).toEqual([]);
  });

  it("pins at an Environment a value equal to Global's, as its Override, recorded as inherited before", async () => {
    const settings = fakeSettings();
    const logged: RunChange[] = [];
    const tool = await toolsOver(settings.service, { logged });

    const result = await run(tool("settings_model_set"), {
      scope: "env-a",
      model: "anthropic/claude-opus-5-5",
      reason: "Keep Opus here whatever Global becomes",
    });

    expect(result.isError).not.toBe(true);
    expect(settings.environment("env-a")).toEqual({ model: "anthropic/claude-opus-5-5" });
    expect(settings.overrides()).toEqual({});
    expect(settings.calls[0]).toMatchObject({
      scope: "env-a",
      changes: [{ field: "model", value: "anthropic/claude-opus-5-5" }],
    });
    expect(text(result)).toContain('Changed the defaults for Environment "A" (env-a)');
    expect(text(result)).toContain(
      "default model: it was anthropic/claude-opus-5-5 (inherited from Global), and is anthropic/claude-opus-5-5 (overridden) now",
    );
    expect(result.details).toMatchObject({
      scope: "env-a",
      agentChanges: [
        {
          scope: "env-a",
          field: "model",
          before: "anthropic/claude-opus-5-5",
          after: "anthropic/claude-opus-5-5",
          beforeInherited: true,
          afterInherited: false,
        },
      ],
    });
    expect(logged).toEqual([{ tool: "settings_model_set", field: "model", environmentName: "A" }]);

    // Pinned: the same call again finds the Override, and changes nothing.
    const again = await run(tool("settings_model_set"), {
      scope: "env-a",
      model: "anthropic/claude-opus-5-5",
      reason: "r",
    });

    expect(text(again)).toContain(
      'Environment "A" (env-a) overrides the default with these values already',
    );
    expect(settings.calls).toHaveLength(1);
  });

  it("says a change at another Environment does not reach this Session", async () => {
    const reloaded: SettingsApplied[] = [];
    const tool = await toolsOver(fakeSettings().service, { reloaded });

    const result = await run(tool("settings_model_set"), {
      scope: "env-a",
      model: "anthropic/claude-haiku-5-5",
      reason: "r",
    });

    expect(text(result)).toContain(
      'This Session runs with the Settings of its own Environment (id default), so a change for Environment "A" (env-a) does not reach it',
    );
    expect(text(result)).not.toContain("This Session follows the defaults");
    expect(reloaded).toHaveLength(1);
  });

  it("says a change at this Session's own Environment reaches its next request", async () => {
    const tool = await toolsOver(fakeSettings({}, { own: "env-a" }).service);

    const result = await run(tool("settings_model_set"), {
      scope: "env-a",
      model: "anthropic/claude-haiku-5-5",
      reason: "r",
    });

    expect(text(result)).toContain(
      'This Session runs in Environment "A" (env-a), so the change reaches its next request',
    );
    expect(text(result)).toContain(
      "This Session follows the defaults, so its next request uses them",
    );
  });

  it("says a change at Global does not reach this Session for a field its Environment overrides", async () => {
    const settings = fakeSettings(
      {},
      {
        environments: {
          default: { name: "Default", overrides: { thinkingLevel: "low" } },
          "env-a": { name: "A", overrides: {} },
        },
      },
    );

    const tool = await toolsOver(settings.service);

    const result = await run(tool("settings_model_set"), {
      scope: "*",
      model: "anthropic/claude-haiku-5-5",
      thinking_level: "medium",
      reason: "r",
    });

    expect(settings.overrides()).toEqual({
      model: "anthropic/claude-haiku-5-5",
      thinkingLevel: "medium",
    });
    expect(text(result)).toContain("Changed the defaults at Global");
    expect(text(result)).toContain(
      'This Session\'s own Environment "Default" (default) overrides the default thinking level, so that part of the change does not reach this Session',
    );
  });

  it("fails for an id no Environment has, changing nothing", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    expect(
      await failure(
        run(tool("settings_model_set"), { scope: "nope", thinking_level: "low", reason: "r" }),
      ),
    ).toContain('No Environment has the id "nope"');
    expect(settings.calls).toEqual([]);
  });
});

describe("settings_role_set", () => {
  it("changes a role's model, leaving its hint", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    const result = await run(tool("settings_role_set"), {
      scope: "*",
      role: "small",
      model: "anthropic/claude-sonnet-5-5",
      reason: "Haiku missed too much",
    });

    expect(settings.overrides()).toEqual({
      roles: { small: { model: "anthropic/claude-sonnet-5-5" } },
    });
    expect(settings.calls[0]?.changes).toEqual([
      {
        field: "roles.small",
        value: {
          model: "anthropic/claude-sonnet-5-5",
          hint: DEFAULT_SETTINGS.roles.small.hint,
        },
      },
    ]);
    expect(text(result)).toContain(
      "small role: it was anthropic/claude-haiku-5-5, and is anthropic/claude-sonnet-5-5 now, with the same hint",
    );
  });

  it("overrides a Role whole at an Environment, completing the hint from the Role in force there", async () => {
    const settings = fakeSettings({ roles: { small: { hint: "Global hint" } } });
    const tool = await toolsOver(settings.service);

    const result = await run(tool("settings_role_set"), {
      scope: "env-a",
      role: "small",
      model: "anthropic/claude-sonnet-5-5",
      reason: "r",
    });

    expect(settings.calls[0]?.changes).toEqual([
      {
        field: "roles.small",
        value: { model: "anthropic/claude-sonnet-5-5", hint: "Global hint" },
      },
    ]);
    expect(settings.environment("env-a")).toEqual({
      roles: { small: { model: "anthropic/claude-sonnet-5-5", hint: "Global hint" } },
    });
    expect(text(result)).toContain(
      "small role: it was anthropic/claude-haiku-5-5 (inherited from Global), and is anthropic/claude-sonnet-5-5 (overridden) now, with the same hint",
    );
  });

  it("changes the hint with it", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    await run(tool("settings_role_set"), {
      scope: "*",
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
          scope: "*",
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

    const result = await run(tool("settings_tool_offer"), {
      scope: "*",
      pattern: "web_fetch",
      reason: "r",
    });

    expect(settings.overrides()).toEqual({
      tools: { offered: [...DEFAULT_OFFERED_TOOLS, "web_fetch"] },
    });
    expect(text(result)).toContain("Offered web_fetch");
    expect(logged).toEqual([{ tool: "settings_tool_offer", field: "tools.offered" }]);
  });

  it("says so of an entry the list has", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    const result = await run(tool("settings_tool_offer"), {
      scope: "*",
      pattern: "bash",
      reason: "r",
    });

    expect(text(result)).toContain("bash is among the offered tools at Global already");
    expect(settings.calls).toEqual([]);
  });

  it("refuses an entry that is not a name or a pattern, with the owner's message", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    const message = await failure(
      run(tool("settings_tool_offer"), { scope: "*", pattern: "Web Fetch", reason: "r" }),
    );

    expect(message).toContain("Nothing was saved:");
    expect(message).toContain("tools.offered");
    expect(settings.calls).toEqual([]);
  });

  it("defers a tool by removing its entry", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    const result = await run(tool("settings_tool_defer"), {
      scope: "*",
      pattern: "grep",
      reason: "r",
    });

    expect(settings.overrides()).toEqual({
      tools: { offered: Arr.filter(DEFAULT_OFFERED_TOOLS, (name) => name !== "grep") },
    });
    expect(text(result)).toContain("Deferred grep");
  });

  it("says tool_search stays offered whatever the list says", async () => {
    const tool = await toolsOver(fakeSettings().service);

    const result = await run(tool("settings_tool_defer"), {
      scope: "*",
      pattern: "tool_search",
      reason: "r",
    });

    expect(text(result)).toContain("tool_search stays offered whatever the list says");
  });

  it("says an entry the list lacks is not deferred, naming the pattern that offers the tool", async () => {
    const settings = fakeSettings({ tools: { offered: ["read", "context_*"] } });
    const tool = await toolsOver(settings.service);

    const result = await run(tool("settings_tool_defer"), {
      scope: "*",
      pattern: "context_notes",
      reason: "r",
    });

    expect(text(result)).toContain('no entry "context_notes"');
    expect(text(result)).toContain("offered by context_*");
    expect(settings.calls).toEqual([]);
  });

  it("offers at an Environment by overriding the list in force there whole", async () => {
    const settings = fakeSettings({ tools: { offered: ["read", "bash"] } });
    const tool = await toolsOver(settings.service);

    const result = await run(tool("settings_tool_offer"), {
      scope: "env-a",
      pattern: "web_fetch",
      reason: "r",
    });

    expect(settings.environment("env-a")).toEqual({
      tools: { offered: ["read", "bash", "web_fetch"] },
    });
    expect(settings.overrides()).toEqual({ tools: { offered: ["read", "bash"] } });
    expect(text(result)).toContain('Offered web_fetch for Environment "A" (env-a)');
  });
});

describe("settings_compaction_set", () => {
  it("changes the settings given, and leaves the others", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    const result = await run(tool("settings_compaction_set"), {
      scope: "*",
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

    expect(
      await failure(run(tool("settings_compaction_set"), { scope: "*", reason: "r" })),
    ).toContain("Give at least one");
  });

  it("refuses a value the settings do not take with the owner's message, and records nothing", async () => {
    const settings = fakeSettings();
    const logged: RunChange[] = [];
    const tool = await toolsOver(settings.service, { logged });

    const message = await failure(
      run(tool("settings_compaction_set"), { scope: "*", reserve_tokens: -5, reason: "r" }),
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
      scope: "*",
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
      scope: "*",
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
      scope: "*",
      extension: "subagents",
      key: "readToolset",
      value: null,
      reason: "r",
    });

    expect(settings.overrides()).toEqual({});
  });

  it("removes an option's Override at an Environment with null, so it inherits Global", async () => {
    const settings = fakeSettings(
      { extensions: { subagents: { readToolset: ["read"] } } },
      {
        environments: {
          default: { name: "Default", overrides: {} },
          "env-a": {
            name: "A",
            overrides: { extensions: { subagents: { readToolset: ["read", "grep"] } } },
          },
        },
      },
    );

    const tool = await toolsOver(settings.service);

    const args = {
      scope: "env-a",
      extension: "subagents",
      key: "readToolset",
      value: null,
      reason: "r",
    };

    const result = await run(tool("settings_extension_set"), args);

    expect(settings.calls[0]?.changes).toEqual([
      { field: "extensions.subagents.readToolset", value: null, reset: true },
    ]);
    expect(settings.environment("env-a")).toEqual({});
    expect(text(result)).toContain(
      "extension option subagents.readToolset: it was read, grep (overridden), and is read (inherited from Global) now",
    );
    expect(text(await run(tool("settings_extension_set"), args))).toContain(
      'Environment "A" (env-a) has no Override of subagents.readToolset: it inherits Global already',
    );
    expect(settings.calls).toHaveLength(1);
  });

  it("refuses the subagent depth, which is a Limit, pointing to settings_subagent_depth_set", async () => {
    const settings = fakeSettings();
    const logged: RunChange[] = [];
    const tool = await toolsOver(settings.service, { logged });

    expect(
      await failure(
        run(tool("settings_extension_set"), {
          scope: "*",
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

  it("refuses the Subagent Workspace limit, which is a Limit, pointing to settings_subagent_workspaces_set", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    expect(
      await failure(
        run(tool("settings_extension_set"), {
          scope: "*",
          extension: "subagents",
          key: "maxSubagentWorkspaces",
          value: 9,
          reason: "r",
        }),
      ),
    ).toContain("settings_subagent_workspaces_set");
    expect(settings.calls).toEqual([]);
  });

  it("refuses a toolset that is not a list of names, which the extension would ignore with its other options", async () => {
    const settings = fakeSettings();
    const tool = await toolsOver(settings.service);

    expect(
      await failure(
        run(tool("settings_extension_set"), {
          scope: "*",
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
      scope: "*",
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
          scope: "*",
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
          scope: "*",
          thinking_level: "low",
          reason: "uses sk-live-0123456789",
        }),
      ),
    ).toContain("holds the value of a Secret");
    expect(
      await failure(
        run(tool("settings_branch_summary_set"), {
          scope: "*",
          skip_prompt: true,
          reason: GITHUB_TOKEN,
        }),
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
            scope: "*",
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
      scope: "*",
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
      scope: "*",
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
      ...fakeSettings().service,
      change: () => Effect.fail(SettingsAccessError.make({ message: "Registry down" })),
    };

    const logged: RunChange[] = [];
    const tool = await toolsOver(failing, { logged });

    expect(
      await failure(
        run(tool("settings_branch_summary_set"), { scope: "*", skip_prompt: true, reason: "r" }),
      ),
    ).toContain("Registry down");
    expect(logged).toEqual([]);
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("are what the fake starts from", () => {
    expect(DEFAULT_SETTINGS.model).toBe("anthropic/claude-opus-5-5");
  });
});
