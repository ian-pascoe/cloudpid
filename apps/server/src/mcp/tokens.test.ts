// The host's token cache (`docs/architecture/mcp-sign-in.md` → Tokens reach the host object): what it keeps and for how
// long, the one retry after a 401 that asks the Registry again with the refused token as `stale`, and the binding of a token
// to its sign-in's resource.
// @effect-diagnostics asyncFunction:off missedPipeableOpportunity:off strictEffectProvide:off
import type { McpAccessTokenAnswer, McpAccessTokenInput, McpSignInNote } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";
import {
  McpRegistryPort,
  McpRegistryUnavailable,
  type McpRegistryPortService,
} from "./registry-port.ts";
import {
  McpTokens,
  NO_EXPIRY_HOLD_MS,
  TOKEN_MARGIN_MS,
  type McpTokensService,
  engineAuth,
  withinResource,
} from "./tokens.ts";

const RESOURCE = "https://mcp.example.com/mcp";
const FOR = { environment: "env", server: "linear", url: RESOURCE };

const ok = (
  token: string,
  extra: { expiresAt?: number; resource?: string; note?: McpSignInNote } = {},
): McpAccessTokenAnswer => ({ status: "ok", token, resource: RESOURCE, signIn: "grant", ...extra });

type Script = ReadonlyArray<McpAccessTokenAnswer | "down">;

/** Run `body` over a fresh cache backed by a Registry that answers from `script`, one answer per ask (the last repeats). */
const run = <A>(
  script: Script,
  body: (tokens: McpTokensService, asked: ReadonlyArray<McpAccessTokenInput>) => Effect.Effect<A>,
) => {
  const asked: Array<McpAccessTokenInput> = [];

  const port: McpRegistryPortService = {
    serverSet: () => Effect.die("not asked"),
    serverValues: () => Effect.die("not asked"),
    reportAuth: () => Effect.die("not asked"),
    accessToken: (input) => {
      asked.push(input);

      const answer = script[Math.min(asked.length - 1, script.length - 1)];

      return answer === "down" || answer === undefined
        ? Effect.fail(McpRegistryUnavailable.make({ message: "down" }))
        : Effect.succeed(answer);
    },
  };

  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* McpTokens, asked);
    }).pipe(
      Effect.provide(McpTokens.layer),
      Effect.provideService(McpRegistryPort, port),
      Effect.provide(TestClock.layer()),
    ),
  );
};

describe("withinResource", () => {
  it.each([
    ["https://mcp.example.com/mcp", RESOURCE, true],
    ["https://mcp.example.com/mcp/sse", RESOURCE, true],
    ["https://mcp.example.com/mcp-other", RESOURCE, false],
    ["https://mcp.example.com/other", RESOURCE, false],
    ["https://evil.example.com/mcp", RESOURCE, false],
    ["http://mcp.example.com/mcp", RESOURCE, false],
    ["https://mcp.example.com:8443/mcp", RESOURCE, false],
    ["https://mcp.example.com/anything", "https://mcp.example.com/", true],
    ["not a url", RESOURCE, false],
    [RESOURCE, "not a url", false],
  ])("%s within %s: %s", (url, resource, within) => {
    expect(withinResource(url, resource)).toBe(within);
  });
});

describe("the cache", () => {
  it("asks the Registry once while the token stands, then again after it is close to expiring", () =>
    run([ok("t1", { expiresAt: 10 * TOKEN_MARGIN_MS }), ok("t2")], (tokens, asked) =>
      Effect.gen(function* () {
        expect(yield* tokens.access(FOR)).toMatchObject({ kind: "token", token: "t1" });

        yield* TestClock.setTime(9 * TOKEN_MARGIN_MS - 1);

        expect(yield* tokens.access(FOR)).toMatchObject({ token: "t1" });
        expect(asked).toHaveLength(1);

        yield* TestClock.setTime(9 * TOKEN_MARGIN_MS);

        expect(yield* tokens.access(FOR)).toMatchObject({ token: "t2" });
        expect(asked).toHaveLength(2);
      }),
    ));

  it("holds a token with no lifetime for fifteen minutes", () =>
    run([ok("t1"), ok("t2")], (tokens, asked) =>
      Effect.gen(function* () {
        yield* tokens.access(FOR);
        yield* TestClock.setTime(NO_EXPIRY_HOLD_MS - 1);
        yield* tokens.access(FOR);

        expect(asked).toHaveLength(1);

        yield* TestClock.setTime(NO_EXPIRY_HOLD_MS);

        expect(yield* tokens.access(FOR)).toMatchObject({ token: "t2" });
      }),
    ));

  it("keeps a note with the token it serves", () =>
    run([ok("t1", { note: { status: "refresh_failing", reason: "later" } })], (tokens) =>
      Effect.gen(function* () {
        const first = yield* tokens.access(FOR);
        const second = yield* tokens.access(FOR);

        expect(first).toMatchObject({ note: { status: "refresh_failing" } });
        expect(second).toEqual(first);
      }),
    ));

  it("asks again for a server at another URL, and for another server", () =>
    run([ok("t1")], (tokens, asked) =>
      Effect.gen(function* () {
        yield* tokens.access(FOR);
        yield* tokens.access({ ...FOR, url: `${RESOURCE}/sse` });
        yield* tokens.access({ ...FOR, server: "sentry" });

        expect(asked).toHaveLength(3);
      }),
    ));

  it("drops what is named, or all of it", () =>
    run([ok("t1")], (tokens, asked) =>
      Effect.gen(function* () {
        yield* tokens.access(FOR);
        yield* tokens.access({ ...FOR, server: "sentry" });
        yield* tokens.drop(["linear"]);
        yield* tokens.access(FOR);
        yield* tokens.access({ ...FOR, server: "sentry" });

        expect(asked).toHaveLength(3);

        yield* tokens.drop();
        yield* tokens.access(FOR);

        expect(asked).toHaveLength(4);
      }),
    ));
});

