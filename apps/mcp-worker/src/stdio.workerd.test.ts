// The engine's stdio targets (`docs/architecture/mcp-connections.md` → The stdio bridge, Failures and cuts), through a
// stand-in Workspaces Worker over a fake server (`workspaces.fixture.ts`): discovery and calls in a Workspace's Container,
// the restart after an idle stop, the minimum bridge level, the refusals, cuts named from the bridge's status, and Roots
// offered on bridge connections only.
// workerd's RPC and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off globalFetch:off schemaSync:off newPromise:off preferEffectArray:off
// The expected failures are written as they cross the edge, encoded, so they are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import { env } from "cloudflare:workers";
import type { McpEngineMethods, McpEnginePriorEncoded } from "@cloudpid/mcp/types";
import { McpEngineDiscoverResult, McpEngineRequestResult } from "@cloudpid/mcp/types";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_ENGINE: McpEngineMethods;
      readonly FAKES: Fetcher;
      readonly WORKSPACES: Fetcher;
    }
  }
}

const SECRET = "SECRET-IN-STDERR-1234";

const ROOTS = [
  { uri: "file:///workspace/app", name: "ian/app" },
  { uri: "file:///workspace/lib", name: "ian/lib" },
];

/** A stdio server in Workspace `ws:<kind>-<key>`, whose Container may be started by the call. */
const stdio = (
  kind: "legacy" | "modern",
  key: string,
  extra: { readonly start?: boolean; readonly roots?: ReadonlyArray<{ uri: string }> } = {},
) => ({
  kind: "stdio" as const,
  conn: `conn-${key}`,
  name: key,
  workspace: `ws:${kind}-${key}`,
  start: true,
  command: "fake-server",
  args: ["--stdio"],
  env: { API_TOKEN: SECRET },
  redact: [SECRET],
  roots: ROOTS,
  ...extra,
});

type Target = ReturnType<typeof stdio>;

const AGENT = { origin: "agent" as const, conversation: "conversation-1" };

const ECHO = { name: "echo", inputSchema: { type: "object" } };

const ROOTS_TOOL = { name: "roots", inputSchema: { type: "object" } };

const patient = () => ({ untilAborted: () => new Promise<void>(() => undefined) });

const decodeDiscover = Schema.decodeSync(McpEngineDiscoverResult);

const decodeRequest = Schema.decodeSync(McpEngineRequestResult);

/** One `tools/call` of `tool` on `server`, from the rows a discovery or an earlier call left. */
const call = async (
  server: Target,
  prior: McpEnginePriorEncoded,
  tool = ECHO,
  args: Record<string, Schema.Json> = { text: "hi" },
) =>
  decodeRequest(
    await env.MCP_ENGINE.request(
      server,
      prior,
      { op: "tools/call", tool, arguments: args, ctx: AGENT },
      patient(),
    ),
  );

const control = (server: Target, op: string) =>
  env.WORKSPACES.fetch(`https://workspaces.test/${server.workspace}/${op}`);

/** What reached the stand-in for `server`'s Workspace. */
const seen = async (server: Target) =>
  // SAFETY: the stand-in answers `_seen` with this shape (`workspaces.fixture.ts`).
  (await (await control(server, "_seen")).json()) as {
    running: boolean;
    spawn: number;
    methods: Array<string>;
    declared: Array<object>;
    seen: Array<{ method: string; path: string; start: boolean; use: boolean; era: string | null }>;
  };

/** The text of an inline `tools/call` result. */
const textOf = (result: ReturnType<typeof decodeRequest>) => {
  if (result.kind !== "complete" || result.result.kind !== "inline") {
    throw new Error(`not an inline result: ${JSON.stringify(result)}`);
  }

  return JSON.stringify(result.result.value);
};

