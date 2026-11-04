// The host's Resource watches over real Durable Object SQLite and a scripted engine (`docs/architecture/
// mcp-in-a-session.md` → Resource watches; `docs/architecture/mcp-connections.md` → Listens): what a read with `watch`
// starts and refuses, what the listen's events mark, the gaps (a closed listen, an eviction, a Legacy session) checked
// by re-reading, the swap and the hold, the hash check, the 16 MiB abort, the caps, the 7-day expiry and every end.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off globalTimers:off newPromise:off
// The engine's answers are written as they cross the edge, encoded, so their failures are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import type {
  EraRow,
  McpApplySet,
  McpEngineDiscoverResult,
  McpEngineRequestResult,
  McpErrorWire,
  McpHostResourceRequest,
  McpSetEntry,
} from "@cloudpid/mcp/types";
import { abortAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { modernServer } from "@cloudpid/mcp/testing";
import { MCP_LARGE_RESULT_BYTES } from "@cloudpid/mcp/types";
import type { Mutable } from "effect/Types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineScript, TestMcpHost } from "./host.fixture.ts";
import { DAY_MS, MINUTE_MS } from "./time.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_HOSTS: DurableObjectNamespace<TestMcpHost>;
    }
  }
}

let counter = 0;

const freshHost = () => env.MCP_HOSTS.getByName(`mcp:watches${counter++}`);

type Host = ReturnType<typeof freshHost>;

const URL_OF_DOCS = "https://docs.example/mcp";

const entry = (name: string, hash = `hash-${name}`, conn = `conn-${name}`): McpSetEntry => ({
  name,
  source: { kind: "global" },
  server: { type: "http", url: `https://${name}.example/mcp`, headers: {} },
  hash,
  conn,
  identity: `identity-${name}`,
});

let revision = 1;

const setOf = (...entries: ReadonlyArray<McpSetEntry>): McpApplySet => ({
  kind: "set",
  hash: entries.map((each) => `${each.name}:${each.hash}`).join("|"),
  revision: revision++,
  entries,
});

const MODERN: EraRow = { v: 1, era: "modern", version: "2026-07-28", discover: {}, probedAt: 1 };
const LEGACY: EraRow = { v: 1, era: "legacy", version: "2025-11-25", probedAt: 1 };

const found = (era: EraRow): EngineScript => ({
  // SAFETY: a discovered answer, encoded as the engine sends it.
  result: {
    kind: "discovered",
    era: era.era,
    protocolVersion: era.version,
    capabilities: { resources: { subscribe: true } },
    tools: [],
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    state: { era },
  } as typeof McpEngineDiscoverResult.Encoded,
});

/** A host whose `docs` server was discovered, in `era`. */
const hostWith = async (era: EraRow = MODERN, docs: McpSetEntry = entry("docs")) => {
  const host = freshHost();

  await host.apply(setOf(docs));
  await host.scriptEngine(URL_OF_DOCS, [found(era)]);
  await host.requestStart({
    caller: { session: "s-1", conversation: "0", workspace: "ws:w-1" },
    waitFor: ["docs"],
    waitMs: 5000,
  });

  return host;
};

const callerOf = (conversation: string, session = "s-1") => ({
  session,
  conversation,
  workspace: "ws:w-1",
});

const ctxOf = (conversation: string, session = "s-1") =>
  ({ origin: "agent", callId: "call", session, conversation, workspace: "ws:w-1" }) as const;

/** A read of `uri` by `conversation`, watching, not watching, or neither. */
const read = (
  uri: string,
  watch: boolean | undefined = true,
  conversation = "1",
): typeof McpHostResourceRequest.Encoded => ({
  op: "resources/read",
  server: "docs",
  params: watch === undefined ? { uri } : { uri, watch },
  ctx: ctxOf(conversation),
});

/** What the engine answers a read with: its contents, hashed `sha256`; none says what a read with no contents says. */
const contents = (
  uri: string,
  sha256: string | undefined,
): typeof McpEngineRequestResult.Encoded => {
  const answer: Mutable<
    Extract<typeof McpEngineRequestResult.Encoded, { readonly kind: "complete" }>
  > = {
    kind: "complete",
    result: { kind: "inline", value: { contents: [{ uri, text: "text" }] } },
    cacheable: false,
    fetchedAt: Date.now(),
    state: {},
  };

  if (sha256 !== undefined) answer.sha256 = sha256;

  return answer;
};

