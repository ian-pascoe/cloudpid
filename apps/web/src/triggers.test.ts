// @effect-diagnostics globalDate:off preferEffectArray:off -- expected times, read as ISO strings.
import type { TriggerDefinition } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  emptyTriggerDraft,
  nextFireOf,
  outcomeWords,
  previewFires,
  scheduleWords,
  sourceWords,
  triggerDraftOf,
  triggerDraftProblems,
  triggerDraftReady,
  triggerInput,
  triggerPatch,
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
    expect(outcomeWords({ type: "started", session: "s-1" })).toBe("Started a session");
    expect(outcomeWords({ type: "skipped", reason: "overlap" })).toBe("Skipped: overlap");
    expect(outcomeWords({ type: "failed", reason: "The Session refused it" })).toBe(
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
    ).toBe("Fire now");
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
    ).toBe("Webhook delivery d-1");
  });

  it("names a webhook Trigger's format where a Schedule's cron goes, and gives it no next Fire", () => {
    const hook: TriggerDefinition = {
      ...DEFINITION,
      source: { type: "webhook", format: "github" },
    };

    expect(scheduleWords(hook)).toBe("Webhook · github");
    expect(nextFireOf(hook, MONDAY)).toBeNull();
  });
});
