// @effect-diagnostics preferEffectArray:off -- plain arrays of fixtures.
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_OVER_WINDOW_RATIO,
  contextOverWindow,
  type ImportDefaults,
  resolveImportAgent,
} from "./import-model.ts";

/** A catalog of the models the proxy serves, each with what `clampThinkingLevel` reads of it. */
const models = new Map([
  ["claude-sonnet-5-5", { reasoning: true }],
  ["claude-haiku-5-5", { reasoning: false }],
]);

const defaults: ImportDefaults = {
  catalog: {
    getModel: (provider, id) => {
      const known = provider === "anthropic" ? models.get(id) : undefined;

      // SAFETY: the fixture has the two fields `clampThinkingLevel` reads of a model.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions
      return known === undefined ? undefined : (known as unknown as Model<never>);
    },
  },
  agent: { model: { provider: "anthropic", modelId: "claude-opus-5-5" }, thinkingLevel: "medium" },
};

describe("the model an import runs with", () => {
  it("is the Environment's default, with nothing picked, when the Local agent named none", () => {
    expect(resolveImportAgent({}, defaults)).toEqual({
      agent: { model: defaults.agent.model, thinkingLevel: "medium" },
      pick: {},
      warnings: [],
    });
  });

  it("is the Local agent's own when the owner has it, and stays picked", () => {
    const resolved = resolveImportAgent({ model: "anthropic/claude-sonnet-5-5" }, defaults);

    expect(resolved.agent.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5-5" });
    expect(resolved.pick).toEqual({
      model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
    });
    expect(resolved.warnings).toEqual([]);
  });

  it.each(["openai/gpt-9", "not-a-model"])(
    "falls back to the default, not picked, with a warning that names %s",
    (model) => {
      const resolved = resolveImportAgent({ model }, defaults);

      expect(resolved.agent.model).toEqual(defaults.agent.model);
      expect(resolved.pick.model).toBeUndefined();
      expect(resolved.warnings).toHaveLength(1);
      expect(resolved.warnings[0]).toContain(model);
      expect(resolved.warnings[0]).toContain("anthropic/claude-opus-5-5");
    },
  );

  it("clamps the thinking level to what the model supports, and keeps it picked", () => {
    const resolved = resolveImportAgent(
      { model: "anthropic/claude-haiku-5-5", thinking: "high" },
      defaults,
    );

    expect(resolved.agent.thinkingLevel).toBe("off");
    expect(resolved.pick.thinkingLevel).toBe("off");
    expect(resolved.warnings).toEqual([]);

    expect(
      resolveImportAgent({ model: "anthropic/claude-sonnet-5-5", thinking: "low" }, defaults).agent
        .thinkingLevel,
    ).toBe("low");
  });

  it("leaves out a thinking level that is none", () => {
    const resolved = resolveImportAgent({ thinking: "ludicrous" }, defaults);

    expect(resolved.agent.thinkingLevel).toBe("medium");
    expect(resolved.pick).toEqual({});
  });
});

describe("a context over the window", () => {
  it("warns from the ratio of the window up, and not below", () => {
    const window = 200_000;

    expect(contextOverWindow(window * CONTEXT_OVER_WINDOW_RATIO - 1, window)).toBeUndefined();
    expect(contextOverWindow(window * CONTEXT_OVER_WINDOW_RATIO, window)).toContain(
      "context_over_window",
    );
    expect(contextOverWindow(window * CONTEXT_OVER_WINDOW_RATIO, window)).toContain("close to");
    expect(contextOverWindow(window + 1, window)).toContain("over the model's window");
  });

  it("says nothing of a model whose window is not known", () => {
    expect(contextOverWindow(1_000_000, 0)).toBeUndefined();
  });
});