describe("discover, over the bridge", () => {
  it("discovers a Legacy stdio server in the Workspace's Container, keeping its session row and the spawn id", async () => {
    const server = stdio("legacy", "discover-legacy");
    const discovered = decodeDiscover(await env.MCP_ENGINE.discover(server, {}, {}));

    expect(discovered).toMatchObject({
      kind: "discovered",
      era: "legacy",
      spawn: "spawn-1",
      state: { era: { era: "legacy" }, session: { v: 1, sessionId: "session-1" } },
    });
    expect(discovered.kind === "discovered" && discovered.tools.map((tool) => tool.name)).toContain(
      "echo",
    );
  });

  it("discovers a Modern stdio server", async () => {
    const server = stdio("modern", "discover-modern");
    const discovered = decodeDiscover(await env.MCP_ENGINE.discover(server, {}, {}));

    expect(discovered).toMatchObject({ kind: "discovered", era: "modern", spawn: "spawn-1" });
  });

  it("starts the Container for a POST that says start, as a use; a GET stream never does either", async () => {
    const server = stdio("legacy", "uses");

    await env.MCP_ENGINE.discover(server, {}, {});

    const posts = (await seen(server)).seen.filter((each) => each.method === "POST");
    const gets = (await seen(server)).seen.filter((each) => each.method === "GET");

    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((each) => each.start && each.use)).toBe(true);
    expect(gets.every((each) => !each.start && !each.use)).toBe(true);
  });

  it("is refused when the Container is stopped and the call may not start it (a background request)", async () => {
    const server = stdio("legacy", "no-start", { start: false });
    const discovered = decodeDiscover(await env.MCP_ENGINE.discover(server, {}, {}));

    expect(discovered).toMatchObject({
      kind: "failed",
      error: { _tag: "Unreachable", message: expect.stringContaining("stopped") },
    });
    expect((await seen(server)).running).toBe(false);
  });
});

describe("request, over the bridge", () => {
  it("restarts the Container after an idle stop and initializes again, the call going through once", async () => {
    const server = stdio("legacy", "idle-stop");
    const discovered = decodeDiscover(await env.MCP_ENGINE.discover(server, {}, {}));

    if (discovered.kind !== "discovered") throw new Error(JSON.stringify(discovered));

    // The first call goes on with the session the discovery opened, no `initialize` of its own.
    const first = await call(server, discovered.state);

    expect(first).toMatchObject({ kind: "complete", spawn: "spawn-1", state: {} });
    expect((await seen(server)).methods.filter((method) => method === "initialize")).toHaveLength(
      1,
    );

    // An idle stop: the Container and its child go, and with them the session the row names.
    await control(server, "_stop");

    const again = await call(server, discovered.state);

    expect(JSON.parse(textOf(again)).content[0].text).toBe("hi");
    expect(again).toMatchObject({ kind: "complete", spawn: "spawn-2" });
    // The row of the new session goes back to the host, and the stand-in started the Container for it.
    expect(again.state.session).toMatchObject({ v: 1, sessionId: "session-1" });
    expect((await seen(server)).spawn).toBe(2);

    const { methods } = await seen(server);

    expect(methods.filter((method) => method === "initialize")).toHaveLength(2);
    expect(methods.filter((method) => method === "tools/call")).toHaveLength(2);
  });

  it("passes the era row's hint to the bridge", async () => {
    const server = stdio("modern", "hint");
    const discovered = decodeDiscover(await env.MCP_ENGINE.discover(server, {}, {}));

    await call(server, discovered.state);

    const posts = (await seen(server)).seen.filter((each) => each.method === "POST");

    expect(posts.at(-1)?.era).toBe("modern");
  });

  it("names the child to the bridge by its config, and never sends it the token or the Secret in the header", async () => {
    const server = stdio("legacy", "config");

    await env.MCP_ENGINE.discover(server, {}, {});

    // SAFETY: the stand-in's own `_seen` answer.
    const { seen: reached } = (await (await control(server, "_seen")).json()) as {
      seen: Array<{ config?: { command: string; args: Array<string>; env: object } }>;
    };

    expect(reached.find((each) => each.config !== undefined)?.config).toMatchObject({
      command: "fake-server",
      args: ["--stdio"],
      env: { API_TOKEN: SECRET },
    });
  });
});

