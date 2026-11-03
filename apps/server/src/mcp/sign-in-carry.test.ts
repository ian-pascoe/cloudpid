// The main Worker's carry of an MCP sign-in change to the hosts (`docs/architecture/mcp-sign-in.md` → Tokens reach the host
// object): each Environment's host gets `apply({ kind: "sign_ins" })`, and a host that cannot be reached never fails the
// page or sign-out that caused it.
// @effect-diagnostics asyncFunction:off missedPipeableOpportunity:off
import { HostFailed, McpSignInsTaken } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { mcpSignInCarry } from "./sign-in-carry.ts";
import { mcpHostName } from "./name.ts";

const change = {
  change: "signed_in",
  server: "sentry",
  environments: [{ id: "env_1" }, { id: "env_2" }],
  revision: 5,
} as const;

describe("mcpSignInCarry", () => {
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
});
