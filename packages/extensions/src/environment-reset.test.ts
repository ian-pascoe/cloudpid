// The `environment` extension's `environment_setting_reset` (docs/architecture/agent-changes.md): an Environment's Override
// of a Container setting taken back, so it inherits Global's value. Over fake Environments that hold Global's settings and
// each Environment's Overrides. A reset of the size limit is a Limit: it asks the owner's Approval, and on Approve
// changes the field against the limit the owner saw; a reset of any other field asks nothing.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off strictEffectProvide:off
import {
  CONTAINER_SETTING_NAMES,
  type ContainerSettings,
  type ContainerSettingsOverrides,
  DEFAULT_CONTAINER_SETTINGS,
  resolveEnvironmentContainerSettings,
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
import type * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type * as Types from "effect/Types";
import { describe, expect, it } from "vitest";
import { type ApprovalAsk, Approvals, type ApprovalsService, makeApprovals } from "./approvals.ts";
import {
  AgentChangeLog,
  type ChangeAuthor,
  DeployCredentials,
  type EnvironmentDetails,
  Environments,
  EnvironmentTools,
  type RunChange,
} from "./environment.ts";
import { unusedLifecycle } from "./environment-lifecycle.fixture.ts";
import { unusedSecretMarks } from "./environment-secret-marks.fixture.ts";
import { unusedSkills } from "./environment-skills.fixture.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";

const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

/** An Environment as the fake holds it: its Overrides, resolved over Global's settings. */
const details = (
  global: ContainerSettings,
  id: string,
  name: string,
  overrides: ContainerSettingsOverrides = {},
): EnvironmentDetails => ({
  id,
  name,
  repos: [],
  build: { status: "none" },
  settings: resolveEnvironmentContainerSettings(global, overrides),
  overrides,
  global,
  secrets: [],
  skills: [],
  globalSkills: [],
});

/** What the fake Environments were asked to change. */
type Changed = {
  environment: string;
  field: string;
  value: Schema.Json | null;
  expected: Schema.Json | null | undefined;
  author: ChangeAuthor;
};

type Start = {
  /** Global's Container settings. */
  readonly global?: ContainerSettings;
  /** The Overrides of the Session's Environment, `default`. */
  readonly overrides?: ContainerSettingsOverrides;
  /** A change meanwhile, run before the owner answers: the limit becomes this. */
  readonly meanwhile?: () => void;
};

const setUp = async ({ global = DEFAULT_CONTAINER_SETTINGS, overrides = {} }: Start = {}) => {
  const calls: Changed[] = [];
  const logged: RunChange[] = [];
  const asked: ApprovalAsk[] = [];
  const kept = new Map([["default", details(global, "default", "Default", overrides)]]);
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
      asked: () => Effect.void,
    }),
  );

  // SAFETY: the tools use only `refresh` and `redact` of the Secrets.
  const secrets = { refresh: Effect.void, redact: (value: string) => value } as SecretsService;

  const extension = await Effect.runPromise(
    EnvironmentTools.pipe(
      Effect.provideService(Approvals, approvals),
      Effect.provideService(Environments, {
        ...unusedLifecycle,
        ...unusedSecretMarks,
        ...unusedSkills,
        current: Effect.succeed("default"),
        list: Effect.succeed([]),
        get: (id) => Effect.succeed(kept.get(id) ?? null),
        global: Effect.succeed({ settings: global, overriddenIn: {}, secrets: [], skills: [] }),
        change: ({ environment, change: { field, value }, expected, author }) =>
          Effect.sync(() => {
            calls.push({ environment, field, value, expected: expected?.value, author });

            const known = kept.get(environment);

            if (known === undefined) return { status: "missing" as const };

            const where = { id: known.id, name: known.name };

            // The tests reset only Container settings.
            const name = Option.getOrThrow(
              Arr.findFirst(CONTAINER_SETTING_NAMES, (each) => each === field),
            );

            const inherited = global[name];
            const own = known.overrides[name];
            const before = known.settings[name];

            if (own === undefined) {
              return { status: "unchanged" as const, environment: where, value: before };
            }

            if (expected !== undefined && expected.value !== before) {
              return { status: "changed-since" as const, current: before };
            }

            const others = Struct.omit(known.overrides, [name]);

            kept.set(environment, details(global, known.id, known.name, others));

            const recorded: Types.Mutable<AgentChange> = {
              id: 1,
              scope: environment,
              at: 1_000,
              actor: "agent",
              session: "s-1",
              conversation: author.conversation,
              tool: author.tool,
              reason: author.reason,
              field,
              before,
              after: inherited,
              reverts: null,
              revertedBy: null,
            };

            if (author.approved === true) recorded.approved = true;

            return {
              status: "changed" as const,
              environment: where,
              change: recorded,
              newBuild: false,
            };
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

  /** Call `environment_setting_reset`; `answer` answers its request once it waits, unless the call ends without one. */
  const reset = async (
    args: Readonly<Record<string, Schema.Json>>,
    answer: { readonly approve: boolean; readonly reason?: string } = { approve: true },
  ) => {
    const asking: Pick<ToolExecutionApi, "taskId" | "conversationId"> = {
      // SAFETY: a task's id is a number pi-durable brands; each call here is a task of its own.
      taskId: ++task as TaskId,
      conversationId: ROOT_CONVERSATION_ID,
    };

    // SAFETY: the tool reads only the call's task and conversation from the invocation's API.
    const api = asking as ToolExecutionApi;

    // SAFETY: the arguments are the tool's JSON parameters.
    const running = tool("environment_setting_reset").execute(
      args as never,
      api,
      BACKGROUND_CONTEXT,
    );

    let settled = false;

    void running.finally(() => {
      settled = true;
    });

    for (;;) {
      const [request] = await Effect.runPromise(approvals.pending);

      if (request !== undefined) {
        asked.push(request);

        await Effect.runPromise(approvals.answer(request.id, answer));

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

    return { result, text };
  };

  return { tool, reset, calls, logged, asked };
};

describe("environment_setting_reset", () => {
  it("runs alone and is replayed after an eviction", async () => {
    const { tool } = await setUp();

    expect(tool("environment_setting_reset").executionMode).toBe("sequential");
    expect(tool("environment_setting_reset").replay).toBe("safe");
  });

  it("resets a field with value null, reports the value it inherits, and records it for the Run", async () => {
    const { reset, calls, logged, asked } = await setUp({ overrides: { idleMinutes: 10 } });

    const { result, text } = await reset({
      id: "default",
      setting: "idleMinutes",
      reason: "Global's idle time is right now",
    });

    expect(calls).toMatchObject([
      {
        environment: "default",
        field: "idleMinutes",
        value: null,
        expected: undefined,
        author: {
          tool: "environment_setting_reset",
          reason: "Global's idle time is right now",
        },
      },
    ]);
    expect(calls[0]?.author.approved).toBeUndefined();
    expect(text).toContain(
      'Reset the idle time of Environment "Default" (default): it was 10 minutes (its own), and inherits Global\'s 2 minutes now',
    );
    expect(result.details).toMatchObject({
      agentChange: { field: "idleMinutes", before: 10, after: 2 },
    });
    expect(logged).toEqual([
      { tool: "environment_setting_reset", environmentName: "Default", field: "idleMinutes" },
    ]);
    expect(asked).toEqual([]);
  });

  it("says a field that inherits Global's already is unchanged, recording nothing", async () => {
    const { reset, logged, asked } = await setUp();

    const { result, text } = await reset({ id: "default", setting: "idleMinutes", reason: "r" });

    expect(result.isError).not.toBe(true);
    expect(text).toContain("inherited from Global already (2 minutes): nothing changed");
    expect(result.details).toMatchObject({ unchanged: { field: "idleMinutes" } });
    expect(logged).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("refuses the id *, whose settings are not reset here, changing nothing", async () => {
    const { reset, calls, asked } = await setUp({ overrides: { idleMinutes: 10 } });

    const { result, text } = await reset({ id: "*", setting: "idleMinutes", reason: "r" });

    expect(result.isError).toBe(true);
    expect(text).toContain('The id "*" names what is kept Global');
    expect(calls).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("refuses a reason that holds a GitHub token, changing nothing", async () => {
    const { reset, calls } = await setUp({ overrides: { idleMinutes: 10 } });

    const { result } = await reset({
      id: "default",
      setting: "idleMinutes",
      reason: `with ${GITHUB_TOKEN}`,
    });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("asks the owner to reset the size limit, and on Approve changes it against the limit they saw, as approved", async () => {
    const { reset, calls, asked, logged } = await setUp({ overrides: { maxInstance: "cpu-3" } });

    const { result, text } = await reset({
      id: "default",
      setting: "maxInstance",
      reason: "Global's limit will do",
    });

    expect(asked).toMatchObject([
      {
        tool: "environment_setting_reset",
        target: 'Environment "Default"',
        change: "Size limit (reset to Global's)",
        before: "cpu-3 (3 vCPU, 9 GiB memory, 12 GB disk), its own",
        after: "cpu-2 (2 vCPU, 6 GiB memory, 12 GB disk), inherited from Global",
        reason: "Global's limit will do",
        expected: "cpu-3",
      },
    ]);
    expect(calls).toMatchObject([
      {
        environment: "default",
        field: "maxInstance",
        value: null,
        expected: "cpu-3",
        author: { tool: "environment_setting_reset", approved: true },
      },
    ]);
    expect(text).toContain("The user approved: reset the size limit of");
    expect(result.details).toMatchObject({
      approval: { approved: true },
      agentChange: { field: "maxInstance", before: "cpu-3", after: "cpu-2" },
    });
    expect(logged).toEqual([
      { tool: "environment_setting_reset", environmentName: "Default", field: "maxInstance" },
    ]);
  });

  it("changes nothing when the owner declines the reset of the size limit", async () => {
    const { reset, calls, asked, logged } = await setUp({ overrides: { maxInstance: "cpu-3" } });

    const { result, text } = await reset(
      { id: "default", setting: "maxInstance", reason: "r" },
      { approve: false, reason: "Keep the room" },
    );

    expect(asked).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(logged).toEqual([]);
    expect(text).toContain("The user declined");
    expect(text).toContain("Nothing changed.");
    expect(text).toContain("Keep the room");
    expect(result.details).toMatchObject({ approval: { approved: false } });
  });

  it("answers, without asking, that a size limit with no Override is inherited from Global already", async () => {
    const { reset, calls, asked } = await setUp();

    const { result, text } = await reset({ id: "default", setting: "maxInstance", reason: "r" });

    expect(result.isError).not.toBe(true);
    expect(text).toContain("inherited from Global already (cpu-2): nothing changed");
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("refuses, without asking, a reset that would leave the size above Global's limit", async () => {
    const { reset, calls, asked } = await setUp({
      global: { ...DEFAULT_CONTAINER_SETTINGS, maxInstance: "cpu-1" },
      overrides: { instance: "cpu-2", maxInstance: "cpu-3" },
    });

    const { result, text } = await reset({ id: "default", setting: "maxInstance", reason: "r" });

    expect(result.isError).toBe(true);
    expect(text).toContain(
      "Nothing was asked or saved: the size limit at Global, cpu-1, is below the size of",
    );
    expect(text).toContain("cpu-2");
    expect(text).toContain("environment_container_resize");
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
  });
});
