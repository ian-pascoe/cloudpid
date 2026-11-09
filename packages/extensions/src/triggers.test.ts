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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// The tools read the time from the Clock, which reads `Date`: held at `NOW`, the next Fires they give stay the same.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

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

const MATCH = { event: ["workflow_run"], "workflow_run.conclusion": ["failure", "timed_out"] };

const CI = {
  owner: "default",
  name: "CI failures",
  message: "Find out why the run failed and say what to fix.",
  webhook: { format: "github" },
  match: MATCH,
  reason: "the user wants failed CI runs looked into",
};

/** A webhook Trigger held by the fake: it takes the failed workflow runs of GitHub. */
const hook = (fields: Partial<TriggerDefinition> = {}): TriggerDefinition =>
  weekly({
    id: "h1",
    name: "CI failures",
    message: CI.message,
    source: { type: "webhook", format: "github", match: MATCH },
    whenBusy: "start",
    ...fields,
  });

describe("a webhook Trigger", () => {
  it("is made once the owner approves a card showing its format and match, and gives no URL or secret", async () => {
    const { call, triggers, logged, asked } = await setUp();

    const { result, text } = await call("trigger_create", CI);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      tool: "trigger_create",
      change: "Create a Trigger",
      before: "None",
      expected: { id: "0190-a" },
    });
    expect(asked[0]?.after).toContain("Webhook: a webhook (github format)");
    expect(asked[0]?.after).toContain(
      'Match: "event" is "workflow_run"; "workflow_run.conclusion" is "failure" or "timed_out"',
    );
    expect(asked[0]?.after).toContain("when busy: start");
    expect(asked[0]?.after).not.toContain("Schedule:");
    expect(asked[0]?.notes?.join("\n")).toContain("shown only to the user");
    expect(asked[0]?.notes?.join("\n")).not.toContain("Next Fires");

    for (const note of asked[0]?.notes ?? []) expect(note.length).toBeLessThanOrEqual(200);

    expect(triggers.held.get("0190-a")).toMatchObject({
      environment: "default",
      source: { type: "webhook", format: "github", match: MATCH },
      whenBusy: "start",
    });
    expect(triggers.changes).toMatchObject([
      { field: triggerField("0190-a"), before: null, approved: true },
    ]);
    expect(logged).toHaveLength(1);

    expect(text).toContain('made the Trigger "CI failures" (id 0190-a)');
    expect(text).toContain("Trigger's page");
    expect(text).toContain("never shown to you");
    expect(text).not.toContain("/hooks/");
    expect(text).not.toContain("Next Fires");

    const output = decodeChange(result.structuredOutput);

    expect(output.trigger).toMatchObject({
      id: "0190-a",
      schedule: null,
      webhook: { format: "github", match: MATCH },
      next_fires: [],
      when_busy: "start",
    });
    expect(JSON.stringify(result.structuredOutput)).not.toContain("/hooks/");
  });

  it("is made without a match, which takes every delivery signed right", async () => {
    const { call, triggers, asked } = await setUp();

    const { match: _match, ...unfiltered } = CI;

    const { result } = await call("trigger_create", {
      ...unfiltered,
      webhook: { format: "standard" },
    });

    expect(asked[0]?.after).toContain("Webhook: a webhook (standard format)");
    expect(asked[0]?.after).toContain(
      "Match: none: every delivery that is signed right starts a Session",
    );
    expect(triggers.held.get("0190-a")?.source).toEqual({ type: "webhook", format: "standard" });
    expect(decodeChange(result.structuredOutput).trigger).toMatchObject({
      webhook: { format: "standard", match: null },
    });
  });

  it("refuses a source it can't make, and a match it can't keep, without asking", async () => {
    const { call, asked, triggers } = await setUp();

    const { match: _match, webhook: _webhook, ...bare } = CI;

    const refused = [
      // Neither a schedule nor a webhook.
      bare,
      // Both.
      { ...CI, schedule: WEEKLY.schedule },
      // A match belongs to a webhook.
      { ...WEEKLY, match: MATCH },
      // A path of no name, a path of an empty segment, a path that lists no values.
      { ...CI, match: { "": ["x"] } },
      { ...CI, match: { "a..b": ["x"] } },
      { ...CI, match: { event: [] } },
      // A Secret held, or a deploy credential, in a value.
      { ...CI, match: { "head.ref": [HELD] } },
      { ...CI, match: { "head.ref": [GITHUB_TOKEN] } },
    ];

    for (const args of refused) {
      const { error, text } = await call("trigger_create", args);

      expect(error).toBe(true);
      expect(text).toContain("Nothing was asked or saved");
    }

    expect(asked).toEqual([]);
    expect(triggers.held.size).toBe(0);
  });

  it("is listed and read with its format and match, and without a Schedule", async () => {
    const { call } = await setUp([hook(), weekly()]);

    const listed = await call("trigger_list", {});

    expect(listed.text).toContain("a webhook (github format)");
    expect(listed.text).not.toContain("/hooks/");
    expect(decodeList(listed.result.structuredOutput)).toMatchObject({
      triggers: [
        { id: "h1", schedule: null, webhook: { format: "github", match: MATCH } },
        { id: "t1", webhook: null, schedule: { cron: "0 9 * * MON" } },
      ],
    });

    const got = await call("trigger_get", { id: "h1" });

    expect(got.text).toContain("Webhook: a webhook (github format)");
    expect(got.text).toContain('Match: "event" is "workflow_run"');
    expect(got.text).toContain("Signing secret are the user's alone");
    expect(got.text).not.toContain("Next Fires");
    expect(decodeTrigger(got.result.structuredOutput)).toMatchObject({
      webhook: { format: "github", match: MATCH },
      next_fires: [],
    });
  });

  it("trigger_match_set shows the match before and after, and changes it once approved", async () => {
    const { call, triggers, asked, logged } = await setUp([hook()]);

    const { result, text } = await call("trigger_match_set", {
      id: "h1",
      match: { event: ["workflow_run"], "workflow_run.head_branch": ["main"] },
      reason: "only the main branch matters",
    });

    expect(asked[0]).toMatchObject({
      tool: "trigger_match_set",
      change: "Change a Trigger's match",
      before: '"event" is "workflow_run"; "workflow_run.conclusion" is "failure" or "timed_out"',
      after: '"event" is "workflow_run"; "workflow_run.head_branch" is "main"',
      reason: "only the main branch matters",
    });
    expect(text).toContain("The user approved");
    expect(text).toContain("answered and counted");
    expect(triggers.held.get("h1")?.source).toEqual({
      type: "webhook",
      format: "github",
      match: { event: ["workflow_run"], "workflow_run.head_branch": ["main"] },
    });
    expect(triggers.changes).toMatchObject([
      { field: triggerField("h1"), approved: true, author: { tool: "trigger_match_set" } },
    ]);
    expect(logged).toHaveLength(1);
    expect(decodeChange(result.structuredOutput)).toMatchObject({
      approval: { approved: true },
      trigger: { webhook: { match: { "workflow_run.head_branch": ["main"] } } },
    });
  });

  it("trigger_match_set takes the match away with null or an empty one", async () => {
    const { call, triggers, asked } = await setUp([hook(), hook({ id: "h2" })]);

    await call("trigger_match_set", { id: "h1", match: null, reason: "take everything" });

    expect(asked[0]).toMatchObject({
      after: "none: every delivery that is signed right starts a Session",
    });
    expect(asked[0]?.notes?.join("\n")).toContain("No match");
    expect(triggers.held.get("h1")?.source).toEqual({ type: "webhook", format: "github" });

    await call("trigger_match_set", { id: "h2", match: {}, reason: "take everything" });

    expect(triggers.held.get("h2")?.source).toEqual({ type: "webhook", format: "github" });
  });

  it("trigger_match_set asks nothing for the match the Trigger has, nor for a bad one", async () => {
    const { call, asked, triggers } = await setUp([hook()]);

    const same = await call("trigger_match_set", { id: "h1", match: MATCH, reason: "r" });

    expect(same.text).toContain("has that match already");
    expect(same.text).toContain("nothing was changed or recorded");

    for (const match of [{ "a..b": ["x"] }, { event: [] }, { "head.ref": [HELD] }]) {
      expect((await call("trigger_match_set", { id: "h1", match, reason: "r" })).error).toBe(true);
    }

    expect(
      (await call("trigger_match_set", { id: "nope", match: null, reason: "r" })).text,
    ).toContain("trigger_list");
    expect(asked).toEqual([]);
    expect(triggers.changes).toEqual([]);
  });

  it("trigger_match_set compares matches as the Trigger holds them, not as the card reads them", async () => {
    // Two values read as one on a card that doesn't quote them; they are two matches.
    const { call, triggers, asked } = await setUp([
      hook({ source: { type: "webhook", format: "github", match: { a: ["x or y"] } } }),
    ]);

    await call("trigger_match_set", { id: "h1", match: { a: ["x", "y"] }, reason: "two values" });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ before: '"a" is "x or y"', after: '"a" is "x" or "y"' });
    expect(triggers.held.get("h1")?.source).toMatchObject({ match: { a: ["x", "y"] } });

    // The same paths in another order is the same match: nothing is asked.
    const { call: again, asked: none } = await setUp([
      hook({ source: { type: "webhook", format: "github", match: { a: ["x"], b: ["y"] } } }),
    ]);

    const same = await again("trigger_match_set", {
      id: "h1",
      match: { b: ["y"], a: ["x"] },
      reason: "r",
    });

    expect(same.text).toContain("has that match already");
    expect(none).toEqual([]);
  });

  it("quotes a match's paths and values on the card, so none can fake a line or blur two values", async () => {
    const { call, asked } = await setUp();

    await call("trigger_create", {
      ...CI,
      match: { "label.name": ["bug\nMessage:", 'a" or "b', "x; y"] },
    });

    expect(asked[0]?.after).toContain(
      'Match: "label.name" is "bug\\nMessage:" or "a\\" or \\"b" or "x; y"',
    );
    expect(asked[0]?.after.split("\n").filter((line) => line.startsWith("Message:"))).toHaveLength(
      1,
    );
  });

  it("refuses a match the card can't show whole, without asking", async () => {
    const { call, asked } = await setUp([hook()]);

    const long = { "a.b": Array.from({ length: 2_000 }, (_, at) => `value-${String(at)}`) };

    const made = await call("trigger_create", { ...CI, match: long });
    const set = await call("trigger_match_set", { id: "h1", match: long, reason: "r" });

    for (const refused of [made, set]) {
      expect(refused.error).toBe(true);
      expect(refused.text).toContain("the card shows");
    }

    expect(asked).toEqual([]);
  });

  it("is made without a match when the match is empty", async () => {
    const { call, triggers } = await setUp();

    await call("trigger_create", { ...CI, match: {} });

    expect(triggers.held.get("0190-a")?.source).toEqual({ type: "webhook", format: "github" });
  });

  it("names neither a Schedule nor a webhook for a source this version can't read", async () => {
    const { call, asked } = await setUp([weekly({ id: "u1", source: { type: "unknown" } })]);

    const match = await call("trigger_match_set", { id: "u1", match: MATCH, reason: "r" });

    expect(match.error).toBe(true);
    expect(match.text).toContain("can't read");
    expect(match.text).not.toContain("Schedule");

    const paused = await call("trigger_pause", { id: "u1", reason: "r" });

    expect(paused.error).toBe(false);

    const { text } = await call("trigger_resume", { id: "u1", reason: "r" });

    expect(text).not.toContain("not caught up");
    expect(asked[0]?.after).toBe("Active: fires a source this version can't read");
  });

  it("refuses a webhook Trigger's Schedule change before it looks at the Schedule", async () => {
    const { call, asked } = await setUp([hook()]);

    const { error, text } = await call("trigger_schedule_set", {
      id: "h1",
      schedule: { cron: "0 9 * * MON", zone: "" },
      reason: "r",
    });

    expect(error).toBe(true);
    expect(text).toContain("trigger_match_set");
    expect(asked).toEqual([]);
  });

  it("trigger_match_set changes nothing once the Trigger changed while the card waited", async () => {
    const { call, triggers } = await setUp([hook()]);

    const { error, text } = await call(
      "trigger_match_set",
      { id: "h1", match: { event: ["push"] }, reason: "r" },
      {
        ...APPROVE,
        meanwhile: () => {
          triggers.held.set(
            "h1",
            hook({ revision: 3, source: { type: "webhook", format: "github" } }),
          );
        },
      },
    );

    expect(error).toBe(true);
    expect(text).toContain("changed since they were asked");
    expect(triggers.held.get("h1")?.source).toEqual({ type: "webhook", format: "github" });
  });

  it("trigger_match_set refuses a Schedule Trigger, and trigger_schedule_set a webhook one, without asking", async () => {
    const { call, asked } = await setUp([hook(), weekly()]);

    const match = await call("trigger_match_set", { id: "t1", match: MATCH, reason: "r" });

    expect(match.error).toBe(true);

    const schedule = await call("trigger_schedule_set", {
      id: "h1",
      schedule: { cron: "@daily", zone: "UTC" },
      reason: "r",
    });

    expect(schedule.error).toBe(true);
    expect(schedule.text).toContain("trigger_match_set");
    expect(asked).toEqual([]);
  });

  it("trigger_resume of a paused one says what happens to the deliveries that came while paused", async () => {
    const { call, triggers, asked } = await setUp([hook({ paused: true })]);

    const { text } = await call("trigger_resume", { id: "h1", reason: "the user is back" });

    expect(asked[0]).toMatchObject({
      change: "Resume a Trigger",
      before: "Paused",
      after: "Active: fires a webhook (github format)",
    });
    expect(text).toContain("not caught up");
    expect(text).not.toContain("times it missed");
    expect(triggers.held.get("h1")?.paused).toBe(false);
  });
});

