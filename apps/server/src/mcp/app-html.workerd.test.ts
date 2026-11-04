// App HTML in `McpHost` (`docs/architecture/mcp-apps.md` → Declaring and reading Apps; `mcp-connections.md` → Storage):
// read with an App tool's call when the inventory moved, kept by hash and deduplicated, evicted past 64 MiB, and served
// by `request({ op: "ui/html" })`. Over real Durable Object SQLite, a scripted engine and, once, the real one against a
// fixture App server. workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off newPromise:off globalTimers:off
// The engine's answers are written as they cross the edge, encoded, so their failures are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { appTool, APP_MIME_TYPE, modernServer } from "@cloudpid/mcp/testing";
import type {
  McpApplySet,
  McpEngineDiscoverResult,
  McpEngineRequestResult,
  McpHostRequestInput,
  McpHostToolCall,
  McpSetEntry,
} from "@cloudpid/mcp/types";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_APP_STORE_BYTES, openMcpHostStore } from "./store.ts";
import type { EngineScript, RequestScript, TestMcpHost } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_HOSTS: DurableObjectNamespace<TestMcpHost>;
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

let counter = 0;

const freshHost = () => env.MCP_HOSTS.getByName(`mcp:app${counter++}`);

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

const URI = "ui://docs/app";

/** A page read and marked mounted at `now`, as a mount's `ui/html` does it (`request.ts`'s `mountedPage`). */
const mounted = (store: ReturnType<typeof openMcpHostStore>, hash: string, now: number) => {
  const page = store.readApp(hash);

  if (page !== undefined) store.touchApp(hash, now);

  return page;
};

/** `echo`, `app` (whose App is `URI`) and `later` (whose App is `ui://docs/later`), as the server lists them. */
const TOOLS = [
  { name: "echo", inputSchema: { type: "object" } },
  { name: "app", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: URI } } },
  {
    name: "later",
    inputSchema: { type: "object" },
    _meta: { ui: { resourceUri: "ui://docs/later" } },
  },
] as const;

/** A discovery that found `TOOLS`. */
const found = (): EngineScript => ({
  // SAFETY: a discovered answer, encoded as the engine sends it.
  result: {
    kind: "discovered",
    era: "modern",
    protocolVersion: "2026-07-28",
    capabilities: { tools: {}, resources: {} },
    tools: TOOLS,
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    state: {
      era: { v: 1, era: "modern", version: "2026-07-28", discover: {}, probedAt: 1 },
    },
  } as typeof McpEngineDiscoverResult.Encoded,
});

const complete = (value: Schema.Json): typeof McpEngineRequestResult.Encoded => ({
  kind: "complete",
  result: { kind: "inline", value },
  cacheable: true,
  fetchedAt: Date.now(),
  state: {},
});

/** A completed `tools/call`. */
const called: RequestScript = { result: complete({ content: [{ type: "text", text: "ok" }] }) };

/** The `resources/read` answer: `items` as the server's `contents`. */
const read = (...items: ReadonlyArray<Record<string, Schema.Json>>): RequestScript => ({
  op: "resources/read",
  result: complete({ contents: items }),
});

/** The `resources/read` answer as the engine returns it past 1 MiB: a stream of the JSON text of `items`. */
const streamedRead = (
  items: ReadonlyArray<Record<string, Schema.Json>>,
  rest: Partial<RequestScript> = {},
): RequestScript => ({
  op: "resources/read",
  result: complete({}),
  streamJson: { contents: items },
  ...rest,
});

/** A content item holding `text` as an App's HTML, with the rest of its fields. */
const page = (text: string, rest: Record<string, Schema.Json> = {}) => ({
  uri: URI,
  mimeType: APP_MIME_TYPE,
  text,
  ...rest,
});

const CTX = {
  origin: "agent",
  callId: "call-1",
  session: "s-1",
  conversation: "1",
  workspace: "ws:w-1",
} as const;

const callTool = (server: string, tool: string): typeof McpHostToolCall.Encoded => ({
  op: "tools/call",
  server,
  params: { name: tool, arguments: { q: "x" } },
  ctx: CTX,
});

const htmlOf = (
  server: string,
  params: { readonly hash: string } | { readonly uri: string },
): typeof McpHostRequestInput.Encoded => ({ op: "ui/html", server, params, ctx: CTX });

