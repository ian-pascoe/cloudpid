// The tools that wait for the owner's Approval (docs/spec.md → Approval): each asks the owner on a card, with the values
// before and after and the agent's reason, applies the change on Approve against what the owner saw, changes nothing on
// Decline, and refuses without asking what it would refuse anyway.
// @effect-diagnostics asyncFunction:off strictEffectProvide:off preferEffectArray:off newPromise:off globalTimers:off
import { DEFAULT_CONTAINER_SETTINGS, DEFAULT_SETTINGS, type Settings } from "@cloudpid/config";
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
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
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
import { Redactions } from "./secrets/redaction.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";
import { type SettingsFieldChange, SettingsAccess, SettingsReload } from "./settings.ts";
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

/** An Environment as the fake holds it. */
const details = (id: string, name: string, settings = {}): EnvironmentDetails => ({
  id,
  name,
  repos: [],
  build: { status: "none" },
  settings: { ...DEFAULT_CONTAINER_SETTINGS, ...settings },
  secrets: [],
});

/** What a fake recorded being asked to do. */
type Calls = {
  settings: Array<{ changes: ReadonlyArray<SettingsFieldChange>; author: ChangeAuthor }>;
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

/** What a test starts from: the Session's Environment, the Settings, the Environments and their kept Secrets. */
type Start = {
  readonly current?: string;
  readonly spendLimit?: number | null;
  readonly extensions?: Settings["extensions"];
  readonly held?: Readonly<Record<string, EnvironmentDetails>>;
  readonly footprint?: EnvironmentFootprint;
  readonly kept?: Readonly<Record<string, ReadonlyArray<KeptSecretMark>>>;
};

/** How the owner answers a call's request; `meanwhile` runs first, as what happens while the card waits. */
type Answer = {
  readonly approve: boolean;
  readonly reason?: string;
  readonly meanwhile?: () => void;
};

const APPROVE: Answer = { approve: true };

const setUp = async ({
  current = "default",
  spendLimit = 5,
  extensions = {},
  held = { default: details("default", "Default"), "0000abcd": details("0000abcd", "Other") },
  footprint = { workspaces: 2, sessions: 3, secrets: 1 },
  kept = { default: [{ name: "API_KEY", build: true }], "*": [] },
}: Start = {}) => {
  const calls: Calls = { settings: [], environments: [], deleted: [], secrets: [], reloads: 0 };
  const logged: RunChange[] = [];
  /** The requests the owner was shown, as a card shows them. */
  const asked: ApprovalAsk[] = [];
  /** The requests the owner was notified of. */
  const notified: ApprovalAsk[] = [];
  const state = { spendLimit, extensions, footprint };
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

  const settings = (): Settings => ({
    ...DEFAULT_SETTINGS,
    spendLimit: { perSession: state.spendLimit },
    extensions: state.extensions,
  });

  const extension = await Effect.runPromise(
    ApprovalTools.pipe(
      Effect.provideService(Approvals, approvals),
      Effect.provideService(Environments, {
        ...unusedLifecycle,
        ...unusedSecretMarks,
        current: Effect.succeed(current),
        list: Effect.succeed([]),
        get: (id) => Effect.succeed(held[id] ?? null),
        change: ({ environment, change: { field, value }, expected, author }) =>
          Effect.sync(() => {
            calls.environments.push({
              environment,
              field,
              value,
              expected: expected?.value,
              author,
            });

            const known = held[environment];

            if (known === undefined) return { status: "missing" as const };

            const before = known.settings.maxInstance;

            if (expected !== undefined && expected.value !== before) {
              return { status: "changed-since" as const, current: before };
            }

            return {
              status: "changed" as const,
              environment: { id: known.id, name: known.name },
              change: change({ scope: environment, field, before, after: value, approved: true }),
              newBuild: false,
            };
          }),
      }),
      Effect.provideService(EnvironmentRemoval, {
        footprint: (environment) =>
          Effect.succeed(held[environment] === undefined ? null : state.footprint),
        deleteEnvironment: (environment) =>
          Effect.sync(() => {
            calls.deleted.push(environment);
          }),
        keptSecrets: (scope) => Effect.succeed(kept[scope] ?? null),
        deleteSecret: ({ environment, name, author }) =>
          Effect.sync(() => {
            calls.secrets.push({ environment, name, author });

            return {
              status: "deleted" as const,
              environment: {
                id: environment,
                name: held[environment]?.name ?? "every Environment",
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
        get: Effect.sync(() => ({ settings: settings(), overrides: {} })),
        change: ({ changes, author }) =>
          Effect.sync(() => {
            calls.settings.push({ changes, author });

            const [first] = changes;

            if (first === undefined) return { status: "unchanged" as const };

            const before =
              first.field === "spendLimit.perSession"
                ? state.spendLimit
                : (state.extensions.subagents?.maxSubagentDepth ?? null);

            if (first.expected !== undefined && first.expected.value !== before) {
              return { status: "changed-since" as const, field: first.field, current: before };
            }

            return {
              status: "changed" as const,
              changes: [change({ field: first.field, before, after: first.value, approved: true })],
            };
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
    task++;

    const asking: Pick<ToolExecutionApi, "taskId" | "conversationId"> = {
      // SAFETY: a task's id is a number pi-durable brands; each call here is a task of its own.
      taskId: task as TaskId,
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

  return { tool, call, calls, logged, asked, notified, state };
};

const NAMES = [
  "settings_spend_limit_set",
  "settings_subagent_depth_set",
  "environment_container_size_limit_set",
  "environment_delete",
  "environment_secret_delete",
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
      per_session: 10,
      reason: `the key ${HELD} is billed`,
    });

    expect(result.isError).toBe(true);
    expect(text).toContain("reason holds the value of a Secret");
    expect(asked).toEqual([]);
  });
});

describe("settings_spend_limit_set", () => {
  it("asks the owner on a card with the limit before and after and the reason, and applies it on Approve", async () => {
    const { call, calls, logged, asked, notified } = await setUp();

    const { result, text, pending } = await call("settings_spend_limit_set", {
      per_session: 10,
      reason: "The refactor needs more requests",
    });

    expect(asked).toEqual([
      {
        id: "1",
        conversationId: ROOT_CONVERSATION_ID,
        tool: "settings_spend_limit_set",
        target: "the Settings",
        change: "Spend limit",
        before: "$5 per Session",
        after: "$10 per Session",
        reason: "The refactor needs more requests",
        expected: 5,
      },
    ]);
    expect(calls.settings).toEqual([
      {
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notified).toEqual(asked);
  });

  it("changes nothing on Decline, and gives the owner's reason", async () => {
    const { call, calls, logged } = await setUp();

    const { result, text } = await call(
      "settings_spend_limit_set",
      { per_session: null, reason: "No limit for the migration" },
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
      { per_session: 10, reason: "More requests" },
      {
        approve: true,
        meanwhile: () => {
          // The owner saves another limit on the Settings page while the card waits.
          state.spendLimit = 7;
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(text).toContain("changed since they were asked");
    expect(text).toContain("Ask again");
  });

  it("asks nothing when the limit already has the value", async () => {
    const { call, asked } = await setUp();

    const { text } = await call("settings_spend_limit_set", { per_session: 5, reason: "Same" });

    expect(text).toContain("already");
    expect(asked).toEqual([]);
  });
});

describe("settings_subagent_depth_set", () => {
  it("asks with the default depth as the value before, and sets the option the extension reads", async () => {
    const { call, calls, asked } = await setUp();

    await call("settings_subagent_depth_set", { depth: 3, reason: "A review tree needs three" });

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

describe("environment_container_size_limit_set", () => {
  it("refuses, asking nothing, a limit below the Environment's size", async () => {
    const { call, asked } = await setUp({
      held: {
        default: details("default", "Default", { instance: "standard-3", maxInstance: "custom-3" }),
      },
    });

    const { result, text } = await call("environment_container_size_limit_set", {
      size: "custom-2",
      reason: "Cheaper",
    });

    expect(result.isError).toBe(true);
    expect(text).toContain("below the size");
    expect(asked).toEqual([]);
  });

  it("asks with the limit before and after, and sets maxInstance as approved against the limit the owner saw", async () => {
    const { call, calls, asked, logged } = await setUp();

    const { result, text } = await call("environment_container_size_limit_set", {
      size: "custom-3",
      reason: "The build needs 9 GiB",
    });

    expect(asked[0]).toMatchObject({
      tool: "environment_container_size_limit_set",
      target: 'Environment "Default"',
      change: "Size limit",
      before: "custom-2 (2 vCPU, 6 GiB memory, 12 GB disk)",
      after: "custom-3 (3 vCPU, 9 GiB memory, 12 GB disk)",
      expected: "custom-2",
    });
    expect(calls.environments).toMatchObject([
      {
        environment: "default",
        field: "maxInstance",
        value: "custom-3",
        expected: "custom-2",
        author: { approved: true },
      },
    ]);
    expect(text).toContain("The user approved");
    expect(result.details).toMatchObject({
      approval: { approved: true },
      agentChange: { field: "maxInstance", before: "custom-2", after: "custom-3" },
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
    expect(text).toContain("no Secret API_KEY is kept for every Environment");
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
});
