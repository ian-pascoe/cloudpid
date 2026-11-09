// @effect-diagnostics globalDate:off preferEffectArray:off -- expected times, read as ISO strings.

// The Triggers section's values (`triggers.ts`): what the form makes and sends for a Schedule or a webhook (the rows of
// a `match`, when `when_busy` follows the source, which rows are refused, and when an edit sends the `match` at all),
// the next Fires, the per-day delivery counts and the Trigger URL. The words a row shows are copy, and are held by
// `settings/triggers.test.tsx` only as far as the markup has them.
import { fireTimeWords, type TriggerDefinition } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  deliveryDays,
  emptyTriggerDraft,
  githubHookWords,
  matchRowsProblem,
  nextFireOf,
  outcomeWords,
  previewFires,
  triggerSourceWords,
  sourceWords,
  triggerDraftOf,
  triggerDraftProblems,
  triggerDraftReady,
  triggerInput,
  triggerNames,
  triggerPatch,
  triggerUrl,
  type TriggerDraft,
  waitingWords,
  withSource,
  whenBusyChoices,
  whenBusyOfText,
  workspaceTriggersOf,
} from "./triggers.ts";

const DEFINITION: TriggerDefinition = {
  id: "t1",
  revision: 2,
  kind: "environment",
  environment: "default",
  name: "Weekly report",
  message: "Summarize last week's PRs.",
  source: { type: "schedule", cron: "0 9 * * 1", zone: "America/Chicago" },
  whenBusy: "skip",
  model: "anthropic/claude-sonnet-4-5",
  paused: false,
  createdAt: 1,
  updatedAt: 2,
};

/** Monday 2025-01-06, 08:00 in Chicago. */
const MONDAY = Date.parse("2025-01-06T14:00:00Z");

describe("the Trigger form", () => {
  it("starts empty in the browser's zone, and says why it can't be saved yet", () => {
    const draft = emptyTriggerDraft("default", "Europe/Paris");

    expect(draft.zone).toBe("Europe/Paris");
    expect(triggerDraftReady(draft)).toBe(false);
    expect(triggerDraftProblems(draft)).toEqual({
      name: "A Trigger needs a name",
      message: "A Trigger needs a message to send",
      match: null,
      hook: null,
      schedule: expect.any(String),
    });
  });

  it("refuses a Schedule the Registry refuses, and previews the next 5 Fires of a good one", () => {
    const draft = triggerDraftOf(DEFINITION);

    expect(triggerDraftProblems({ ...draft, zone: "" }).schedule).not.toBeNull();
    expect(triggerDraftProblems({ ...draft, cron: "0 0 9 * * 1" }).schedule).not.toBeNull();
    expect(triggerDraftProblems({ ...draft, cron: "0 9 L * *" }).schedule).not.toBeNull();
    expect(triggerDraftProblems({ ...draft, cron: "@daily" }).schedule).toBeNull();
    expect(previewFires({ ...draft, zone: "" }, MONDAY)).toEqual([]);
    expect(previewFires(draft, MONDAY).map((at) => new Date(at).toISOString())).toEqual([
      "2025-01-06T15:00:00.000Z",
      "2025-01-13T15:00:00.000Z",
      "2025-01-20T15:00:00.000Z",
      "2025-01-27T15:00:00.000Z",
      "2025-02-03T15:00:00.000Z",
    ]);
  });

  it("makes an Environment trigger of what was typed, an empty option left to the Environment", () => {
    const draft = {
      ...emptyTriggerDraft("default", "America/Chicago"),
      name: "  Nightly  ",
      message: "Run the checks.",
      cron: " @daily ",
      base: " ",
      thinking: "high",
    };

    expect(triggerInput(draft)).toEqual({
      kind: "environment",
      environment: "default",
      name: "Nightly",
      message: "Run the checks.",
      source: { type: "schedule", cron: "@daily", zone: "America/Chicago" },
      whenBusy: "skip",
      thinking: "high",
    });
  });

  it("changes only what was edited, an emptied option back to the Environment's", () => {
    const draft = triggerDraftOf(DEFINITION);

    expect(triggerPatch(DEFINITION, draft)).toEqual({});
    expect(
      triggerPatch(DEFINITION, {
        ...draft,
        cron: "0 10 * * 1",
        model: "",
        whenBusy: "start",
        base: "develop",
      }),
    ).toEqual({
      source: { type: "schedule", cron: "0 10 * * 1", zone: "America/Chicago" },
      whenBusy: "start",
      base: "develop",
      model: null,
    });
  });
});

