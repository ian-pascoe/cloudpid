import { SUPPORTED_MODELS } from "@cloudpid/config";
import { describe, expect, it } from "vitest";
import { modelChoices, modelName } from "./models.ts";

describe("model names", () => {
  it("drop the provider", () => {
    expect(modelName("anthropic/claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(modelName("claude-opus-5-5")).toBe("claude-opus-5-5");
  });
});

describe("the models to offer", () => {
  it("are the ones the settings accept", () => {
    expect(modelChoices(null)).toEqual(SUPPORTED_MODELS);
    expect(modelChoices("anthropic/claude-opus-5-5")).toEqual(SUPPORTED_MODELS);
  });

  it("include the model a Session runs when the settings no longer list it", () => {
    expect(modelChoices("anthropic/retired")).toEqual([...SUPPORTED_MODELS, "anthropic/retired"]);
  });
});
