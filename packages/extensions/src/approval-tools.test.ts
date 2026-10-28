// The tools that wait for the owner's Approval (docs/architecture/agent-changes.md → Approval): each asks the owner on a card, with the values
// before and after and the agent's reason, applies the change on Approve against what the owner saw, changes nothing on
// Decline, and refuses without asking what it would refuse anyway.
// @effect-diagnostics asyncFunction:off strictEffectProvide:off preferEffectArray:off newPromise:off globalTimers:off
import {
  type ContainerSettingsOverrides,
  DEFAULT_CONTAINER_SETTINGS,
  overridesFrom,
  resolveOverridesLeniently,
  type Settings,
} from "@cloudpid/config";
import type { AgentChange } from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type TaskId,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import {
  ApprovalTools,
  type EnvironmentFootprint,
  EnvironmentRemoval,
  type KeptSecretMark,
} from "./approval-tools.ts";
import { type ApprovalAsk, Approvals, type ApprovalsService, makeApprovals } from "./approvals.ts";
import {
  AgentChangeLog,
  type ChangeAuthor,
  DeployCredentials,
  type EnvironmentDetails,
  Environments,
  type RunChange,
} from "./environment.ts";
import { unusedLifecycle } from "./environment-lifecycle.fixture.ts";
import { unusedSecretMarks } from "./environment-secret-marks.fixture.ts";
import { unusedSkills } from "./environment-skills.fixture.ts";
import { Redactions } from "./secrets/redaction.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";
import {
  type AppliedSettingsChange,
  GLOBAL_SETTINGS_SCOPE,
  SettingsAccess,
  SettingsAccessError,
  type SettingsFieldChange,
  SettingsReload,
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
const HELD = "sk-live-0123456789abcdef";

const change = (fields: Partial<AgentChange>): AgentChange => ({
  id: 1,
  scope: "settings",
  at: 1_000,
  actor: "agent",
  session: "s-1",
  conversation: 0,
  tool: null,
  reason: "r",
  field: "",
  before: null,
  after: null,
  reverts: null,
  revertedBy: null,
  ...fields,
});

/** An Environment as the fake holds it: `overrides` over the defaults Global has. */
const details = (
  id: string,
  name: string,
  overrides: ContainerSettingsOverrides = {},
): EnvironmentDetails => ({
  id,
  name,
  repos: [],
  build: { status: "none" },
  settings: { ...DEFAULT_CONTAINER_SETTINGS, ...overrides },
  overrides,
  global: DEFAULT_CONTAINER_SETTINGS,
  secrets: [],
  skills: [],
  globalSkills: [],
});

/** What a fake recorded being asked to do. */
type Calls = {
  settings: Array<{
    scope: string;
    changes: ReadonlyArray<SettingsFieldChange>;
    author: ChangeAuthor;
  }>;
  environments: Array<{
    environment: string;
    field: string;
    value: Schema.Json | null;
    expected: Schema.Json | null | undefined;
    author: ChangeAuthor;
  }>;
  deleted: string[];
  secrets: Array<{ environment: string; name: string; author: ChangeAuthor }>;
  reloads: number;
};

/** An Environment's Settings as the fake holds them: its name and its Overrides. */
type FakeOverrides = { name: string; overrides: Schema.Json };

/** What a test changes as it goes: the Settings at both Scopes, and what deletes take and find. */
type FakeState = {
  /** Global's overrides. */
  global: Schema.Json;
  environments: Record<string, FakeOverrides>;
  footprint: EnvironmentFootprint;
  kept: Readonly<Record<string, ReadonlyArray<KeptSecretMark>>>;
};

/** What a test starts from: the Session's Environment, the Settings, the Environments and their kept Secrets. */
type Start = {
  readonly current?: string;
  /** Global's spend limit. */
  readonly spendLimit?: number | null;
  /** Global's extension options. */
  readonly extensions?: Settings["extensions"];
  /** The Environments' Settings Overrides by id: Default and Other (0000abcd), with none, by default. */
  readonly overrides?: Readonly<Record<string, FakeOverrides>>;
  readonly held?: Readonly<Record<string, EnvironmentDetails>>;
  readonly footprint?: EnvironmentFootprint;
  readonly kept?: Readonly<Record<string, ReadonlyArray<KeptSecretMark>>>;
};

/** How the owner answers a call's request; `meanwhile` runs first, as what happens while the card waits. */
type Answer = {
  readonly approve: boolean;
  readonly reason?: string;
  readonly meanwhile?: () => void;
  /** The task of a rerun: a call an eviction cut off, which asked already. */
  readonly task?: number;
};

const APPROVE: Answer = { approve: true };

const setUp = async ({
  current = "default",
  spendLimit = 5,
  extensions = {},
  held = { default: details("default", "Default"), "0000abcd": details("0000abcd", "Other") },
  footprint = { workspaces: 2, sessions: 3, secrets: 1 },
  kept = { default: [{ name: "API_KEY", build: true, updatedAt: 1 }], "*": [] },
  overrides = {
    default: { name: "Default", overrides: {} },
    "0000abcd": { name: "Other", overrides: {} },
  },
}: Start = {}) => {
  const calls: Calls = { settings: [], environments: [], deleted: [], secrets: [], reloads: 0 };
  const logged: RunChange[] = [];
  /** The requests the owner was shown, as a card shows them. */
  const asked: ApprovalAsk[] = [];
  /** The requests the owner was notified of. */
  const notified: ApprovalAsk[] = [];

  const state: FakeState = {
    global: { spendLimit: { perSession: spendLimit }, extensions },
    environments: structuredClone({ ...overrides }),
    footprint,
    kept,
  };

  const map = new Map<string, unknown>();

  const approvals: ApprovalsService = await Effect.runPromise(
    makeApprovals({
      storage: {
        // SAFETY: the store reads back only what it wrote under each key.
        get: <T>(key: string) => map.get(key) as T | undefined,
        put: (key, value) => {
          map.set(key, structuredClone(value));
        },
        delete: (key) => map.delete(key),
      },
      announce: () => Effect.void,
      asked: (request) =>
        Effect.sync(() => {
          notified.push(request);
        }),
    }),
  );

  const redactions = new Redactions();

  redactions.hold("API_KEY", HELD);

  // SAFETY: the tools use only `refresh` and `redact` of the Secrets.
  const secrets = {
    refresh: Effect.void,
    redact: (value: string) => redactions.redact(value),
  } as SecretsService;

  const globalSettings = (): Settings => resolvedGlobal(state.global);

  /** Global's fields changed as the Registry changes them: a reset to the default, against what the owner saw. */
  const changeGlobal = (changes: ReadonlyArray<SettingsFieldChange>): AppliedSettingsChange => {
    const changed = changeGlobalSettings(state.global, changes, (made) =>
      change({ ...made, approved: true }),
    );

    state.global = changed.global;

    return changed.answer;
  };

  /** An Environment's Overrides changed as the Registry changes them, against what the owner saw. */
  const changeOverrides = (
    id: string,
    environment: FakeOverrides,
    changes: ReadonlyArray<SettingsFieldChange>,
  ): AppliedSettingsChange => {
    const changed = changeSettingsOverrides(
      state.global,
      environment.overrides,
      id,
      changes,
      (made) => change({ ...made, approved: true }),
    );

    environment.overrides = changed.overrides;

    return changed.answer;
  };

  const extension = await Effect.runPromise(
    ApprovalTools.pipe(
      Effect.provideService(Approvals, approvals),
      Effect.provideService(Environments, {
        ...unusedLifecycle,
        ...unusedSecretMarks,
        ...unusedSkills,
        current: Effect.succeed(current),
        list: Effect.succeed(
          Arr.map(Record.values(held), ({ id, name, repos, build }) => ({
            id,
            name,
            repos,
            build,
          })),
        ),
        get: (id) => Effect.succeed(held[id] ?? null),
        global: Effect.succeed({
          settings: DEFAULT_CONTAINER_SETTINGS,
          overriddenIn: {},
          secrets: [],
          skills: [],
        }),
        change: ({ environment, change: { field, value }, expected, author }) =>
          Effect.sync(() => {
            calls.environments.push({
              environment,
              field,
              value,
              expected: expected?.value,
              author,
            });

            // Global's size limit is the default's; any other id is an Environment.
            const known =
              environment === "*"
                ? { ...details("*", "Global"), settings: DEFAULT_CONTAINER_SETTINGS }
                : held[environment];

            if (known === undefined) return { status: "missing" as const };

            const before = known.settings.maxInstance;

            if (expected !== undefined && expected.value !== before) {
              return { status: "changed-since" as const, current: before };
            }

            const changed = {
              status: "changed" as const,
              environment: { id: known.id, name: known.name },
              change: change({ scope: environment, field, before, after: value, approved: true }),
              newBuild: false,
            };

            // At Global, one Environment overrides the limit and one inherits it, wanting a Build.
            return environment === "*"
              ? {
                  ...changed,
                  global: {
                    overriddenIn: [{ id: "0000abcd", name: "Web" }],
                    newBuilds: [{ id: "default", name: "Default" }],
                    own: true,
                  },
                }
              : changed;
          }),
      }),
      Effect.provideService(EnvironmentRemoval, {
        footprint: (environment) =>
          Effect.succeed(held[environment] === undefined ? null : state.footprint),
        deleteEnvironment: (environment) =>
          Effect.sync(() => {
            calls.deleted.push(environment);
          }),
        keptSecrets: (scope) => Effect.sync(() => state.kept[scope] ?? null),
        deleteSecret: ({ environment, name, expected, author }) =>
          Effect.sync(() => {
            calls.secrets.push({ environment, name, author });

            const secret = state.kept[environment]?.find((each) => each.name === name);
            const where = { id: environment, name: held[environment]?.name ?? "Global" };

            if (secret === undefined) return { status: "absent" as const, environment: where };

            if (expected !== undefined && expected.updatedAt !== secret.updatedAt) {
              return { status: "changed-since" as const, environment: where };
            }

            return {
              status: "deleted" as const,
              environment: {
                id: environment,
                name: held[environment]?.name ?? "Global",
              },
              change: change({
                scope: environment,
                field: `secrets.${name}`,
                before: "kept",
                after: null,
                approved: true,
              }),
            };
          }),
      }),
      Effect.provideService(SettingsAccess, {
        get: (scope) =>
          Effect.suspend((): Effect.Effect<SettingsView, SettingsAccessError> => {
            if (scope === GLOBAL_SETTINGS_SCOPE) {
              return Effect.succeed({
                scope: GLOBAL_SETTINGS_SCOPE,
                settings: globalSettings(),
                overrides: overridesFrom(globalSettings()),
                overriddenIn: {},
              });
            }

            const environment = state.environments[scope];

            if (environment === undefined) {
              return Effect.fail(
                SettingsAccessError.make({
                  message: `No Environment has the id "${scope}".`,
                }),
              );
            }

            const lenient = resolveOverridesLeniently(state.global, environment.overrides);

            return Effect.succeed({
              scope,
              name: environment.name,
              settings: lenient.settings,
              overrides: lenient.overrides,
              global: lenient.global,
            });
          }),
        own: Effect.succeed(current),
        change: ({ scope, changes, author }) =>
          Effect.sync(() => {
            calls.settings.push({ scope, changes, author });

            const environment = state.environments[scope];

            return environment === undefined
              ? changeGlobal(changes)
              : changeOverrides(scope, environment, changes);
          }),
      }),
      Effect.provideService(SettingsReload, {
        apply: Effect.sync(() => {
          calls.reloads++;

          return { picked: { model: false, thinkingLevel: false } };
        }),
      }),
      Effect.provideService(AgentChangeLog, {
        record: (made) =>
          Effect.sync(() => {
            logged.push(made);
          }),
      }),
      Effect.provideService(DeployCredentials, { values: [GITHUB_TOKEN] }),
      Effect.provideService(Secrets, secrets),
    ),
  );

  const tool = (name: string): ToolRegistration =>
    Option.getOrThrowWith(
      Arr.findFirst(extension.tools ?? [], (each) => each.name === name),
      () => new Error(`no tool ${name}`),
    );

  let task = 0;

  /** Call `name` with `args`; `answer` answers its request once it waits, unless the call refuses without one. */
  const call = async (
    name: string,
    args: Readonly<Record<string, Schema.Json>>,
    answer: Answer = APPROVE,
  ) => {
    const id = answer.task ?? ++task;

    const asking: Pick<ToolExecutionApi, "taskId" | "conversationId"> = {
      // SAFETY: a task's id is a number pi-durable brands; each call here is a task of its own.
      taskId: id as TaskId,
      conversationId: ROOT_CONVERSATION_ID,
    };

    // SAFETY: the tools read only the call's task and conversation from the invocation's API.
    const api = asking as ToolExecutionApi;
    // SAFETY: the arguments are the tool's JSON parameters.
    const running = tool(name).execute(args as never, api, BACKGROUND_CONTEXT);

    let settled = false;

    void running.finally(() => {
      settled = true;
    });

    for (;;) {
      const [request] = await Effect.runPromise(approvals.pending);

      if (request !== undefined) {
        asked.push(request);

        answer.meanwhile?.();

        await Effect.runPromise(
          approvals.answer(request.id, { approve: answer.approve, reason: answer.reason }),
        );

        break;
      }

      if (settled) break;

      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const result = await running;

    const text = Arr.join(
      Arr.map(result.output ?? [], (part) => (part.type === "text" ? part.text : "")),
      "",
    );

    return { result, text, pending: await Effect.runPromise(approvals.pending) };
  };

  /**
   * A call of task `id` that asked with `expected` and was answered, then cut off by an eviction before it ended: the
   * answer is kept for its rerun.
   */
  const answeredEarlier = async (id: number, expected: Schema.Json | null) => {
    task = Math.max(task, id);

    const asking = Effect.runPromise(
      approvals.ask({
        id: String(id),
        conversationId: ROOT_CONVERSATION_ID,
        tool: "earlier",
        target: "earlier",
        change: "earlier",
        before: "earlier",
        after: "earlier",
        reason: "earlier",
        expected,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 2));
    await Effect.runPromise(approvals.answer(String(id), { approve: true }));
    await asking;
  };

  return { tool, call, calls, logged, asked, notified, state, answeredEarlier };
};

const NAMES = [
  "settings_spend_limit_set",
  "settings_subagent_depth_set",
  "settings_subagent_workspaces_set",
  "environment_container_size_limit_set",
  "environment_delete",
  "environment_secret_delete",
  "settings_reset",
];

describe("the tools that wait for Approval", () => {
  it("run alone, rerun after an eviction to wait again, and are the root conversation's only", async () => {
    const { tool } = await setUp();

    for (const name of NAMES) {
      expect(tool(name).replay).toBe("safe");
      expect(tool(name).executionMode).toBe("sequential");
    }

    expect(resolveTools(undefined, ["bash", ...NAMES], DEFAULT_TOOLSETS)).toMatchObject({
      success: { tools: ["bash"] },
    });
  });

  it("refuse a reason that holds a Secret's value, asking nothing", async () => {
    const { call, asked } = await setUp();

    const { result, text } = await call("settings_spend_limit_set", {
      scope: "*",
      per_session: 10,
      reason: `the key ${HELD} is billed`,
    });

    expect(result.isError).toBe(true);
    expect(text).toContain("reason holds the value of a Secret");
    expect(asked).toEqual([]);
  });

  it("refuse a reason that holds a Secret Reference's placeholder, held or not, asking nothing", async () => {
    const { call, asked, calls } = await setUp();
    /** A Secret Reference's placeholder, the double-brace form. */
    const placeholder = (name: string) => `${"{{"}secret:${name}${"}}"}`;

    for (const name of ["API_KEY", "NOT_HELD"]) {
      const { result, text } = await call("settings_spend_limit_set", {
        scope: "*",
        per_session: 10,
        reason: `the key ${placeholder(name)} is billed`,
      });

      expect(result.isError).toBe(true);
      expect(text).toContain("the reference's text, not the Secret");
    }

    expect(asked).toEqual([]);

    // An escaped placeholder is plain text.
    const { result } = await call("settings_spend_limit_set", {
      scope: "*",
      per_session: 10,
      reason: `written as \\${placeholder("API_KEY")} in the docs`,
    });

    expect(result.isError).not.toBe(true);
    expect(asked).toHaveLength(1);
    expect(calls.settings).toHaveLength(1);
  });
});

describe("settings_spend_limit_set", () => {
  it("asks the owner on a card with the limit before and after and the reason, and applies it on Approve", async () => {
    const { call, calls, logged, asked, notified } = await setUp();

    const { result, text, pending } = await call("settings_spend_limit_set", {
      scope: "*",
      per_session: 10,
      reason: "The refactor needs more requests",
    });

    expect(asked).toEqual([
      {
        id: "1",
        conversationId: ROOT_CONVERSATION_ID,
        tool: "settings_spend_limit_set",
        target: "the Global Settings",
        change: "Spend limit",
        before: "$5 per Session",
        after: "$10 per Session",
        reason: "The refactor needs more requests",
        expected: 5,
      },
    ]);
    expect(calls.settings).toEqual([
      {
        scope: "*",
        changes: [{ field: "spendLimit.perSession", value: 10, expected: { value: 5 } }],
        author: {
          conversation: ROOT_CONVERSATION_ID,
          tool: "settings_spend_limit_set",
          reason: "The refactor needs more requests",
          approved: true,
        },
      },
    ]);
    expect(result.isError).not.toBe(true);
    expect(text).toContain("The user approved");
    expect(result.details).toMatchObject({
      approval: { approved: true },
      agentChanges: [{ field: "spendLimit.perSession", before: 5, after: 10 }],
    });
    expect(logged).toEqual([{ tool: "settings_spend_limit_set", field: "spendLimit.perSession" }]);
    expect(calls.reloads).toBe(1);
    expect(pending).toEqual([]);
    // The owner's notification goes out in the background, once.
    await vi.waitFor(() => expect(notified).toEqual(asked));
  });

  it("changes nothing on Decline, and gives the owner's reason", async () => {
    const { call, calls, logged } = await setUp();

    const { result, text } = await call(
      "settings_spend_limit_set",
      { scope: "*", per_session: null, reason: "No limit for the migration" },
      { approve: false, reason: "Keep it at $5" },
    );

    expect(result.isError).not.toBe(true);
    expect(text).toContain("The user declined");
    expect(text).toContain("Keep it at $5");
    expect(result.details).toEqual({ approval: { approved: false, reason: "Keep it at $5" } });
    expect(calls.settings).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("applies nothing when the owner changed the limit between the request and the answer", async () => {
    const { call, state } = await setUp();

    const { result, text } = await call(
      "settings_spend_limit_set",
      { scope: "*", per_session: 10, reason: "More requests" },
      {
        approve: true,
        meanwhile: () => {
          // The owner saves another limit on the Settings page while the card waits.
          state.global = { spendLimit: { perSession: 7 } };
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(text).toContain("changed since they were asked");
    expect(text).toContain("Ask again");
  });

  it("asks nothing when the limit already has the value", async () => {
    const { call, asked } = await setUp();

    const { text } = await call("settings_spend_limit_set", {
      scope: "*",
      per_session: 5,
      reason: "Same",
    });

    expect(text).toContain("already");
    expect(asked).toEqual([]);
  });

  it("reports the owner's Approval on a rerun that finds the limit it set before an eviction", async () => {
    const { call, answeredEarlier, state, asked } = await setUp();

    await answeredEarlier(7, 5);
    // The cut-off call had applied the change.
    state.global = { spendLimit: { perSession: 10 } };

    const { result, text, pending } = await call(
      "settings_spend_limit_set",
      { scope: "*", per_session: 10, reason: "More requests" },
      { approve: true, task: 7 },
    );

    expect(result.isError).not.toBe(true);
    expect(text).toContain(
      "The user approved, and the spend limit at Global is $10 per Session already",
    );
    expect(result.details).toMatchObject({ approval: { approved: true } });
    expect(asked).toEqual([]);
    expect(pending).toEqual([]);
  });
});

describe("settings_subagent_depth_set", () => {
  it("asks with the default depth as the value before, and sets the option the extension reads", async () => {
    const { call, calls, asked } = await setUp();

    await call("settings_subagent_depth_set", {
      scope: "*",
      depth: 3,
      reason: "A review tree needs three",
    });

    expect(asked[0]).toMatchObject({
      change: "Subagent depth",
      before: "2 levels of subagents below the root (the default)",
      after: "3 levels of subagents below the root",
      expected: null,
    });
    expect(calls.settings[0]?.changes).toEqual([
      { field: "extensions.subagents.maxSubagentDepth", value: 3, expected: { value: null } },
    ]);
  });
});

describe("settings_subagent_workspaces_set", () => {
  it("asks with the default limit as the value before, and sets the option the extension reads only on Approve", async () => {
    const { call, calls, asked } = await setUp();

    const { text } = await call("settings_subagent_workspaces_set", {
      scope: "*",
      limit: 5,
      reason: "Five parallel implementers",
    });

    expect(asked[0]).toMatchObject({
      tool: "settings_subagent_workspaces_set",
      change: "Subagent Workspace limit",
      before: "1 Subagent Workspace per Session (the default)",
      after: "5 Subagent Workspaces per Session",
      expected: null,
    });
    expect(calls.settings[0]?.changes).toEqual([
      { field: "extensions.subagents.maxSubagentWorkspaces", value: 5, expected: { value: null } },
    ]);
    expect(text).toContain("The user approved");
  });

  it("changes nothing on Decline", async () => {
    const { call, calls } = await setUp();

    await call(
      "settings_subagent_workspaces_set",
      { scope: "*", limit: 9, reason: "More" },
      { approve: false },
    );

    expect(calls.settings).toEqual([]);
  });

  it("asks nothing when the limit already has the value", async () => {
    const { call, asked } = await setUp();

    const { text } = await call("settings_subagent_workspaces_set", {
      scope: "*",
      limit: 1,
      reason: "Same",
    });

    expect(text).toContain("already");
    expect(asked).toEqual([]);
  });
});

describe("the Limits at an Environment", () => {
  it("each require a scope, which has no default", async () => {
    const { tool, call, calls } = await setUp();

    for (const name of [
      "settings_spend_limit_set",
      "settings_subagent_depth_set",
      "settings_subagent_workspaces_set",
      "settings_reset",
    ]) {
      expect(tool(name).parameters).toMatchObject({ required: expect.arrayContaining(["scope"]) });
    }

    const { result } = await call("settings_spend_limit_set", { per_session: 10, reason: "r" });

    expect(result.isError).toBe(true);
    expect(calls.settings).toEqual([]);
  });

  it("ask with the Environment as the target and the inherited value now, and override it on Approve", async () => {
    const { call, calls, asked, logged, state } = await setUp();

    const { result, text } = await call("settings_spend_limit_set", {
      scope: "0000abcd",
      per_session: 10,
      reason: "The experiment needs more",
    });

    expect(asked).toEqual([
      {
        id: "1",
        conversationId: ROOT_CONVERSATION_ID,
        tool: "settings_spend_limit_set",
        target: 'Environment "Other"\'s Settings',
        change: "Spend limit",
        before: "$5 per Session (inherited from Global)",
        after: "$10 per Session",
        reason: "The experiment needs more",
        expected: { value: 5, inherited: true },
      },
    ]);
    expect(calls.settings).toEqual([
      {
        scope: "0000abcd",
        changes: [
          {
            field: "spendLimit.perSession",
            value: 10,
            expected: { value: 5, inherited: true },
          },
        ],
        author: {
          conversation: ROOT_CONVERSATION_ID,
          tool: "settings_spend_limit_set",
          reason: "The experiment needs more",
          approved: true,
        },
      },
    ]);
    expect(state.environments["0000abcd"]?.overrides).toEqual({
      spendLimit: { perSession: 10 },
    });
    expect(text).toContain(
      'The user approved: the spend limit for Environment "Other" (0000abcd) was $5 per Session (inherited from Global), and is $10 per Session now.',
    );
    // This Session runs in the default Environment.
    expect(text).toContain("does not reach it");
    expect(result.details).toMatchObject({
      approval: { approved: true },
      agentChanges: [
        {
          scope: "0000abcd",
          field: "spendLimit.perSession",
          before: 5,
          after: 10,
          beforeInherited: true,
          afterInherited: false,
        },
      ],
    });
    expect(logged).toEqual([
      {
        tool: "settings_spend_limit_set",
        field: "spendLimit.perSession",
        environmentName: "Other",
      },
    ]);
  });

  it("ask to pin a value equal to the inherited one, and not for one the Environment overrides with already", async () => {
    const { call, asked, state } = await setUp({
      overrides: {
        default: { name: "Default", overrides: { spendLimit: { perSession: 20 } } },
        "0000abcd": { name: "Other", overrides: {} },
      },
    });

    await call("settings_spend_limit_set", { scope: "0000abcd", per_session: 5, reason: "Pin" });

    expect(asked).toHaveLength(1);
    expect(state.environments["0000abcd"]?.overrides).toEqual({ spendLimit: { perSession: 5 } });

    const { text } = await call("settings_spend_limit_set", {
      scope: "default",
      per_session: 20,
      reason: "Same",
    });

    expect(text).toContain(
      'The spend limit for Environment "Default" (default) is $20 per Session as its Override already',
    );
    expect(asked).toHaveLength(1);
  });

  it("apply nothing when the Environment's Override changed between the request and the answer", async () => {
    const { call, state } = await setUp();

    const { result, text } = await call(
      "settings_subagent_depth_set",
      { scope: "0000abcd", depth: 3, reason: "Deeper" },
      {
        approve: true,
        meanwhile: () => {
          // The owner pins the inherited value meanwhile: same value, no longer inherited.
          state.environments["0000abcd"] = {
            name: "Other",
            overrides: { extensions: { subagents: { maxSubagentDepth: 2 } } },
          };
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(text).toContain(
      "changed since they were asked: it is 2 levels of subagents below the root (overridden) now",
    );
  });

  it("fail for an id no Environment has, asking nothing", async () => {
    const { call, asked } = await setUp();

    const { result, text } = await call("settings_subagent_workspaces_set", {
      scope: "nope",
      limit: 3,
      reason: "r",
    });

    expect(result.isError).toBe(true);
    expect(text).toContain('No Environment has the id "nope"');
    expect(asked).toEqual([]);
  });
});

describe("settings_reset", () => {
  const OVERRIDDEN = {
    default: { name: "Default", overrides: {} },
    "0000abcd": {
      name: "Other",
      overrides: { model: "anthropic/claude-sonnet-5-5", spendLimit: { perSession: 20 } },
    },
  };

  it("of a Limit at an Environment waits for Approval, then removes the Override", async () => {
    const { call, calls, asked, state, logged } = await setUp({ overrides: OVERRIDDEN });

    const { result, text } = await call("settings_reset", {
      scope: "0000abcd",
      field: "spendLimit.perSession",
      reason: "Back to the Global limit",
    });

    expect(asked).toEqual([
      {
        id: "1",
        conversationId: ROOT_CONVERSATION_ID,
        tool: "settings_reset",
        target: 'Environment "Other"\'s Settings',
        change: "Spend limit, reset",
        before: "$20 per Session (overridden)",
        after: "$5 per Session (inherited from Global)",
        reason: "Back to the Global limit",
        expected: { value: 20, inherited: false },
      },
    ]);
    expect(calls.settings[0]?.changes).toEqual([
      {
        field: "spendLimit.perSession",
        value: null,
        reset: true,
        expected: { value: 20, inherited: false },
      },
    ]);
    expect(state.environments["0000abcd"]?.overrides).toEqual({
      model: "anthropic/claude-sonnet-5-5",
    });
    expect(text).toContain("The user approved");
    expect(result.details).toMatchObject({
      approval: { approved: true },
      agentChanges: [{ before: 20, after: 5, beforeInherited: false, afterInherited: true }],
    });
    expect(logged).toEqual([
      { tool: "settings_reset", field: "spendLimit.perSession", environmentName: "Other" },
    ]);
  });

  it("of a Limit at Global waits for Approval, then puts the default back", async () => {
    const { call, asked, state } = await setUp();

    await call("settings_reset", { scope: "*", field: "spendLimit.perSession", reason: "r" });

    expect(asked[0]).toMatchObject({
      target: "the Global Settings",
      before: "$5 per Session",
      after: "no limit (the default)",
      expected: 5,
    });
    expect(state.global).toEqual({});
  });

  it("changes nothing on Decline", async () => {
    const { call, calls, state } = await setUp({ overrides: OVERRIDDEN });

    const { text } = await call(
      "settings_reset",
      { scope: "0000abcd", field: "spendLimit.perSession", reason: "r" },
      { approve: false, reason: "Keep $20 there" },
    );

    expect(text).toContain("The user declined");
    expect(calls.settings).toEqual([]);
    expect(state.environments["0000abcd"]?.overrides).toEqual(OVERRIDDEN["0000abcd"].overrides);
  });

  it("of any other field applies at once, asking nothing", async () => {
    const { call, asked, state, logged, calls } = await setUp({ overrides: OVERRIDDEN });

    const { result, text } = await call("settings_reset", {
      scope: "0000abcd",
      field: "model",
      reason: "Follow Global again",
    });

    expect(asked).toEqual([]);
    expect(calls.settings[0]?.changes).toEqual([{ field: "model", value: null, reset: true }]);
    expect(state.environments["0000abcd"]?.overrides).toEqual({
      spendLimit: { perSession: 20 },
    });
    expect(text).toContain(
      'Reset the default model for Environment "Other" (0000abcd): it inherits Global again',
    );
    expect(text).toContain(
      "default model: it was anthropic/claude-sonnet-5-5 (overridden), and is anthropic/claude-opus-5-5 (inherited from Global) now",
    );
    expect(result.details).toMatchObject({
      agentChanges: [
        {
          scope: "0000abcd",
          environment: { id: "0000abcd", name: "Other" },
          field: "model",
          afterInherited: true,
        },
      ],
    });
    expect(logged).toEqual([{ tool: "settings_reset", field: "model", environmentName: "Other" }]);
  });

  it("says so of a field the Environment does not override, asking and changing nothing", async () => {
    const { call, asked, calls } = await setUp();

    const { result, text } = await call("settings_reset", {
      scope: "0000abcd",
      field: "spendLimit.perSession",
      reason: "r",
    });

    expect(result.isError).not.toBe(true);
    expect(text).toContain(
      "does not override the spend limit per Session: it inherits Global already",
    );
    expect(asked).toEqual([]);
    expect(calls.settings).toEqual([]);
  });

  it("refuses a name that is not a setting it takes, listing those it does", async () => {
    const { call, calls } = await setUp();

    const { result, text } = await call("settings_reset", {
      scope: "*",
      field: "roles.small.model",
      reason: "r",
    });

    expect(result.isError).toBe(true);
    expect(text).toContain("roles.small.model is not a setting settings_reset takes");
    expect(text).toContain("roles.small, roles.medium");
    expect(text).toContain("extensions.<extension>.<key>");
    expect(calls.settings).toEqual([]);
  });
});

describe("environment_container_size_limit_set", () => {
  it("with id * asks for the size limit at Global, on a card for Global, and sets it there as approved", async () => {
    const { call, calls, asked, logged } = await setUp();

    const { result, text } = await call("environment_container_size_limit_set", {
      id: "*",
      size: "cpu-3",
      reason: "Every build needs 9 GiB",
    });

    expect(result.isError).not.toBe(true);

    expect(asked[0]).toMatchObject({
      tool: "environment_container_size_limit_set",
      target: "Global",
      change: "Size limit",
      before: "cpu-2 (2 vCPU, 6 GiB memory, 12 GB disk)",
      after: "cpu-3 (3 vCPU, 9 GiB memory, 12 GB disk)",
      expected: "cpu-2",
    });
    expect(calls.environments).toMatchObject([
      {
        environment: "*",
        field: "maxInstance",
        value: "cpu-3",
        expected: "cpu-2",
        author: { approved: true },
      },
    ]);
    expect(text).toContain(
      "The user approved: the size limit of Global was cpu-2, and is cpu-3 now",
    );
    expect(text).toContain('it does not reach Environment "Web" (0000abcd), which override it');
    expect(text).toContain('a new Build was asked for in Environment "Default" (default)');
    expect(logged).toEqual([
      {
        tool: "environment_container_size_limit_set",
        environmentName: "Global",
        field: "maxInstance",
      },
    ]);
  });

  it("with id * refuses, asking nothing, a limit below the own size of an Environment that inherits it, naming it", async () => {
    const { call, asked, calls } = await setUp({
      held: {
        default: details("default", "Default", { instance: "cpu-2" }),
        "0000abcd": details("0000abcd", "Other", { instance: "cpu-2", maxInstance: "cpu-2" }),
      },
    });

    const { result, text } = await call("environment_container_size_limit_set", {
      id: "*",
      size: "cpu-1",
      reason: "Cheaper",
    });

    expect(result.isError).toBe(true);
    expect(text).toContain('Environment "Default" (default), cpu-2');
    expect(text).not.toContain("Other");
    expect(asked).toEqual([]);
    expect(calls.environments).toEqual([]);
  });

  it("with id * refuses, asking nothing, a limit below Global's size", async () => {
    const { call, asked, calls } = await setUp();

    const { result, text } = await call("environment_container_size_limit_set", {
      id: "*",
      size: "basic",
      reason: "Cheaper",
    });

    expect(result.isError).toBe(true);
    expect(text).toContain("below the size of Global");
    expect(asked).toEqual([]);
    expect(calls.environments).toEqual([]);
  });

  it("with id * says the limit is Global's already, asking nothing", async () => {
    const { call, asked } = await setUp();

    const { text } = await call("environment_container_size_limit_set", {
      id: "*",
      size: "cpu-2",
      reason: "Same",
    });

    expect(text).toContain("The size limit of Global is cpu-2 already");
    expect(asked).toEqual([]);
  });

  it("asks to make an inherited limit the Environment's own, even at the size it inherits", async () => {
    const { call, asked } = await setUp();

    await call("environment_container_size_limit_set", { size: "cpu-2", reason: "Pin it" });

    expect(asked[0]).toMatchObject({ change: "Size limit", expected: "cpu-2" });
  });

  it("asks nothing when the Environment's own limit already has the value", async () => {
    const { call, asked } = await setUp({
      held: { default: details("default", "Default", { maxInstance: "cpu-3" }) },
    });

    const { text } = await call("environment_container_size_limit_set", {
      size: "cpu-3",
      reason: "Same",
    });

    expect(text).toContain("is cpu-3 already");
    expect(asked).toEqual([]);
  });

  it("refuses, asking nothing, a limit below the Environment's size", async () => {
    const { call, asked } = await setUp({
      held: {
        default: details("default", "Default", { instance: "standard-3", maxInstance: "cpu-3" }),
      },
    });

    const { result, text } = await call("environment_container_size_limit_set", {
      size: "cpu-2",
      reason: "Cheaper",
    });

    expect(result.isError).toBe(true);
    expect(text).toContain("below the size");
    expect(asked).toEqual([]);
  });

  it("asks with the limit before and after, and sets maxInstance as approved against the limit the owner saw", async () => {
    const { call, calls, asked, logged } = await setUp();

    const { result, text } = await call("environment_container_size_limit_set", {
      size: "cpu-3",
      reason: "The build needs 9 GiB",
    });

    expect(asked[0]).toMatchObject({
      tool: "environment_container_size_limit_set",
      target: 'Environment "Default"',
      change: "Size limit",
      before: "cpu-2 (2 vCPU, 6 GiB memory, 12 GB disk)",
      after: "cpu-3 (3 vCPU, 9 GiB memory, 12 GB disk)",
      expected: "cpu-2",
    });
    expect(calls.environments).toMatchObject([
      {
        environment: "default",
        field: "maxInstance",
        value: "cpu-3",
        expected: "cpu-2",
        author: { approved: true },
      },
    ]);
    expect(text).toContain("The user approved");
    expect(result.details).toMatchObject({
      approval: { approved: true },
      agentChange: { field: "maxInstance", before: "cpu-2", after: "cpu-3" },
    });
    expect(logged).toEqual([
      {
        tool: "environment_container_size_limit_set",
        environmentName: "Default",
        field: "maxInstance",
      },
    ]);
  });
});

describe("environment_delete", () => {
  it("refuses the default Environment, asking nothing", async () => {
    const { call, asked } = await setUp({ current: "0000abcd" });

    const { result, text } = await call("environment_delete", { id: "default", reason: "Unused" });

    expect(result.isError).toBe(true);
    expect(text).toContain("default Environment cannot be deleted");
    expect(asked).toEqual([]);
  });

  it("refuses this Session's own Environment, asking nothing", async () => {
    const { call, asked, calls } = await setUp({ current: "0000abcd" });

    const { result, text } = await call("environment_delete", { id: "0000abcd", reason: "Unused" });

    expect(result.isError).toBe(true);
    expect(text).toContain("this Session's own Environment");
    expect(asked).toEqual([]);
    expect(calls.deleted).toEqual([]);
  });

  it("asks with what the delete takes, and deletes on Approve", async () => {
    const { call, calls, asked, logged } = await setUp();

    const { result, text } = await call("environment_delete", {
      id: "0000abcd",
      reason: "The experiment is over",
    });

    expect(asked[0]).toMatchObject({
      tool: "environment_delete",
      target: 'Environment "Other"',
      change: "Delete the Environment",
      before:
        'Environment "Other" (0000abcd): 2 Workspaces with 3 Sessions (archived ones too), its spare Workspace and Build, 1 kept Secret and its Agent changes',
    });
    expect(calls.deleted).toEqual(["0000abcd"]);
    expect(text).toContain("The user approved: deleted");
    expect(result.details).toMatchObject({ approval: { approved: true } });
    expect(logged).toEqual([
      { tool: "environment_delete", environmentName: "Other", field: "deleted" },
    ]);
  });

  it("deletes nothing when a Session started in it between the request and the answer", async () => {
    const { call, calls, state } = await setUp();

    const { result, text } = await call(
      "environment_delete",
      { id: "0000abcd", reason: "The experiment is over" },
      {
        approve: true,
        meanwhile: () => {
          state.footprint = { workspaces: 3, sessions: 4, secrets: 1 };
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(text).toContain("changed since they were asked");
    expect(calls.deleted).toEqual([]);
  });

  it("finishes on a rerun a delete an eviction cut off, which took part of it already", async () => {
    const { call, calls, answeredEarlier, state } = await setUp();

    await answeredEarlier(3, { workspaces: 2, sessions: 3, secrets: 1 });
    state.footprint = { workspaces: 1, sessions: 1, secrets: 1 };

    const { result, text } = await call(
      "environment_delete",
      { id: "0000abcd", reason: "The experiment is over" },
      { approve: true, task: 3 },
    );

    expect(result.isError).not.toBe(true);
    expect(text).toContain("The user approved: deleted");
    expect(text).toContain("2 Workspaces with 3 Sessions");
    expect(calls.deleted).toEqual(["0000abcd"]);
  });

  it("changes nothing on Decline", async () => {
    const { call, calls } = await setUp();

    const { text } = await call(
      "environment_delete",
      { id: "0000abcd", reason: "Unused" },
      { approve: false },
    );

    expect(text).toContain("The user declined");
    expect(calls.deleted).toEqual([]);
  });
});

describe("environment_secret_delete", () => {
  it("refuses, asking nothing, a Secret that is not kept there", async () => {
    const { call, asked } = await setUp();

    const { result, text } = await call("environment_secret_delete", {
      id: "*",
      name: "API_KEY",
      reason: "Rotated",
    });

    expect(result.isError).toBe(true);
    expect(text).toContain("no Secret API_KEY is kept Global");
    expect(asked).toEqual([]);
  });

  it("asks with the Secret's name and Build mark, and deletes it on Approve, recorded as approved", async () => {
    const { call, calls, asked, logged } = await setUp();

    const { result } = await call("environment_secret_delete", {
      name: "API_KEY",
      reason: "The key was rotated",
    });

    expect(asked[0]).toMatchObject({
      tool: "environment_secret_delete",
      target: 'Environment "Default"',
      change: "Delete a kept Secret",
      before: 'API_KEY, kept for Environment "Default" (default), marked for the Build',
    });
    expect(calls.secrets).toEqual([
      {
        environment: "default",
        name: "API_KEY",
        author: {
          conversation: ROOT_CONVERSATION_ID,
          tool: "environment_secret_delete",
          reason: "The key was rotated",
          approved: true,
        },
      },
    ]);
    expect(result.details).toMatchObject({
      approval: { approved: true },
      agentChange: { field: "secrets.API_KEY", before: "kept", after: null },
    });
    expect(logged).toEqual([
      { tool: "environment_secret_delete", environmentName: "Default", field: "secrets.API_KEY" },
    ]);
    expect(JSON.stringify(result)).not.toContain(HELD);
  });

  it("deletes nothing when the owner kept a new value between the request and the answer", async () => {
    const { call, state } = await setUp();

    const { result, text } = await call(
      "environment_secret_delete",
      { name: "API_KEY", reason: "The key was rotated" },
      {
        approve: true,
        meanwhile: () => {
          state.kept = { ...state.kept, default: [{ name: "API_KEY", build: true, updatedAt: 2 }] };
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(text).toContain("changed since they were asked");
  });
});