describe("a Trigger's row and fire log", () => {
  it("shows the next Fire, and none while paused", () => {
    expect(nextFireOf(DEFINITION, MONDAY)).toBe(Date.parse("2025-01-06T15:00:00Z"));
    expect(nextFireOf({ ...DEFINITION, paused: true }, MONDAY)).toBeNull();
    expect(nextFireOf({ ...DEFINITION, source: { type: "unknown" } }, MONDAY)).toBeNull();
  });

  it("says what made each Fire and what came of it", () => {
    expect(outcomeWords({ type: "started", session: "s-1" }, "environment")).toBe(
      "Started a session",
    );
    expect(outcomeWords({ type: "skipped", reason: "overlap" }, "environment")).toBe(
      "Skipped: overlap",
    );
    expect(outcomeWords({ type: "sent", delivery: "queued" }, "environment")).toBe("Sent (queued)");
    expect(outcomeWords({ type: "sent", delivery: "unknown" }, "environment")).toBe("Sent");
    expect(outcomeWords({ type: "skipped", reason: "coalesced" }, "workspace")).toBe(
      "Skipped: merged into the waiting fire",
    );
    expect(outcomeWords({ type: "skipped", reason: "coalesced" }, "environment")).toBe(
      "Skipped: coalesced",
    );
    expect(outcomeWords({ type: "skipped", reason: "coalesced" }, "session")).toBe(
      "Skipped: an earlier fire is still queued",
    );
    expect(outcomeWords({ type: "failed", reason: "The Session refused it" }, "environment")).toBe(
      "Failed: The Session refused it",
    );
    expect(
      sourceWords(
        {
          key: "t1:1",
          at: MONDAY,
          source: { type: "schedule", scheduledAt: Date.parse("2025-01-06T15:00:00Z") },
          outcome: { type: "unknown" },
        },
        "America/Chicago",
      ),
    ).toContain("Scheduled for");
    expect(
      sourceWords(
        {
          key: "t1:d-1",
          at: MONDAY,
          source: { type: "webhook", delivery: "d-1", event: "push" },
          outcome: { type: "unknown" },
        },
        "UTC",
      ),
    ).toContain("d-1");
  });

  it("names a webhook Trigger's format where a Schedule's cron goes, and gives it no next Fire", () => {
    const webhookTrigger: TriggerDefinition = {
      ...DEFINITION,
      source: { type: "webhook", format: "github" },
    };

    expect(triggerSourceWords(webhookTrigger)).toBe("Webhook · github");
    expect(nextFireOf(webhookTrigger, MONDAY)).toBeNull();
  });
});

describe("editing a webhook Trigger", () => {
  const webhookTrigger: TriggerDefinition = {
    ...DEFINITION,
    name: "CI failed",
    source: { type: "webhook", format: "github" },
    whenBusy: "start",
  };

  it("asks for no Schedule, whose source it never sends", () => {
    const draft = triggerDraftOf(webhookTrigger);

    expect(draft.scheduled).toBe(false);
    expect(triggerDraftProblems(draft).schedule).toBeNull();
    expect(triggerDraftReady(draft)).toBe(true);
    expect(previewFires(draft, MONDAY)).toEqual([]);
    expect(triggerPatch(webhookTrigger, { ...draft, name: "CI broke" })).toEqual({
      name: "CI broke",
    });
    expect(triggerPatch(webhookTrigger, { ...draft, cron: "@daily", zone: "UTC" })).toEqual({});
  });

  it("still sends a Schedule's changed source", () => {
    const draft = triggerDraftOf(DEFINITION);

    expect(draft.scheduled).toBe(true);
    expect(triggerPatch(DEFINITION, { ...draft, cron: "@daily" }).source).toEqual({
      type: "schedule",
      cron: "@daily",
      zone: "America/Chicago",
    });
  });
});

describe("a webhook Trigger's deliveries", () => {
  it("totals the refused and filtered deliveries by day, newest first", () => {
    expect(
      deliveryDays([
        { day: "2026-11-07", outcome: "filtered", n: 4 },
        { day: "2026-11-08", outcome: "unauthorized", n: 1 },
        { day: "2026-11-08", outcome: "filtered", n: 3 },
      ]),
    ).toEqual([
      {
        day: "2026-11-08",
        counts: [
          { outcome: "unauthorized", n: 1 },
          { outcome: "filtered", n: 3 },
        ],
      },
      { day: "2026-11-07", counts: [{ outcome: "filtered", n: 4 }] },
    ]);
    expect(deliveryDays([])).toEqual([]);
  });

  it("gives the URL the stage's origin, or the page's own where the stage has none", () => {
    expect(
      triggerUrl({ origin: "https://c.example", path: "/hooks/a/b", secret: "s" }, "http://x"),
    ).toBe("https://c.example/hooks/a/b");
    expect(triggerUrl({ path: "/hooks/a/b", secret: "s" }, "http://localhost:5173")).toBe(
      "http://localhost:5173/hooks/a/b",
    );
  });
});

