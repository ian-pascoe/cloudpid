// The host's resource requests over real Durable Object SQLite and a scripted engine (`docs/architecture/
// mcp-in-a-session.md` → Resource tools; `docs/architecture/mcp-connections.md` → The list cache): a Modern server's page
// kept for its `ttlMs` and a Legacy one's never; what the cache is keyed by and dropped with; and a read's SHA-256, its
// questions and its bound.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off globalTimers:off newPromise:off
// The engine's answers are written as they cross the edge, encoded, so their failures are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import type {
  EraRow,
  McpApplySet,
  McpEngineDiscoverResult,
  McpEngineRequestResult,
  McpHostResourceRequest,
  McpSetEntry,
} from "@cloudpid/mcp/types";
import { env } from "cloudflare:workers";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { describe, expect, it } from "vitest";
import type { EngineScript, TestMcpHost } from "./host.fixture.ts";
import { DAY_MS } from "./time.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_HOSTS: DurableObjectNamespace<TestMcpHost>;
    }
  }
}

let counter = 0;

const freshHost = () => env.MCP_HOSTS.getByName(`mcp:resources${counter++}`);

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

type Era = EraRow;

const MODERN: Era = { v: 1, era: "modern", version: "2026-07-28", discover: {}, probedAt: 1 };
const LEGACY: Era = { v: 1, era: "legacy", version: "2025-11-25", probedAt: 1 };

/** A discovery that found a server with resources, in `era`. */
const found = (era: Era = MODERN): EngineScript => ({
  // SAFETY: a discovered answer, encoded as the engine sends it.
  result: {
    kind: "discovered",
    era: era.era,
    protocolVersion: era.version,
    capabilities: { resources: {} },
    tools: [],
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    state: { era },
  } as typeof McpEngineDiscoverResult.Encoded,
});

/** A server in a host's set, discovered (the era the engine found is kept as its era row). */
const hostWith = async (
  era: Era = MODERN,
  more: ReadonlyArray<McpSetEntry> = [],
  docs: McpSetEntry = entry("docs"),
) => {
  const host = freshHost();
  const entries = [docs, ...more];

  await host.apply(setOf(...entries));

  for (const each of entries) await host.scriptEngine(urlOf(each.name), [found(era)]);

  await host.requestStart({
    caller: { session: "s-1", conversation: "1", workspace: "ws:w-1" },
    waitFor: entries.map((each) => each.name),
    waitMs: 5000,
  });

  return host;
};

const CTX = {
  origin: "agent",
  callId: "call-1",
  session: "s-1",
  conversation: "1",
  workspace: "ws:w-1",
} as const;

const list = (
  cursor?: string,
  op: "resources/list" | "resources/templates/list" = "resources/list",
  server = "docs",
): typeof McpHostResourceRequest.Encoded => ({
  op,
  server,
  params: cursor === undefined ? {} : { cursor },
  ctx: CTX,
});

const read = (uri: string, server = "docs"): typeof McpHostResourceRequest.Encoded => ({
  op: "resources/read",
  server,
  params: { uri },
  ctx: CTX,
});

/** A request the engine completed with `value`, and its cache hints. */
const completed = (
  value: Schema.Json,
  hints: {
    readonly ttlMs?: number;
    readonly cacheable?: boolean;
    readonly era?: Era;
    readonly sha256?: string;
  } = {},
): typeof McpEngineRequestResult.Encoded => {
  const answer: Mutable<
    Extract<typeof McpEngineRequestResult.Encoded, { readonly kind: "complete" }>
  > = {
    kind: "complete",
    result: { kind: "inline", value },
    cacheable: hints.cacheable ?? true,
    fetchedAt: Date.now(),
    state: {},
  };

  if (hints.ttlMs !== undefined) answer.ttlMs = hints.ttlMs;

  if (hints.sha256 !== undefined) answer.sha256 = hints.sha256;

  if (hints.era !== undefined) answer.state = { era: hints.era };

  return answer;
};

