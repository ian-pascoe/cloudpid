// The `trigger_*` tools (docs/architecture/triggers.md → Agent tools and Approval): making a Trigger, changing what it
// sends or when, and resuming it wait for the owner's Approval and apply only what the card showed; pausing and removing
// apply at once; each refuses without asking what it would refuse anyway, and records an Agent change of
// `triggers.<id>` under the Trigger's Environment.
// @effect-diagnostics asyncFunction:off strictEffectProvide:off preferEffectArray:off newPromise:off globalTimers:off
import { DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import { type TriggerDefinition, triggerField } from "@cloudpid/protocol";
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
import { type ApprovalAsk, Approvals, type ApprovalsService, makeApprovals } from "./approvals.ts";
import {
  AgentChangeLog,
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
import { isParentOnly } from "./subagents/toolsets.ts";
import { TriggerChangeOutput, TriggerListOutput, TriggerOutput } from "./trigger-outputs.ts";
import { fakeTriggers } from "./triggers.fixture.ts";
import { TriggerAccess, TriggerTools } from "./triggers.ts";

const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
const HELD = "sk-live-0123456789abcdef";

/** Monday 2026-11-09 08:00 in Chicago (14:00 UTC): the weekly Trigger's next Fire is an hour away. */
const NOW = Date.parse("2026-11-09T14:00:00Z");

const details = (id: string, name: string): EnvironmentDetails => ({
  id,
  name,
  repos: [],
  build: { status: "none" },
  settings: DEFAULT_CONTAINER_SETTINGS,
  overrides: {},
  global: DEFAULT_CONTAINER_SETTINGS,
  secrets: [],
  skills: [],
  globalSkills: [],
});

const ENVIRONMENTS = { default: "Default", "0000abcd": "Web" };

const WEEKLY = {
  owner: "default",
  name: "Weekly report",
  message: "Summarize last week's PRs.",
  schedule: { cron: "0 9 * * MON", zone: "America/Chicago" },
  reason: "the user asked for a summary of the week's PRs every Monday",
};

/** A Trigger held by the fake: the weekly one of Default, active. */
const weekly = (fields: Partial<TriggerDefinition> = {}): TriggerDefinition => ({
  id: "t1",
  revision: 1,
  kind: "environment",
  environment: "default",
  name: "Weekly report",
  message: "Summarize last week's PRs.",
  source: { type: "schedule", cron: "0 9 * * MON", zone: "America/Chicago" },
  whenBusy: "skip",
  paused: false,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...fields,
});

/** How the owner answers a call's request; `meanwhile` runs first, as what happens while the card waits. */
type Answer = {
  readonly approve: boolean;
  readonly reason?: string;
  readonly meanwhile?: () => void;
  /** The task of a rerun: a call an eviction cut off, which asked already. */
  readonly task?: number;
};

const APPROVE: Answer = { approve: true };

/** The Workspace of the Session under test, which a Workspace trigger made by `owner: "workspace"` keeps. */
const HERE = { id: "0f0f0f0f", branch: "cloudpid/0f0f0f0f", environment: "default" };

const setUp = async (held: ReadonlyArray<TriggerDefinition> = [], here?: typeof HERE) => {
  const triggers = fakeTriggers(ENVIRONMENTS, NOW, here);

  for (const definition of held) triggers.held.set(definition.id, definition);

  const logged: RunChange[] = [];
  const asked: ApprovalAsk[] = [];
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
    }),
  );

  const redactions = new Redactions();

  redactions.hold("API_KEY", HELD);

  // SAFETY: the tools use only `refresh` and `redact` of the Secrets.
  const secrets = {
    refresh: Effect.void,
    redact: (value: string) => redactions.redact(value),
  } as SecretsService;

  const extension = await Effect.runPromise(
    TriggerTools.pipe(
      Effect.provideService(TriggerAccess, triggers.access),
      Effect.provideService(Approvals, approvals),
      Effect.provideService(Environments, {
        ...unusedLifecycle,
        ...unusedSecretMarks,
        ...unusedSkills,
        current: Effect.succeed("default"),
        list: Effect.die("not listed here"),
        get: (id) =>
          Effect.succeed(
            id === "default" || id === "0000abcd" ? details(id, ENVIRONMENTS[id]) : null,
          ),
        global: Effect.die("not read here"),
        change: () => Effect.die("not changed here"),
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

    return { result, text, error: result.isError === true };
  };

  /**
   * A call of task `id` that asked with `expected` and was answered, then cut off by an eviction before it ended: the
   * answer is kept for its rerun.
   */
  const answeredEarlier = async (id: number, expected: Schema.Json | null) => {
    task = Math.max(task, id);

    const earlier = Effect.runPromise(
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
    await earlier;
  };

  return { call, triggers, logged, asked, answeredEarlier };
};

// @effect-diagnostics-next-line schemaSync:off -- a test reads a tool result it holds.
const decodeChange = Schema.decodeUnknownSync(TriggerChangeOutput);

// @effect-diagnostics-next-line schemaSync:off -- a test reads a tool result it holds.
const decodeList = Schema.decodeUnknownSync(TriggerListOutput);

// @effect-diagnostics-next-line schemaSync:off -- a test reads a tool result it holds.
const decodeTrigger = Schema.decodeUnknownSync(TriggerOutput);

describe("trigger_create", () => {
  it("makes the Trigger once the owner approves the card, recorded as approved", async () => {
    const { call, triggers, logged, asked } = await setUp();

    const { result, text } = await call("trigger_create", WEEKLY);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      tool: "trigger_create",
      target: 'Environment "Default"',
      change: "Create a Trigger",
      before: "None",
      reason: WEEKLY.reason,
      expected: { id: "0190-a" },
    });
    expect(asked[0]?.after).toContain('Schedule: "0 9 * * MON" in America/Chicago');
    expect(asked[0]?.after).toContain("Summarize last week's PRs.");
    expect(asked[0]?.notes?.join("\n")).toContain("Next Fires: Mon, Nov 9, 2026, 9:00 AM CST");

    expect(text).toContain('The user approved: made the Trigger "Weekly report" (id 0190-a)');
    expect(triggers.held.get("0190-a")).toMatchObject({
      environment: "default",
      source: { type: "schedule", cron: "0 9 * * MON", zone: "America/Chicago" },
      whenBusy: "skip",
    });
    expect(triggers.changes).toMatchObject([
      {
        field: triggerField("0190-a"),
        before: null,
        approved: true,
        author: { tool: "trigger_create", reason: WEEKLY.reason, approved: true },
      },
    ]);
    expect(logged).toEqual([
      { tool: "trigger_create", environmentName: "Default", field: triggerField("0190-a") },
    ]);

    const output = decodeChange(result.structuredOutput);

    expect(output).toMatchObject({
      scope: { id: "default", name: "Default" },
      approval: { approved: true, reason: null },
      trigger: {
        id: "0190-a",
        schedule: { cron: "0 9 * * MON", zone: "America/Chicago" },
        next_fires: [
          "2026-11-09T15:00:00.000Z",
          "2026-11-16T15:00:00.000Z",
          "2026-11-23T15:00:00.000Z",
        ],
      },
    });
    expect(output.changes).toHaveLength(1);
  });

  it("makes nothing when the owner declines", async () => {
    const { call, triggers } = await setUp();

    const { text, result } = await call("trigger_create", WEEKLY, {
      approve: false,
      reason: "not weekly",
    });

    expect(text).toContain("The user declined");
    expect(text).toContain("not weekly");
    expect(triggers.held.size).toBe(0);
    expect(decodeChange(result.structuredOutput)).toMatchObject({
      approval: { approved: false, reason: "not weekly" },
      changes: [],
      trigger: null,
    });
  });

  it("refuses a Schedule without a zone, of 6 fields, or with L, W or #, without asking", async () => {
    const { call, asked, triggers } = await setUp();

    for (const schedule of [
      { cron: "0 9 * * MON", zone: "" },
      { cron: "0 0 9 * * MON", zone: "UTC" },
      { cron: "0 9 L * *", zone: "UTC" },
      { cron: "0 9 15W * *", zone: "UTC" },
      { cron: "0 9 * * MON#1", zone: "UTC" },
    ]) {
      const { error, text } = await call("trigger_create", { ...WEEKLY, schedule });

      expect(error).toBe(true);
      expect(text).toContain("Nothing was asked or saved");
    }

    expect(asked).toEqual([]);
    expect(triggers.held.size).toBe(0);

    // @daily is a Schedule.
    await call("trigger_create", { ...WEEKLY, schedule: { cron: "@daily", zone: "UTC" } });

    expect(asked).toHaveLength(1);
  });

  it("refuses a name or message it can't keep, and a text holding a Secret, without asking", async () => {
    const { call, asked } = await setUp();

    for (const args of [
      { ...WEEKLY, name: "x".repeat(81) },
      { ...WEEKLY, message: " " },
      { ...WEEKLY, message: `Use ${HELD} to call the API.` },
      { ...WEEKLY, reason: `the token ${GITHUB_TOKEN} works` },
      { ...WEEKLY, owner: "*" },
      { ...WEEKLY, owner: "0000ffff" },
    ]) {
      expect((await call("trigger_create", args)).error).toBe(true);
    }

    expect(asked).toEqual([]);
  });

  it("shows a long message cut on the card, with a warning, and keeps it whole", async () => {
    const { call, asked, triggers } = await setUp();

    const message = `${"a".repeat(16_000)}${"b".repeat(5_000)}`;

    await call("trigger_create", { ...WEEKLY, message });

    expect(asked[0]?.after).toContain(
      "[The card shows only the first 16000 of the message's 21000 characters: Approve keeps the rest unreviewed.]",
    );
    expect(asked[0]?.after).not.toContain("ab");
    expect(asked[0]?.notes?.join("\n")).toContain("longer than the card shows");
    expect(triggers.held.get("0190-a")?.message).toBe(message);
  });

  it("keeps each note of its card within a note's bound", async () => {
    const { call, asked } = await setUp();

    await call("trigger_create", WEEKLY);

    for (const note of asked[0]?.notes ?? []) expect(note.length).toBeLessThanOrEqual(200);
  });

  it("makes the Trigger the owner approved under the id it asked with, on a rerun after an eviction", async () => {
    const { call, triggers, answeredEarlier, asked } = await setUp();

    // The cut-off call drew 0190-z and was approved; the rerun draws another id, but makes 0190-z.
    await answeredEarlier(7, { id: "0190-z" });

    await call("trigger_create", WEEKLY, { ...APPROVE, task: 7 });

    expect(asked).toEqual([]);
    expect([...triggers.held.keys()]).toEqual(["0190-z"]);

    // Made before the eviction: nothing more is made.
    await answeredEarlier(8, { id: "0190-z" });

    const { text } = await call("trigger_create", WEEKLY, { ...APPROVE, task: 8 });

    expect(text).toContain("The user approved, and the Trigger");
    expect(triggers.held.size).toBe(1);
    expect(triggers.changes).toHaveLength(1);
  });
});

describe("the changes that wait for the owner's Approval", () => {
  it("trigger_message_set changes the message the owner saw, and nothing once the Trigger changed", async () => {
    const { call, triggers, asked } = await setUp([weekly()]);

    const { text } = await call("trigger_message_set", {
      id: "t1",
      message: "Summarize this week's PRs.",
      reason: "the user wants this week's",
    });

    expect(asked[0]).toMatchObject({
      tool: "trigger_message_set",
      change: "Change a Trigger's message",
      before: "Summarize last week's PRs.",
      after: "Summarize this week's PRs.",
    });
    expect(text).toContain("The user approved");
    expect(triggers.held.get("t1")?.message).toBe("Summarize this week's PRs.");

    // The owner edits the Trigger while the card waits: what they approved is not what it is now.
    const changedSince = await call(
      "trigger_message_set",
      { id: "t1", message: "Summarize nothing.", reason: "r" },
      {
        ...APPROVE,
        meanwhile: () => {
          triggers.held.set("t1", weekly({ message: "The owner's words.", revision: 3 }));
        },
      },
    );

    expect(changedSince.error).toBe(true);
    expect(changedSince.text).toContain("changed since they were asked");
    expect(triggers.held.get("t1")?.message).toBe("The owner's words.");
  });

  it("asks nothing for a Trigger that has the values already, but still has the Session wake its object", async () => {
    const { call, asked, triggers } = await setUp([weekly({ paused: false })]);

    const same = await call("trigger_message_set", {
      id: "t1",
      message: "Summarize last week's PRs.",
      reason: "r",
    });

    expect(same.text).toContain("nothing was changed or recorded");
    expect((await call("trigger_resume", { id: "t1", reason: "r" })).text).toContain(
      "active already",
    );
    expect(asked).toEqual([]);
    expect(triggers.changes).toEqual([]);
    // The Session wakes the object after every call that reaches it, a change of nothing too.
    expect(triggers.reached).toEqual(["update", "setPaused"]);
  });

  it("trigger_schedule_set refuses a bad Schedule without asking, and changes it once approved", async () => {
    const { call, triggers, asked } = await setUp([weekly()]);

    expect(
      (
        await call("trigger_schedule_set", {
          id: "t1",
          schedule: { cron: "0 9 * * MON", zone: "Mars/Olympus" },
          reason: "r",
        })
      ).error,
    ).toBe(true);
    expect(asked).toEqual([]);

    await call("trigger_schedule_set", {
      id: "t1",
      schedule: { cron: "@daily", zone: "UTC" },
      reason: "every day",
    });

    expect(asked[0]).toMatchObject({
      change: "Change a Trigger's Schedule",
      before: '"0 9 * * MON" in America/Chicago',
      after: '"@daily" in UTC',
    });
    expect(triggers.held.get("t1")?.source).toEqual({
      type: "schedule",
      cron: "@daily",
      zone: "UTC",
    });
  });

  it("trigger_options_set changes the options given, and refuses none or a kind that takes none", async () => {
    const { call, triggers, asked } = await setUp([
      weekly({ base: "develop" }),
      weekly({ id: "t2", kind: "unknown" }),
    ]);

    await call("trigger_options_set", {
      id: "t1",
      when_busy: "start",
      model: "anthropic/claude-sonnet-5-5",
      base: null,
      reason: "runs may overlap",
    });

    expect(asked[0]).toMatchObject({
      change: "Change a Trigger's options",
      before: expect.stringContaining("when busy: skip, base: develop"),
      after: expect.stringContaining(
        "when busy: start, base: each Repo's default branch, model: anthropic/claude-sonnet-5-5",
      ),
    });
    expect(triggers.held.get("t1")).toMatchObject({
      whenBusy: "start",
      model: "anthropic/claude-sonnet-5-5",
    });
    expect(triggers.held.get("t1")?.base).toBeUndefined();

    expect((await call("trigger_options_set", { id: "t1", reason: "r" })).error).toBe(true);
    expect(
      (await call("trigger_options_set", { id: "t2", when_busy: "start", reason: "r" })).error,
    ).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it("trigger_resume waits for the owner, and says the missed times aren't caught up", async () => {
    const { call, triggers, asked } = await setUp([weekly({ paused: true })]);

    const { text } = await call("trigger_resume", { id: "t1", reason: "the user is back" });

    expect(asked[0]).toMatchObject({ change: "Resume a Trigger", before: "Paused" });
    expect(text).toContain("not caught up");
    expect(triggers.held.get("t1")?.paused).toBe(false);
  });
});

describe("the changes that apply at once", () => {
  it("trigger_pause pauses without asking, recorded as the agent's", async () => {
    const { call, triggers, asked, logged } = await setUp([weekly()]);

    const { result } = await call("trigger_pause", { id: "t1", reason: "the user is away" });

    expect(asked).toEqual([]);
    expect(triggers.held.get("t1")?.paused).toBe(true);
    expect(triggers.changes).toMatchObject([{ author: { tool: "trigger_pause" } }]);
    expect(triggers.changes[0]?.approved).toBeUndefined();
    expect(logged).toHaveLength(1);
    expect(decodeChange(result.structuredOutput)).toMatchObject({
      approval: null,
      trigger: { paused: true, next_fires: [] },
    });

    expect((await call("trigger_pause", { id: "t1", reason: "r" })).text).toContain(
      "paused already",
    );
  });

  it("trigger_remove removes without asking", async () => {
    const { call, triggers, asked } = await setUp([weekly()]);

    const { result, text } = await call("trigger_remove", { id: "t1", reason: "not needed" });

    expect(asked).toEqual([]);
    expect(text).toContain("removed");
    expect(triggers.held.size).toBe(0);
    expect(decodeChange(result.structuredOutput)).toMatchObject({
      trigger: null,
      changes: [{ before: expect.anything(), after: null }],
    });
    expect((await call("trigger_remove", { id: "t1", reason: "r" })).error).toBe(true);
  });
});

describe("the reads", () => {
  it("trigger_list and trigger_get give the Triggers, with their next Fires", async () => {
    const { call } = await setUp([weekly(), weekly({ id: "t2", environment: "0000abcd" })]);

    const listed = await call("trigger_list", { environment: "0000abcd" });

    expect(decodeList(listed.result.structuredOutput)).toMatchObject({
      triggers: [{ id: "t2", environment: { id: "0000abcd", name: "Web" } }],
    });

    const got = await call("trigger_get", { id: "t1" });

    expect(got.text).toContain("Next Fires: Mon, Nov 9, 2026, 9:00 AM CST");
    expect(decodeTrigger(got.result.structuredOutput)).toMatchObject({
      message: "Summarize last week's PRs.",
      message_truncated: false,
    });
    expect((await call("trigger_get", { id: "nope" })).text).toContain("trigger_list");
  });
});

describe("a subagent", () => {
  it("is never granted a trigger_* tool", () => {
    expect(isParentOnly("trigger_create")).toBe(true);
    expect(isParentOnly("trigger_list")).toBe(true);
  });
});

/** A Workspace trigger held by the fake: nightly, for `HERE`, waiting when busy. */
const nightly = (fields: Partial<TriggerDefinition> = {}): TriggerDefinition =>
  weekly({
    id: "w1",
    kind: "workspace",
    workspace: { id: HERE.id, branch: HERE.branch },
    name: "Nightly check",
    message: "Check the build.",
    whenBusy: "wait",
    ...fields,
  });

describe("a Workspace trigger", () => {
  const NIGHTLY = {
    owner: "workspace",
    name: "Nightly check",
    message: "Check the build.",
    schedule: { cron: "@daily", zone: "UTC" },
    reason: "the user wants the build checked every night",
  };

  it("is made for this Session's own Workspace once the owner approves, recorded naming it by branch", async () => {
    const { call, triggers, asked } = await setUp([], HERE);

    const { result, text } = await call("trigger_create", NIGHTLY);

    expect(asked[0]).toMatchObject({
      tool: "trigger_create",
      target: 'Workspace "cloudpid/0f0f0f0f" of Environment "Default"',
      change: "Create a Trigger",
    });
    expect(asked[0]?.after).toContain("Workspace: cloudpid/0f0f0f0f");
    expect(asked[0]?.after).toContain("when busy: wait");
    expect(asked[0]?.after).not.toContain("base:");
    expect(asked[0]?.notes?.join("\n")).toContain('Workspace "cloudpid/0f0f0f0f"');
    expect(text).toContain('made the Trigger "Nightly check" (id 0190-a)');
    expect(text).toContain("once the Workspace is idle");
    expect(triggers.held.get("0190-a")).toMatchObject({
      kind: "workspace",
      environment: "default",
      workspace: { id: "0f0f0f0f", branch: "cloudpid/0f0f0f0f" },
      whenBusy: "wait",
    });
    // Recorded under the Environment's Scope, naming the Workspace by its branch.
    expect(triggers.changes).toMatchObject([
      {
        field: triggerField("0190-a"),
        before: null,
        after: { kind: "workspace", workspace: { branch: "cloudpid/0f0f0f0f" }, whenBusy: "wait" },
      },
    ]);
    expect(decodeChange(result.structuredOutput)).toMatchObject({
      scope: { id: "default" },
      trigger: { kind: "workspace", workspace: { id: "0f0f0f0f", branch: "cloudpid/0f0f0f0f" } },
    });
  });

  it("takes no base, and wait only as a Workspace trigger's", async () => {
    const { call, asked, triggers } = await setUp([], HERE);

    const withBase = await call("trigger_create", { ...NIGHTLY, base: "develop" });

    expect(withBase.error).toBe(true);
    expect(withBase.text).toContain("takes no base");

    const waiting = await call("trigger_create", { ...WEEKLY, when_busy: "wait" });

    expect(waiting.error).toBe(true);
    expect(waiting.text).toContain("Only a Workspace trigger can wait");
    expect(asked).toEqual([]);
    expect(triggers.held.size).toBe(0);
  });

  it("is refused where the Session has no Workspace the Registry lists", async () => {
    const { call, asked } = await setUp();

    const { error, text } = await call("trigger_create", NIGHTLY);

    expect(error).toBe(true);
    expect(text).toContain("no Workspace");
    expect(asked).toEqual([]);
  });

  it("changes when_busy, model and thinking, and refuses a base", async () => {
    const { call, asked, triggers } = await setUp([nightly()], HERE);

    await call("trigger_options_set", {
      id: "w1",
      when_busy: "skip",
      thinking: "low",
      reason: "overlap is fine to skip",
    });

    expect(asked[0]).toMatchObject({
      target: 'Workspace "cloudpid/0f0f0f0f" of Environment "Default"',
      before: expect.stringContaining("when busy: wait, model: the Environment's"),
      after: expect.stringContaining("when busy: skip, model: the Environment's, thinking: low"),
    });
    expect(triggers.held.get("w1")).toMatchObject({ whenBusy: "skip", thinking: "low" });

    const base = await call("trigger_options_set", { id: "w1", base: "develop", reason: "r" });

    expect(base.error).toBe(true);
    expect(base.text).toContain("takes no base");
    expect(asked).toHaveLength(1);
  });

  it("is listed with its Workspace", async () => {
    const { call } = await setUp([nightly(), weekly()], HERE);

    const listed = await call("trigger_list", {});

    expect(listed.text).toContain("Workspace cloudpid/0f0f0f0f of Environment");
    expect(decodeList(listed.result.structuredOutput)).toMatchObject({
      triggers: [
        { id: "w1", kind: "workspace", workspace: { branch: "cloudpid/0f0f0f0f" } },
        { id: "t1", workspace: null },
      ],
    });
  });
});