describe("a webhook Trigger's form", () => {
  const MATCH = { event: ["workflow_run"], "workflow_run.conclusion": ["failure", "timed_out"] };

  const webhookTrigger: TriggerDefinition = {
    ...DEFINITION,
    name: "CI failed",
    source: { type: "webhook", format: "github", match: MATCH },
    whenBusy: "start",
  };

  /** A new webhook draft, ready but for its rows. */
  const hookDraft = (match: TriggerDraft["match"]): TriggerDraft =>
    withSource(
      { ...emptyTriggerDraft("default", "UTC"), name: "CI failed", message: "Look.", match },
      "webhook",
    );

  it("makes a webhook Trigger of the format and rows typed, each value trimmed, a blank row left out", () => {
    const draft = {
      ...hookDraft([
        { path: "event", values: "workflow_run" },
        { path: "workflow_run.conclusion", values: "failure\n  timed_out \r\n" },
        { path: "", values: "" },
      ]),
      format: "standard" as const,
    };

    expect(triggerDraftReady(draft)).toBe(true);
    expect(previewFires(draft, MONDAY)).toEqual([]);
    expect(triggerInput(draft)).toMatchObject({
      source: { type: "webhook", format: "standard", match: MATCH },
      whenBusy: "start",
    });
  });

  it("makes a webhook with no match when no row holds anything", () => {
    const draft = hookDraft([{ path: " ", values: "" }]);

    expect(triggerDraftReady(draft)).toBe(true);
    expect(triggerInput(draft).source).toEqual({ type: "webhook", format: "github" });
  });

  it("moves when_busy with the source only while it is the old source's default", () => {
    const draft = emptyTriggerDraft("default", "UTC");

    expect(withSource(draft, "webhook").whenBusy).toBe("start");
    expect(withSource(withSource(draft, "webhook"), "schedule").whenBusy).toBe("skip");
    // Chosen on purpose, it stays; a Workspace trigger waits either way.
    expect(withSource({ ...draft, whenBusy: "start" }, "webhook").whenBusy).toBe("start");
    expect(withSource(emptyTriggerDraft("default", "UTC", "ab12"), "webhook").whenBusy).toBe(
      "wait",
    );
  });

  it("holds the rows no match can come of: a path with no values, a value with no path, a path typed twice", () => {
    expect(matchRowsProblem([{ path: "a", values: "" }])).not.toBeNull();
    expect(matchRowsProblem([{ path: "", values: "x" }])).not.toBeNull();
    expect(
      matchRowsProblem([
        { path: "a", values: "x" },
        { path: " a", values: "y" },
      ]),
    ).not.toBeNull();
    expect(
      matchRowsProblem([
        { path: "a", values: "x" },
        { path: "", values: "" },
      ]),
    ).toBeNull();

    const draft = hookDraft([{ path: "a", values: "" }]);

    expect(triggerDraftProblems(draft).match).not.toBeNull();
    expect(triggerDraftReady(draft)).toBe(false);
  });

  it("sends only the match, once its rows changed, and null once none is left", () => {
    const draft = triggerDraftOf(webhookTrigger);

    expect(triggerPatch(webhookTrigger, draft)).toEqual({});
    expect(
      triggerPatch(webhookTrigger, { ...draft, match: [{ path: "event", values: "push" }] }),
    ).toEqual({ match: { event: ["push"] } });
    expect(triggerPatch(webhookTrigger, { ...draft, match: [] })).toEqual({ match: null });
    // A Trigger with no match yet takes the first one.
    expect(
      triggerPatch(
        { ...webhookTrigger, source: { type: "webhook", format: "github" } },
        { ...draft, match: [{ path: "event", values: "push" }] },
      ),
    ).toEqual({ match: { event: ["push"] } });
  });

  it("never rewrites a match the form can't hold as it was set, nor refuses an edit of another field for it", () => {
    // The agent's match can hold an empty value, a line break and a path with edge spaces.
    const odd: TriggerDefinition = {
      ...webhookTrigger,
      source: {
        type: "webhook",
        format: "github",
        match: { " body ": ["line\nbreak", ""], "": ["x"] },
      },
    };

    const draft = triggerDraftOf(odd);

    expect(triggerDraftProblems(draft, odd).match).toBeNull();
    expect(triggerDraftReady({ ...draft, name: "Renamed" }, odd)).toBe(true);
    expect(triggerPatch(odd, { ...draft, name: "Renamed" })).toEqual({ name: "Renamed" });

    // A new draft with the same rows is refused, and so is an edit of the rows themselves.
    expect(triggerDraftProblems(draft).match).not.toBeNull();
    expect(
      triggerDraftProblems({ ...draft, match: [{ path: "", values: "x" }, ...draft.match] }, odd)
        .match,
    ).not.toBeNull();
  });
});