/** A host whose set is `entries`, each discovered with `TOOLS`. */
const discovered = async (...entries: ReadonlyArray<McpSetEntry>) => {
  const host = freshHost();

  await host.apply(setOf(...entries));

  for (const each of entries) await host.scriptEngine(urlOf(each.name), [found()]);

  await host.requestStart({
    caller: { session: "s-1", conversation: "1", workspace: "ws:w-1" },
    waitFor: entries.map((each) => each.name),
    waitMs: 5000,
  });

  return host;
};

const requestsOf = async (host: Host, op: string) =>
  (await host.engineRequests()).filter((each) => each.request.op === op);

const completedWith = async (host: Host, tool: string) => {
  const answer = await host.request(callTool("docs", tool), {});

  if (!Predicate.isTagged(answer, "Completed"))
    throw new Error(`not completed: ${JSON.stringify(answer)}`);

  return answer;
};

/** Waits until the host keeps `pages` pages of HTML. */
const keeping = (host: Host, pages: number) =>
  waitFor(async () => expect(await host.appPages()).toHaveLength(pages));

/** Waits until the engine was given `count` reads. */
const readsGiven = (host: Host, count: number) =>
  waitFor(async () => expect(await requestsOf(host, "resources/read")).toHaveLength(count));

const pause = () => new Promise((resolve) => setTimeout(resolve, 150));

/** A read the engine fails. */
const readFailed: RequestScript = {
  op: "resources/read",
  result: {
    kind: "failed",
    error: { _tag: "ServerError", message: "no such resource", code: -32002 },
    state: {},
  },
};

/** A discovery whose server is Legacy and has no session: each connection `initialize`s. */
const foundLegacy = (): EngineScript => {
  const script = found();

  // SAFETY: the same discovered answer, as a Legacy server with no session row.
  return {
    result: {
      ...script.result,
      era: "legacy",
      protocolVersion: "2025-11-25",
      state: { era: { v: 1, era: "legacy", version: "2025-11-25", probedAt: 1 } },
    } as typeof McpEngineDiscoverResult.Encoded,
  };
};

/** What an App's origin is named by: 26 lowercase base32 characters (`view-hash.ts`). */
const VIEW_HASH = /^[a-z2-7]{26}$/;

/** `vi.waitFor` with a wait that a loaded machine does not run out of. */
const waitFor = <A>(check: () => A | Promise<A>) => vi.waitFor(check, { timeout: 8000 });