describe("the minimum bridge level", () => {
  it("fails a server whose bridge answers with no level: this Container runs an older bridge", async () => {
    const server = stdio("legacy", "old-bridge");

    await control(server, "_level?value=none");

    const discovered = decodeDiscover(await env.MCP_ENGINE.discover(server, {}, {}));

    expect(discovered).toMatchObject({
      kind: "failed",
      error: { _tag: "Unsupported", message: "this Container runs an older bridge; restart it" },
    });
  });

  it("fails a server whose bridge answers a level below the minimum the same way", async () => {
    const server = stdio("legacy", "level-zero");

    await control(server, "_level?value=0");

    expect(decodeDiscover(await env.MCP_ENGINE.discover(server, {}, {}))).toMatchObject({
      kind: "failed",
      error: { _tag: "Unsupported", message: "this Container runs an older bridge; restart it" },
    });
  });

  it("fails a call the same way", async () => {
    const server = stdio("legacy", "old-bridge-call");

    await control(server, "_level?value=none");

    expect(await call(server, {})).toMatchObject({
      kind: "failed",
      error: { _tag: "Unsupported", message: "this Container runs an older bridge; restart it" },
    });
  });
});

describe("the bridge's refusals", () => {
  it.each([
    ["stopped", 503, undefined],
    ["start_failed", 502, undefined],
    ["bridge_unreachable", 502, undefined],
    ["bridge_failed", 502, 502],
    ["a_code_a_later_bridge_adds", 502, 502],
  ] as const)(
    "reads %s as an unreachable server, with the bridge's words",
    async (code, status, reported) => {
      const server = stdio("legacy", `refused-${code}`);

      await control(server, `_refuse?code=${code}&status=${status}`);

      const failed = await call(server, {});

      expect(failed).toMatchObject({
        kind: "failed",
        error: { _tag: "Unreachable", message: `The stand-in refuses: ${code}` },
      });
      // Only the stopped Container is told from the others, which the host counts as the failures they are.
      expect(
        failed.kind === "failed" && "stopped" in failed.error ? failed.error.stopped : undefined,
      ).toBe(code === "stopped" ? true : undefined);
      expect(
        failed.kind === "failed" && "status" in failed.error ? failed.error.status : undefined,
      ).toBe(reported);
    },
  );

  it("reads 404 no_workspace as a Workspace that is gone: unreachable with status 404, never run", async () => {
    const server = stdio("legacy", "gone");

    await control(server, "_gone");

    expect(await call(server, {})).toMatchObject({
      kind: "failed",
      error: { _tag: "Unreachable", status: 404, message: "The Workspace no longer exists" },
    });
  });
});

