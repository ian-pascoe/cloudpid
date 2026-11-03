// `McpHost.request` over real Durable Object SQLite and a scripted engine (`docs/architecture/mcp-connections.md` → RPC,
// The engine → Load caps): what reaches the engine, what is refused before it, and how a cut call reads.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off globalTimers:off newPromise:off
// The engine's answers are written as they cross the edge, encoded, so their failures are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import type {
  McpAccessTokenAnswer,
  McpApplySet,
  McpEngineDiscoverResult,
  McpEngineRequestResult,
  McpHostRequest,
  McpSetEntry,
} from "@cloudpid/mcp/types";
import { env } from "cloudflare:workers";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import type { EngineScript, TestMcpHost } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_HOSTS: DurableObjectNamespace<TestMcpHost>;
    }
  }
}

let counter = 0;

/** A host named as the main Worker names one, that no earlier test has touched. */
const freshHost = () => env.MCP_HOSTS.getByName(`mcp:request${counter++}`);

type Host = ReturnType<typeof freshHost>;

const urlOf = (name: string) => `https://${name}.example/mcp`;

const entry = (name: string, server: Readonly<Record<string, Schema.Json>> = {}): McpSetEntry => ({
  name,
  source: { kind: "global" },
  server: { type: "http", url: urlOf(name), headers: {}, ...server },
  hash: `hash-${name}`,
  conn: `conn-${name}`,
  identity: `identity-${name}`,
});

let revision = 1;

const setOf = (...entries: ReadonlyArray<McpSetEntry>): McpApplySet => ({
  kind: "set",
  hash: entries.map((each) => `${each.name}:${each.hash}`).join("|"),
  revision: revision++,
  entries,
});

/** A discovery that found `tools` (by name). */
const found = (tools: ReadonlyArray<string>): EngineScript => ({
  // SAFETY: a discovered answer, encoded as the engine sends it.
  result: {
    kind: "discovered",
    era: "modern",
    protocolVersion: "2026-07-28",
    capabilities: { tools: {} },
    tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })),
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    state: {
      era: { v: 1, era: "modern", version: "2026-07-28", discover: {}, probedAt: 1 },
    },
  } as typeof McpEngineDiscoverResult.Encoded,
});

/** A completed call that answered `text`. */
const completed = (text: string): typeof McpEngineRequestResult.Encoded => ({
  kind: "complete",
  result: { kind: "inline", value: { content: [{ type: "text", text }] } },
  cacheable: true,
  fetchedAt: Date.now(),
  state: {},
});

/** A `tools/call` of `tool` on `server`, as a Session sends it. */
const call = (server: string, tool: string): typeof McpHostRequest.Encoded => ({
  op: "tools/call",
  server,
  params: { name: tool, arguments: { q: "x" } },
  ctx: {
    origin: "agent",
    callId: "call-1",
    session: "s-1",
    conversation: "1",
    workspace: "ws:w-1",
  },
});

/** A host whose set is `entries`, each discovered with `tools`, its Registry answering `tokens` for each in turn. */
const discovered = async (
  tools: ReadonlyArray<string>,
  ...entries: ReadonlyArray<McpSetEntry & { readonly tokens?: ReadonlyArray<McpAccessTokenAnswer> }>
) => {
  const host = freshHost();

  await host.apply(setOf(...entries.map(({ tokens: _tokens, ...each }) => each)));

  for (const each of entries) {
    if (each.tokens !== undefined) await host.scriptToken(each.name, each.tokens);
  }

  for (const each of entries) await host.scriptEngine(urlOf(each.name), [found(tools)]);

  await host.requestStart({
    caller: { session: "s-1", conversation: "1", workspace: "ws:w-1" },
    waitFor: entries.map((each) => each.name),
    waitMs: 5000,
  });

  return host;
};

const tagOf = async (host: Host, input: typeof McpHostRequest.Encoded) =>
  (await host.request(input, {}))._tag;

