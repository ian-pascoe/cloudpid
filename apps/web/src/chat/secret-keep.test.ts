import { describe, expect, it } from "vite-plus/test";
import { chosenKeep } from "./secret-keep.ts";

describe("the choice of what to do with the Secrets entered", () => {
  it("reads no choice, or one it does not know, as the Session only", () => {
    expect(chosenKeep(null)).toBe("session");
    expect(chosenKeep("everything")).toBe("session");
  });
});
