// docs/architecture/mcp-endpoint.md → Environment and Settings tools → After a change, and Notifications;
// docs/architecture/agent-changes.md → Reverting: `upkeepFor`, the upkeep read off a recorded change's Scope and field,
// one row per kind of change, each step handed to `background` and nothing run before it is.
// @effect-diagnostics missedPipeableOpportunity:off
import { SPARE_WORKSPACE_FIELD } from "@cloudpid/config";
import { GLOBAL_SCOPE, SETTINGS_SCOPE } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { type UpkeepChange, type UpkeepDeps, upkeepFor } from "./upkeep.ts";

/** The upkeep's stand-ins over two Environments, each step noted when it runs, and `background` holding each until drained. */
const upkeeping = () => {
  const calls: Array<string> = [];
  const pending: Array<Effect.Effect<void>> = [];

  const noted = (step: string) => Effect.sync(() => void calls.push(step));

  const deps: UpkeepDeps = {
    registry: {
      // SAFETY: the upkeep reads only the ids of the Environments listed.
      listEnvironments: () => Effect.succeed([{ id: "default" }, { id: "other" }] as never),
    },
    builds: { of: (environment) => noted(`builds.of:${environment}`) },
    spares: { of: (environment) => noted(`spares.of:${environment}`), all: noted("spares.all") },
    mcp: { sync: (environment) => noted(`mcp.sync:${environment ?? "all"}`) },
    background: (effect) => Effect.sync(() => void pending.push(effect)),
  };

  /** `upkeepFor` over `changes`: the steps run before `background` runs any, and those after. */
  const run = (changes: ReadonlyArray<UpkeepChange>) =>
    Effect.runSync(
      Effect.gen(function* () {
        yield* upkeepFor(deps, changes);

        const before = [...calls];

        yield* Effect.forEach(pending, (step) => step, { discard: true });

        return { before, after: calls };
      }),
    );

  return { run };
};

describe("the upkeep after a recorded change", () => {
  it.each([
    ["a variable", "default", "variables.API_URL", ["builds.of:default"]],
    [
      "a Container setting at Global",
      GLOBAL_SCOPE,
      "idleMinutes",
      ["builds.of:default", "builds.of:other"],
    ],
    ["a Build mark", "default", "secrets.API_KEY.build", ["builds.of:default"]],
    [
      "a Build mark at Global",
      GLOBAL_SCOPE,
      "secrets.API_KEY.build",
      ["builds.of:default", "builds.of:other"],
    ],
    ["an MCP server's key", "default", "mcp.servers.docs", ["mcp.sync:default"]],
    ["a Repo", "default", "repos.api", ["spares.of:default", "builds.of:default"]],
    [
      "the Spare Workspace setting",
      "default",
      SPARE_WORKSPACE_FIELD,
      ["spares.of:default", "builds.of:default"],
    ],
    [
      "the Spare Workspace setting at Global",
      GLOBAL_SCOPE,
      SPARE_WORKSPACE_FIELD,
      ["spares.all", "builds.of:default", "builds.of:other"],
    ],
    [
      "an MCP server's key at Global's Settings",
      SETTINGS_SCOPE,
      "mcp.servers.docs",
      ["mcp.sync:all"],
    ],
    ["a setting at Global's Settings", SETTINGS_SCOPE, "roles.small", []],
    ["a setting an Environment overrides", "default", "roles.small", []],
    ["a Skill", "default", "skills.release", []],
    ["a Trigger", "default", "triggers.nightly", []],
  ] as const)("of %s runs its steps in the background only", (_, scope, field, steps) => {
    const { before, after } = upkeeping().run([{ scope, field }]);

    expect(before).toEqual([]);
    expect(after).toEqual(steps);
  });

  it("runs each change's steps once, however many records name it", () => {
    const change = { scope: "default", field: "variables.API_URL" };

    expect(upkeeping().run([change, change, { ...change, field: "repos.api" }]).after).toEqual([
      "builds.of:default",
      "spares.of:default",
      "builds.of:default",
    ]);
  });
});
