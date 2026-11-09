import { describe, expect, it } from "vitest";
import {
  FALLBACK_CATALOG,
  keepsSavedModel,
  type ModelCatalog,
  unservedModelLines,
  withServedModels,
} from "./model-catalog.ts";

const model = (id: string) => ({
  id,
  name: id,
  ownedBy: "anthropic",
  contextWindow: 1_000_000,
  maxTokens: 128_000,
});

/** A catalog the Registry read from the proxy: Fable 5.2 and Opus 5.5, and no longer Sonnet 5.5. */
const KNOWN: ModelCatalog = {
  models: [model("anthropic/claude-fable-5-2"), model("anthropic/claude-opus-5-5")],
  fetchedAt: 1,
};

describe("a write of a model", () => {
  it("is refused, by field, for each model the catalog does not list", () => {
    expect(
      unservedModelLines(
        {
          model: "anthropic/claude-sonnet-5-5",
          roles: {
            small: { model: "anthropic/claude-opus-5-5" },
            large: { model: "anthropic/gone", hint: "h" },
          },
        },
        KNOWN,
      ),
    ).toEqual([
      expect.stringMatching(/^model: anthropic\/claude-sonnet-5-5 is not one of the models/),
      expect.stringMatching(/^roles\.large\.model: anthropic\/gone is not one of the models/),
    ]);
  });

  it("checks only the models the write gives, not one the saved layer already holds at the field", () => {
    const saved = {
      model: "anthropic/claude-fable-5-2",
      roles: { small: { model: "anthropic/x" } },
    };

    expect(unservedModelLines(saved, FALLBACK_CATALOG, saved)).toEqual([]);
    expect(
      unservedModelLines(
        { ...saved, model: "anthropic/claude-fable-5-3" },
        FALLBACK_CATALOG,
        saved,
      ),
    ).toEqual([expect.stringMatching(/^model: anthropic\/claude-fable-5-3 /)]);
  });

  it("is checked against the fallback before the catalog was ever read", () => {
    expect(
      unservedModelLines({ model: "anthropic/claude-fable-5-2" }, FALLBACK_CATALOG),
    ).toHaveLength(1);
    expect(unservedModelLines({ model: "anthropic/claude-opus-5-5" }, FALLBACK_CATALOG)).toEqual(
      [],
    );
  });
});

describe("a read of saved models", () => {
  it("leaves out each model a catalog read from the proxy no longer lists, and keeps the rest", () => {
    const { document, dropped } = withServedModels(
      {
        model: "anthropic/claude-sonnet-5-5",
        thinkingLevel: "low",
        roles: {
          small: { model: "anthropic/claude-sonnet-5-5", hint: "mine" },
          large: { model: "anthropic/claude-fable-5-2" },
        },
      },
      KNOWN,
    );

    expect(document).toEqual({
      thinkingLevel: "low",
      roles: { small: { hint: "mine" }, large: { model: "anthropic/claude-fable-5-2" } },
    });
    expect(dropped).toEqual([
      "model: anthropic/claude-sonnet-5-5 is no longer served by the model proxy",
      "roles.small.model: anthropic/claude-sonnet-5-5 is no longer served by the model proxy",
    ]);
  });

  it("keeps every model while the catalog is the fallback, which says nothing of what the proxy serves", () => {
    const saved = { model: "anthropic/claude-fable-5-2" };

    expect(withServedModels(saved, FALLBACK_CATALOG)).toEqual({ document: saved, dropped: [] });
    expect(keepsSavedModel(FALLBACK_CATALOG, "anthropic/claude-fable-5-2")).toBe(true);
    expect(keepsSavedModel(KNOWN, "anthropic/claude-sonnet-5-5")).toBe(false);
    expect(keepsSavedModel(FALLBACK_CATALOG, "not-a-model")).toBe(false);
  });
});
