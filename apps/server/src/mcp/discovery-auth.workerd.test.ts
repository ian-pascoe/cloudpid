// What a discovery does with an MCP sign-in's token, over real Durable Object SQLite, a scripted Registry and a scripted engine
// (`docs/architecture/mcp-sign-in.md` → Tokens reach the host object, Reports and pushes; `mcp-connections.md` → Tokens and
// 401/403 at the connection): the token in the target's header, the second call after a refusal, the reports, the states with
// no token, the cache, `apply({ kind: "sign_ins" })`, the heal at `windowOpened`, and that no token is kept, logged or put on
// a span.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off globalDate:off globalTimers:off newPromise:off
// The engine's answers are written as they cross the edge, encoded, so their failures are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import type {
  McpAccessTokenAnswer,
  McpApplySet,
  McpEngineDiscoverResult,
  McpRequestStart,
  McpSetEntry,
} from "@cloudpid/mcp/types";
import { env } from "cloudflare:workers";
import type * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
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

const freshHost = () => env.MCP_HOSTS.getByName(`mcp:discovery-auth${counter++}`);

type Host = ReturnType<typeof freshHost>;

const urlOf = (name: string) => `https://${name}.example/mcp`;

const TOKEN = "access-token-0001-secret";
const NEXT = "access-token-0002-secret";

const entry = (
  name: string,
  server: Readonly<Record<string, Schema.Json>> = {},
  extra: Partial<McpSetEntry> = {},
): McpSetEntry => ({
  name,
  source: { kind: "global" },
  server: { type: "http", url: urlOf(name), headers: {}, ...server },
  hash: `hash-${name}`,
  conn: `conn-${name}`,
  identity: `identity-${name}`,
  ...extra,
});

let revision = 1;

const setOf = (...entries: ReadonlyArray<McpSetEntry>): McpApplySet => ({
  kind: "set",
  hash: entries.map((each) => `${each.name}:${each.hash}:${each.conn}`).join("|"),
  revision: revision++,
  entries,
});

type Encoded = typeof McpEngineDiscoverResult.Encoded;

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
    state: {},
  } as Encoded,
});

const failedWith = (error: Readonly<Record<string, Schema.Json>>): EngineScript => ({
  // SAFETY: a failure as it crosses the edge; the host decodes it.
  result: { kind: "failed", error, state: {} } as Encoded,
});

const unauthorized = () => failedWith({ _tag: "SignInRequired", message: "401", rejected: false });

type Granted = (typeof McpAccessTokenAnswer.members)[0]["Type"];

const ok = (token: string, over: Partial<Granted> = {}): Granted => ({
  status: "ok",
  token,
  resource: "https://sentry.example/mcp",
  signIn: "grant-1",
  ...over,
});

const noToken = (
  status: "required" | "step_up" | "rejected" | "refresh_failing" | "unavailable" | "failed",
  reason: string,
  scope?: string,
): McpAccessTokenAnswer => (scope === undefined ? { status, reason } : { status, reason, scope });

const CALLER = { session: "s-1", conversation: "1", workspace: "w-1" };

const start = (host: Host, more: Partial<McpRequestStart> = {}) =>
  host.requestStart({ caller: CALLER, ...more });

const restart = (host: Host) => start(host, { known: "built" });

const stateOf = async (host: Host, name: string) => (await restart(host)).servers[name]?.state;

const settled = (host: Host) => host.servers({ parts: [], waitMs: 10_000 });

/** The `Authorization` header of each discovery the engine was asked for, in order. */
const sent = async (host: Host) =>
  (await host.engineCalls()).map((call) =>
    call.target.kind === "http" ? call.target.headers?.Authorization : undefined,
  );

const MINUTE = 60_000;

/** A host with `sentry` in its set, and its first discovery waited for. */
const discovered = async (
  tokens: ReadonlyArray<McpAccessTokenAnswer | "unreachable">,
  scripts: ReadonlyArray<EngineScript>,
  extra: Readonly<Record<string, Schema.Json>> = {},
) => {
  const host = freshHost();

  await host.apply(setOf(entry("sentry", extra)));
  await host.scriptToken("sentry", tokens);
  await host.scriptEngine(urlOf("sentry"), scripts);
  await start(host, { waitFor: ["sentry"], waitMs: 5000 });
  await settled(host);

  return host;
};