/** A page the engine answers: the server's own `ListResourcesResult`, and its cache hints. */
const page = (
  names: ReadonlyArray<string>,
  hints: Parameters<typeof completed>[1] & { readonly nextCursor?: string } = {},
): typeof McpEngineRequestResult.Encoded => {
  const resources = names.map((name) => ({ uri: `file:///${name}`, name }));

  return completed(
    hints.nextCursor === undefined ? { resources } : { resources, nextCursor: hints.nextCursor },
    hints,
  );
};

const script = (host: Host, ...results: ReadonlyArray<typeof McpEngineRequestResult.Encoded>) =>
  host.scriptRequest(
    urlOf("docs"),
    results.map((result) => ({ op: "resources/list_page", result })),
  );

const Named = Schema.Struct({ name: Schema.String });

const Listing = Schema.Struct({ resources: Named.pipe(Schema.Array, Schema.optionalKey) });

const decodeListing = Schema.decodeUnknownOption(Listing);

/** What a host answered a request: its tag, and the names of the resources it listed, if it listed. */
const listed = async (host: Host, input: typeof McpHostResourceRequest.Encoded) => {
  const answer = await host.request(input, {});

  if (!Predicate.isTagged(answer, "Completed") || answer.result.kind !== "inline") {
    return { tag: answer._tag };
  }

  const value = Option.getOrUndefined(decodeListing(answer.result.value));

  return { tag: answer._tag, names: value?.resources?.map((each) => each.name) };
};

describe("a list a Modern server answered with a ttlMs", () => {
  it("is kept for the ttlMs, then asked again", async () => {
    const host = await hostWith();

    await script(host, page(["a"], { ttlMs: 60_000 }), page(["b"], { ttlMs: 60_000 }));

    expect(await listed(host, list())).toEqual({ tag: "Completed", names: ["a"] });
    expect(await listed(host, list())).toEqual({ tag: "Completed", names: ["a"] });
    expect(await host.engineRequests()).toHaveLength(1);

    await host.advance(59_000);

    expect(await listed(host, list())).toEqual({ tag: "Completed", names: ["a"] });
    expect(await host.engineRequests()).toHaveLength(1);

    await host.advance(2_000);

    expect(await listed(host, list())).toEqual({ tag: "Completed", names: ["b"] });
    expect(await host.engineRequests()).toHaveLength(2);
  });

  it("sends the engine one page, from its cursor, and keeps each cursor and each method apart", async () => {
    const host = await hostWith();

    await script(
      host,
      page(["a"], { ttlMs: 60_000, nextCursor: "1" }),
      page(["b"], { ttlMs: 60_000 }),
    );

    await host.scriptRequest(urlOf("docs"), [
      {
        op: "resources/templates/list_page",
        result: completed(
          { resourceTemplates: [{ uriTemplate: "x://{id}", name: "t" }] },
          { ttlMs: 60_000 },
        ),
      },
    ]);

    await listed(host, list());
    await listed(host, list("1"));
    await listed(host, list(undefined, "resources/templates/list"));
    await listed(host, list());
    await listed(host, list("1"));
    await listed(host, list(undefined, "resources/templates/list"));

    expect((await host.engineRequests()).map(({ request }) => request)).toMatchObject([
      { op: "resources/list_page" },
      { op: "resources/list_page", cursor: "1" },
      { op: "resources/templates/list_page" },
    ]);
  });

  it("is not kept without a ttlMs, with a ttlMs of 0, or marked uncacheable", async () => {
    const host = await hostWith();

    await script(
      host,
      page(["a"]),
      page(["a"], { ttlMs: 0 }),
      page(["a"], { ttlMs: 60_000, cacheable: false }),
    );

    for (let asked = 1; asked <= 3; asked++) {
      await listed(host, list());
      expect(await host.engineRequests()).toHaveLength(asked);
    }
  });

  it("is kept at most 24 hours, whatever the server said", async () => {
    const host = await hostWith();

    await script(host, page(["a"], { ttlMs: 7 * DAY_MS }), page(["b"], { ttlMs: 7 * DAY_MS }));

    await listed(host, list());
    await host.advance(DAY_MS - 1_000);

    expect(await listed(host, list())).toEqual({ tag: "Completed", names: ["a"] });

    await host.advance(2_000);

    expect(await listed(host, list())).toEqual({ tag: "Completed", names: ["b"] });
  });

  it("is not kept when it came as a stream, which the host passes on unread", async () => {
    const host = await hostWith();

    await host.scriptRequest(urlOf("docs"), [
      {
        op: "resources/list_page",
        result: page(["a"], { ttlMs: 60_000 }),
        streamBytes: 2 * 1024 * 1024,
      },
      {
        op: "resources/list_page",
        result: page(["a"], { ttlMs: 60_000 }),
        streamBytes: 2 * 1024 * 1024,
      },
    ]);

    const first = await host.request(list(), {});
    const second = await host.request(list(), {});

    expect([first._tag, second._tag]).toEqual(["Completed", "Completed"]);
    expect(Predicate.isTagged(first, "Completed") && first.result.kind).toBe("stream");
    expect(await host.engineRequests()).toHaveLength(2);
  });

  it("is dropped when the server initializes again or speaks another protocol version", async () => {
    const host = await hostWith();

    // The first page is kept; a page of another cursor then comes back with a new era row: the server was probed again.
    await script(
      host,
      page(["a"], { ttlMs: 60_000, nextCursor: "1" }),
      page(["b"], { ttlMs: 60_000, era: { ...MODERN, probedAt: 2 } }),
      page(["a2"], { ttlMs: 60_000 }),
    );

    await listed(host, list());
    await listed(host, list("1"));

    expect(await listed(host, list())).toEqual({ tag: "Completed", names: ["a2"] });
    expect(await host.engineRequests()).toHaveLength(3);
  });

  it("is kept for the server's auth context only: another header value is another context", async () => {
    const host = await hostWith(MODERN, [], entry("docs", { headers: { "X-Key": "${KEY}" } }));

    await host.scriptValues("docs", {
      status: "values",
      env: {},
      headers: { "X-Key": "one" },
      missing: [],
    });

    await script(host, page(["one"], { ttlMs: 60_000 }), page(["two"], { ttlMs: 60_000 }));

    expect(await listed(host, list())).toEqual({ tag: "Completed", names: ["one"] });

    // A Variable or a Secret the header names changed: the same server, the same cursor, another principal.
    await host.scriptValues("docs", {
      status: "values",
      env: {},
      headers: { "X-Key": "two" },
      missing: [],
    });

    expect(await listed(host, list())).toEqual({ tag: "Completed", names: ["two"] });
    expect(await listed(host, list())).toEqual({ tag: "Completed", names: ["two"] });
    expect(await host.engineRequests()).toHaveLength(2);
  });
});

