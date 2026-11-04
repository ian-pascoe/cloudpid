/**
 * `completion/complete` in the core (`docs/architecture/mcp-in-a-session.md` → Arguments and completions): the values a
 * server suggests for a prompt's or a resource template's argument, never asked of a server that does not declare the
 * capability, and cancelled with the request that is interrupted, in both eras.
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { OWNER, run, TARGET, testDeps } from "./core.fixture.ts";
import {
  type FakeOptions,
  type FakeServer,
  fetchTo,
  legacyStatefulServer,
  legacyStatelessServer,
  modernServer,
  rpcMethods,
} from "./fakes.fixture.ts";
import { connect } from "./index.ts";

const servers: ReadonlyArray<readonly [string, (options?: FakeOptions) => FakeServer]> = [
  ["Modern", modernServer],
  ["Legacy stateless", legacyStatelessServer],
  ["Legacy stateful", legacyStatefulServer],
];

describe.each(servers)("completion against a %s server", (_name, makeServer) => {
  it("completes a prompt's argument and a template's variable, with the other values as context", async () => {
    const seen: Array<unknown> = [];

    const server = makeServer({
      completions: {
        complete: (params) => {
          seen.push(params);

          return {
            values: [`${params.argument.value}-a`, `${params.argument.value}-b`],
            total: 7,
            hasMore: true,
          };
        },
      },
    });

    const { prompt, template } = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

        const prompt = yield* connection.complete(
          { type: "ref/prompt", name: "review_pr" },
          { name: "repo", value: "cl" },
          { arguments: { owner: "ian" } },
          OWNER,
        );

        const template = yield* connection.complete(
          { type: "ref/resource", uri: "repo://{owner}/{name}" },
          { name: "name", value: "" },
          undefined,
          OWNER,
        );

        return { prompt, template };
      }),
    );

    expect(prompt.value.completion).toEqual({ values: ["cl-a", "cl-b"], total: 7, hasMore: true });
    expect(prompt.cacheable).toBe(false);
    expect(template.value.completion.values).toEqual(["-a", "-b"]);
    expect(seen).toMatchObject([
      {
        ref: { type: "ref/prompt", name: "review_pr" },
        argument: { name: "repo", value: "cl" },
        context: { arguments: { owner: "ian" } },
      },
      { ref: { type: "ref/resource", uri: "repo://{owner}/{name}" } },
    ]);
  });

  it("does not ask a server that declares no completions", async () => {
    const server = makeServer();

    const failed = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

        return yield* Effect.flip(
          connection.complete(
            { type: "ref/prompt", name: "p" },
            { name: "a", value: "" },
            undefined,
            OWNER,
          ),
        );
      }),
    );

    expect(failed._tag).toBe("Unsupported");
    expect(rpcMethods(server)).not.toContain("completion/complete");
  });
});

// A Legacy server with no session has no way to be told: the request's connection is all it would see end.
describe.each([servers[0]!, servers[2]!])(
  "cancelling a completion against a %s server",
  (_name, makeServer) => {
    it("cancels the request of a completion that is interrupted", async () => {
      const cancelled: Array<string> = [];

      const server = makeServer({
        cancelled,
        completions: { hangs: true, complete: () => ({ values: [] }) },
      });

      const answered = await run(
        Effect.gen(function* () {
          const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

          return yield* connection
            .complete(
              { type: "ref/prompt", name: "p" },
              { name: "repo", value: "c" },
              undefined,
              OWNER,
            )
            .pipe(Effect.timeoutOption(150));
        }),
      );

      expect(answered._tag).toBe("None");
      await vi.waitFor(() => {
        expect(cancelled).toEqual(["repo"]);
      });
    });
  },
);