const failure = (error: typeof McpErrorWire.Encoded): typeof McpEngineRequestResult.Encoded => ({
  kind: "failed",
  error,
  state: {},
});

const scriptReads = (
  host: Host,
  ...results: ReadonlyArray<typeof McpEngineRequestResult.Encoded>
) =>
  host.scriptRequest(
    URL_OF_DOCS,
    results.map((result) => ({ op: "resources/read", result })),
  );

/** Wait until `done` holds: the host's background work (a listen, a gap check) is not awaited by its caller. */
const until = async (done: () => Promise<boolean>) => {
  for (let tries = 0; tries < 200; tries++) {
    if (await done()) return;

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("The host did not get there");
};

const FILE = "file:///a.txt";

/** A watched `file:///a.txt` (baseline `aaa`) in a host whose listen is open. */
const watching = async (era: EraRow = MODERN) => {
  const host = await hostWith(era);

  await host.scriptListen(URL_OF_DOCS, [{ era: era.era }]);
  await scriptReads(host, contents(FILE, "aaa"));

  const answer = await host.request(read(FILE), {});

  expect(answer).toMatchObject({ _tag: "Completed", sha256: "aaa", watch: { started: true } });

  return host;
};

const marks = async (host: Host) => (await host.watchRows()).map((row) => [row.uri, row.mark]);

describe("a read with watch: true", () => {
  it("subscribes first, reads, and keeps the contents' SHA-256 as the baseline of an active watch", async () => {
    const host = await watching();

    expect(await host.listens()).toEqual([
      {
        url: URL_OF_DOCS,
        filter: {
          resourceSubscriptions: [FILE],
          toolsListChanged: true,
          promptsListChanged: true,
          resourcesListChanged: true,
        },
        stopped: false,
      },
    ]);
    expect(await host.watchRows()).toMatchObject([
      {
        session: "s-1",
        conversation: "1",
        server: "docs",
        uri: FILE,
        conn: "conn-docs",
        workspace: "",
        state: "active",
        hash: "aaa",
        mark: 0,
      },
    ]);
  });

  it("shares one listen between the watches on a server, adding a URI by opening the new one before closing the old", async () => {
    const host = await watching();

    await scriptReads(host, contents("file:///b.txt", "bbb"));

    const second = await host.request(read("file:///b.txt", true, "2"), {});

    expect(second).toMatchObject({ watch: { started: true } });

    const listens = await host.listens();

    expect(listens.map((each) => each.filter.resourceSubscriptions)).toEqual([
      [FILE],
      [FILE, "file:///b.txt"],
    ]);
    expect(listens.map((each) => each.stopped)).toEqual([true, false]);
    // A Modern swap has no gap: nothing was read again.
    expect(
      (await host.engineRequests()).filter((each) => each.request.op === "resources/read"),
    ).toHaveLength(2);
  });

  it("is refused up front by a server that cannot send updates: the contents still come, with why not", async () => {
    const host = await hostWith();

    await host.scriptListen(URL_OF_DOCS, [
      { failed: { _tag: "Unsupported", message: "The server cannot send updates" } },
    ]);
    await scriptReads(host, contents(FILE, "aaa"));

    expect(await host.request(read(FILE), {})).toMatchObject({
      _tag: "Completed",
      sha256: "aaa",
      watch: { started: false, reason: "not watched: The server cannot send updates" },
    });
    expect(await host.watchRows()).toEqual([]);
  });

  it("is refused for a URI the acknowledgement left out", async () => {
    const host = await hostWith();

    await host.scriptListen(URL_OF_DOCS, [{ honored: [] }]);
    await scriptReads(host, contents(FILE, "aaa"));

    expect(await host.request(read(FILE), {})).toMatchObject({
      watch: {
        started: false,
        reason: "not watched: the server does not send updates for this resource",
      },
    });
    expect(await host.watchRows()).toEqual([]);
  });

  it("drops the pending watch of a read that ended without contents", async () => {
    const host = await hostWith();

    await scriptReads(host, contents(FILE, undefined));

    expect(await host.request(read(FILE), {})).toMatchObject({
      watch: { started: false, reason: "not watched: the read did not complete" },
    });
    expect(await host.watchRows()).toEqual([]);

    await scriptReads(host, failure({ _tag: "NotFound", message: "No such resource" }));

    expect(await host.request(read(FILE), {})).toMatchObject({ _tag: "CallFailed" });
    expect(await host.watchRows()).toEqual([]);
    // The listen of the watch that never was is closed.
    expect((await host.listens()).every((each) => each.stopped)).toBe(true);
  });

  it("returns the contents with the watch not started when the host could not store the watch", async () => {
    const host = await hostWith();

    await host.refuse(["putWatch"]);
    await scriptReads(host, contents(FILE, "aaa"));

    expect(await host.request(read(FILE), {})).toMatchObject({
      _tag: "Completed",
      sha256: "aaa",
      watch: { started: false, reason: "not watched: the host could not store the watch" },
    });
    expect(await host.listens()).toEqual([]);
  });
});

describe("what a listen hears", () => {
  it("marks the watch of an updated URI changed, told once at the conversation's next request start", async () => {
    const host = await watching();

    await host.sendListenEvent(0, { kind: "resource_updated", uri: FILE });
    await until(async () => (await marks(host))[0]?.[1] === 1);

    // Another conversation is told nothing.
    expect((await host.requestStart({ caller: callerOf("2") })).watches).toEqual({
      changed: [],
      ended: [],
    });

    const told = await host.requestStart({ caller: callerOf("1") });

    expect(told.watches).toEqual({
      changed: [FILE],
      ended: [],
      changes: [{ server: "docs", uri: FILE, subUris: [], unchecked: false }],
    });
    expect((await host.requestStart({ caller: callerOf("1") })).watches).toEqual({
      changed: [],
      ended: [],
    });
  });

  it("keeps at most 3 sub-resource URIs of a watched directory, once each", async () => {
    const host = await hostWith();

    await host.scriptListen(URL_OF_DOCS, [{}]);
    await scriptReads(host, contents("file:///dir/", "ddd"));
    await host.request(read("file:///dir/"), {});

    for (const name of ["a", "b", "a", "c", "d"]) {
      await host.sendListenEvent(0, { kind: "resource_updated", uri: `file:///dir/${name}` });
    }

    await until(async () => (await host.watchRows())[0]?.subUris.length === 3);

    const { watches } = await host.requestStart({ caller: callerOf("1") });

    expect(watches.changes).toEqual([
      {
        server: "docs",
        uri: "file:///dir/",
        subUris: ["file:///dir/a", "file:///dir/b", "file:///dir/c"],
        unchecked: false,
      },
    ]);
  });

  it("clears the mark and makes a new baseline when the same conversation reads the URI again", async () => {
    const host = await watching();

    await host.sendListenEvent(0, { kind: "resource_updated", uri: FILE });
    await until(async () => (await marks(host))[0]?.[1] === 1);
    await scriptReads(host, contents(FILE, "bbb"));
    await host.request(read(FILE, undefined), {});

    expect(await host.watchRows()).toMatchObject([{ mark: 0, hash: "bbb", state: "active" }]);
    expect((await host.requestStart({ caller: callerOf("1") })).watches.changed).toEqual([]);
  });

  it("expires the inventory on a list change, so the next demand lists again", async () => {
    const host = await watching();
    const before = (await host.engineCalls()).length;

    await host.scriptEngine(URL_OF_DOCS, [found(MODERN)]);
    await host.sendListenEvent(0, { kind: "list_changed", list: "prompts" });
    await until(
      async () => (await host.servers({ names: ["docs"], parts: [] })).servers[0] !== undefined,
    );
    await host.requestStart({ caller: callerOf("0") });
    await until(async () => (await host.engineCalls()).length > before);
  });
});

describe("a gap", () => {
  it("is checked by re-reading when the listen reopens: a hash that differs marks the watch changed, one that matches does not", async () => {
    const host = await watching();

    await host.endListen(0);
    await until(async () => (await host.listens())[0]?.stopped === true);
    await scriptReads(host, contents(FILE, "bbb"));
    await host.requestStart({ caller: callerOf("1") });
    await until(async () => (await host.listens()).length === 2);
    await until(async () => (await marks(host))[0]?.[1] === 1);

    const reads = (await host.engineRequests()).filter(
      (each) => each.request.op === "resources/read",
    );

    // The re-read is the host's own, at no Container's expense.
    expect(reads.at(-1)?.request).toMatchObject({
      op: "resources/read",
      uri: FILE,
      ctx: { origin: "host" },
    });
    expect((await host.requestStart({ caller: callerOf("1") })).watches.changes).toEqual([
      { server: "docs", uri: FILE, subUris: [], unchecked: false },
    ]);

    // The agent reads it; the next gap finds the same contents.
    await scriptReads(host, contents(FILE, "bbb"));
    await host.request(read(FILE, undefined), {});
    await host.endListen(1);
    await scriptReads(host, contents(FILE, "bbb"));
    await host.requestStart({ caller: callerOf("1") });
    await until(async () => (await host.listens()).length === 3);
    await until(
      async () =>
        (await host.engineRequests()).filter((each) => each.request.op === "resources/read")
          .length === 4,
    );
    expect(await marks(host)).toEqual([[FILE, 0]]);
  });

  it("says a watch could not be checked when its re-read fails, a read over 16 MiB included", async () => {
    const host = await watching();

    await host.endListen(0);
    await until(async () => (await host.listens())[0]?.stopped === true);
    await scriptReads(
      host,
      failure({
        _tag: "TooLarge",
        message: "The answer is over 16 MiB and was dropped",
        limit: 16777216,
      }),
    );
    await host.requestStart({ caller: callerOf("1") });
    await until(async () => (await marks(host))[0]?.[1] === 2);

    expect((await host.requestStart({ caller: callerOf("1") })).watches.changes).toEqual([
      { server: "docs", uri: FILE, subUris: [], unchecked: true },
    ]);
  });

  it("re-reads in the background, bounded by the engine queue", async () => {
    const host = await hostWith();

    await host.scriptListen(URL_OF_DOCS, [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}]);

    for (let index = 0; index < 8; index++) {
      const uri = `file:///${index}`;

      await scriptReads(host, contents(uri, `h${index}`));
      await host.request(read(uri), {});
    }

    const latest = (await host.listens()).length - 1;

    await host.endListen(latest);
    await until(async () => (await host.listens()).at(-1)?.stopped === true);

    await host.scriptRequest(
      URL_OF_DOCS,
      Array.from({ length: 8 }, (_, index) => ({
        op: "resources/read",
        result: contents(`file:///${index}`, `h${index}`),
        hold: true,
      })),
    );
    await host.requestStart({ caller: callerOf("1") });
    await until(async () => (await host.heldCount(URL_OF_DOCS)) >= 3);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // At most 6 are asked at once; the engine's background queue (3) holds the rest for a slot.
    expect(await host.heldCount(URL_OF_DOCS)).toBe(3);

    for (let round = 0; round < 3; round++) {
      await host.release(URL_OF_DOCS);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await until(
      async () =>
        (await host.engineRequests()).filter((each) => each.request.op === "resources/read")
          .length === 16,
    );
  });
});

describe("the hold and the swap", () => {
  it("swaps a Modern listen older than 10 min at the next request start: the new one acknowledged before the old one closes, with no gap check", async () => {
    const host = await watching();

    await host.advance(11 * MINUTE_MS);
    await host.requestStart({ caller: callerOf("1") });
    await until(async () => (await host.listens()).length === 2);

    expect((await host.listens()).map((each) => each.stopped)).toEqual([true, false]);
    expect(
      (await host.engineRequests()).filter((each) => each.request.op === "resources/read"),
    ).toHaveLength(1);
  });

  it("closes a Legacy listen before opening the new one, and checks the gap", async () => {
    const host = await watching(LEGACY);

    await host.advance(11 * MINUTE_MS);
    await scriptReads(host, contents(FILE, "bbb"));
    await host.requestStart({ caller: callerOf("1") });
    await until(async () => (await host.listens()).length === 2);
    await until(async () => (await marks(host))[0]?.[1] === 1);

    expect((await host.listens()).map((each) => each.stopped)).toEqual([true, false]);
  });

  it("holds a listen only while a watching conversation has made a request in the last 15 min", async () => {
    const host = await watching();

    await host.advance(16 * MINUTE_MS);
    // Another conversation's request start sweeps what no watching conversation holds.
    await host.requestStart({ caller: callerOf("2") });

    expect((await host.listens()).map((each) => each.stopped)).toEqual([true]);
    // The watch stays: its conversation's next request start opens the listen again and checks the gap.
    expect(await marks(host)).toEqual([[FILE, 0]]);

    await scriptReads(host, contents(FILE, "aaa"));
    await host.requestStart({ caller: callerOf("1") });
    await until(async () => (await host.listens()).length === 2);
    await until(
      async () =>
        (await host.engineRequests()).filter((each) => each.request.op === "resources/read")
          .length === 2,
    );
    expect(await marks(host)).toEqual([[FILE, 0]]);
  });
});

describe("the hold timer", () => {
  it("closes a listen by itself 15 min after the last touch, with no sweep to do it", async () => {
    const host = await watching();

    expect((await host.listens()).map((each) => each.stopped)).toEqual([false]);

    // No request start or apply runs: only the timer, which the host's clock reaching its deadline wakes.
    await host.advanceAndWake(16 * MINUTE_MS);
    await until(async () => (await host.listens())[0]?.stopped === true);

    // The watch stays, as after a sweep: its conversation's next request start opens the listen again.
    expect(await marks(host)).toEqual([[FILE, 0]]);
  });

  it("does not close a listen that a request since then held", async () => {
    const host = await watching();

    await host.advanceAndWake(9 * MINUTE_MS);
    await host.requestStart({ caller: callerOf("1") });
    // 18 min after the listen opened, and 9 after the request: the timer wakes at the first deadline and sleeps on.
    await host.advanceAndWake(9 * MINUTE_MS);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect((await host.listens()).map((each) => each.stopped)).toEqual([false]);
  });
});

describe("the caps", () => {
  it("refuse a 21st watch of a conversation: the read still happens and says why", async () => {
    const host = await hostWith();

    await host.scriptListen(
      URL_OF_DOCS,
      Array.from({ length: 22 }, () => ({})),
    );

    for (let index = 0; index < 20; index++) {
      await scriptReads(host, contents(`file:///${index}`, `h${index}`));
      await host.request(read(`file:///${index}`), {});
    }

    await scriptReads(host, contents("file:///over", "hh"));

    expect(await host.request(read("file:///over"), {})).toMatchObject({
      _tag: "Completed",
      sha256: "hh",
      watch: {
        started: false,
        reason: "not watched: this conversation already has 20 Resource watches",
      },
    });
    expect(await host.watchRows()).toHaveLength(20);

    // Another conversation has its own 20.
    await scriptReads(host, contents("file:///other", "oo"));
    expect(await host.request(read("file:///other", true, "2"), {})).toMatchObject({
      watch: { started: true },
    });
  });

  it("refuse the 101st watch of an Environment", async () => {
    const host = await hostWith();

    await host.scriptListen(
      URL_OF_DOCS,
      Array.from({ length: 120 }, () => ({})),
    );

    for (let index = 0; index < 100; index++) {
      const uri = `file:///${index}`;

      await scriptReads(host, contents(uri, `h${index}`));
      await host.request(read(uri, true, `c${Math.floor(index / 20)}`), {});
    }

    expect(await host.watchRows()).toHaveLength(100);

    await scriptReads(host, contents("file:///over", "hh"));

    expect(await host.request(read("file:///over", true, "c9"), {})).toMatchObject({
      watch: {
        started: false,
        reason: "not watched: this Environment already has 100 Resource watches",
      },
    });
  });
});

describe("ends", () => {
  it("are noted for the conversation's next request start, once", async () => {
    const host = await watching();

    await host.advance(8 * DAY_MS);
    await host.setWatchRequestAt(FILE, 0);
    // The expiry: 7 days without a request, swept at `requestStart`, never by an alarm.
    const told = await host.requestStart({ caller: callerOf("1") });

    expect(told.watches).toEqual({
      changed: [],
      ended: [FILE],
      ends: [{ server: "docs", uri: FILE, reason: "not used for 7 days" }],
    });
    expect(await host.watchRows()).toEqual([]);
    expect((await host.requestStart({ caller: callerOf("1") })).watches.ended).toEqual([]);
    expect((await host.listens()).map((each) => each.stopped)).toEqual([true]);
  });

  it("include watch: false, which ends the watch and still reads, with no notice", async () => {
    const host = await watching();

    await scriptReads(host, contents(FILE, "aaa"));

    expect(await host.request(read(FILE, false), {})).toMatchObject({
      _tag: "Completed",
      sha256: "aaa",
    });
    expect(await host.watchRows()).toEqual([]);
    expect(await host.watchEnds()).toEqual([]);
    expect((await host.listens()).map((each) => each.stopped)).toEqual([true]);
  });

  it("include apply end_watches: the owner's ✕ is noted, a deleted Session's is silent", async () => {
    const host = await watching();

    await scriptReads(host, contents("file:///b.txt", "bbb"));
    await host.request(read("file:///b.txt", true, "2"), {});

    expect(
      await host.apply({
        kind: "end_watches",
        session: "s-1",
        conversation: "1",
        server: "docs",
        uri: FILE,
        reason: "ended by the owner",
      }),
    ).toEqual({ _tag: "WatchesEnded", ended: 1 });
    expect((await host.requestStart({ caller: callerOf("1") })).watches.ends).toEqual([
      { server: "docs", uri: FILE, reason: "ended by the owner" },
    ]);

    expect(await host.apply({ kind: "end_watches", session: "s-1", silent: true })).toEqual({
      _tag: "WatchesEnded",
      ended: 1,
    });
    expect(await host.watchRows()).toEqual([]);
    expect(await host.watchEnds()).toEqual([]);
    expect((await host.listens()).at(-1)?.stopped).toBe(true);
  });

  it("include a server that changed or left the set (server changed)", async () => {
    const host = await watching();

    await host.apply(setOf(entry("docs", "hash-docs-2", "conn-docs-2")));

    expect(await host.watchRows()).toEqual([]);
    expect((await host.requestStart({ caller: callerOf("1") })).watches.ends).toEqual([
      { server: "docs", uri: FILE, reason: "server changed" },
    ]);
    expect((await host.listens()).at(-1)?.stopped).toBe(true);
  });

  it("include the owner signing out of the server's MCP sign-in (signed out)", async () => {
    const host = await watching();

    await host.apply({ kind: "sign_ins", change: "signed_out", servers: ["docs"], revision: 1 });

    expect(await host.watchRows()).toEqual([]);
    expect((await host.requestStart({ caller: callerOf("1") })).watches.ends).toEqual([
      { server: "docs", uri: FILE, reason: "signed out" },
    ]);
  });

  it("include a wipe of the host, which closes every listen", async () => {
    const host = await watching();

    await host.apply({ kind: "destroy", revision: 99 });

    expect(await host.watchRows()).toEqual([]);
    expect((await host.listens()).at(-1)?.stopped).toBe(true);
  });
});

describe("a stdio server's watch", () => {
  const WORKSPACE = "ws:aaaa1111";
  const KEY = "stdio:local";

  const stdioHost = async () => {
    const host = freshHost();

    await host.apply(
      setOf({
        name: "local",
        source: { kind: "global" },
        server: { type: "stdio", command: "npx", args: ["-y", "some-server"], env: {} },
        hash: "hash-local",
        conn: "conn-local",
        identity: "identity-local",
      }),
    );
    await host.scriptEngine(KEY, [
      {
        // SAFETY: a discovered answer, encoded as the engine sends it.
        result: {
          kind: "discovered",
          era: "modern",
          protocolVersion: "2026-07-28",
          capabilities: { resources: {} },
          tools: [],
          prompts: [],
          problems: [],
          fetchedAt: Date.now(),
          state: { era: MODERN },
        } as typeof McpEngineDiscoverResult.Encoded,
      },
    ]);
    await host.requestStart({
      caller: { session: "s-1", conversation: "0", workspace: WORKSPACE },
      waitFor: ["local"],
      waitMs: 5000,
    });

    return host;
  };

  const stdioRead = (uri: string, watch?: boolean): typeof McpHostResourceRequest.Encoded => ({
    op: "resources/read",
    server: "local",
    params: watch === undefined ? { uri } : { uri, watch },
    ctx: { origin: "agent", session: "s-1", conversation: "1", workspace: WORKSPACE },
  });

  it("is held on the Workspace's process, listened to without starting the Container, and ends with it", async () => {
    const host = await stdioHost();

    await host.scriptListen(KEY, [{ spawn: "spawn-1" }]);
    await host.scriptRequest(KEY, [
      { op: "resources/read", result: { ...contents(FILE, "aaa"), spawn: "spawn-1" } },
    ]);

    expect(await host.request(stdioRead(FILE, true), {})).toMatchObject({
      watch: { started: true },
    });
    expect(await host.watchRows()).toMatchObject([
      { workspace: WORKSPACE, spawn: "spawn-1", state: "active" },
    ]);

    // The process was spawned again: its watches end, and are never resumed on the new one.
    await host.scriptRequest(KEY, [
      { op: "resources/read", result: { ...contents(FILE, "bbb"), spawn: "spawn-2" } },
    ]);
    await host.request(stdioRead(FILE), {});

    expect(await host.watchRows()).toEqual([]);
    expect((await host.requestStart({ caller: callerOf("1") })).watches.ends).toEqual([
      { server: "local", uri: FILE, reason: "server process ended" },
    ]);
    expect(await host.endedProcesses()).toEqual([
      { conn: "conn-local", workspace: WORKSPACE, spawn: "spawn-1" },
    ]);
    expect((await host.listens()).at(-1)?.stopped).toBe(true);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a host whose storage refuses an operation under a watch", () => {
  /** Whether a server new to the set is discovered: background work goes on only until a storage operation fails. */
  const discoversLater = async (host: Host) => {
    const before = (await host.engineCalls()).length;

    await host.accept();
    await host.apply(setOf(entry("docs"), entry("later")));
    await host.scriptEngine("https://later.example/mcp", [found(MODERN)]);
    await host.requestStart({
      caller: callerOf("1"),
      waitFor: ["later"],
      waitMs: 300,
    });

    return (await host.engineCalls()).length > before;
  };

  it("gives the contents and halts when the watch row cannot be stored", async () => {
    const host = await hostWith();

    await host.refuse(["putWatch"]);
    await scriptReads(host, contents(FILE, "aaa"));

    expect(await host.request(read(FILE), {})).toMatchObject({
      _tag: "Completed",
      watch: { started: false, reason: "not watched: the host could not store the watch" },
    });
    expect(await discoversLater(host)).toBe(false);
  });

  it("gives the contents and halts when the watches cannot be read", async () => {
    const host = await hostWith();

    await host.refuse(["watches"]);
    await scriptReads(host, contents(FILE, "aaa"));

    expect(await host.request(read(FILE), {})).toMatchObject({
      _tag: "Completed",
      sha256: "aaa",
      watch: { started: false, reason: "not watched: the host could not read its watches" },
    });
    expect(await discoversLater(host)).toBe(false);
  });

  it("answers the read of a watched resource and halts when its new baseline cannot be stored", async () => {
    const host = await watching();

    await host.refuse(["putWatch"]);
    await scriptReads(host, contents(FILE, "bbb"));

    expect(await host.request(read(FILE, undefined), {})).toMatchObject({
      _tag: "Completed",
      sha256: "bbb",
    });
    expect(await discoversLater(host)).toBe(false);
  });
});

describe("a gap check", () => {
  it("does not read again a watch already marked changed, nor mark it twice", async () => {
    const host = await watching();
    const other = "file:///b.txt";

    await scriptReads(host, contents(other, "bbb"));
    await host.request(read(other, true, "2"), {});

    // Conversation 1's watch is marked by an event (the listen that names both URIs is the newest one).
    await host.sendListenEvent(1, { kind: "resource_updated", uri: FILE });
    await until(async () => (await marks(host)).some(([uri, mark]) => uri === FILE && mark === 1));

    await host.endListen(1);
    await until(async () => (await host.listens())[1]?.stopped === true);

    const rereads = async () =>
      (await host.engineRequests()).filter((each) => each.request.op === "resources/read");

    const before = (await rereads()).length;

    await scriptReads(host, contents(other, "bbb"));
    await host.requestStart({ caller: callerOf("2") });
    await until(async () => (await host.listens()).length === 3);
    await until(async () => (await rereads()).length === before + 1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Only the unmarked watch's resource is read; the marked one is told as it was.
    expect(await rereads()).toHaveLength(before + 1);
    expect((await rereads()).at(-1)?.request).toMatchObject({ op: "resources/read", uri: other });
    expect(await marks(host)).toEqual([
      [FILE, 1],
      [other, 0],
    ]);
  });

  it("is made when a new host instance finds its listens gone, an eviction or a deploy", async () => {
    await watching();

    // The instance is aborted, as an eviction or a deploy ends it: the one that replaces it has the rows, and none of
    // the old one's memory (its stub is made again, as a caller's is).
    await abortAllDurableObjects();

    const host = env.MCP_HOSTS.getByName(`mcp:watches${counter - 1}`);

    await host.scriptListen(URL_OF_DOCS, [{}]);
    await scriptReads(host, contents(FILE, "bbb"));
    await host.requestStart({ caller: callerOf("1") });
    await until(async () => (await host.listens()).length === 1);
    await until(async () => (await marks(host))[0]?.[1] === 1);

    expect((await host.requestStart({ caller: callerOf("1") })).watches.changes).toEqual([
      { server: "docs", uri: FILE, subUris: [], unchecked: false },
    ]);
  });

  it("is made when a Legacy session ends, whose next listen initializes again", async () => {
    const host = await watching(LEGACY);

    // The server cut the GET stream (a 404 session): the listen is forgotten, and the core never reopens it.
    await host.endListen(0);
    await until(async () => (await host.listens())[0]?.stopped === true);
    await host.scriptListen(URL_OF_DOCS, [{ era: "legacy" }]);
    await scriptReads(host, contents(FILE, "bbb"));
    await host.requestStart({ caller: callerOf("1") });
    await until(async () => (await host.listens()).length === 2);
    await until(async () => (await marks(host))[0]?.[1] === 1);
  });

  it("cuts a re-read off at 16 MiB: the engine reads no more of the answer, and the watch is unchecked", async () => {
    const host = await watching();
    const total = MCP_LARGE_RESULT_BYTES + 8 * 1024 * 1024;

    const server = modernServer({
      resources: [
        {
          uri: FILE,
          name: "big",
          mimeType: "text/plain",
          contents: [{ uri: FILE, text: "x".repeat(total) }],
        },
      ],
    });

    // The server's answers arrive 64 KiB at a time, with no length: only the engine's count of bytes can stop it.
    let pulled = 0;

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await server.handle(new Request(input, init));
      const bytes = new Uint8Array(await response.arrayBuffer());
      let at = 0;

      const body = new ReadableStream<Uint8Array>(
        {
          pull: (controller) => {
            if (at >= bytes.length) return controller.close();

            const chunk = bytes.subarray(at, at + 64 * 1024);

            at += chunk.length;
            pulled += chunk.length;
            controller.enqueue(chunk);
          },
        },
        { highWaterMark: 0 },
      );

      const headers = new Headers(response.headers);

      headers.delete("content-length");

      return new Response(body, { status: response.status, headers });
    });

    await host.endListen(0);
    await until(async () => (await host.listens())[0]?.stopped === true);
    await host.useRealRequests();
    await host.requestStart({ caller: callerOf("1") });
    await until(async () => (await marks(host))[0]?.[1] === 2);

    expect(pulled).toBeGreaterThanOrEqual(MCP_LARGE_RESULT_BYTES);
    expect(pulled).toBeLessThan(MCP_LARGE_RESULT_BYTES + 2 * 1024 * 1024);
  });
});

describe("the 7-day expiry", () => {
  it("is swept at apply too: a watch no request touched for 7 days ends and is noted for its conversation", async () => {
    const host = await watching();

    await host.advance(8 * DAY_MS);
    await host.setWatchRequestAt(FILE, 0);
    await host.apply({ kind: "end_watches", session: "another-session" });

    expect(await host.watchRows()).toEqual([]);
    expect(await host.watchEnds()).toMatchObject([
      { session: "s-1", conversation: "1", uri: FILE, reason: "not used for 7 days" },
    ]);
    expect((await host.requestStart({ caller: callerOf("1") })).watches.ends).toEqual([
      { server: "docs", uri: FILE, reason: "not used for 7 days" },
    ]);
  });
});
