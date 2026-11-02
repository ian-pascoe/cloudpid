// @effect-diagnostics asyncFunction:off preferEffectArray:off
// The main Worker's push of the MCP server set (`docs/architecture/mcp-configuration.md` → From the Registry to the host)
// over a scripted Registry and scripted hosts: which hosts are called, what is recorded as told, and that a push never
// fails the save that caused it.
import {
  HostUnsupported,
  McpApplied,
  type McpApplyResult,
  type McpApplySet,
  type McpPush,
} from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { mcpPushes } from "./push.ts";

// SAFETY: a result of a tag this build does not know, as a newer host answers it: the type cannot name it, so the edge's
// decode (`readMcpApplyResult`) is what must read it.
const newerResult = JSON.parse('{"_tag":"Deferred","message":"later"}') as McpApplyResult;

const set = (hash: string): McpApplySet => ({ kind: "set", hash, entries: [] });

const push = (environment: string, hash: string): McpPush => ({ environment, set: set(hash) });

/** A Registry that has `pending` to push, and hosts that answer as `answers` say (by host name) or take the set. */
const scripted = (
  pending: ReadonlyArray<McpPush>,
  answers: Record<string, () => Effect.Effect<McpApplyResult>> = {},
) => {
  const asked: Array<string | undefined> = [];
  const applied: Array<readonly [string, McpApplySet]> = [];
  const pushed: Array<readonly [string, string]> = [];

  const pushes = mcpPushes({
    registry: () => ({
      mcpPending: ({ environment }) =>
        Effect.sync(() => {
          asked.push(environment);

          return pending.filter(
            (one) => environment === undefined || one.environment === environment,
          );
        }),
      mcpPushed: ({ environment, hash }) =>
        Effect.sync(() => {
          pushed.push([environment, hash]);
        }),
    }),
    host: (name) => ({
      apply: (input) =>
        Effect.suspend(() => {
          applied.push([name, input]);

          return (
            answers[name] ??
            (() =>
              Effect.succeed<McpApplyResult>(McpApplied.make({ hash: input.hash, changed: true })))
          )();
        }),
    }),
  });

  return { pushes, asked, applied, pushed };
};

describe("pushing the MCP server set", () => {
  it("calls the host of each Environment with a set to push, by its name, and records what it took", async () => {
    const world = scripted([push("a", "h1"), push("b", "h2")]);

    await Effect.runPromise(world.pushes.sync(undefined));

    expect(world.asked).toEqual([undefined]);
    expect(world.applied.map(([name, one]) => [name, one.hash])).toEqual([
      ["mcp:a", "h1"],
      ["mcp:b", "h2"],
    ]);
    expect(world.pushed).toEqual([
      ["a", "h1"],
      ["b", "h2"],
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
    expect(world.pushed).toEqual([["b", "h2"]]);
  });

  it("reads a result of a tag it does not know as a failure, and a host that cannot be reached as one", async () => {
    const world = scripted([push("a", "h1"), push("b", "h2"), push("c", "h3")], {
      // A newer host answering with a result this Worker does not know.
      "mcp:a": () => Effect.succeed(newerResult),
      "mcp:b": () => Effect.die(new Error("Network connection lost.")),
    });

    await Effect.runPromise(world.pushes.sync(undefined));

    expect(world.pushed).toEqual([["c", "h3"]]);
  });

  it("never fails when the Registry cannot say what to push", async () => {
    const pushes = mcpPushes({
      registry: () => ({
        mcpPending: () => Effect.die(new Error("The Registry is gone")),
        mcpPushed: () => Effect.void,
      }),
      host: () => ({ apply: () => Effect.die(new Error("never called")) }),
    });

    await expect(Effect.runPromise(pushes.sync(undefined))).resolves.toBeUndefined();
  });
});