describe("the token in a discovery", () => {
  it("is asked of the Registry and sent as the target's Authorization header, with no callback", async () => {
    const host = await discovered([ok(TOKEN)], [found(["issues"])]);

    expect(await stateOf(host, "sentry")).toBe("connected");
    expect(await sent(host)).toEqual([`Bearer ${TOKEN}`]);
    expect(await host.tokenAsks()).toEqual([{ environment: expect.any(String), server: "sentry" }]);
    // A background discovery passes no hook: a function stub would not outlive its invocation.
    expect((await host.engineCalls()).map((call) => call.hooks)).toEqual([[]]);
    // A server that was not waiting for a sign-in is not reported to the Registry as working.
    expect(await host.reports()).toEqual([]);
  });

  it("is never kept, logged or put on a span: not in the storage, the log, or the spans", async () => {
    const host = await discovered([ok(TOKEN), ok(NEXT)], [unauthorized(), found(["issues"])]);

    expect(await stateOf(host, "sentry")).toBe("connected");
    expect(await sent(host)).toEqual([`Bearer ${TOKEN}`, `Bearer ${NEXT}`]);

    for (const secret of [TOKEN, NEXT]) {
      expect(await host.dump()).not.toContain(secret);
      expect(await host.observed()).not.toContain(secret);
    }
  });

  it("is not asked for, nor replaced, when the entry sends an Authorization header of its own", async () => {
    const host = await discovered([ok(TOKEN)], [found(["issues"])], {
      headers: { Authorization: "Bearer from-the-entry" },
    });

    expect(await host.tokenAsks()).toEqual([]);
    expect(await sent(host)).toEqual(["Bearer from-the-entry"]);
  });

  it("is held in memory until a minute before it expires, and asked of the Registry again after", async () => {
    const host = await discovered(
      [ok(TOKEN, { expiresAt: Date.now() + 10 * MINUTE }), ok(NEXT)],
      [found(["a"]), found(["a"]), found(["a"])],
    );

    // Reloads rediscover at once: the cache answers while the token stands.
    await host.apply({ kind: "reload" });
    await settled(host);
    expect(await host.tokenAsks()).toHaveLength(1);

    await host.advance(9 * MINUTE + 1);
    await host.apply({ kind: "reload" });
    await settled(host);

    expect(await host.tokenAsks()).toHaveLength(2);
    expect(await sent(host)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`, `Bearer ${NEXT}`]);
  });

  it("is held 15 minutes when the server gave it no lifetime", async () => {
    const host = await discovered(
      [ok(TOKEN), ok(NEXT)],
      [found(["a"]), found(["a"]), found(["a"])],
    );

    await host.advance(14 * MINUTE);
    await host.apply({ kind: "reload" });
    await settled(host);
    expect(await host.tokenAsks()).toHaveLength(1);

    await host.advance(2 * MINUTE);
    await host.apply({ kind: "reload" });
    await settled(host);
    expect(await host.tokenAsks()).toHaveLength(2);
  });

  it("is not sent to a server outside the protected resource it is bound to", async () => {
    const host = await discovered(
      [ok(TOKEN, { resource: "https://elsewhere.example/mcp" })],
      [found(["a"])],
    );

    expect(await host.engineCalls()).toHaveLength(0);
    expect(await stateOf(host, "sentry")).toBe("unavailable");
    expect(await host.observed()).not.toContain(TOKEN);
    expect(await host.dump()).not.toContain(TOKEN);
  });

  it("is sent to a server within the resource's path, and the resource may name a wider path", async () => {
    const host = await discovered(
      [ok(TOKEN, { resource: "https://sentry.example/" })],
      [found(["a"])],
    );

    expect(await sent(host)).toEqual([`Bearer ${TOKEN}`]);
  });
});

describe("a 401", () => {
  it("with a token asks the Registry again with the refused one as stale, and retries once with the new token", async () => {
    const host = await discovered([ok(TOKEN), ok(NEXT)], [unauthorized(), found(["issues"])]);

    expect(await stateOf(host, "sentry")).toBe("connected");
    expect(await host.tokenAsks()).toEqual([
      { environment: expect.any(String), server: "sentry" },
      { environment: expect.any(String), server: "sentry", stale: TOKEN },
    ]);
    expect(await sent(host)).toEqual([`Bearer ${TOKEN}`, `Bearer ${NEXT}`]);
    expect(await host.reports()).toEqual([]);
  });

  it("twice, with a fresh token, makes the server `rejected` and is reported once, the tokens kept", async () => {
    const host = await discovered([ok(TOKEN), ok(NEXT)], [unauthorized(), unauthorized()]);

    expect(await stateOf(host, "sentry")).toBe("rejected");
    expect(await sent(host)).toEqual([`Bearer ${TOKEN}`, `Bearer ${NEXT}`]);
    expect(await host.reports()).toEqual([
      { environment: expect.any(String), server: "sentry", event: "rejected" },
    ]);
  });

  it("is not retried with the token the Registry hands over again, as a rejected sign-in's is", async () => {
    const host = await discovered([ok(TOKEN)], [unauthorized(), found(["never"])]);

    expect(await stateOf(host, "sentry")).toBe("rejected");
    expect(await sent(host)).toEqual([`Bearer ${TOKEN}`]);
    expect(await host.reports()).toMatchObject([{ event: "rejected" }]);
  });

  it("with no token makes the server `sign_in` with no retry, and is reported once as needs_sign_in", async () => {
    const host = await discovered(
      [noToken("required", "Not signed in")],
      [unauthorized(), unauthorized()],
    );

    expect(await stateOf(host, "sentry")).toBe("sign_in");
    expect(await host.engineCalls()).toHaveLength(1);
    expect(await sent(host)).toEqual([undefined]);
    expect(await host.reports()).toEqual([
      { environment: expect.any(String), server: "sentry", event: "needs_sign_in" },
    ]);
  });

  it("with a token whose refresh then leaves none makes the server `sign_in`, with the Registry's reason", async () => {
    const host = await discovered(
      [ok(TOKEN), noToken("required", "The authorization server no longer accepts the sign-in")],
      [unauthorized(), found(["never"])],
    );

    expect(await stateOf(host, "sentry")).toBe("sign_in");
    expect(await host.engineCalls()).toHaveLength(1);
    expect((await host.servers({ parts: [] })).servers[0]?.error).toContain("no longer accepts");
  });
});

describe("a 403 for more scope", () => {
  it("is reported as step_up with the scope it wants, and the server waits for the owner", async () => {
    const host = await discovered(
      [ok(TOKEN)],
      [failedWith({ _tag: "StepUpRequired", message: "403", scope: "write" })],
    );

    expect(await stateOf(host, "sentry")).toBe("sign_in");
    expect(await host.reports()).toEqual([
      {
        environment: expect.any(String),
        server: "sentry",
        event: "step_up",
        challenge: { scope: "write" },
      },
    ]);
  });
});

describe("the challenge of a 401 or 403", () => {
  const challenge = {
    resourceMetadataUrl: "https://sentry.example/.well-known/oauth-protected-resource",
    error: "invalid_token",
    errorDescription: "expired",
  };

  it("is carried to the Registry with needs_sign_in", async () => {
    const host = await discovered(
      [noToken("required", "Not signed in")],
      [failedWith({ _tag: "SignInRequired", message: "401", rejected: false, challenge })],
    );

    expect(await host.reports()).toEqual([
      { environment: expect.any(String), server: "sentry", event: "needs_sign_in", challenge },
    ]);
  });

  it("is carried with rejected, which sets the error and its description", async () => {
    const host = await discovered(
      [ok(TOKEN)],
      [failedWith({ _tag: "SignInRequired", message: "401", rejected: true, challenge })],
    );

    expect(await host.reports()).toEqual([
      { environment: expect.any(String), server: "sentry", event: "rejected", challenge },
    ]);
  });

  it("is carried with step_up: the scope, the metadata URL, the error and its description", async () => {
    const wanted = {
      resourceMetadataUrl: "https://sentry.example/.well-known/oauth-protected-resource",
      scope: "write",
      error: "insufficient_scope",
      errorDescription: "Needs write",
    };

    const host = await discovered(
      [ok(TOKEN)],
      [failedWith({ _tag: "StepUpRequired", message: "403", scope: "write", challenge: wanted })],
    );

    expect(await stateOf(host, "sentry")).toBe("sign_in");
    expect(await host.reports()).toEqual([
      { environment: expect.any(String), server: "sentry", event: "step_up", challenge: wanted },
    ]);
  });
});

describe("reports on transitions only", () => {
  it("reports `rejected` again at the next discovery while the Registry's note does not say it, and stops when it does", async () => {
    const host = await discovered([ok(TOKEN)], [unauthorized(), unauthorized(), unauthorized()]);

    expect(await stateOf(host, "sentry")).toBe("rejected");
    expect(await host.reports()).toMatchObject([{ event: "rejected" }]);

    // The report was lost, or a new sign-in was refused again: the Registry still has the sign-in at `ok`, so it is told.
    await host.apply({ kind: "reload" });
    await settled(host);

    expect(await stateOf(host, "sentry")).toBe("rejected");
    expect(await host.reports()).toMatchObject([{ event: "rejected" }, { event: "rejected" }]);

    // Now the Registry has it: its note says `rejected`, and the next discovery says nothing.
    await host.scriptToken("sentry", [
      ok(TOKEN, { note: { status: "rejected", reason: "invalid_token" } }),
    ]);
    await host.apply({ kind: "reload" });
    await settled(host);

    expect(await host.engineCalls()).toHaveLength(3);
    expect(await host.reports()).toHaveLength(2);
  });

  it("does not report a rejected sign-in the Registry's note already names", async () => {
    const host = await discovered(
      [ok(TOKEN, { note: { status: "rejected", reason: "invalid_token" } })],
      [unauthorized()],
    );

    expect(await host.reports()).toEqual([]);
  });

  it("does not report a step-up the Registry's note already names for the same scope, and reports another", async () => {
    const stepUp = failedWith({ _tag: "StepUpRequired", message: "403", scope: "write" });

    const same = await discovered(
      [ok(TOKEN, { note: { status: "step_up", scope: "read write" } })],
      [stepUp],
    );

    expect(await stateOf(same, "sentry")).toBe("sign_in");
    expect(await same.reports()).toEqual([]);

    const other = await discovered(
      [ok(TOKEN, { note: { status: "step_up", scope: "read write" } })],
      [failedWith({ _tag: "StepUpRequired", message: "403", scope: "admin" })],
    );

    expect(await other.reports()).toMatchObject([
      { event: "step_up", challenge: { scope: "admin" } },
    ]);
  });

  it("does not report needs_sign_in again for a server that is at `sign_in` and asked with no token", async () => {
    const host = await discovered(
      [noToken("required", "Not signed in")],
      [unauthorized(), unauthorized()],
    );

    await host.apply({ kind: "reload" });
    await settled(host);

    expect(await host.reports()).toMatchObject([{ event: "needs_sign_in" }]);
  });
});

describe("no token to connect with", () => {
  it("connects with none when the server was never signed in to: it may need no sign-in", async () => {
    const host = await discovered([noToken("required", "Not signed in")], [found(["public"])]);

    expect(await stateOf(host, "sentry")).toBe("connected");
    expect(await sent(host)).toEqual([undefined]);
  });

  it("keeps a server that wants a sign-in at `sign_in` without a call, even at a reload", async () => {
    const host = await discovered(
      [noToken("required", "Not signed in")],
      [unauthorized(), found(["never"])],
    );

    await host.apply({ kind: "reload" });
    await settled(host);

    expect(await stateOf(host, "sentry")).toBe("sign_in");
    expect(await host.engineCalls()).toHaveLength(1);
  });

  it.each<[string, McpAccessTokenAnswer | "unreachable", string, string]>([
    [
      "a step-up whose token no longer stands",
      noToken("step_up", "More access", "write"),
      "sign_in",
      "More access",
    ],
    [
      "a sign-in the server rejected",
      noToken("rejected", "The server refused it"),
      "rejected",
      "refused",
    ],
    [
      "a refresh that failed",
      noToken("refresh_failing", "HTTP 503"),
      "unavailable",
      "Can't refresh the sign-in: HTTP 503",
    ],
    [
      "a sign-in that is unavailable",
      noToken("unavailable", "Not an OAuth server"),
      "unavailable",
      "Not an OAuth server",
    ],
    ["a Registry that cannot be asked", "unreachable", "unavailable", "could not be asked"],
    ["a status this build does not know", { status: "newer" }, "unavailable", "does not know"],
  ])("makes the server not reached, with no call, for %s", async (_, answer, state, message) => {
    const host = await discovered([answer], [found(["never"])]);

    expect(await host.engineCalls()).toHaveLength(0);
    expect(await stateOf(host, "sentry")).toBe(state);
    expect((await host.servers({ parts: [] })).servers[0]?.error).toContain(message);
  });
});

describe("working again", () => {
  it("is reported when a server that waited for a sign-in connects, and not before", async () => {
    const host = await discovered([noToken("required", "Not signed in")], [unauthorized()]);

    expect(await host.reports()).toMatchObject([{ event: "needs_sign_in" }]);

    await host.scriptToken("sentry", [ok(TOKEN)]);
    await host.scriptEngine(urlOf("sentry"), [found(["issues"])]);
    await host.apply({ kind: "sign_ins", change: "signed_in", servers: ["sentry"], revision: 2 });
    await settled(host);

    expect(await stateOf(host, "sentry")).toBe("connected");
    expect(await host.reports()).toMatchObject([{ event: "needs_sign_in" }, { event: "working" }]);
  });

  it("is reported when a server connects on a token whose sign-in carries a note that it was refused", async () => {
    const host = await discovered(
      [ok(TOKEN, { note: { status: "rejected", reason: "invalid_token" } })],
      [found(["issues"])],
    );

    expect(await host.reports()).toMatchObject([{ event: "working" }]);
  });

  it("is not reported for a token whose sign-in cannot refresh: the server works while the refresh still fails", async () => {
    const host = await discovered(
      [ok(TOKEN, { note: { status: "refresh_failing", reason: "HTTP 503" } })],
      [found(["issues"])],
    );

    expect(await stateOf(host, "sentry")).toBe("connected");
    expect(await host.reports()).toEqual([]);
  });
});

describe("apply({ kind: 'sign_ins' })", () => {
  const withTwo = async () => {
    const host = freshHost();

    await host.apply(setOf(entry("Sentry"), entry("linear")));
    await host.scriptToken("Sentry", [noToken("required", "Not signed in")]);
    await host.scriptToken("linear", [noToken("required", "Not signed in")]);
    await host.scriptEngine(urlOf("Sentry"), [unauthorized()]);
    await host.scriptEngine(urlOf("linear"), [unauthorized()]);
    await start(host, { waitFor: ["Sentry", "linear"], waitMs: 5000 });
    await settled(host);

    return host;
  };

  it("rediscovers the servers that waited for the sign-in at once, matching a name as the sign-in key does", async () => {
    const host = await withTwo();

    expect(await stateOf(host, "Sentry")).toBe("sign_in");
    await host.scriptToken("Sentry", [ok(TOKEN, { resource: urlOf("Sentry") })]);
    await host.scriptEngine(urlOf("Sentry"), [found(["issues"])]);

    expect(
      await host.apply({ kind: "sign_ins", change: "signed_in", servers: ["sentry"], revision: 3 }),
    ).toEqual({ _tag: "SignInsTaken", servers: ["Sentry"] });
    await settled(host);

    expect(await stateOf(host, "Sentry")).toBe("connected");
    // The other server is left as it was: no call.
    expect(await stateOf(host, "linear")).toBe("sign_in");
    expect((await host.engineCalls()).map((call) => call.target.name)).toEqual([
      "Sentry",
      "linear",
      "Sentry",
    ]);
  });

  it.each(["replaced", "rebound"])("does the same for %s", async (change) => {
    const host = await withTwo();

    await host.scriptToken("linear", [ok(TOKEN, { resource: urlOf("linear") })]);
    await host.scriptEngine(urlOf("linear"), [found(["issues"])]);
    await host.apply({ kind: "sign_ins", change, servers: ["linear"], revision: 3 });
    await settled(host);

    expect(await stateOf(host, "linear")).toBe("connected");
  });

  it("takes effect while a discovery of the server is running: it is interrupted and asked again with the new token", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("sentry")));
    await host.scriptToken("sentry", [noToken("required", "Not signed in")]);
    // The first discovery waits for the engine, which will answer 401 for the token it had none of.
    await host.scriptEngine(urlOf("sentry"), [
      { ...unauthorized(), hold: true },
      found(["issues"]),
    ]);
    await start(host);
    await vi.waitFor(async () => expect(await host.engineCalls()).toHaveLength(1));

    await host.scriptToken("sentry", [ok(TOKEN)]);
    await host.apply({ kind: "sign_ins", change: "signed_in", servers: ["sentry"], revision: 2 });
    await vi.waitFor(async () => expect(await stateOf(host, "sentry")).toBe("connected"));

    // The old discovery's answer, when it comes, settles nothing.
    await host.release(urlOf("sentry"));
    await settled(host);

    expect(await stateOf(host, "sentry")).toBe("connected");
    expect(await sent(host)).toEqual([undefined, `Bearer ${TOKEN}`]);
    expect(await host.reports()).toEqual([]);
  });

  it("leaves a server that works alone: no call, and no rediscovery", async () => {
    const host = await discovered([ok(TOKEN)], [found(["issues"])]);

    await host.apply({ kind: "sign_ins", change: "signed_in", servers: ["sentry"], revision: 2 });
    await settled(host);

    expect(await stateOf(host, "sentry")).toBe("connected");
    expect(await host.engineCalls()).toHaveLength(1);
  });

  it("drops the cached token, so the next ask reaches the Registry", async () => {
    const host = await discovered([ok(TOKEN), ok(NEXT)], [found(["a"]), found(["a"])]);

    expect(await host.tokenAsks()).toHaveLength(1);

    await host.apply({ kind: "sign_ins", change: "replaced", servers: ["sentry"], revision: 2 });
    await host.apply({ kind: "reload" });
    await settled(host);

    expect(await host.tokenAsks()).toHaveLength(2);
    expect(await sent(host)).toEqual([`Bearer ${TOKEN}`, `Bearer ${NEXT}`]);
  });

  it("after a sign-out drops the token and the server's Legacy session, rediscovers nothing and keeps the inventory", async () => {
    const host = await discovered([ok(TOKEN)], [found(["issues"])]);

    expect(await host.tokenAsks()).toHaveLength(1);

    const taken = await host.apply({
      kind: "sign_ins",
      change: "signed_out",
      servers: ["sentry"],
      revision: 2,
    });

    expect(taken).toEqual({ _tag: "SignInsTaken", servers: ["sentry"] });
    await settled(host);
    expect(await host.engineCalls()).toHaveLength(1);
    expect(await stateOf(host, "sentry")).toBe("connected");
    expect(
      (await host.servers({ parts: ["tools"] })).servers[0]?.tools?.map((tool) => tool.name),
    ).toEqual(["issues"]);

    // The token is not held any more: the next discovery asks the Registry.
    await host.scriptToken("sentry", [noToken("required", "Not signed in")]);
    await host.apply({ kind: "reload" });
    await settled(host);
    expect(await host.tokenAsks()).toHaveLength(2);
  });

  it("answers a change this build does not know by dropping the tokens and asking nothing", async () => {
    const host = await withTwo();

    expect(
      await host.apply({
        kind: "sign_ins",
        change: "teleported",
        servers: ["sentry"],
        revision: 3,
      }),
    ).toEqual({ _tag: "SignInsTaken", servers: ["Sentry"] });
    await settled(host);

    expect(await host.engineCalls()).toHaveLength(2);
  });

  it("names no server it does not hold, and is a failure when malformed", async () => {
    const host = await withTwo();

    expect(
      await host.apply({
        kind: "sign_ins",
        change: "signed_in",
        servers: ["nowhere"],
        revision: 3,
      }),
    ).toEqual({ _tag: "SignInsTaken", servers: [] });
    expect(await host.apply(JSON.parse('{"kind":"sign_ins","change":"signed_in"}'))).toMatchObject({
      _tag: "HostFailed",
    });
  });

  it("keeps the revision it carries when it is the very next one, so the next pull does not act on it a second time", async () => {
    const host = await withTwo();

    // The host holds revision 2 (a pull); the sign-in's change is revision 3.
    await host.script({ hash: "", signInsRevision: 2 });
    await start(host, { windowOpened: true, known: "built" });
    await settled(host);
    await host.apply({ kind: "sign_ins", change: "signed_in", servers: ["sentry"], revision: 3 });
    await settled(host);

    const before = (await host.engineCalls()).length;

    await host.scriptToken("Sentry", [ok(TOKEN, { resource: urlOf("Sentry") })]);
    await host.scriptEngine(urlOf("Sentry"), [found(["issues"])]);
    await host.script({ hash: "", signInsRevision: 3 });
    await start(host, { windowOpened: true, known: "built" });
    await settled(host);

    expect((await host.engineCalls()).length).toBe(before);
  });

  it("does not keep a revision that skips one, so a push that was lost is healed by the next pull", async () => {
    const host = await withTwo();

    await host.script({ hash: "", signInsRevision: 2 });
    await start(host, { windowOpened: true, known: "built" });
    await settled(host);

    // Revision 3 (a change of linear's, whose push was lost) is not seen: the push that arrives is revision 4, for sentry.
    await host.apply({ kind: "sign_ins", change: "signed_in", servers: ["sentry"], revision: 4 });
    await settled(host);

    const before = (await host.engineCalls()).length;

    await host.scriptToken("linear", [ok(TOKEN, { resource: urlOf("linear") })]);
    await host.scriptEngine(urlOf("linear"), [found(["issues"])]);
    await host.script({ hash: "", signInsRevision: 4 });
    await start(host, { windowOpened: true, known: "built" });
    await vi.waitFor(async () => expect(await stateOf(host, "linear")).toBe("connected"));

    expect((await host.engineCalls()).length).toBeGreaterThan(before);
  });
});

describe("a pull that finds the sign-ins revision moved", () => {
  it("heals a lost push: the cached tokens go and the servers that waited for a sign-in are asked at once", async () => {
    const host = freshHost();

    await host.script({ hash: "", signInsRevision: 1 });
    await host.apply(setOf(entry("sentry")));
    await host.scriptToken("sentry", [noToken("required", "Not signed in")]);
    await host.scriptEngine(urlOf("sentry"), [unauthorized(), found(["issues"])]);
    await start(host, { windowOpened: true, waitFor: ["sentry"], waitMs: 5000 });
    await settled(host);
    expect(await stateOf(host, "sentry")).toBe("sign_in");

    // The owner signed in while the host heard nothing: the Registry's revision is 2 now.
    await host.scriptToken("sentry", [ok(TOKEN)]);
    await host.script({ hash: "", signInsRevision: 2 });
    await start(host, { windowOpened: true, known: "built" });
    await vi.waitFor(async () => expect(await stateOf(host, "sentry")).toBe("connected"));

    expect(await sent(host)).toEqual([undefined, `Bearer ${TOKEN}`]);
  });

  it("does nothing while the revision is the one held", async () => {
    const host = freshHost();

    await host.script({ hash: "", signInsRevision: 1 });
    await host.apply(setOf(entry("sentry")));
    await host.scriptToken("sentry", [noToken("required", "Not signed in")]);
    await host.scriptEngine(urlOf("sentry"), [unauthorized(), found(["never"])]);
    await start(host, { windowOpened: true, waitFor: ["sentry"], waitMs: 5000 });
    await settled(host);

    await start(host, { windowOpened: true, known: "built" });
    await settled(host);

    expect(await host.engineCalls()).toHaveLength(1);
    expect(await stateOf(host, "sentry")).toBe("sign_in");
  });
});

describe("the heal at windowOpened", () => {
  it("asks only the servers that wait for a sign-in, not one that is unavailable for another reason", async () => {
    const host = freshHost();

    await host.script({ hash: "", signInsRevision: 1 });
    await host.apply(setOf(entry("sentry"), entry("linear")));
    await host.scriptToken("sentry", [noToken("required", "Not signed in")]);
    await host.scriptToken("linear", [noToken("unavailable", "Not an OAuth server")]);
    await host.scriptEngine(urlOf("sentry"), [unauthorized(), found(["issues"])]);
    await host.scriptEngine(urlOf("linear"), [found(["never"])]);
    await start(host, { windowOpened: true, waitFor: ["sentry", "linear"], waitMs: 5000 });
    await settled(host);

    expect(await stateOf(host, "sentry")).toBe("sign_in");
    expect(await stateOf(host, "linear")).toBe("unavailable");

    // The sign-ins moved (some change that no push carried): sentry's token is there now, linear's answer is the same.
    await host.scriptToken("sentry", [ok(TOKEN)]);
    await host.script({ hash: "", signInsRevision: 2 });
    await start(host, { windowOpened: true, known: "built" });
    await vi.waitFor(async () => expect(await stateOf(host, "sentry")).toBe("connected"));
    await settled(host);

    expect(await stateOf(host, "linear")).toBe("unavailable");
    expect((await host.tokenAsks()).filter((ask) => ask.server === "linear")).toHaveLength(1);
  });

  it("is made for a server the push names even when it is unavailable, skipping the backoff", async () => {
    const host = await discovered([noToken("refresh_failing", "HTTP 503")], [found(["never"])]);

    expect(await stateOf(host, "sentry")).toBe("unavailable");

    await host.scriptToken("sentry", [ok(TOKEN)]);
    await host.scriptEngine(urlOf("sentry"), [found(["issues"])]);
    await host.apply({ kind: "sign_ins", change: "signed_in", servers: ["sentry"], revision: 2 });
    await settled(host);

    expect(await stateOf(host, "sentry")).toBe("connected");
  });
});

describe("a server that signs in on its own", () => {
  const GRANT = {
    oauth: {
      grantType: "client_credentials",
      clientId: "cloudpid-prod",
      clientSecret: "${CLIENT_SECRET}",
      issuer: "https://auth.example.com",
    },
  } as const;

  const EXTENSION = "io.modelcontextprotocol/oauth-client-credentials";

  it("declares the OAuth Client Credentials extension on its connection, and no other connection does", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("sentry", GRANT), entry("linear")));
    await host.scriptToken("sentry", [ok(TOKEN)]);
    await host.scriptToken("linear", [noToken("required", "Not signed in")]);
    await host.scriptEngine(urlOf("sentry"), [found(["issues"])]);
    await host.scriptEngine(urlOf("linear"), [found(["tasks"])]);
    await start(host, { waitFor: ["sentry", "linear"], waitMs: 5000 });
    await settled(host);

    const targets = Object.fromEntries(
      (await host.engineCalls()).map(({ target }) => [
        target.name,
        target.kind === "http" ? target.extensions : undefined,
      ]),
    );

    expect(targets["sentry"]).toEqual({ [EXTENSION]: {} });
    expect(targets["linear"]).toBeUndefined();
  });

  it("sends the Registry's token and reports nothing to it", async () => {
    const host = await discovered([ok(TOKEN)], [found(["issues"])], GRANT);

    expect(await stateOf(host, "sentry")).toBe("connected");
    expect(await sent(host)).toEqual([`Bearer ${TOKEN}`]);
    expect(await host.reports()).toEqual([]);
  });

  it("is `failed` with the Registry's problem, never `sign_in`, when there is no token; and no call is made", async () => {
    const host = await discovered(
      [noToken("failed", "The authorization server does not accept the entry's client id")],
      [found(["never"])],
      GRANT,
    );

    expect(await stateOf(host, "sentry")).toBe("failed");
    expect(await host.engineCalls()).toHaveLength(0);
    expect((await host.servers({ parts: [] })).servers[0]?.error).toContain("client id");
    expect(await host.reports()).toEqual([]);
  });

  it("never connects without a token, whatever status stands in the token's place", async () => {
    for (const status of ["required", "step_up", "rejected", "refresh_failing"] as const) {
      const host = await discovered([noToken(status, "no")], [found(["never"])], GRANT);

      expect(await stateOf(host, "sentry")).toBe("failed");
      expect(await host.engineCalls()).toHaveLength(0);
      expect(await host.reports()).toEqual([]);
    }

    const host = await discovered([noToken("unavailable", "no")], [found(["never"])], GRANT);

    expect(await stateOf(host, "sentry")).toBe("unavailable");
  });

  it("asks for a new token after a 401, retries once with it, and reports nothing", async () => {
    const host = await discovered(
      [ok(TOKEN), ok(NEXT)],
      [unauthorized(), found(["issues"])],
      GRANT,
    );

    expect(await stateOf(host, "sentry")).toBe("connected");
    expect(await host.tokenAsks()).toEqual([
      { environment: expect.any(String), server: "sentry" },
      { environment: expect.any(String), server: "sentry", stale: TOKEN },
    ]);
    expect(await sent(host)).toEqual([`Bearer ${TOKEN}`, `Bearer ${NEXT}`]);
    expect(await host.reports()).toEqual([]);
  });

  it("is `failed`, not `rejected` or `sign_in`, when a renewed token is refused too", async () => {
    const host = await discovered(
      [ok(TOKEN), ok(NEXT)],
      [unauthorized(), failedWith({ _tag: "SignInRequired", message: "401", rejected: false })],
      GRANT,
    );

    expect(await stateOf(host, "sentry")).toBe("failed");
    expect((await host.servers({ parts: [] })).servers[0]?.error).toContain(
      "refused the access token its client credentials gave",
    );
    expect(await host.reports()).toEqual([]);
  });

  it("is `failed` when the Registry hands the same token again, which is what it does after one renewal", async () => {
    const host = await discovered([ok(TOKEN)], [unauthorized(), found(["never"])], GRANT);

    expect(await stateOf(host, "sentry")).toBe("failed");
    expect(await host.engineCalls()).toHaveLength(1);
    expect(await host.reports()).toEqual([]);
  });

  it("is `failed`, not `sign_in`, for a 403 for more scope, which names the scope and the setting, and is not reported", async () => {
    const host = await discovered(
      [ok(TOKEN)],
      [failedWith({ _tag: "StepUpRequired", message: "403", scope: "write" })],
      GRANT,
    );

    expect(await stateOf(host, "sentry")).toBe("failed");
    expect((await host.servers({ parts: [] })).servers[0]?.error).toMatch(
      /scope write.*oauth\.scope/,
    );
    expect(await host.reports()).toEqual([]);
  });

  it("keeps no token in the storage, the log or a span", async () => {
    const host = await discovered(
      [ok(TOKEN), ok(NEXT)],
      [unauthorized(), found(["issues"])],
      GRANT,
    );

    for (const secret of [TOKEN, NEXT]) {
      expect(await host.dump()).not.toContain(secret);
      expect(await host.observed()).not.toContain(secret);
    }
  });
});