const HOOKED = {
  ...CI,
  webhook: { format: "github", repo: "octo-org/octo-repo", events: ["workflow_run"] },
};

describe("a GitHub-managed hook", () => {
  it("is made with its repo and events once the owner approves a card naming them, and needs no setting up", async () => {
    const { call, triggers, asked } = await setUp();

    const { result, text, error } = await call("trigger_create", HOOKED);

    expect(error).toBe(false);
    // The owner approves the repo and the events: the card names both.
    expect(asked[0]?.after).toContain('"octo-org/octo-repo"');
    expect(asked[0]?.after).toContain('"workflow_run"');
    expect(triggers.held.get("0190-a")?.source).toEqual({
      type: "webhook",
      format: "github",
      match: MATCH,
      repo: "octo-org/octo-repo",
      events: ["workflow_run"],
    });
    expect(text).not.toContain("/hooks/");

    const output = decodeChange(result.structuredOutput);

    expect(output.trigger?.webhook).toEqual({
      format: "github",
      match: MATCH,
      repo: "octo-org/octo-repo",
      events: ["workflow_run"],
    });
    expect(output.github_hook).toEqual({
      repo: "octo-org/octo-repo",
      state: "ready",
      problem: null,
    });
  });

  it("says why GitHub has no hook yet, which cloudpid keeps trying", async () => {
    const { call, triggers } = await setUp();
    const problem = "The GitHub App can't make hooks: accept Webhooks: write on its installation";

    triggers.hookAnswers.set("0190-a", {
      repo: "octo-org/octo-repo",
      state: "failed",
      problem: { code: "permission", message: problem },
    });

    const { result, text, error } = await call("trigger_create", HOOKED);

    // The Trigger is made: only its hook waits.
    expect(error).toBe(false);
    expect(decodeChange(result.structuredOutput).github_hook).toEqual({
      repo: "octo-org/octo-repo",
      state: "failed",
      problem,
    });
    // GitHub's reason reaches the agent, who tells the user what to do.
    expect(text).toContain(problem);
  });

  it("refuses a repo or events it can't make a hook of, without asking", async () => {
    const { call, asked, triggers } = await setUp();

    // Which repos and events are refused is `githubHookProblem`'s (`packages/protocol`): one passes through here.
    const { error, text } = await call("trigger_create", {
      ...HOOKED,
      webhook: { format: "github", repo: "octo-org/octo-repo" },
    });

    expect(error).toBe(true);
    expect(text).toContain("Nothing was asked or saved");
    expect(asked).toEqual([]);
    expect(triggers.held.size).toBe(0);
  });
});

