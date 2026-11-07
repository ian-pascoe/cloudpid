// @effect-diagnostics preferEffectArray:off -- expected lines, joined as the header joins them.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  FireOutcome,
  FireSource,
  fireText,
  fireTitle,
  renderFireHeader,
  scheduledFireKey,
  TriggerDefinition,
  MAX_TRIGGER_MESSAGE_BYTES,
  triggerMessageProblem,
  triggerNameProblem,
} from "./triggers.ts";

// The helper feeds future members to a schema, which is what it tests.
const read = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  input: unknown,
) => Effect.runSync(Schema.decodeUnknownEffect(schema)(input));

const at = (iso: string) => Date.parse(iso);

describe("triggerNameProblem", () => {
  it("takes 1 to 80 characters after trimming", () => {
    expect(triggerNameProblem("Weekly report")).toBeUndefined();
    expect(triggerNameProblem(` ${"x".repeat(80)} `)).toBeUndefined();
    expect(triggerNameProblem("  ")).toBeDefined();
    expect(triggerNameProblem("x".repeat(81))).toBeDefined();
  });
});

describe("triggerMessageProblem", () => {
  it("takes any words up to an input's bound, and refuses none or more", () => {
    expect(triggerMessageProblem("Summarize last week's PRs.")).toBeUndefined();
    expect(triggerMessageProblem("x".repeat(MAX_TRIGGER_MESSAGE_BYTES))).toBeUndefined();
    expect(triggerMessageProblem(" \n")).toBeDefined();
    expect(triggerMessageProblem("é".repeat(MAX_TRIGGER_MESSAGE_BYTES / 2 + 1))).toBeDefined();
  });
});

describe("a Fire's words", () => {
  it("title its Session by the Trigger's name and the time in its zone", () => {
    // Monday 2026-11-09 09:00 in Chicago (CST) is 15:00 UTC.
    expect(fireTitle("Weekly report", at("2026-11-09T15:00:00Z"), "America/Chicago")).toBe(
      "Weekly report · Mon, Nov 9, 2026, 9:00 AM",
    );
  });

  it("head the message with the Trigger's name and its scheduled and actual time", () => {
    const header = {
      name: "Weekly report",
      zone: "America/Chicago",
      scheduledAt: at("2026-11-09T15:00:00Z"),
      firedAt: at("2026-11-09T17:42:00Z"),
    };

    expect(renderFireHeader(header)).toBe(
      [
        '[cloudpid] Trigger "Weekly report" fired.',
        "Scheduled for: Mon, Nov 9, 2026, 9:00 AM CST.",
        "Fired at: Mon, Nov 9, 2026, 11:42 AM CST.",
      ].join("\n"),
    );
    expect(fireText(header, "Summarize last week's PRs.")).toBe(
      `${renderFireHeader(header)}\n\nSummarize last week's PRs.`,
    );
  });

  it("say the owner fired it, for Fire now", () => {
    expect(
      renderFireHeader({
        name: "Nightly",
        zone: "Europe/Stockholm",
        firedAt: at("2026-07-01T10:00:00Z"),
      }),
    ).toBe(
      [
        '[cloudpid] Trigger "Nightly" fired.',
        "Source: the owner's Fire now.",
        "Fired at: Wed, Jul 1, 2026, 12:00 PM GMT+2.",
      ].join("\n"),
    );
  });

  it("key a scheduled Fire by its Trigger and time, the same at every retry", () => {
    expect(scheduledFireKey("t1", at("2026-11-09T15:00:00Z"))).toBe("t1:2026-11-09T15:00:00.000Z");
  });
});

describe("a value a later slice added", () => {
  const definition = {
    id: "t1",
    revision: 3,
    kind: "environment",
    environment: "default",
    name: "Nightly",
    message: "Check CI",
    source: { type: "schedule", cron: "@daily", zone: "UTC" },
    whenBusy: "skip",
    paused: false,
    createdAt: 1,
    updatedAt: 2,
  };

  it("reads known members as they are", () => {
    expect(read(TriggerDefinition, definition)).toEqual(definition);
  });

  it("reads a kind, source, overlap or outcome it doesn't know as the fallback member", () => {
    expect(
      read(TriggerDefinition, {
        ...definition,
        kind: "workspace",
        source: { type: "webhook", format: "github" },
        whenBusy: "wait",
      }),
    ).toMatchObject({ kind: "unknown", source: { type: "unknown" }, whenBusy: "skip" });
    expect(read(FireSource, { type: "webhook", delivery: "d1" })).toEqual({ type: "unknown" });
    expect(read(FireOutcome, { type: "sent", delivery: "queued" })).toEqual({ type: "unknown" });
    expect(read(FireOutcome, { type: "skipped", reason: "coalesced" })).toEqual({
      type: "skipped",
      reason: "unknown",
    });
  });
});