describe("a list a Legacy server answered", () => {
  it("is never kept, even with a ttlMs", async () => {
    const host = await hostWith(LEGACY);

    await script(host, page(["a"], { ttlMs: 60_000 }), page(["a"], { ttlMs: 60_000 }));

    await listed(host, list());
    await listed(host, list());

    expect(await host.engineRequests()).toHaveLength(2);
  });
});

describe("a read", () => {
  it("answers the server's result and the SHA-256 of its contents, and is never kept", async () => {
    const host = await hostWith();
    const sha256 = "ab".repeat(32);

    const contentsOf = (text: string) =>
      completed(
        { contents: [{ uri: "file:///notes", mimeType: "text/plain", text }] },
        { ttlMs: 60_000, sha256 },
      );

    await host.scriptRequest(urlOf("docs"), [
      { op: "resources/read", result: contentsOf("one") },
      { op: "resources/read", result: contentsOf("two") },
    ]);

    const first = await host.request(read("file:///notes"), {});
    const second = await host.request(read("file:///notes"), {});

    expect(first).toEqual({
      _tag: "Completed",
      result: {
        kind: "inline",
        value: { contents: [{ uri: "file:///notes", mimeType: "text/plain", text: "one" }] },
      },
      sha256,
    });
    expect(second).toMatchObject({ result: { value: { contents: [{ text: "two" }] } } });
    expect((await host.engineRequests()).map(({ request }) => request)).toMatchObject([
      { op: "resources/read", uri: "file:///notes" },
      { op: "resources/read", uri: "file:///notes" },
    ]);
  });

  it("passes what the caller can answer on to the engine, with its onInput, for a read only", async () => {
    const host = await hostWith();

    await host.scriptRequest(urlOf("docs"), [
      {
        op: "resources/read",
        result: completed({ contents: [] }),
      },
    ]);

    await script(host, page(["a"]));

    const answers = { elicitation: true, inputWaitMs: 1000 } as const;

    const onInput = () =>
      Promise.resolve({ kind: "answered", result: { action: "cancel" } } as const);

    await host.request({ ...read("file:///x"), ctx: { ...CTX, answers } }, { onInput });
    await host.request({ ...list(), ctx: { ...CTX, answers } }, { onInput });

    const [readSent, listSent] = await host.engineRequests();

    expect(readSent).toMatchObject({
      request: { op: "resources/read", ctx: { answers } },
      hooks: expect.arrayContaining(["onInput"]),
    });
    // The agent's read is no App's, whatever its URI: it has the 16 MiB every read has.
    expect(readSent?.request).not.toHaveProperty("app");
    expect(listSent?.request).not.toHaveProperty("ctx.answers");
  });

  it("is bound by the entry's timeout when that is under the 30 s of a read", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("docs", { timeout: 10 })));
    await host.scriptEngine(urlOf("docs"), [found()]);
    await host.requestStart({
      caller: { session: "s-1", conversation: "1", workspace: "ws:w-1" },
      waitFor: ["docs"],
      waitMs: 5000,
    });

    await host.scriptRequest(urlOf("docs"), [
      {
        op: "resources/read",
        result: completed({ contents: [] }),
      },
    ]);

    await host.request(read("file:///x"), {});

    const [sent] = await host.engineRequests();

    expect(sent?.target.timeoutMs).toBeLessThanOrEqual(10_000);
  });
});