describe("an App tool's call", () => {
  it("starts the read beside the call, keeps the page by hash, and the next call answers its hash", async () => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [
      called,
      read(
        page("<p>hi</p>", {
          _meta: { ui: { prefersBorder: true, csp: { connectDomains: ["https://a.test"] } } },
        }),
      ),
      called,
    ]);

    await completedWith(host, "app");
    await keeping(host, 1);

    const [kept] = await host.appPages();
    const next = await completedWith(host, "app");

    // With the hash that names the server's origin, which its record pins.
    expect(next.app).toEqual({ htmlHash: kept?.hash, viewHash: expect.stringMatching(VIEW_HASH) });
    expect(kept?.bytes).toBe("<p>hi</p>".length);
    expect(await requestsOf(host, "tools/call")).toHaveLength(2);
    expect(await requestsOf(host, "resources/read")).toEqual([
      expect.objectContaining({
        request: { op: "resources/read", uri: URI, app: true, ctx: expect.anything() },
      }),
    ]);

    // The page is served by its hash, with what the View is mounted with.
    expect(await host.request(htmlOf("docs", { hash: next.app?.htmlHash ?? "" }), {})).toEqual({
      _tag: "AppHtml",
      hash: kept?.hash,
      html: "<p>hi</p>",
      meta: { prefersBorder: true, csp: { connectDomains: ["https://a.test"] } },
      viewHash: expect.stringMatching(VIEW_HASH),
    });
  });

  it("names the origin of the server that asks, though a page is kept by content and shared", async () => {
    const host = await discovered(entry("docs"), entry("other"));

    await host.scriptRequest(urlOf("docs"), [read(page("<p>same</p>"))]);
    await host.scriptRequest(urlOf("other"), [read(page("<p>same</p>"))]);

    const [docs, other] = await Promise.all([
      host.request(htmlOf("docs", { uri: URI }), {}),
      host.request(htmlOf("other", { uri: URI }), {}),
    ]);

    if (!Predicate.isTagged(docs, "AppHtml") || !Predicate.isTagged(other, "AppHtml")) {
      throw new Error(JSON.stringify([docs, other]));
    }

    // One page, kept once; each server's own origin.
    expect(other.hash).toBe(docs.hash);
    expect(docs.viewHash).toMatch(VIEW_HASH);
    expect(other.viewHash).toMatch(VIEW_HASH);
    expect(other.viewHash).not.toBe(docs.viewHash);

    // The same by hash, as a mount of a record does it.
    expect(await host.request(htmlOf("docs", { hash: docs.hash }), {})).toMatchObject({
      viewHash: docs.viewHash,
    });

    expect(await host.request(htmlOf("other", { hash: docs.hash }), {})).toMatchObject({
      viewHash: other.viewHash,
    });
  });

  it("answers `app` when the page was kept by the time the call is done, and never waits for it", async () => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [{ ...called, hold: true }, read(page("<p>fast</p>"))]);

    const pending = completedWith(host, "app");

    // The read lands while the call is still with the server.
    await keeping(host, 1);
    await host.release(urlOf("docs"));

    expect((await pending).app?.htmlHash).toBe((await host.appPages())[0]?.hash);
  });

  it("is never held up by a read that hangs, which goes on and keeps the page when it ends", async () => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [called, { ...read(page("<p>slow</p>")), hold: true }]);

    const answer = await completedWith(host, "app");

    expect(answer.app).toBeUndefined();
    await readsGiven(host, 1);
    expect(await host.appPages()).toEqual([]);

    await host.release(urlOf("docs"));
    await keeping(host, 1);
  });

  it("does not delay another server's mount by a read that hangs", async () => {
    const host = await discovered(entry("docs"), entry("other"));

    await host.scriptRequest(urlOf("docs"), [called, { ...read(page("<p>hung</p>")), hold: true }]);
    await host.scriptRequest(urlOf("other"), [read(page("<p>other</p>"))]);

    await completedWith(host, "app");
    await readsGiven(host, 1);

    // The first server's read is still with its server; the other's mount is answered.
    expect(await host.request(htmlOf("other", { uri: URI }), {})).toMatchObject({
      _tag: "AppHtml",
      html: "<p>other</p>",
    });
    expect(await host.appPages()).toHaveLength(1);

    await host.release(urlOf("docs"));
    await keeping(host, 2);
  });

  it("ends the read it started when the caller aborts the call, and does not hold it against the server", async () => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [
      { ...called, hold: true },
      { ...read(page("<p>never</p>")), hold: true },
    ]);

    let abort = () => {};

    const aborted = new Promise<void>((resolve) => {
      abort = resolve;
    });

    const pending = host.request(callTool("docs", "app"), { untilAborted: () => aborted });

    await readsGiven(host, 1);
    abort();

    expect(await pending).toMatchObject({ _tag: "CallFailed", error: { _tag: "Cut" } });

    // The read was cancelled, and no failure of the server's: the next call reads again, though a minute has not passed.
    await host.scriptRequest(urlOf("docs"), [called, read(page("<p>again</p>"))]);
    await completedWith(host, "app");
    await keeping(host, 1);
    expect(await requestsOf(host, "resources/read")).toHaveLength(2);
  });

  it("keeps a read for a mount that joined it when the call that started it aborts", async () => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [
      { ...called, hold: true },
      { ...read(page("<p>first</p>")), hold: true },
    ]);

    let abort = () => {};

    const aborted = new Promise<void>((resolve) => {
      abort = resolve;
    });

    const pending = host.request(callTool("docs", "app"), { untilAborted: () => aborted });

    await readsGiven(host, 1);

    const mounting = host.request(htmlOf("docs", { uri: URI }), {});

    await pause();
    expect(await requestsOf(host, "resources/read")).toHaveLength(1);

    // The starter's abort ends its read, not the mount's: the mount reads once more.
    await host.scriptRequest(urlOf("docs"), [read(page("<p>second</p>"))]);
    abort();

    expect(await pending).toMatchObject({ _tag: "CallFailed", error: { _tag: "Cut" } });
    expect(await mounting).toMatchObject({ _tag: "AppHtml", html: "<p>second</p>" });
    expect(await requestsOf(host, "resources/read")).toHaveLength(2);
  });

  it("reads nothing for a tool with no App, and nothing again while the inventory has not moved", async () => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [called, called, called, read(page("<p>hi</p>"))]);

    expect((await completedWith(host, "echo")).app).toBeUndefined();
    expect(await requestsOf(host, "resources/read")).toEqual([]);

    await completedWith(host, "app");
    await keeping(host, 1);

    const second = await completedWith(host, "app");

    expect(second.app).toEqual({
      htmlHash: (await host.appPages())[0]?.hash,
      viewHash: expect.stringMatching(VIEW_HASH),
    });
    expect(await requestsOf(host, "resources/read")).toHaveLength(1);
    expect(await host.appUiRows()).toEqual([
      { conn: "conn-docs", uri: URI, hash: second.app?.htmlHash, version: expect.any(String) },
    ]);
  });

  it("reads again when the inventory's version has moved", async () => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [
      called,
      read(page("<p>one</p>")),
      called,
      read(page("<p>two</p>")),
    ]);

    await completedWith(host, "app");
    await keeping(host, 1);

    // A server joining the set moves the inventory's version.
    await host.apply(setOf(entry("docs"), entry("other")));
    await completedWith(host, "app");
    await keeping(host, 2);

    expect(await requestsOf(host, "resources/read")).toHaveLength(2);
  });

  it("keeps a page once however many URIs give it, and apart when its declaration differs", async () => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [
      called,
      read(page("<p>same</p>")),
      called,
      read(page("<p>same</p>", { uri: "ui://docs/later" })),
    ]);

    await completedWith(host, "app");
    await keeping(host, 1);
    await completedWith(host, "later");
    await waitFor(async () => expect(await host.appUiRows()).toHaveLength(2));

    expect(await host.appPages()).toHaveLength(1);

    await host.apply(setOf(entry("docs"), entry("other")));
    await host.scriptRequest(urlOf("docs"), [
      called,
      read(page("<p>same</p>", { _meta: { ui: { domain: "d.test" } } })),
    ]);
    await completedWith(host, "app");
    await keeping(host, 2);
  });

  it("is answered without `app` when the read fails, and a call after it does not read until the version moves or a minute passes", async () => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [called, readFailed, called, called, called]);

    const answer = await completedWith(host, "app");

    expect(answer.result).toEqual({
      kind: "inline",
      value: { content: [{ type: "text", text: "ok" }] },
    });
    expect(answer.app).toBeUndefined();
    await readsGiven(host, 1);

    // A broken App server costs the next calls nothing.
    expect((await completedWith(host, "app")).app).toBeUndefined();
    await pause();
    expect(await requestsOf(host, "resources/read")).toHaveLength(1);

    // A minute later it is tried again.
    await host.advance(61_000);
    await host.scriptRequest(urlOf("docs"), [read(page("<p>healed</p>"))]);
    await completedWith(host, "app");
    await keeping(host, 1);
    expect(await requestsOf(host, "resources/read")).toHaveLength(2);
  });

  it("tries a failed read again once the inventory's version has moved", async () => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [called, readFailed, called, read(page("<p>ok</p>"))]);
    await completedWith(host, "app");
    await readsGiven(host, 1);

    await host.apply(setOf(entry("docs"), entry("other")));
    await completedWith(host, "app");
    await keeping(host, 1);
  });

  it("is read again by a mount whose call's read failed, whatever the backoff", async () => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [called, readFailed]);
    await completedWith(host, "app");
    await readsGiven(host, 1);
    await pause();

    await host.scriptRequest(urlOf("docs"), [read(page("<p>late</p>"))]);

    const mounted = await host.request(htmlOf("docs", { uri: URI }), {});

    expect(mounted).toMatchObject({ _tag: "AppHtml", html: "<p>late</p>", meta: {} });

    // The call that follows finds it kept for this inventory.
    await host.scriptRequest(urlOf("docs"), [called]);
    expect((await completedWith(host, "app")).app?.htmlHash).toBe(
      Predicate.isTagged(mounted, "AppHtml") ? mounted.hash : undefined,
    );
    expect(await requestsOf(host, "resources/read")).toHaveLength(2);
  });

  it("reads a page once for the calls and the mount that want it at the same time", async () => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [
      called,
      called,
      called,
      { ...read(page("<p>once</p>")), hold: true },
    ]);

    const calls = [
      completedWith(host, "app"),
      completedWith(host, "app"),
      completedWith(host, "app"),
    ];

    await Promise.all(calls);
    await readsGiven(host, 1);

    const mounting = host.request(htmlOf("docs", { uri: URI }), {});

    await pause();
    expect(await requestsOf(host, "resources/read")).toHaveLength(1);

    await host.release(urlOf("docs"));

    expect(await mounting).toMatchObject({ _tag: "AppHtml", html: "<p>once</p>" });
    expect(await requestsOf(host, "resources/read")).toHaveLength(1);
    expect(await host.appPages()).toHaveLength(1);
  });

  it("decodes one streamed answer at a time in the host: the second request is sent, and its decode waits for the first", async () => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [
      called,
      called,
      streamedRead([page("<p>a</p>")], { holdStream: true }),
      streamedRead([page("<p>b</p>", { uri: "ui://docs/later" })]),
    ]);

    await completedWith(host, "app");
    await completedWith(host, "later");
    await readsGiven(host, 2);
    await pause();

    // Both reads have their answers; the first holds the slot at its first pull, and the second has not pulled.
    expect(await host.streamPulls()).toBe(1);
    expect(await host.appPages()).toEqual([]);

    await host.releaseStreams();
    await keeping(host, 2);
    expect(await requestsOf(host, "resources/read")).toHaveLength(2);
  });

  it("decodes an answer that is inline with no slot, though a streamed one holds it", async () => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [
      called,
      called,
      streamedRead([page("<p>a</p>")], { holdStream: true }),
      read(page("<p>b</p>", { uri: "ui://docs/later" })),
    ]);

    await completedWith(host, "app");
    await completedWith(host, "later");

    // The inline one is kept while the streamed one is still held.
    await keeping(host, 1);
    expect((await host.appPages())[0]?.bytes).toBe("<p>b</p>".length);

    await host.releaseStreams();
    await keeping(host, 2);
  });

  it("reads after the call, not beside it, from a Legacy server with no session", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("docs")));
    await host.scriptEngine(urlOf("docs"), [foundLegacy()]);
    await host.requestStart({
      caller: { session: "s-1", conversation: "1", workspace: "ws:w-1" },
      waitFor: ["docs"],
      waitMs: 5000,
    });
    await host.scriptRequest(urlOf("docs"), [
      { ...called, hold: true },
      read(page("<p>after</p>")),
    ]);

    const pending = completedWith(host, "app");

    await waitFor(async () => expect(await requestsOf(host, "tools/call")).toHaveLength(1));
    await pause();

    // The call holds the server's only connection that `initialize`d: the read has not been sent.
    expect(await requestsOf(host, "resources/read")).toEqual([]);

    await host.release(urlOf("docs"));
    await pending;
    await keeping(host, 1);
  });
});