describe("Session triggers", () => {
  const CHECK_CI = {
    owner: "session",
    name: "Check CI",
    message: "Check the current state of CI, and fix what is red.",
    schedule: { cron: "0 * * * *", zone: "UTC" },
    reason: "the user asked to keep an eye on CI while they are away",
  };

  /** A Session trigger held by the fake: this Session's own. */
  const checkCi = (fields: Partial<TriggerDefinition> = {}): TriggerDefinition =>
    weekly({
      id: "t3",
      kind: "session",
      session: "s-1",
      name: "Check CI",
      message: CHECK_CI.message,
      source: { type: "schedule", cron: "0 * * * *", zone: "UTC" },
      whenBusy: "queue",
      ...fields,
    });

  it("trigger_create with the owner session makes one for this Session once the owner approves", async () => {
    const { call, triggers, logged, asked } = await setUp();

    const { result, text } = await call("trigger_create", CHECK_CI);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      tool: "trigger_create",
      target: "This Session",
      change: "Create a Trigger",
      reason: CHECK_CI.reason,
      expected: { id: "0190-a" },
    });
    expect(asked[0]?.after).toContain("Options: when busy: queue");
    expect(asked[0]?.after).not.toContain("base:");

    expect(text).toContain(
      'The user approved: made the Trigger "Check CI" (id 0190-a) in This Session',
    );
    expect(triggers.held.get("0190-a")).toMatchObject({
      kind: "session",
      session: "s-1",
      environment: "default",
      whenBusy: "queue",
    });
    expect(triggers.changes).toMatchObject([
      { field: triggerField("0190-a"), before: null, approved: true },
    ]);
    expect(logged).toEqual([
      { tool: "trigger_create", environmentName: "Default", field: triggerField("0190-a") },
    ]);
    expect(decodeChange(result.structuredOutput)).toMatchObject({
      scope: { id: "default" },
      trigger: { id: "0190-a", kind: "session", session: "s-1", when_busy: "queue" },
    });
  });

  it("takes steer and skip, and refuses a when_busy or an option its kind doesn't take, without asking", async () => {
    const { call, asked, triggers } = await setUp();

    for (const args of [
      { ...CHECK_CI, when_busy: "start" },
      { ...CHECK_CI, base: "develop" },
      { ...CHECK_CI, model: "anthropic/claude-sonnet-5-5" },
      { ...CHECK_CI, thinking: "low" },
      { ...WEEKLY, when_busy: "queue" },
      { ...WEEKLY, when_busy: "steer" },
    ]) {
      expect((await call("trigger_create", args)).error).toBe(true);
    }

    expect(asked).toEqual([]);
    expect(triggers.held.size).toBe(0);

    await call("trigger_create", { ...CHECK_CI, when_busy: "steer" });

    expect(triggers.held.get("0190-a")).toMatchObject({ whenBusy: "steer" });
  });

  it("takes a Schedule only: a webhook or a match is refused without asking, and trigger_match_set finds no match to change", async () => {
    const { call, asked, triggers } = await setUp([checkCi()]);

    const { schedule: _schedule, ...bare } = CHECK_CI;

    for (const args of [
      { ...bare, webhook: { format: "github" } },
      { ...bare, webhook: { format: "github" }, match: MATCH },
      { ...CHECK_CI, match: MATCH },
    ]) {
      const { error, text } = await call("trigger_create", args);

      expect(error).toBe(true);
      expect(text).toMatch(/Session trigger fires on a Schedule only|a Schedule has none/);
    }

    const match = await call("trigger_match_set", { id: "t3", match: MATCH, reason: "r" });

    expect(match.error).toBe(true);
    expect(asked).toEqual([]);
    expect(triggers.held.size).toBe(1);
  });

  it("trigger_options_set changes a Session trigger's when_busy alone", async () => {
    const { call, triggers, asked } = await setUp([checkCi()]);

    for (const args of [
      { id: "t3", when_busy: "start", reason: "r" },
      { id: "t3", base: "develop", reason: "r" },
      { id: "t3", model: "anthropic/claude-sonnet-5-5", reason: "r" },
    ]) {
      expect((await call("trigger_options_set", args)).error).toBe(true);
    }

    expect(asked).toEqual([]);

    await call("trigger_options_set", { id: "t3", when_busy: "skip", reason: "no pile-up" });

    expect(asked[0]).toMatchObject({
      target: "This Session",
      before: "when busy: queue",
      after: "when busy: skip",
    });
    expect(triggers.held.get("t3")).toMatchObject({ whenBusy: "skip" });
  });

  it("pause, resume and the reads treat it as this Session's own", async () => {
    const { call, triggers, asked } = await setUp([checkCi()]);

    await call("trigger_pause", { id: "t3", reason: "not now" });
    expect(triggers.held.get("t3")?.paused).toBe(true);

    await call("trigger_resume", { id: "t3", reason: "again" });
    expect(asked[0]).toMatchObject({ target: "This Session", change: "Resume a Trigger" });

    const listed = await call("trigger_list", {});

    expect(decodeList(listed.result.structuredOutput)).toMatchObject({
      triggers: [{ id: "t3", kind: "session", session: "s-1" }],
    });
    expect((await call("trigger_get", { id: "t3" })).error).toBeFalsy();
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