describe("a request for resources the host refuses", () => {
  it("is UnknownServer for a name not in the set, and NotAllowed for a server switched off", async () => {
    const host = await hostWith(MODERN, [entry("off", { enabled: false })]);

    expect((await host.request(list(undefined, "resources/list", "nowhere"), {}))._tag).toBe(
      "UnknownServer",
    );
    expect((await host.request(list(undefined, "resources/list", "off"), {}))._tag).toBe(
      "NotAllowed",
    );
    expect(await host.engineRequests()).toHaveLength(0);
  });

  it("is NotAllowed when it is malformed", async () => {
    const host = await hostWith();

    const answer = await host.request(
      // SAFETY: a malformed request, as a Session that is wrong would send it.
      { op: "resources/read", server: "docs", params: {}, ctx: CTX } as never,
      {},
    );

    expect(answer._tag).toBe("NotAllowed");
  });
});

describe("a host whose storage refuses an operation under a resource request", () => {
  /** Whether a server new to the set is discovered: background work goes on only until a storage operation fails. */
  const discoversLater = async (host: Host) => {
    const before = (await host.engineCalls()).length;

    await host.accept();
    await host.apply(setOf(entry("docs"), entry("later")));
    await host.scriptEngine(urlOf("later"), [found()]);
    await host.requestStart({
      caller: { session: "s-1", conversation: "1", workspace: "ws:w-1" },
      waitFor: ["later"],
      waitMs: 300,
    });

    return (await host.engineCalls()).length > before;
  };

  it("answers HostFailed at a read it cannot make, and stops background work", async () => {
    const host = await hostWith();

    await script(host, page(["a"], { ttlMs: 1000 }));
    await host.refuse(["prior"]);

    expect((await host.request(list(), {}))._tag).toBe("HostFailed");
    expect(await discoversLater(host)).toBe(false);
  });

  it("stops background work at a write its engine round could not keep", async () => {
    const host = await hostWith();

    await script(host, page(["a"], { ttlMs: 1000 }));
    await host.refuse(["applyEngineState"]);

    await host.request(list(), {});

    expect(await discoversLater(host)).toBe(false);
  });
});
