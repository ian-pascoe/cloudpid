/**
 * Roots (`docs/architecture/mcp-in-a-session.md` → Roots): a connection given `roots` declares the capability and answers
 * `roots/list` in both eras, on the call's stream in a Legacy exchange and in the `input_required` round on Modern; one
 * given none declares no `roots`, so a remote server is never offered any. `roots.listChanged` is never declared.
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  type FakeServer,
  fetchTo,
  legacyStatefulServer,
  modernServer,
  ROOTS_TOOL,
} from "./fakes.fixture.ts";
import { AGENT, completed, run, TARGET, testDeps } from "./core.fixture.ts";
import { connect } from "./index.ts";
import type { McpRoot } from "./types.ts";

const ROOTS: ReadonlyArray<McpRoot> = [
  { uri: "file:///workspace/app", name: "ian/app" },
  { uri: "file:///workspace/lib", name: "ian/lib" },
];

const servers: ReadonlyArray<readonly [string, () => FakeServer]> = [
  ["Modern", () => modernServer({ listMore: true })],
  ["Legacy stateful", () => legacyStatefulServer({ listMore: true })],
];

/** What a server told the `roots` tool the client answered, and the capabilities the client declared to it. */
const rootsOf = (server: FakeServer, roots: ReadonlyArray<McpRoot> | undefined) =>
  run(
    Effect.gen(function* () {
      const deps = testDeps(fetchTo(server), roots === undefined ? {} : { roots });
      const connection = yield* connect(TARGET, deps);

      return yield* connection.callTool({ tool: ROOTS_TOOL, arguments: {} }, AGENT);
    }),
  );

/** The capabilities the client declared: Legacy's `initialize`, or a Modern request's `_meta`. */
const declared = (server: FakeServer) => {
  const meta = server.received
    .map((received) => received.rpc?.params?.["_meta"])
    .find((found) => found !== undefined);

  const initialize = server.received.find((received) => received.rpc?.method === "initialize");

  return (
    initialize?.rpc?.params?.["capabilities"] ??
    // SAFETY: the SDK's own `_meta`, a JSON object whose capabilities key is read here.
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- a JSON object read by one key.
    (meta as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientCapabilities"]
  );
};

describe("Roots", () => {
  for (const [name, make] of servers) {
    describe(name, () => {
      it("answers roots/list from the roots it was given, declaring roots without listChanged", async () => {
        const server = make();
        const outcome = await rootsOf(server, ROOTS);

        expect(JSON.stringify(completed(outcome).value.content)).toContain("file:///workspace/app");
        expect(JSON.stringify(completed(outcome).value.content)).toContain("ian/lib");
        expect(declared(server)).toMatchObject({ roots: {} });
        // SAFETY: asserted just above to hold `roots`.
        expect((declared(server) as { roots: object }).roots).not.toHaveProperty("listChanged");
      });

      it("declares no roots to a connection given none", async () => {
        const server = make();

        await rootsOf(server, undefined).catch(() => undefined);

        expect(declared(server)).not.toHaveProperty("roots");
      });
    });
  }
});