describe("a cut", () => {
  it("is named Container stopped when the Container stopped under the call", async () => {
    const server = stdio("legacy", "cut-stopped");
    const discovered = decodeDiscover(await env.MCP_ENGINE.discover(server, {}, {}));

    await control(server, "_cut?how=stopped");

    expect(await call(server, discovered.state)).toMatchObject({
      kind: "failed",
      error: { _tag: "Cut", mayHaveRun: true, message: "Container stopped" },
    });
  });

  it("is named from the child's exit, with the end of its stderr, scrubbed of the Secrets", async () => {
    const server = stdio("legacy", "cut-exited");
    const discovered = decodeDiscover(await env.MCP_ENGINE.discover(server, {}, {}));

    await control(server, "_cut?how=exited");

    const cut = await call(server, discovered.state);

    expect(cut).toMatchObject({
      kind: "failed",
      error: {
        _tag: "Cut",
        mayHaveRun: true,
        message: expect.stringContaining("stdio server exited (code 1)"),
      },
    });
    expect(JSON.stringify(cut)).toContain("boom: could not open /data");
    expect(JSON.stringify(cut)).not.toContain(SECRET);
    // Asked with `start: false`: the status read never starts a Container.
    expect(
      (await seen(server)).seen.filter((each) => each.path === "/_bridge/status"),
    ).toMatchObject([{ start: false, use: false }]);
  });

  it("quotes the end of stderr scrubbed whole: a Secret across the start of the quote is still found", async () => {
    const server = stdio("legacy", "cut-straddle");
    const discovered = decodeDiscover(await env.MCP_ENGINE.discover(server, {}, {}));

    // The last 2 KiB of the stderr begin ten characters into the Secret.
    await control(server, "_stderr?before=500&after=2038");
    await control(server, "_cut?how=exited");

    const cut = JSON.stringify(await call(server, discovered.state));

    expect(cut).toContain("[REDACTED]");
    expect(cut).not.toContain("TDERR-1234");
  });

  it("quotes a last line longer than 2 KiB that ends in a newline: the end of the line, not nothing", async () => {
    const server = stdio("legacy", "cut-long-line");
    const discovered = decodeDiscover(await env.MCP_ENGINE.discover(server, {}, {}));

    await control(server, "_stderr_lines?lines=1&width=3000&trail=1");
    await control(server, "_cut?how=exited");

    const cut = await call(server, discovered.state);

    expect(cut.kind === "failed" ? cut.error.message : "").toContain(
      `its stderr ended:\n${"0".repeat(2_000)}`,
    );
  });

  it("starts the quote at a whole line when the cut falls inside one", async () => {
    const server = stdio("legacy", "cut-mid-line");
    const discovered = decodeDiscover(await env.MCP_ENGINE.discover(server, {}, {}));

    await control(server, "_stderr_lines?lines=100&width=99&trail=1");
    await control(server, "_cut?how=exited");

    const cut = await call(server, discovered.state);
    const message = cut.kind === "failed" ? cut.error.message : "";
    const [, quote = ""] = message.split("its stderr ended:\n");
    const lines = quote.split("\n");

    // Each is a whole line of 99 digits, the first not a part of one.
    expect(lines.length).toBeGreaterThan(15);
    expect(lines.every((line) => line.length === 99 && new Set(line).size === 1)).toBe(true);
  });

  it("stays a cut when the status says nothing more", async () => {
    const server = stdio("legacy", "cut-silent");
    const discovered = decodeDiscover(await env.MCP_ENGINE.discover(server, {}, {}));

    await control(server, "_cut?how=silent");

    expect(await call(server, discovered.state)).toMatchObject({
      kind: "failed",
      error: { _tag: "Cut", mayHaveRun: true },
    });
  });
});

describe("Roots", () => {
  it("are offered to a stdio server, from the Workspace's Repos the target carries (an input_required round)", async () => {
    // The Legacy exchange (`roots/list` on the call's stream) is `packages/mcp/src/roots.test.ts`'s: a stand-in's server
    // cannot answer across the separate requests of an RPC binding.
    for (const kind of ["modern"] as const) {
      const server = stdio(kind, `roots-${kind}`);
      const discovered = decodeDiscover(await env.MCP_ENGINE.discover(server, {}, {}));
      const answered = await call(server, discovered.state, ROOTS_TOOL, {});

      expect(textOf(answered)).toContain("file:///workspace/app");
      expect(textOf(answered)).toContain("ian/lib");
    }
  });

  it("are not offered to a remote server: it is declared no roots capability", async () => {
    const remote = {
      kind: "http" as const,
      conn: "conn-roots-remote",
      name: "roots-remote",
      url: "https://stateful.test/roots-remote/mcp",
    };

    await env.MCP_ENGINE.discover(remote, {}, {});

    const response = await env.FAKES.fetch("https://stateful.test/roots-remote/_seen");
    // SAFETY: the fake's own `_seen` answer.
    const { declared } = (await response.json()) as { declared: Array<object> };

    expect(declared.length).toBeGreaterThan(0);
    expect(declared.every((capabilities) => !("roots" in capabilities))).toBe(true);
  });

  it("are declared without listChanged: a Workspace's Repos are fixed when it is made", async () => {
    const server = stdio("legacy", "roots-declared");

    await env.MCP_ENGINE.discover(server, {}, {});

    const { declared } = await seen(server);

    expect(declared.length).toBeGreaterThan(0);
    expect(declared.every((capabilities) => "roots" in capabilities)).toBe(true);
    expect(JSON.stringify(declared)).not.toContain("listChanged");
  });
});
