// @effect-diagnostics preferEffectArray:off
import { describe, expect, it } from "vitest";
import { chosenKeep, defaultKeep, KEEP_CHOICES, KEEP_VALUES, keepNote } from "./secret-keep.ts";

describe("the choice of what to do with the Secrets entered", () => {
  it("offers the Session, the Environment and Global, whatever the agent suggested", () => {
    expect(KEEP_VALUES).toEqual(["session", "environment", "all"]);
    expect(KEEP_CHOICES.map(({ label }) => label)).toEqual([
      "This Session only",
      "Keep for this Environment",
      "Keep at Global",
    ]);
  });

  it("starts on the agent's suggestion, else on the Session only", () => {
    expect(defaultKeep({})).toBe("session");
    expect(defaultKeep({ keep: "environment" })).toBe("environment");
    expect(defaultKeep({ keep: "all" })).toBe("all");
  });

  it("reads the owner's choice from the form, final over the suggestion", () => {
    expect(chosenKeep("all")).toBe("all");
    expect(chosenKeep("environment")).toBe("environment");
    expect(chosenKeep("session")).toBe("session");
    expect(chosenKeep(null)).toBe("session");
    expect(chosenKeep("everything")).toBe("session");
  });

  it("says what each choice does", () => {
    expect(keepNote("session", 15)).toContain("15 minutes");
    expect(keepNote("environment", 15)).toContain("does not expire");
    expect(keepNote("all", 15)).toContain("Global");
  });
});
