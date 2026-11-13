// @effect-diagnostics preferEffectArray:off
import type { CatalogModel, ModelCatalog } from "@cloudpid/config";
import { describe, expect, it } from "vite-plus/test";
import {
  agentSelect,
  FOLLOW_DEFAULT,
  isLevel,
  modelChoices,
  modelGroups,
  modelLabel,
  modelName,
  pickedChange,
  UNLISTED_GROUP,
} from "./models.ts";

const model = (id: string, name: string, ownedBy: string): CatalogModel => ({
  id,
  name,
  ownedBy,
  contextWindow: 1_000_000,
  maxTokens: 128_000,
});

/** A catalog as the proxy lists it: servers in no order, names that sort by their numbers. */
const CATALOG: ModelCatalog = {
  models: [
    model("anthropic/claude-fable-5-dd-5-tpg", "GPT-5", "opencode"),
    model("anthropic/claude-opus-5-10", "Claude Opus 5.10", "anthropic"),
    model("anthropic/claude-opus-5-5", "Claude Opus 5.5", "anthropic"),
    model("anthropic/claude-fable-5-dd-weiverp-pans-qbus", "SubQ Snap", "subquadratic"),
    model("anthropic/claude-fable-5-2", "Claude Fable 5.2", "antigravity"),
  ],
  fetchedAt: 1,
};

describe("a model and thinking level picked together", () => {
  it("ask for both, or to follow the default for either", () => {
    expect(pickedChange("anthropic/claude-opus-5-5", "high")).toEqual({
      model: "anthropic/claude-opus-5-5",
      thinkingLevel: "high",
    });
    expect(pickedChange(FOLLOW_DEFAULT, FOLLOW_DEFAULT)).toEqual({
      model: null,
      thinkingLevel: null,
    });
  });

  it("leave a value that is not a model's id as it is", () => {
    expect(pickedChange("claude-retired-1", "low")).toEqual({ thinkingLevel: "low" });
  });

  it("know the thinking levels", () => {
    expect(isLevel("xhigh")).toBe(true);
    expect(isLevel("huge")).toBe(false);
  });
});

describe("model names", () => {
  it("drop the provider", () => {
    expect(modelName("anthropic/claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(modelName("claude-opus-5-5")).toBe("claude-opus-5-5");
  });
});

describe("the models to offer", () => {
  it("are the catalog's, grouped by who serves them, anthropic first, each group by name", () => {
    expect(
      modelGroups(CATALOG, "anthropic/claude-opus-5-5").map((group) => [
        group.label,
        group.models.map((each) => each.name),
      ]),
    ).toEqual([
      ["anthropic", ["Claude Opus 5.5", "Claude Opus 5.10"]],
      ["antigravity", ["Claude Fable 5.2"]],
      ["opencode", ["GPT-5"]],
      ["subquadratic", ["SubQ Snap"]],
    ]);
    expect(modelChoices(CATALOG, null)).toEqual([
      "anthropic/claude-opus-5-5",
      "anthropic/claude-opus-5-10",
      "anthropic/claude-fable-5-2",
      "anthropic/claude-fable-5-dd-5-tpg",
      "anthropic/claude-fable-5-dd-weiverp-pans-qbus",
    ]);
  });

  it("include the value held when the catalog does not list it, in a group of its own", () => {
    expect(modelGroups(CATALOG, "anthropic/retired").at(-1)).toEqual({
      label: UNLISTED_GROUP,
      models: [
        {
          id: "anthropic/retired",
          name: "retired",
          ownedBy: "anthropic",
          contextWindow: 0,
          maxTokens: 0,
        },
      ],
    });
    expect(modelChoices(CATALOG, "anthropic/retired").at(-1)).toBe("anthropic/retired");
    expect(modelGroups(CATALOG, "")).toHaveLength(4);
  });

  it("are named by the catalog's display name, or by id when it does not list them", () => {
    expect(modelLabel(CATALOG, "anthropic/claude-fable-5-dd-5-tpg")).toBe("GPT-5");
    expect(modelLabel(CATALOG, "anthropic/retired")).toBe("retired");
  });
});

describe("a select over what a Session runs on", () => {
  it("shows the default option, named for what it resolves to, while the Session follows the default", () => {
    expect(agentSelect("anthropic/claude-opus-5-5", false, "claude-opus-5-5")).toEqual({
      value: FOLLOW_DEFAULT,
      defaultLabel: "Default (claude-opus-5-5)",
    });
    expect(agentSelect("low", false)).toEqual({
      value: FOLLOW_DEFAULT,
      defaultLabel: "Default (low)",
    });
  });

  it("shows the pick, and offers to go back to the default, once the Session picked", () => {
    expect(agentSelect("anthropic/claude-haiku-5-5", true, "claude-haiku-5-5")).toEqual({
      value: "anthropic/claude-haiku-5-5",
      defaultLabel: "Use the default",
    });
  });

  it("has nothing to show before the Session says what it runs on", () => {
    expect(agentSelect(null, false)).toEqual({ value: FOLLOW_DEFAULT, defaultLabel: "…" });
  });
});