describe("what is not a token", () => {
  it("is the sign-in's status and why, and is never cached", () =>
    run([{ status: "step_up", reason: "needs more", scope: "write" }], (tokens, asked) =>
      Effect.gen(function* () {
        const expected = {
          kind: "none",
          status: "step_up",
          reason: "needs more",
          scope: "write",
        };

        expect(yield* tokens.access(FOR)).toEqual(expected);
        expect(yield* tokens.access(FOR)).toEqual(expected);
        expect(asked).toHaveLength(2);
      }),
    ));

  it("is a failure to say so when the Registry cannot be asked, with nothing of the call in it", () =>
    run(["down"], (tokens) =>
      Effect.gen(function* () {
        expect(yield* tokens.access(FOR)).toEqual({
          kind: "unreachable",
          message: "The Registry could not be asked for the server's sign-in",
        });
      }),
    ));

  it("is unavailable for a status this build does not know", () =>
    run([{ status: "consent_pending" }], (tokens) =>
      Effect.gen(function* () {
        expect(yield* tokens.access(FOR)).toMatchObject({ kind: "none", status: "unavailable" });
      }),
    ));

  it("is unavailable, and the token is not kept, for a server outside its sign-in's resource", () =>
    run([ok("t1", { resource: "https://other.example.com/mcp" })], (tokens, asked) =>
      Effect.gen(function* () {
        const access = yield* tokens.access(FOR);

        expect(access).toMatchObject({ kind: "none", status: "unavailable" });
        expect(access).not.toHaveProperty("token");

        yield* tokens.access(FOR);

        expect(asked).toHaveLength(2);
      }),
    ));
});

describe("a refused token", () => {
  it("is dropped and the Registry is asked again with it as stale", () =>
    run([ok("old"), ok("new")], (tokens, asked) =>
      Effect.gen(function* () {
        yield* tokens.access(FOR);

        expect(yield* tokens.refused({ ...FOR, token: "old" })).toMatchObject({ token: "new" });
        expect(asked[1]).toEqual({ environment: "env", server: "linear", stale: "old" });
        // The new one is what the cache holds now.
        expect(yield* tokens.access(FOR)).toMatchObject({ token: "new" });
        expect(asked).toHaveLength(2);
      }),
    ));

  it("leaves a newer token that another request cached", () =>
    run([ok("newer")], (tokens) =>
      Effect.gen(function* () {
        yield* tokens.access(FOR);
        // `old` was refused after `newer` was cached; the Registry is still told, the cache answers `newer` after.
        yield* tokens.refused({ ...FOR, token: "old" });

        expect(yield* tokens.access(FOR)).toMatchObject({ token: "newer" });
      }),
    ));
});

describe("engineAuth", () => {
  it("gives the token, and on a stale ask tells the Registry which token the server refused", () =>
    run([ok("old"), ok("new")], (tokens, asked) =>
      Effect.gen(function* () {
        const auth = engineAuth(tokens, FOR);

        expect(yield* auth(false)).toBe("old");
        expect(yield* auth(true)).toBe("new");
        expect(asked[1]).toMatchObject({ stale: "old" });
      }),
    ));

  it("gives no token when there is none, and asks without stale when it never gave one", () =>
    run([{ status: "required", reason: "sign in" }], (tokens, asked) =>
      Effect.gen(function* () {
        const auth = engineAuth(tokens, FOR);

        expect(yield* auth(false)).toBeUndefined();
        expect(yield* auth(true)).toBeUndefined();
        expect(asked).toEqual([
          { environment: "env", server: "linear" },
          { environment: "env", server: "linear" },
        ]);
      }),
    ));
});
