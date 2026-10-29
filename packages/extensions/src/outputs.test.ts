// The bounds the tools hold their values for programs to (`docs/architecture/agent-capabilities.md` → Values for
// programs): a list keeps its first items within its bound, a text its head, an Agent change leaves out a value too
// large, and a change at Global lists the first Environments it reached.
// @effect-diagnostics preferEffectArray:off
import type { AgentChange } from "@cloudpid/protocol";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { environmentChangeOutput } from "./environment-outputs.ts";
import {
  agentChangeOutput,
  boundItems,
  boundText,
  changesOutput,
  EnvironmentChangeOutput,
  MAX_CHANGE_VALUE_BYTES,
  MAX_PART_BYTES,
  outputSchema,
} from "./outputs.ts";
import { storedBytes } from "./stored-bytes.ts";

/** An Agent change of `field` from `before` to `after`. */
const change = (field: string, before: Schema.Json | null, after: Schema.Json | null) =>
  ({
    id: 1,
    scope: "*",
    at: 0,
    actor: "agent",
    session: "s",
    conversation: 0,
    tool: "environment_variable_set",
    reason: "test",
    field,
    before,
    after,
    reverts: null,
    revertedBy: null,
  }) satisfies AgentChange;

describe("the bounds of a value for programs", () => {
  it("keeps the first items of a list that fit, and says when it left some out", () => {
    const items = Array.from({ length: 10 }, (_, i) => `item-${i}`);

    expect(boundItems(items)).toEqual({ items, truncated: false });

    const cut = boundItems(items, storedBytes(items.slice(0, 3)));

    expect(cut).toEqual({ items: items.slice(0, 3), truncated: true });
    expect(boundItems(items, 1)).toEqual({ items: [], truncated: true });
  });

  it("cuts a text to its head, and says so", () => {
    expect(boundText("short")).toEqual({ text: "short", truncated: false });

    const long = boundText("a".repeat(MAX_PART_BYTES * 2));

    expect(long.truncated).toBe(true);
    expect(storedBytes(long.text)).toBeLessThanOrEqual(MAX_PART_BYTES);
  });

  it("leaves out an Agent change's value too large to give, and cuts a long list of changes", () => {
    const large = "x".repeat(MAX_CHANGE_VALUE_BYTES);

    expect(agentChangeOutput(change("setupScript", large, "echo"))).toMatchObject({
      before: null,
      before_truncated: true,
      after: "echo",
      after_truncated: false,
    });

    const many = Array.from({ length: 4000 }, (_, i) =>
      change(`variables.V${i}`, null, "v".repeat(100)),
    );

    const { changes, changes_truncated } = changesOutput(many);

    expect(changes_truncated).toBe(true);
    expect(changes.length).toBeLessThan(many.length);
    expect(storedBytes(changes)).toBeLessThanOrEqual(MAX_PART_BYTES);
  });

  it("lists the first Environments a change at Global reached, and says when it left some out", () => {
    const environments = Array.from({ length: 5000 }, (_, i) => ({
      id: `env-${i}`,
      name: `Environment ${i}`,
    }));

    const value = environmentChangeOutput({
      environment: { id: "*", name: "Global" },
      change: change("idleMinutes", 10, 20),
      own: true,
      global: { overriddenIn: environments, newBuilds: environments, own: true },
    });

    expect(Schema.is(EnvironmentChangeOutput)(value)).toBe(true);
    expect(value.global).toMatchObject({
      overridden_in_truncated: true,
      new_builds_truncated: true,
    });
    expect(value.global?.overridden_in.length).toBeLessThan(environments.length);
    expect(storedBytes(value)).toBeLessThan(MAX_PART_BYTES);
  });

  it("refuses an output schema that would leave a reference dangling", () => {
    expect(() => outputSchema(Schema.String.annotate({ identifier: "Named" }))).toThrow();
  });
});