describe("a request", () => {
  it("sends a listed tool's call to the engine with the server's target, its rows and the tool's definition", async () => {
    const host = await discovered(["search"], entry("docs"));

    await host.scriptRequest(urlOf("docs"), [{ result: completed("found") }]);

    const answer = await host.request(call("docs", "search"), {});

    expect(answer).toEqual({
      _tag: "Completed",
      result: { kind: "inline", value: { content: [{ type: "text", text: "found" }] } },
    });

    const [sent] = await host.engineRequests();

    expect(sent?.target).toMatchObject({ kind: "http", conn: "conn-docs", url: urlOf("docs") });
    expect(sent?.prior).toMatchObject({ era: expect.objectContaining({ era: "modern" }) });
    expect(sent?.request).toEqual({
      op: "tools/call",
      tool: { name: "search", inputSchema: { type: "object" } },
      arguments: { q: "x" },
      ctx: { origin: "agent", conversation: "1", workspace: "ws:w-1" },
    });
  });

  it("refuses what it cannot send, without reaching the engine", async () => {
    const host = await discovered(
      ["search"],
      entry("docs"),
      entry("off", { enabled: false }),
      entry("local", { type: "stdio", command: "server" }),
    );

    // SAFETY: an `op` a later build sends, as it crosses the edge to this host.
    const later = { ...call("docs", "search"), op: "resources/read" as "tools/call" };

    expect(await tagOf(host, later)).toBe("HostUnsupported");
    expect(await tagOf(host, call("nowhere", "search"))).toBe("UnknownServer");
    expect(await tagOf(host, call("docs", "missing"))).toBe("NotAllowed");
    expect(await tagOf(host, call("off", "search"))).toBe("NotAllowed");
    expect(await tagOf(host, call("local", "search"))).toBe("NotAllowed");
    expect(await host.engineRequests()).toEqual([]);
  });

  it("answers a server that wants a sign-in with SignInRequired, without sending the call", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("auth")));
    await host.scriptEngine(urlOf("auth"), [
      {
        // SAFETY: a failure as it crosses the edge, encoded.
        result: {
          kind: "failed",
          error: { _tag: "SignInRequired", message: "401", rejected: false },
          state: {},
        } as typeof McpEngineDiscoverResult.Encoded,
      },
    ]);
    await host.requestStart({
      caller: { session: "s-1", conversation: "1", workspace: "ws:w-1" },
      waitFor: ["auth"],
      waitMs: 5000,
    });

    expect(await host.request(call("auth", "search"), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "SignInRequired", rejected: false },
    });
    expect(await host.engineRequests()).toEqual([]);
  });

  it("reads a call the caller aborts, or the engine drops, as cut and maybe run", async () => {
    const host = await discovered(["search"], entry("docs"));

    await host.scriptRequest(urlOf("docs"), [
      { result: completed("late"), hold: true },
      { result: completed("never"), reject: "the engine went away" },
    ]);

    let abort = () => {};

    const aborted = new Promise<void>((resolve) => {
      abort = resolve;
    });

    const pending = host.request(call("docs", "search"), { untilAborted: () => aborted });

    // Once the engine holds the call, the caller aborts it.
    while ((await host.engineRequests()).length === 0) await new Promise((r) => setTimeout(r, 10));

    abort();

    expect(await pending).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "Cut", mayHaveRun: true },
    });

    await host.release(urlOf("docs"));

    expect(await host.request(call("docs", "search"), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "Cut", mayHaveRun: true },
    });
  });

  it("counts a wait for a free slot toward the timeout, and never sends a call still waiting when it passes", async () => {
    const host = await discovered(["search"], entry("slow", { timeout: 1 }));

    await host.scriptRequest(
      urlOf("slow"),
      Array.from({ length: 5 }, () => ({ result: completed("held"), hold: true })),
    );

    // Five calls fill the engine queue; the sixth waits for a slot.
    const holding = Array.from({ length: 5 }, () => host.request(call("slow", "search"), {}));

    while ((await host.engineRequests()).length < 5) await new Promise((r) => setTimeout(r, 10));

    expect(await host.request(call("slow", "search"), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "Cut", mayHaveRun: false, message: expect.stringMatching(/not sent/) },
    });

    const sent = await host.engineRequests();

    expect(sent).toHaveLength(5);

    // A sent call gives the engine what is left of its timeout.
    for (const each of sent) {
      expect(each.target.timeoutMs).toBeGreaterThan(0);
      expect(each.target.timeoutMs).toBeLessThanOrEqual(1000);
    }

    await host.release(urlOf("slow"));
    await Promise.all(holding);
  });
});

