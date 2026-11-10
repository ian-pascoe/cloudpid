// The Model catalog's checks of saved models (`docs/architecture/overview.md` → Models and Settings, ADR-0052): a write
// refused for each model it gives that the catalog does not list, and a lenient read that leaves out what the proxy no
// longer serves, but nothing while the catalog is the fallback.
// @effect-diagnostics preferEffectArray:off
import { describe, expect, it } from "vitest";
import {
  FALLBACK_CATALOG,
  keepsSavedModel,
  type ModelCatalog,
  unservedModels,
  withNamedModels,
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

/** Settings in force, as far as their models go. */
const inForce = (main: string, small: string) => ({
  model: main,
  roles: { small: { model: small }, large: { model: "anthropic/claude-opus-5-5" } },
});

describe("a write of a model", () => {
  it("is refused, by field, for each model the catalog does not list", () => {
    expect(
      unservedModels(
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
      { field: "model", model: "anthropic/claude-sonnet-5-5" },
      { field: "roles.large.model", model: "anthropic/gone" },
    ]);
  });

  it("checks only the models the write changes, not one the Scope already runs with at the field", () => {
    const now = inForce("anthropic/claude-fable-5-2", "anthropic/x");

    // A Role's hint written alone, completed with the model it runs with (kept under the fallback).
    expect(
      unservedModels(
        { roles: { small: { model: "anthropic/x", hint: "new" } } },
        FALLBACK_CATALOG,
        now,
      ),
    ).toEqual([]);
    expect(unservedModels({ model: "anthropic/claude-fable-5-3" }, FALLBACK_CATALOG, now)).toEqual([
      { field: "model", model: "anthropic/claude-fable-5-3" },
    ]);
  });

  it("is checked against the fallback before the catalog was ever read", () => {
    expect(unservedModels({ model: "anthropic/claude-fable-5-2" }, FALLBACK_CATALOG)).toEqual([
      { field: "model", model: "anthropic/claude-fable-5-2" },
    ]);
    expect(unservedModels({ model: "anthropic/claude-opus-5-5" }, FALLBACK_CATALOG)).toEqual([]);
  });
});

describe("a read of saved models", () => {
  it("leaves out each model a catalog read from the proxy no longer lists, and keeps the rest", () => {
    const { document, unserved, dropped } = withServedModels(
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
    expect(unserved).toEqual([
      { field: "model", model: "anthropic/claude-sonnet-5-5" },
      { field: "roles.small.model", model: "anthropic/claude-sonnet-5-5" },
    ]);
    expect(dropped).toHaveLength(2);
  });

  it("keeps every model while the catalog is the fallback, which says nothing of what the proxy serves", () => {
    const saved = { model: "anthropic/claude-fable-5-2" };

    expect(withServedModels(saved, FALLBACK_CATALOG)).toEqual({
      document: saved,
      unserved: [],
      dropped: [],
    });
    expect(keepsSavedModel(FALLBACK_CATALOG, "anthropic/claude-fable-5-2")).toBe(true);
    expect(keepsSavedModel(KNOWN, "anthropic/claude-sonnet-5-5")).toBe(false);
    expect(keepsSavedModel(FALLBACK_CATALOG, "not-a-model")).toBe(false);
  });

  it("lists, under the fallback only, the models the settings run that it lacks, so a Session can run them", () => {
    const named = [
      "anthropic/claude-fable-5-2",
      "anthropic/claude-opus-5-5",
      "anthropic/claude-fable-5-2",
    ];

    expect(withNamedModels(FALLBACK_CATALOG, named).models.map((each) => each.id)).toEqual([
      ...FALLBACK_CATALOG.models.map((each) => each.id),
      "anthropic/claude-fable-5-2",
    ]);
    expect(withNamedModels(KNOWN, ["anthropic/claude-sonnet-5-5"])).toBe(KNOWN);
  });
});
