// The main Worker's carry of a completed sign-in's resolved requests to their Sessions (`docs/architecture/mcp-sign-in.md` →
// Sign-in requests → Learning the outcome): one call per Session, never a failure of the owner's page.
// @effect-diagnostics asyncFunction:off missedPipeableOpportunity:off strictEffectProvide:off
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it, vi } from "vitest";
import { mcpSignInSessions, SESSION_CARRY_TIMEOUT } from "./sign-in-sessions.ts";

const resolved = [
  { session: "s1", request: "signin-1" },
  { session: "s2", request: "signin-4" },
  { session: "s1", request: "signin-2" },
];

describe("mcpSignInSessions", () => {
  it("tells each Session once, with all of its resolved requests", async () => {
    const told: Array<[string, ReadonlyArray<string>]> = [];

    await Effect.runPromise(
      mcpSignInSessions({
        session: (id) => ({
          mcpSignInsResolved: ({ requests }) => {
            told.push([id, requests]);

            return Effect.succeed(requests.length);
          },
        }),
      }).carry(resolved),
    );

    expect(told).toEqual([
      ["s1", ["signin-1", "signin-2"]],
      ["s2", ["signin-4"]],
    ]);
  });

  it("calls no Session when no request resolved", async () => {
    const session = vi.fn();

    await Effect.runPromise(mcpSignInSessions({ session }).carry([]));

    expect(session).not.toHaveBeenCalled();
  });

  it("never fails: a Session that throws (an old deploy) is logged and the rest are still told", async () => {
    const reached = vi.fn();

    await Effect.runPromise(
      mcpSignInSessions({
        session: (id) => ({
          mcpSignInsResolved: ({ requests }) => {
            if (id === "s1") return Effect.die(new Error("no such method"));

            reached(id);

            return Effect.succeed(requests.length);
          },
        }),
      }).carry(resolved),
    );

    expect(reached).toHaveBeenCalledWith("s2");
  });

  it("gives up on a Session that does not answer, so the page is not held", async () => {
    const reached = vi.fn();

    await Effect.runPromise(
      Effect.gen(function* () {
        const carried = yield* mcpSignInSessions({
          session: (id) => ({
            mcpSignInsResolved: ({ requests }) => {
              if (id === "s1") return Effect.never;

              reached(id);

              return Effect.succeed(requests.length);
            },
          }),
        })
          .carry(resolved)
          .pipe(Effect.forkChild);

        yield* TestClock.adjust(SESSION_CARRY_TIMEOUT);
        yield* Fiber.join(carried);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(reached).toHaveBeenCalledWith("s2");
  });
});