const TOKEN = "access-token-0001-secret";
const NEXT = "access-token-0002-secret";

/** The Registry's answer with `token` for `sentry`. */
const granted = (token: string): McpAccessTokenAnswer => ({
  status: "ok",
  token,
  resource: urlOf("sentry"),
  signIn: "grant-1",
});

/** A call the server failed with `error`, as the engine sends it. */
const failedCall = (error: Readonly<Record<string, Schema.Json>>) =>
  // SAFETY: a failure as it crosses the edge, encoded.
  ({ kind: "failed", error, state: {} }) as typeof McpEngineRequestResult.Encoded;

const unauthorized = failedCall({ _tag: "SignInRequired", message: "401", rejected: false });

/** `sentry` in a host's set, discovered, with its Registry answering `tokens` in turn (the last for good). */
const signedIn = (tokens: ReadonlyArray<McpAccessTokenAnswer>) =>
  discovered(["search"], { ...entry("sentry"), tokens });

describe("a request to a server with a sign-in", () => {
  it("carries the sign-in's token through the engine's auth hook, never in the target", async () => {
    const host = await signedIn([granted(TOKEN)]);

    await host.scriptRequest(urlOf("sentry"), [{ result: completed("found"), auth: [false] }]);

    expect(await tagOf(host, call("sentry", "search"))).toBe("Completed");

    const [sent] = await host.engineRequests();

    expect(sent?.hooks).toContain("auth");
    expect(sent?.tokens).toEqual([TOKEN]);
    expect(sent?.target.headers?.["Authorization"]).toBeUndefined();
    expect(await host.reports()).toEqual([]);
  });

  it("asks again with the refused token as stale after a 401, and reports rejected when the fresh one is refused too", async () => {
    const host = await signedIn([granted(TOKEN), granted(NEXT)]);

    await host.scriptRequest(urlOf("sentry"), [
      { result: completed("found"), auth: [false, true] },
      { result: unauthorized, auth: [false, true] },
    ]);

    // The first 401 is answered with a refreshed token, and the retry works: nothing to report.
    expect(await tagOf(host, call("sentry", "search"))).toBe("Completed");
    expect((await host.engineRequests())[0]?.tokens).toEqual([TOKEN, NEXT]);
    expect((await host.tokenAsks()).at(-1)).toMatchObject({ server: "sentry", stale: TOKEN });
    expect(await host.reports()).toEqual([]);

    // Refused after its refresh too: the sign-in is `rejected`, once.
    expect(await host.request(call("sentry", "search"), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "SignInRequired" },
    });
    expect(await host.reports()).toEqual([
      expect.objectContaining({ server: "sentry", event: "rejected" }),
    ]);
  });

  it("calls with no token when the Registry has none, and reports needs_sign_in on a 401", async () => {
    const host = await signedIn([{ status: "required", reason: "Not signed in" }]);

    await host.scriptRequest(urlOf("sentry"), [{ result: unauthorized }]);

    expect(await host.request(call("sentry", "search"), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "SignInRequired" },
    });
    expect((await host.engineRequests())[0]?.hooks).not.toContain("auth");
    expect(await host.reports()).toEqual([
      expect.objectContaining({ server: "sentry", event: "needs_sign_in" }),
    ]);
  });

  it("is not sent when no token stands, and reports a 403 for more scope as a step-up", async () => {
    const host = await signedIn([
      { status: "required", reason: "Not signed in" },
      { status: "step_up", reason: "More scope", scope: "admin" },
      granted(TOKEN),
    ]);

    // The discovery went without a token; the call finds a step-up the owner has not done.
    expect(await host.request(call("sentry", "search"), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "SignInRequired" },
    });
    expect(await host.engineRequests()).toEqual([]);

    await host.scriptRequest(urlOf("sentry"), [
      {
        result: failedCall({ _tag: "StepUpRequired", message: "403", scope: "admin" }),
        auth: [false],
      },
    ]);

    expect(await tagOf(host, call("sentry", "search"))).toBe("CallFailed");
    expect(await host.reports()).toEqual([
      expect.objectContaining({
        server: "sentry",
        event: "step_up",
        challenge: { scope: "admin" },
      }),
    ]);
  });
});