describe("what an App's read must hold", () => {
  const answered = async (script: RequestScript) => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [script]);

    return { host, answer: await host.request(htmlOf("docs", { uri: URI }), {}) };
  };

  it("takes a blob of base64 UTF-8 as the HTML", async () => {
    const { answer } = await answered(
      read({ uri: URI, mimeType: APP_MIME_TYPE, blob: btoa("<p>blob</p>") }),
    );

    expect(answer).toMatchObject({ _tag: "AppHtml", html: "<p>blob</p>" });
  });

  it.each([
    ["none", read()],
    ["two", read(page("<p>a</p>"), page("<p>b</p>"))],
    [
      "one whose MIME type is not exactly the App's",
      read(page("<p>a</p>", { mimeType: "text/html" })),
    ],
    ["one with no MIME type", read({ uri: URI, text: "<p>a</p>" })],
    ["one with both text and a blob", read(page("<p>a</p>", { blob: btoa("<p>a</p>") }))],
    ["one with neither", read({ uri: URI, mimeType: APP_MIME_TYPE })],
    [
      "one whose blob is not base64 UTF-8",
      read({ uri: URI, mimeType: APP_MIME_TYPE, blob: "////" }),
    ],
  ])("refuses %s content item(s), and keeps nothing", async (_name, script) => {
    const { host, answer } = await answered(script);

    expect(answer).toMatchObject({ _tag: "CallFailed", error: { _tag: "ProtocolViolation" } });
    expect(await host.appPages()).toEqual([]);
  });

  it("refuses HTML over 4 MiB, and takes exactly 4 MiB", async () => {
    const over = await answered(read(page("x".repeat(4 * 1024 * 1024 + 1))));

    expect(over.answer).toMatchObject({ _tag: "CallFailed", error: { _tag: "TooLarge" } });
    expect(await over.host.appPages()).toEqual([]);

    const exact = await answered(read(page("y".repeat(4 * 1024 * 1024))));

    expect(exact.answer).toMatchObject({ _tag: "AppHtml" });
    expect(await exact.host.appPages()).toEqual([
      { hash: expect.any(String), bytes: 4 * 1024 * 1024 },
    ]);
  });

  it("takes `_meta.ui` from the content item, else from the resource's listing entry, and keeps only what it knows", async () => {
    const own = await answered(
      read(
        page("<p>a</p>", {
          _meta: {
            ui: { prefersBorder: false, domain: "own.test", csp: "not an object", extra: 1 },
          },
        }),
      ),
    );

    expect(own.answer).toMatchObject({ meta: { prefersBorder: false, domain: "own.test" } });
    expect(JSON.stringify(own.answer)).not.toContain("extra");
    expect(JSON.stringify(own.answer)).not.toContain("not an object");

    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [
      read(page("<p>b</p>")),
      {
        op: "resources/list",
        result: complete([
          { uri: "ui://docs/other", name: "other", _meta: { ui: { domain: "wrong.test" } } },
          { uri: URI, name: "app", _meta: { ui: { prefersBorder: true } } },
        ]),
      },
    ]);

    expect(await host.request(htmlOf("docs", { uri: URI }), {})).toMatchObject({
      _tag: "AppHtml",
      meta: { prefersBorder: true },
    });
  });

  it("serves no page for a hash it does not hold, and refuses a server it does not have", async () => {
    const host = await discovered(entry("docs"));

    expect(await host.request(htmlOf("docs", { hash: "0".repeat(64) }), {})).toMatchObject({
      _tag: "NoAppHtml",
    });
    expect(await host.request(htmlOf("nowhere", { hash: "x" }), {})).toMatchObject({
      _tag: "UnknownServer",
    });
    expect(await host.request(htmlOf("nowhere", { uri: URI }), {})).toMatchObject({
      _tag: "UnknownServer",
    });
  });

  it("reads a URI by the full checks: a server that may be called, and a URI some listed tool declares", async () => {
    const host = await discovered(entry("docs"), entry("off", { enabled: false }));

    expect(await host.request(htmlOf("off", { uri: URI }), {})).toMatchObject({
      _tag: "NotAllowed",
    });

    for (const uri of [
      "file:///etc/passwd",
      "ui://docs/undeclared",
      `ui://docs/${"x".repeat(2048)}`,
    ]) {
      expect(await host.request(htmlOf("docs", { uri }), {})).toMatchObject({
        _tag: "NotAllowed",
      });
    }

    expect(await requestsOf(host, "resources/read")).toEqual([]);
  });

  it("serves a kept page by hash to a server that is hidden or waiting for a sign-in: nothing remote is touched", async () => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [read(page("<p>kept</p>"))]);

    const mounted = await host.request(htmlOf("docs", { uri: URI }), {});

    if (!Predicate.isTagged(mounted, "AppHtml")) throw new Error(JSON.stringify(mounted));

    const byHash = htmlOf("docs", { hash: mounted.hash });

    // Switched off by Exposure `hidden`: its calls are refused, its Views still mount.
    await host.apply(setOf({ ...entry("docs", { exposure: "hidden" }), hash: "hash-hidden" }));
    expect(await host.request(callTool("docs", "app"), {})).toMatchObject({ _tag: "NotAllowed" });
    expect(await host.request(byHash, {})).toMatchObject({ _tag: "AppHtml", html: "<p>kept</p>" });

    // Waiting for a sign-in.
    await host.apply(setOf({ ...entry("docs"), hash: "hash-visible" }));
    await runInDurableObject(host, async (_instance: TestMcpHost, state) => {
      openMcpHostStore(state.storage).putStatus({
        conn: "conn-docs",
        state: "sign_in",
        since: 1,
        failures: 0,
      });
    });
    expect(await host.request(callTool("docs", "app"), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "SignInRequired" },
    });
    expect(await host.request(byHash, {})).toMatchObject({ _tag: "AppHtml", html: "<p>kept</p>" });
  });

  it("takes a blob over the 3 MiB a slice of base64 is decoded in", async () => {
    const html = `<p>${"é".repeat(1_900_000)}</p>`;
    const bytes = new TextEncoder().encode(html);
    let binary = "";

    for (const byte of bytes) binary += String.fromCharCode(byte);

    const { answer } = await answered(
      read({ uri: URI, mimeType: APP_MIME_TYPE, blob: btoa(binary) }),
    );

    expect(answer).toMatchObject({ _tag: "AppHtml", html });
  });
});

