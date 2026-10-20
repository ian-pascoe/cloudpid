import { SUPPORTED_MODELS } from "@cloudpid/config";
import { describe, expect, it } from "vitest";
import { agentSelect, FOLLOW_DEFAULT, modelChoices, modelName } from "./models.ts";

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