describe("a GitHub-managed hook", () => {
  /** A new github webhook draft, ready but for its repo and events. */
  const hookDraft = (repo: string, events: string): TriggerDraft => ({
    ...withSource(
      { ...emptyTriggerDraft("default", "UTC"), name: "CI failed", message: "Look." },
      "webhook",
    ),
    repo,
    events,
  });

  const hooked: TriggerDefinition = {
    ...DEFINITION,
    name: "CI failed",
    source: {
      type: "webhook",
      format: "github",
      repo: "octo-org/octo-repo",
      events: ["workflow_run", "check_suite"],
    },
    whenBusy: "start",
  };

  it("makes a github webhook with the repo and events typed, the events split on commas and spaces", () => {
    const draft = hookDraft(" octo-org/octo-repo ", "workflow_run, check_suite\n");

    expect(triggerDraftReady(draft)).toBe(true);
    expect(triggerInput(draft).source).toEqual({
      type: "webhook",
      format: "github",
      repo: "octo-org/octo-repo",
      events: ["workflow_run", "check_suite"],
    });
    // Neither typed: a hook the owner makes.
    expect(triggerInput(hookDraft("", " ")).source).toEqual({ type: "webhook", format: "github" });
    // A Standard Webhooks sender has no GitHub hook: what was typed for one is not sent.
    expect(
      triggerInput({ ...hookDraft("octo-org/octo-repo", "push"), format: "standard" }).source,
    ).toEqual({ type: "webhook", format: "standard" });
  });

  it("holds a repo without events, events without a repo, and a repo not written owner/name", () => {
    for (const draft of [
      hookDraft("octo-org/octo-repo", ""),
      hookDraft("", "push"),
      hookDraft("octo-repo", "push"),
      hookDraft("octo-org/octo-repo", "*"),
    ]) {
      expect(triggerDraftProblems(draft).hook).not.toBeNull();
      expect(triggerDraftReady(draft)).toBe(false);
    }
  });

  it("opens a Trigger with its repo and events, which an edit never sends", () => {
    const draft = triggerDraftOf(hooked);

    expect(draft).toMatchObject({
      repo: "octo-org/octo-repo",
      events: "workflow_run, check_suite",
    });
    expect(triggerDraftProblems(draft, hooked).hook).toBeNull();
    expect(triggerPatch(hooked, { ...draft, repo: "other/repo", name: "CI broke" })).toEqual({
      name: "CI broke",
    });
    expect(triggerSourceWords(hooked)).toBe("Webhook · github · octo-org/octo-repo");
  });

  it("says where the hook is on the row: made, being made, or why GitHub refused it", () => {
    const repo = "octo-org/octo-repo";

    expect(githubHookWords({ repo, state: "ready" })).toBe(
      "GitHub hook on octo-org/octo-repo: made",
    );
    expect(githubHookWords({ repo, state: "pending" })).toBe(
      "GitHub hook on octo-org/octo-repo: not made yet, tried again soon",
    );
    expect(
      githubHookWords({
        repo,
        state: "failed",
        problem: { code: "refused", message: "GitHub refused to make the webhook" },
      }),
    ).toBe("GitHub hook on octo-org/octo-repo failed: GitHub refused to make the webhook");
  });
});

const NIGHTLY: TriggerDefinition = {
  ...DEFINITION,
  id: "w1",
  kind: "workspace",
  workspace: { id: "0f0f0f0f", branch: "cloudpid/0f0f0f0f" },
  name: "Nightly check",
  whenBusy: "wait",
};

describe("a waiting Fire", () => {
  it("says how many Fires were merged into one skipped for good", () => {
    expect(outcomeWords({ type: "skipped", reason: "overlap", merged: 2 }, "environment")).toBe(
      "Skipped: overlap, 2 merged",
    );
    expect(outcomeWords({ type: "skipped", reason: "overlap" }, "environment")).toBe(
      "Skipped: overlap",
    );
  });

  it("says since when it waits, and how many more Fires were merged into it", () => {
    const since = Date.parse("2025-01-06T15:00:00Z");

    expect(waitingWords({ since, merged: 0 }, "UTC")).toBe(
      `Waiting for the workspace to be idle (since ${fireTimeWords(since, "UTC")})`,
    );
    expect(waitingWords({ since, merged: 3 }, "UTC")).toBe(
      `Waiting for the workspace to be idle (since ${fireTimeWords(since, "UTC")}, 3 more merged)`,
    );
  });
});