describe("the App store", () => {
  const pageOf = (name: string, bytes: number) => ({
    hash: `hash-${name}`,
    html: name.padEnd(bytes, "x"),
    meta: {},
  });

  it("evicts the least recently mounted past 64 MiB, never the page just written, and prunes the rows that named it", async () => {
    const host = freshHost();

    await runInDurableObject(host, async (_instance: TestMcpHost, state) => {
      const store = openMcpHostStore(state.storage);
      const size = 4 * 1024 * 1024;

      // Sixteen pages fill the bound exactly.
      for (let at = 0; at < 16; at++) {
        store.putApp("conn", `ui://app/${at}`, "v1", pageOf(`p${at}`, size), 1000 + at);
      }

      expect(MAX_APP_STORE_BYTES).toBe(16 * size);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM mcp_app_html_meta").one()).toEqual({
        n: 16,
      });

      // Mounting the oldest makes it the most recent: the next one in line goes when another page comes.
      expect(mounted(store, "hash-p0", 5000)?.html.length).toBe(size);

      store.putApp("conn", "ui://app/16", "v1", pageOf("p16", size), 6000);

      expect(mounted(store, "hash-p1", 7000)).toBeUndefined();
      expect(mounted(store, "hash-p0", 7000)).toBeDefined();
      expect(mounted(store, "hash-p16", 7000)).toBeDefined();
      expect(store.appUi("conn", "ui://app/1")).toBeUndefined();
      expect(store.appUi("conn", "ui://app/0")).toEqual({ hash: "hash-p0", version: "v1" });
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM mcp_app_ui").one()).toEqual({
        n: 16,
      });
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM mcp_app_html WHERE hash = 'hash-p1'")
          .one(),
      ).toEqual({ n: 0 });

      // A page over the bound alone is still kept, and takes every older one with it.
      store.putApp("conn", "ui://app/big", "v1", pageOf("big", 4 * 1024 * 1024), 8000);
      store.putApp("conn", "ui://app/big2", "v1", pageOf("big2", 4 * 1024 * 1024), 9000);

      expect(mounted(store, "hash-big2", 9500)).toBeDefined();
    });
  });

  it("stores a page in chunks and reads it back whole, multi-byte text included", async () => {
    const host = freshHost();

    await runInDurableObject(host, async (_instance: TestMcpHost, state) => {
      const store = openMcpHostStore(state.storage);
      const html = `<p>${"é€😀".repeat(500_000)}</p>`;

      store.putApp("conn", URI, "v1", { hash: "h", html, meta: { domain: "d.test" } }, 1);

      expect(
        Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM mcp_app_html").one()["n"]),
      ).toBeGreaterThan(1);
      expect(mounted(store, "h", 2)).toEqual({ hash: "h", html, meta: { domain: "d.test" } });
    });
  });

  it("goes with its `conn` when the set drops it, though the pages stay for the records that pin them", async () => {
    const host = freshHost();

    await runInDurableObject(host, async (_instance: TestMcpHost, state) => {
      const store = openMcpHostStore(state.storage);

      store.putStatus({
        conn: "conn-gone",
        state: "connected",
        since: 1,
        failures: 0,
      });
      store.putApp("conn-gone", URI, "v1", pageOf("a", 10), 1);
      const day = 24 * 60 * 60 * 1000;

      // The `conn` leaves: its status is kept for a revert, and so is the page it read.
      store.pruneOutsideSet(["conn-other"], day);

      expect(store.appUi("conn-gone", URI)).toBeDefined();

      // Past the retention its status goes, and the page it read with it.
      store.pruneOutsideSet(["conn-other"], 40 * day);

      expect(store.appUi("conn-gone", URI)).toBeUndefined();
      expect(mounted(store, "hash-a", 3)).toBeDefined();
    });
  });
});

