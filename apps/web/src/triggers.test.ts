// @effect-diagnostics globalDate:off preferEffectArray:off -- expected times, read as ISO strings.
import { fireTimeWords, type TriggerDefinition } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  deliveryDays,
  emptyTriggerDraft,
  triggerUrl,
  lastDeliveryWords,
  matchOfRows,
  matchWords,
  pingWords,
  matchRowsProblem,
  nextFireOf,
  rowsOfMatch,
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
        { key: "t1:m", at: MONDAY, source: { type: "manual" }, outcome: { type: "unknown" } },
        "UTC",
      ),
    ).toBe("Fired by hand");
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
    ).toBe("Webhook delivery d-1 (push)");
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

describe("a webhook Trigger's row", () => {
  it("says its match, or that there is none", () => {
    expect(matchWords({ event: ["push", "pull_request"], "sender.login": ["octocat"] })).toBe(
      "Match: event is push or pull_request; sender.login is octocat",
    );
    expect(matchWords(undefined)).toBe("No match: every signed delivery starts a session");
    expect(matchWords({})).toBe("No match: every signed delivery starts a session");
  });

  it("totals the refused and filtered deliveries by day, newest first", () => {
    expect(
      deliveryDays([
        { day: "2026-11-07", outcome: "filtered", n: 4 },
        { day: "2026-11-08", outcome: "unauthorized", n: 1 },
        { day: "2026-11-08", outcome: "filtered", n: 3 },
        { day: "2026-11-06", outcome: "later_outcome", n: 2 },
      ]),
    ).toEqual([
      { day: "2026-11-08", words: "1 unauthorized (401), 3 filtered out by the match" },
      { day: "2026-11-07", words: "4 filtered out by the match" },
      { day: "2026-11-06", words: "2 later_outcome" },
    ]);
    expect(deliveryDays([])).toEqual([]);
  });

  it("says when the last delivery came and GitHub last reached it", () => {
    const at = Date.parse("2026-11-08T15:00:00Z");

    expect(lastDeliveryWords({ counts: [], lastDeliveryAt: null, pingAt: null }, "UTC")).toBe(
      "No delivery yet",
    );
    expect(lastDeliveryWords({ counts: [], lastDeliveryAt: at, pingAt: null }, "UTC")).toContain(
      "Last delivery: ",
    );
    expect(pingWords({ counts: [], lastDeliveryAt: null, pingAt: null }, "UTC")).toBeNull();
    expect(pingWords({ counts: [], lastDeliveryAt: null, pingAt: at }, "UTC")).toContain(
      "GitHub reached this trigger (",
    );
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

  it("makes a webhook Trigger of the format and rows typed, which starts a Session for each delivery", () => {
    const draft = withSource(
      {
        ...emptyTriggerDraft("default", "UTC"),
        name: "CI failed",
        message: "Look into it.",
        format: "standard",
        match: [
          { path: "event", values: "workflow_run" },
          { path: "workflow_run.conclusion", values: "failure\n  timed_out \r\n" },
          { path: "", values: "" },
        ],
      },
      "webhook",
    );

    expect(draft.whenBusy).toBe("start");
    expect(triggerDraftReady(draft)).toBe(true);
    expect(previewFires(draft, MONDAY)).toEqual([]);
    expect(triggerInput(draft)).toEqual({
      kind: "environment",
      environment: "default",
      name: "CI failed",
      message: "Look into it.",
      source: { type: "webhook", format: "standard", match: MATCH },
      whenBusy: "start",
    });
  });

  it("makes a webhook with no match when no row holds anything", () => {
    const draft = withSource(
      {
        ...emptyTriggerDraft("default", "UTC"),
        name: "All",
        message: "Go.",
        match: [{ path: " ", values: "" }],
      },
      "webhook",
    );

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

  it("refuses the rows the Registry would refuse, naming why", () => {
    expect(matchRowsProblem([{ path: "a", values: "" }])).toContain("lists no values");
    expect(matchRowsProblem([{ path: "", values: "x" }])).toContain("is not a path");
    expect(matchRowsProblem([{ path: "a..b", values: "x" }])).toContain("is not a path");
    expect(
      matchRowsProblem([
        { path: "a", values: "x" },
        { path: " a", values: "y" },
      ]),
    ).toContain("typed twice");
    expect(
      matchRowsProblem([
        { path: "a", values: "x" },
        { path: "", values: "" },
      ]),
    ).toBeNull();

    const draft = withSource(
      {
        ...emptyTriggerDraft("default", "UTC"),
        name: "n",
        message: "m",
        match: [{ path: "a", values: "" }],
      },
      "webhook",
    );

    expect(triggerDraftProblems(draft).match).toContain("lists no values");
    expect(triggerDraftReady(draft)).toBe(false);
  });

  it("holds an existing Trigger's match as rows, and back", () => {
    const draft = triggerDraftOf(webhookTrigger);

    expect(draft.format).toBe("github");
    expect(draft.match).toEqual([
      { path: "event", values: "workflow_run" },
      { path: "workflow_run.conclusion", values: "failure\ntimed_out" },
    ]);
    expect(matchOfRows(draft.match)).toEqual(MATCH);
    expect(rowsOfMatch(undefined)).toEqual([]);
  });

  it("sends only the match, once its rows changed, and null once none is left", () => {
    const draft = triggerDraftOf(webhookTrigger);

    // Unchanged rows change nothing.
    expect(triggerPatch(webhookTrigger, draft)).toEqual({});

    expect(
      triggerPatch(webhookTrigger, {
        ...draft,
        match: [{ path: "event", values: "push" }],
      }),
    ).toEqual({ match: { event: ["push"] } });
    expect(triggerPatch(webhookTrigger, { ...draft, match: [] })).toEqual({ match: null });
    expect(
      triggerPatch(
        { ...webhookTrigger, source: { type: "webhook", format: "github" } },
        { ...triggerDraftOf(webhookTrigger), match: [{ path: "event", values: "push" }] },
      ),
    ).toEqual({ match: { event: ["push"] } });
    // The values' order is the Trigger's: reordered values are a change.
    expect(
      triggerPatch(webhookTrigger, {
        ...draft,
        match: [
          { path: "event", values: "workflow_run" },
          { path: "workflow_run.conclusion", values: "timed_out\nfailure" },
        ],
      }),
    ).toEqual({
      match: { event: ["workflow_run"], "workflow_run.conclusion": ["timed_out", "failure"] },
    });
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

  it("trims each value, so the agent's untrimmed match is the only one that can hold edge spaces", () => {
    expect(matchOfRows([{ path: " a ", values: "  x \n\ty\t\n\n" }])).toEqual({ a: ["x", "y"] });
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
});
