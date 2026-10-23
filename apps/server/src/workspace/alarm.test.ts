// The Workspace DO's shared alarm: a step that fails does not keep the later ones from running.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { describe, expect, it } from "vitest";
import { runAlarmSteps } from "./alarm.ts";

describe("the alarm's steps", () => {
  it("runs each in order", async () => {
    const ran: string[] = [];

    await runAlarmSteps(
      ["spare", "build", "idle"].map((name) => [name, async () => void ran.push(name)] as const),
      () => undefined,
    );

    expect(ran).toEqual(["spare", "build", "idle"]);
  });

  it("runs the idle stop after a spare's and a Build's step threw, logs each, then throws the first", async () => {
    const ran: string[] = [];
    const warnings: string[] = [];
    const first = new Error("spare storage failed");

    const alarm = runAlarmSteps(
      [
        [
          "spare",
          async () => {
            throw first;
          },
        ],
        [
          "build",
          async () => {
            throw new Error("build storage failed");
          },
        ],
        ["idle", async () => void ran.push("idle")],
      ],
      (message) => warnings.push(message),
    );

    await expect(alarm).rejects.toBe(first);
    expect(ran).toEqual(["idle"]);
    expect(warnings).toEqual([
      "workspace.alarm: the spare step failed: spare storage failed",
      "workspace.alarm: the build step failed: build storage failed",
    ]);
  });
});
