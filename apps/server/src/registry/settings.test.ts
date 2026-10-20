import { DEFAULT_SETTINGS } from "@cloudpid/config";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { type DocumentStore, readSettings, SETTINGS_DOCUMENT, writeSettings } from "./settings.ts";

/** An in-memory document table, as the Registry store's. */
const documents = (
  initial: Record<string, string> = {},
): DocumentStore & { text: Map<string, string> } => {
  const text = new Map(Record.toEntries(initial));

  return {
    text,
    getDocument: (name) => text.get(name) ?? null,
    putDocument: (name, body) => void text.set(name, body),
  };
};

const saved = (store: DocumentStore, overrides: Schema.Json) => {
  const result = writeSettings(store, overrides, 1_000);

  if (Result.isFailure(result)) throw new Error(result.failure.message);

  return result.success;
};

describe("reading the settings", () => {
  it("gives the defaults and no overrides before anything is saved", () => {
    expect(readSettings(documents())).toEqual({ settings: DEFAULT_SETTINGS, overrides: {} });
  });

  it("gives the saved overrides over the defaults", () => {
    const store = documents();

    saved(store, { model: "anthropic/claude-sonnet-5-5", compaction: { enabled: false } });

    expect(readSettings(store)).toMatchObject({
      settings: {
        model: "anthropic/claude-sonnet-5-5",
        thinkingLevel: "high",
        compaction: { enabled: false, reserveTokens: 16_384 },
      },
      overrides: { model: "anthropic/claude-sonnet-5-5", compaction: { enabled: false } },
    });
  });

  it("falls back to the defaults, and says why, when the saved overrides no longer resolve", () => {
    // A setting a later release dropped, or a hand-edited row.
    const store = documents({ [SETTINGS_DOCUMENT]: '{"model":"anthropic/retired-model"}' });

    const state = readSettings(store);

    expect(state.settings).toEqual(DEFAULT_SETTINGS);
    expect(state.overrides).toEqual({});
    expect(state.problem).toContain("model");
  });

  it("falls back to the defaults when the saved text is not JSON", () => {
    const state = readSettings(documents({ [SETTINGS_DOCUMENT]: "{" }));

    expect(state.settings).toEqual(DEFAULT_SETTINGS);
    expect(state.problem).toBeDefined();
  });
});

describe("saving overrides", () => {
  it("replaces the saved overrides and answers the new settings", () => {
    const store = documents();

    saved(store, { thinkingLevel: "low" });

    const state = saved(store, { model: "anthropic/claude-haiku-5-5" });

    expect(state.settings).toMatchObject({
      model: "anthropic/claude-haiku-5-5",
      thinkingLevel: "high",
    });
    expect(readSettings(store).overrides).toEqual({ model: "anthropic/claude-haiku-5-5" });
  });

  it("keeps only what differs from the defaults", () => {
    const store = documents();

    const state = saved(store, { thinkingLevel: "high", compaction: { enabled: true } });

    expect(state.overrides).toEqual({});
  });

  it("rejects invalid overrides with a readable error and keeps what was saved", () => {
    const store = documents();

    saved(store, { thinkingLevel: "low" });

    const result = writeSettings(store, { compaction: { reserveTokens: -1 } }, 2_000);

    expect(Result.isFailure(result) && result.failure.message).toContain(
      "compaction.reserveTokens",
    );
    expect(readSettings(store).settings.thinkingLevel).toBe("low");
  });
});
