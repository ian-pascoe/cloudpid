// workerd's Durable Object APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
// No resolved Secret reaches the host (`docs/architecture/mcp-configuration.md` → From the Registry to the host): a set
// built from a server whose header is `${TOKEN}`, while the Secret `TOKEN` exists, holds the name only: in its hashes,
// in what the main Worker logs when a push goes wrong, and in the host's tables.
import type { McpApplyResult, McpPush } from "@cloudpid/mcp/types";
import { env } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { mcpServerSetOf, resolvedMcpServers } from "../registry/mcp-set.ts";
import { resolveMcpServerValues } from "../registry/mcp-values.ts";
import type { TestMcpHost } from "./host.fixture.ts";
import { mcpPushes } from "./push.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_HOSTS: DurableObjectNamespace<TestMcpHost>;
    }
  }
}

const SECRET = "s3cret-value-9f2c";

const global: Schema.Json = {
  mcp: {
    servers: {
      linear: {
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer ${TOKEN}" },
      },
    },
  },
};

describe("a Secret an MCP server names", () => {
  it("is in no hash, no log line and no table of the host: only its name is", async () => {
    const layers = { global, overrides: {}, repos: [] };
    const [resolved] = resolvedMcpServers(layers);

    if (resolved === undefined) throw new Error("No server");

    // The Secret resolves where the Registry answers `mcpServerValues`, and only into that answer.
    expect(
      JSON.stringify(
        resolveMcpServerValues(resolved, { secrets: { TOKEN: SECRET }, variables: {} }),
      ),
    ).toContain(SECRET);

    const content = mcpServerSetOf(layers);
    const set: McpPush["set"] = { ...content, revision: 1 };

    expect(JSON.stringify(set)).not.toContain(SECRET);
    expect(JSON.stringify(set)).toContain("Bearer ${TOKEN}");

    const host = env.MCP_HOSTS.getByName("mcp:secrets-a");
    const logged: Array<string> = [];

    const collector = Logger.make((options) => {
      logged.push(`${JSON.stringify(options.message)} ${Cause.pretty(options.cause)}`);
    });

    // One host takes the set; another, which fails, is logged about.
    const world = mcpPushes({
      registry: () => ({
        mcpPending: () =>
          Effect.succeed({
            pushes: [
              { environment: "secrets-a", set },
              { environment: "secrets-b", set },
            ],
            destroys: [],
          }),
        mcpPushed: () => Effect.void,
        mcpDestroyed: () => Effect.void,
      }),
      host: (name) => ({
        apply: (input) =>
          name === "mcp:secrets-a"
            ? Effect.promise(async (): Promise<McpApplyResult> =>
                JSON.parse(JSON.stringify(await host.apply(input))),
              )
            : Effect.die(new Error(`Network connection lost: ${input.kind}`)),
      }),
    });

    await Effect.runPromise(
      world
        .sync(undefined)
        .pipe(Effect.provideService(Logger.CurrentLoggers, new Set([collector]))),
    );

    const tables = await host.dump();

    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(SECRET);
    expect(tables).toContain("Bearer ${TOKEN}");
    expect(tables).not.toContain(SECRET);
  });
});
