// The main Worker's carry of an MCP sign-in change to the hosts (`docs/architecture/mcp-sign-in.md` → Tokens reach the host
// object): each Environment's host gets `apply({ kind: "sign_ins" })`, and a host that cannot be reached never fails the
// page or sign-out that caused it.
// @effect-diagnostics asyncFunction:off missedPipeableOpportunity:off strictEffectProvide:off
import { HostFailed, McpSignInsTaken } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it, vi } from "vitest";
import { CARRY_TIMEOUT, mcpSignInCarry } from "./sign-in-carry.ts";
import { mcpHostName } from "./name.ts";

const change = {
  change: "signed_in",
  server: "sentry",
  environments: [{ id: "env_1" }, { id: "env_2" }],
  revision: 5,
} as const;

describe("mcpSignInCarry", () => {
  it("passes a failed attempt's open requests and its problem on to the Sessions, and to no host", async () => {
    const told: Array<unknown> = [];
    const host = vi.fn();

    await Effect.runPromise(
      mcpSignInCarry({
        host,
        sessions: {
          carry: () => Effect.void,
          failed: (waiting, problem) =>
            Effect.sync(() => {
              told.push([waiting, problem]);
            }),
        },
      }).failed([{ session: "s1", request: "signin-1" }], "The code was refused"),
    );

    expect(told).toEqual([[[{ session: "s1", request: "signin-1" }], "The code was refused"]]);
    expect(host).not.toHaveBeenCalled();
  });

  it("passes the Sign-in requests a change resolved on to the Sessions, after the hosts", async () => {
    const order: Array<string | ReadonlyArray<unknown>> = [];
    const resolved = [{ session: "s1", request: "signin-1" }];

    await Effect.runPromise(
      mcpSignInCarry({
        host: () => ({
          apply: () => {
            order.push("host");

            return Effect.succeed(McpSignInsTaken.make({ servers: ["sentry"] }));
          },
        }),
        sessions: {
          carry: (told) =>
            Effect.sync(() => {
              order.push(told);
            }),
          failed: () => Effect.void,
        },
      }).carry({ ...change, resolved }),
    );

    expect(order).toEqual(["host", "host", resolved]);
  });

  it("applies the change to the host of each Environment that uses the sign-in", async () => {
    const applied: Array<[string, unknown]> = [];

    await Effect.runPromise(
      mcpSignInCarry({
        host: (name) => ({
          apply: (op) => {
            applied.push([name, op]);

            return Effect.succeed(McpSignInsTaken.make({ servers: ["sentry"] }));
          },
        }),
      }).carry(change),
    );

    const op = { kind: "sign_ins", change: "signed_in", servers: ["sentry"], revision: 5 };

    expect(applied).toEqual([
      [mcpHostName("env_1"), op],
      [mcpHostName("env_2"), op],
    ]);
  });

  it("never fails: a host that throws, or does not take it, is logged and the rest still get it", async () => {
    const reached = vi.fn();

    await Effect.runPromise(
      mcpSignInCarry({
        host: (name) => ({
          apply: () => {
            if (name === mcpHostName("env_1")) return Effect.die(new Error("down"));

            reached(name);

            return Effect.succeed(HostFailed.make({ message: "no" }));
          },
        }),
      }).carry(change),
    );

    expect(reached).toHaveBeenCalledWith(mcpHostName("env_2"));
  });

  it("gives up on a host that does not answer, so the page is not held, and the others still get it", async () => {
    const reached = vi.fn();

    await Effect.runPromise(
      Effect.gen(function* () {
        const carried = yield* mcpSignInCarry({
          host: (name) => ({
            apply: () => {
              if (name === mcpHostName("env_1")) return Effect.never;

              reached(name);

              return Effect.succeed(McpSignInsTaken.make({ servers: ["sentry"] }));
            },
          }),
        })
          .carry(change)
          .pipe(Effect.forkChild);

        yield* TestClock.adjust(CARRY_TIMEOUT);
        yield* Fiber.join(carried);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(reached).toHaveBeenCalledWith(mcpHostName("env_2"));
  });
});