describe("against a fixture App server", () => {
  const EVICTED = 17;

  /** The App server: an `app` tool with its HTML, a twin with the same HTML, one whose declaration differs, and many large ones. */
  const appServer = () =>
    modernServer({
      resources: [
        {
          uri: URI,
          name: "app",
          mimeType: APP_MIME_TYPE,
          contents: [
            {
              uri: URI,
              mimeType: APP_MIME_TYPE,
              text: "<main>fixture</main>",
              _meta: { ui: { prefersBorder: true } },
            },
          ],
        },
        {
          uri: "ui://docs/twin",
          name: "twin",
          mimeType: APP_MIME_TYPE,
          contents: [
            {
              uri: "ui://docs/twin",
              mimeType: APP_MIME_TYPE,
              text: "<main>fixture</main>",
              _meta: { ui: { prefersBorder: true } },
            },
          ],
        },
        {
          uri: "ui://docs/bordered",
          name: "bordered",
          mimeType: APP_MIME_TYPE,
          contents: [
            {
              uri: "ui://docs/bordered",
              mimeType: APP_MIME_TYPE,
              text: "<main>fixture</main>",
              _meta: { ui: { prefersBorder: false } },
            },
          ],
        },
        ...Array.from({ length: EVICTED }, (_, at) => ({
          uri: `ui://docs/big${at}`,
          name: `big${at}`,
          mimeType: APP_MIME_TYPE,
          // Made at each read: one 4 MiB page is alive at a time, whatever the server keeps.
          contents: () => [
            {
              uri: `ui://docs/big${at}`,
              mimeType: APP_MIME_TYPE,
              text: `<!-- ${at} -->`.padEnd(4 * 1024 * 1024, "x"),
            },
          ],
        })),
      ],
      moreTools: [
        appTool("app", URI),
        appTool("twin", "ui://docs/twin"),
        appTool("bordered", "ui://docs/bordered"),
        ...Array.from({ length: EVICTED }, (_, at) => appTool(`big${at}`, `ui://docs/big${at}`)),
      ],
    });

  /** A host over the real engine, whose outbound `fetch`es reach `server`, with its set discovered. */
  const overFixture = async (server: ReturnType<typeof appServer>) => {
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      server.handle(new Request(input, init)),
    );

    const host = freshHost();

    await host.useRealEngine();
    await host.apply(setOf(entry("docs")));
    await host.requestStart({
      caller: { session: "s-1", conversation: "1", workspace: "ws:w-1" },
      waitFor: ["docs"],
      waitMs: 5000,
    });

    return host;
  };

  const callApp = async (host: Host, tool: string) => {
    const answer = await host.request(
      {
        op: "tools/call",
        server: "docs",
        params: { name: tool, arguments: { text: "hi" } },
        ctx: CTX,
      },
      {},
    );

    if (!Predicate.isTagged(answer, "Completed")) throw new Error(JSON.stringify(answer));

    return answer;
  };

  it("reads the App's HTML through the real engine beside the call, and serves it by hash", async () => {
    const server = appServer();
    const host = await overFixture(server);

    const answer = await callApp(host, "app");

    expect(answer.result).toMatchObject({
      kind: "inline",
      value: { content: [{ type: "text", text: "hi" }] },
    });
    await keeping(host, 1);

    const hash = (await host.appPages())[0]?.hash ?? "";

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await host.request(htmlOf("docs", { hash }), {})).toEqual({
      _tag: "AppHtml",
      viewHash: expect.stringMatching(VIEW_HASH),
      hash,
      html: "<main>fixture</main>",
      meta: { prefersBorder: true },
    });
    expect((await callApp(host, "app")).app).toEqual({
      htmlHash: hash,
      viewHash: expect.stringMatching(VIEW_HASH),
    });
    expect(server.received.filter((each) => each.rpc?.method === "resources/read")).toHaveLength(1);
  });

  it("keeps one page for two URIs that give the same HTML and declaration, and another where the declaration differs", async () => {
    const host = await overFixture(appServer());

    await callApp(host, "app");
    await keeping(host, 1);
    await callApp(host, "twin");
    await waitFor(async () => expect(await host.appUiRows()).toHaveLength(2));

    expect(await host.appPages()).toHaveLength(1);

    await callApp(host, "bordered");
    await keeping(host, 2);
  });

  it("evicts the least recently mounted pages past 64 MiB, and a mount's read of one brings it back", async () => {
    const host = await overFixture(appServer());
    const hashes: Array<string> = [];

    for (let at = 0; at < EVICTED; at++) {
      await callApp(host, `big${at}`);
      await waitFor(async () =>
        expect(await host.appUiRows()).toHaveLength(at + 1 > 16 ? 16 : at + 1),
      );

      hashes.push(
        (await host.appUiRows()).find((row) => row.uri === `ui://docs/big${at}`)?.hash ?? "",
      );
    }

    // Sixteen pages of 4 MiB are the bound: the first one, mounted longest ago, went when the last came.
    expect(await host.appPages()).toHaveLength(16);
    expect(await host.request(htmlOf("docs", { hash: hashes[0] ?? "" }), {})).toMatchObject({
      _tag: "NoAppHtml",
    });
    expect(
      await host.request(htmlOf("docs", { hash: hashes[EVICTED - 1] ?? "" }), {}),
    ).toMatchObject({
      _tag: "AppHtml",
    });

    // Its mount reads it again by URI, and the least recently mounted of the rest goes.
    expect(await host.request(htmlOf("docs", { uri: "ui://docs/big0" }), {})).toMatchObject({
      _tag: "AppHtml",
      hash: hashes[0],
    });
    expect(await host.appPages()).toHaveLength(16);
  });
});