describe("the Workspace trigger form", () => {
  it("starts waiting when busy, for the Workspace it names", () => {
    const draft = emptyTriggerDraft("default", "UTC", "0f0f0f0f");

    expect(draft).toMatchObject({ workspace: "0f0f0f0f", whenBusy: "wait" });
    expect(emptyTriggerDraft("default", "UTC")).toMatchObject({
      workspace: null,
      whenBusy: "skip",
    });
  });

  it("makes a Workspace trigger with no base, whatever the form held", () => {
    const draft = {
      ...emptyTriggerDraft("default", "UTC", "0f0f0f0f"),
      name: "Nightly check",
      message: "Check the build.",
      cron: "@daily",
      base: "develop",
      model: "anthropic/claude-sonnet-5-5",
    };

    expect(triggerInput(draft)).toEqual({
      kind: "workspace",
      workspace: "0f0f0f0f",
      name: "Nightly check",
      message: "Check the build.",
      source: { type: "schedule", cron: "@daily", zone: "UTC" },
      whenBusy: "wait",
      model: "anthropic/claude-sonnet-5-5",
    });
  });

  it("edits a Workspace trigger as opened, changing only the fields edited and never a base", () => {
    const draft = triggerDraftOf(NIGHTLY);

    expect(draft).toMatchObject({ workspace: "0f0f0f0f", whenBusy: "wait", base: "" });
    expect(triggerPatch(NIGHTLY, draft)).toEqual({});
    expect(triggerPatch(NIGHTLY, { ...draft, whenBusy: "skip", base: "develop" })).toEqual({
      whenBusy: "skip",
    });
  });

  it("offers wait only to a Workspace trigger", () => {
    expect(whenBusyChoices("workspace").map((choice) => choice.value)).toEqual([
      "wait",
      "skip",
      "start",
    ]);
    expect(whenBusyChoices("environment").map((choice) => choice.value)).toEqual(["skip", "start"]);
    expect(whenBusyOfText("environment", "wait")).toBe("skip");
    expect(whenBusyOfText("workspace", "wait")).toBe("wait");
    expect(whenBusyOfText("workspace", "nonsense")).toBe("wait");
  });

  it("names the Triggers that keep a Workspace", () => {
    const listed = [
      { definition: DEFINITION },
      { definition: NIGHTLY },
      { definition: { ...NIGHTLY, id: "w2", name: "Weekly sweep" } },
      {
        definition: { ...NIGHTLY, id: "w3", workspace: { id: "other", branch: "cloudpid/other" } },
      },
    ];

    expect(workspaceTriggersOf(listed, "0f0f0f0f").map((trigger) => trigger.id)).toEqual([
      "w1",
      "w2",
    ]);
    expect(workspaceTriggersOf(null, "0f0f0f0f")).toEqual([]);
    expect(triggerNames([{ name: "A" }])).toBe("“A”");
    expect(triggerNames([{ name: "A" }, { name: "B" }])).toBe("“A” and “B”");
    expect(triggerNames([{ name: "A" }, { name: "B" }, { name: "C" }])).toBe("“A”, “B” and “C”");
    expect(triggerNames([])).toBe("");
  });
});

describe("a Session trigger's form", () => {
  const { model: _model, ...environmentTrigger } = DEFINITION;

  const SESSION: TriggerDefinition = {
    ...environmentTrigger,
    kind: "session",
    session: "s-1",
    whenBusy: "queue",
  };

  it("falls back to a kind's default for a choice it doesn't take", () => {
    expect(whenBusyOfText("session", "steer")).toBe("steer");
    expect(whenBusyOfText("session", "start")).toBe("queue");
    expect(whenBusyOfText("environment", "queue")).toBe("skip");
  });

  it("holds the kind, and changes only the choice, Schedule, name and message", () => {
    const draft = triggerDraftOf(SESSION);

    expect(draft.kind).toBe("session");
    expect(triggerPatch(SESSION, draft)).toEqual({});
    expect(triggerPatch(SESSION, { ...draft, whenBusy: "steer", name: "Renamed" })).toEqual({
      name: "Renamed",
      whenBusy: "steer",
    });
  });

  it("never switches to a webhook: a Session trigger takes a Schedule only", () => {
    const draft = triggerDraftOf(SESSION);

    expect(withSource(draft, "webhook")).toBe(draft);
  });
});
