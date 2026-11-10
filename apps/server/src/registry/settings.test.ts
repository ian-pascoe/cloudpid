import { DEFAULT_SETTINGS, FALLBACK_CATALOG } from "@cloudpid/config";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { MODEL_CATALOG_DOCUMENT } from "./model-catalog.ts";
import { type DocumentStore, readSettings, SETTINGS_DOCUMENT, writeSettings } from "./settings.ts";

/** A Model catalog read from the proxy, listing the built-in models: a saved model it lacks is left out on read. */
const FETCHED_CATALOG = JSON.stringify({ ...FALLBACK_CATALOG, fetchedAt: 1 });

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
    expect(readSettings(documents())).toEqual({
      settings: DEFAULT_SETTINGS,
      overrides: {},
      mcpProblems: [],
    });
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

  it("drops only the saved overrides that no longer resolve, keeps the others, and says which", () => {
    // A model the proxy no longer lists, beside overrides that are still valid.
    const store = documents({
      [MODEL_CATALOG_DOCUMENT]: FETCHED_CATALOG,
      [SETTINGS_DOCUMENT]:
        '{"model":"anthropic/retired-model","thinkingLevel":"low","roles":{"xlarge":{"model":"anthropic/retired-model","hint":"Mine"}}}',
    });

    const state = readSettings(store);

    expect(state.settings.model).toBe(DEFAULT_SETTINGS.model);
    expect(state.settings.thinkingLevel).toBe("low");
    expect(state.settings.roles.xlarge).toEqual({
      model: "anthropic/claude-fable-5-1",
      hint: "Mine",
    });
    expect(state.overrides).toEqual({ thinkingLevel: "low", roles: { xlarge: { hint: "Mine" } } });
    expect(state.problem).toContain("model:");
    expect(state.problem).toContain("roles.xlarge.model");
  });

  it("says an MCP entry it left out structured too, for the page's row of the server, and an empty list when none", () => {
    const store = documents({
      [SETTINGS_DOCUMENT]:
        '{"mcp":{"servers":{"linear":{"command":"x","auth":"y"},"good":{"command":"z"}}}}',
    });

    const state = readSettings(store);

    expect(Record.keys(state.settings.mcp.servers)).toEqual(["good"]);
    expect(state.mcpProblems).toEqual([
      { source: "global", name: "linear", keys: ["auth"], message: expect.any(String), reset: [] },
    ]);
    expect(state.problem).toContain("mcp.servers.linear.auth");
    // With nothing left out it still says so, so that a page tells none from an older Registry that does not say.
    expect(
      readSettings(documents({ [SETTINGS_DOCUMENT]: '{"thinkingLevel":"low"}' })).mcpProblems,
    ).toEqual([]);
  });

  it("saves the survivors, and nothing of what was dropped, when the form saves them back", () => {
    const store = documents({
      [MODEL_CATALOG_DOCUMENT]: FETCHED_CATALOG,
      [SETTINGS_DOCUMENT]: '{"model":"anthropic/retired-model","thinkingLevel":"low"}',
    });

    const { overrides } = readSettings(store);

    saved(store, overrides);

    expect(readSettings(store)).toEqual({
      settings: { ...DEFAULT_SETTINGS, thinkingLevel: "low" },
      overrides: { thinkingLevel: "low" },
      mcpProblems: [],
    });
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
