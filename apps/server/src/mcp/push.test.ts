// @effect-diagnostics asyncFunction:off preferEffectArray:off
// The main Worker's push of the MCP server set (`docs/architecture/mcp-configuration.md` → From the Registry to the host)
// over a scripted Registry and scripted hosts: which hosts are called, what is recorded as told, and that a push never
// fails the save that caused it.
import {
  HostUnsupported,
  McpApplied,
  type McpApply,
  type McpApplyResult,
  McpDestroyed,
  McpStale,
  type McpPush,
} from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { mcpPushes } from "./push.ts";

// SAFETY: a result of a tag this build does not know, as a newer host answers it: the type cannot name it, so the edge's
// decode (`readMcpApplyResult`) is what must read it.
const newerResult = JSON.parse('{"_tag":"Deferred","message":"later"}') as McpApplyResult;

/** A set to push, whose revision is its place in the list `scripted` is given. */
const push = (environment: string, hash: string, revision = 1): McpPush => ({
  environment,
  set: { kind: "set", hash, revision, entries: [] },
});

/** A Registry that has `pending` to push, and hosts that answer as `answers` say (by host name) or take the set. */
const scripted = (
  pending: ReadonlyArray<McpPush>,
  answers: Record<string, () => Effect.Effect<McpApplyResult>> = {},
  destroys: ReadonlyArray<string> = [],
) => {
  const asked: Array<string | undefined> = [];
  const applied: Array<readonly [string, McpApply]> = [];
  const pushed: Array<readonly [string, string, number]> = [];
  const destroyed: Array<string> = [];

  const pushes = mcpPushes({
    registry: () => ({
      mcpPending: ({ environment }) =>
        Effect.sync(() => {
          asked.push(environment);

          return {
            pushes: pending.filter(
              (one) => environment === undefined || one.environment === environment,
            ),
            destroys: destroys.filter((one) => environment === undefined || one === environment),
          };
        }),
      mcpPushed: ({ environment, hash, revision }) =>
        Effect.sync(() => {
          pushed.push([environment, hash, revision]);
        }),
      mcpDestroyed: ({ environment }) =>
        Effect.sync(() => {
          destroyed.push(environment);
        }),
    }),
    host: (name) => ({
      apply: (input) =>
        Effect.suspend(() => {
          applied.push([name, input]);

          return (
            answers[name] ??
            (() =>
              Effect.succeed<McpApplyResult>(
                input.kind === "set"
                  ? McpApplied.make({ hash: input.hash, changed: true })
                  : McpDestroyed.make({}),
              ))
          )();
        }),
    }),
  });

  return { pushes, asked, applied, pushed, destroyed };
};

describe("pushing the MCP server set", () => {
  it("calls the host of each Environment with a set to push, by its name, and records what it took", async () => {
    const world = scripted([push("a", "h1", 1), push("b", "h2", 2)]);

    await Effect.runPromise(world.pushes.sync(undefined));

    expect(world.asked).toEqual([undefined]);
    expect(world.applied.map(([name, one]) => [name, one.kind === "set" ? one.hash : ""])).toEqual([
      ["mcp:a", "h1"],
      ["mcp:b", "h2"],
    ]);
    expect(world.pushed).toEqual([
      ["a", "h1", 1],
      ["b", "h2", 2],
    ]);
  });

  it("asks about the one Environment it is told of", async () => {
    const world = scripted([push("a", "h1"), push("b", "h2")]);

    await Effect.runPromise(world.pushes.sync("b"));

    expect(world.asked).toEqual(["b"]);
    expect(world.applied.map(([name]) => name)).toEqual(["mcp:b"]);
  });

  it("calls no host when the Registry has nothing to push, so an Environment with no servers is never woken", async () => {
    const world = scripted([]);

    await Effect.runPromise(world.pushes.sync(undefined));
    await Effect.runPromise(world.pushes.sync("a"));

    expect(world.applied).toEqual([]);
    expect(world.pushed).toEqual([]);
  });

  it("records nothing for a host that refused the set, and goes on to the next", async () => {
    const world = scripted([push("a", "h1"), push("b", "h2")], {
      "mcp:a": () => Effect.succeed(HostUnsupported.make({ message: "no", op: "set" })),
    });

    await Effect.runPromise(world.pushes.sync(undefined));

    expect(world.applied).toHaveLength(2);
    expect(world.pushed).toEqual([["b", "h2", 1]]);
  });

  it("records the revision the set was pushed under, and nothing for a host that holds a later set (Stale)", async () => {
    const world = scripted([push("a", "h5", 5), push("b", "h6", 6)], {
      "mcp:a": () => Effect.succeed(McpStale.make({ hash: "h7", revision: 7 })),
    });

    await Effect.runPromise(world.pushes.sync(undefined));

    expect(world.pushed).toEqual([["b", "h6", 6]]);
  });

  it("wipes the host of a deleted Environment, and records it once the host answered", async () => {
    const world = scripted([push("a", "h1")], {}, ["gone", "stuck"]);

    await Effect.runPromise(world.pushes.sync(undefined));

    expect(world.applied.map(([name, one]) => [name, one.kind])).toEqual([
      ["mcp:a", "set"],
      ["mcp:gone", "destroy"],
      ["mcp:stuck", "destroy"],
    ]);
    expect(world.destroyed).toEqual(["gone", "stuck"]);
  });

  it("records no wipe for a host that did not answer, and goes on", async () => {
    const world = scripted(
      [],
      {
        "mcp:stuck": () => Effect.die(new Error("Network connection lost.")),
        "mcp:odd": () => Effect.succeed(HostUnsupported.make({ message: "no", op: "destroy" })),
      },
      ["stuck", "odd", "gone"],
    );

    await Effect.runPromise(world.pushes.sync(undefined));

    expect(world.applied).toHaveLength(3);
    expect(world.destroyed).toEqual(["gone"]);
  });

  it("reads a result of a tag it does not know as a failure, and a host that cannot be reached as one", async () => {
    const world = scripted([push("a", "h1"), push("b", "h2"), push("c", "h3")], {
      // A newer host answering with a result this Worker does not know.
      "mcp:a": () => Effect.succeed(newerResult),
      "mcp:b": () => Effect.die(new Error("Network connection lost.")),
    });

    await Effect.runPromise(world.pushes.sync(undefined));

    expect(world.pushed).toEqual([["c", "h3", 1]]);
  });

  it("never fails when the Registry cannot say what to push", async () => {
    const pushes = mcpPushes({
      registry: () => ({
        mcpPending: () => Effect.die(new Error("The Registry is gone")),
        mcpPushed: () => Effect.void,
        mcpDestroyed: () => Effect.void,
      }),
      host: () => ({ apply: () => Effect.die(new Error("never called")) }),
    });

    await expect(Effect.runPromise(pushes.sync(undefined))).resolves.toBeUndefined();
  });
});
