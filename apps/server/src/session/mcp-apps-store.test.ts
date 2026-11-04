// The Session's App records over plain key-value storage (`docs/architecture/mcp-apps.md` → App records): kept in parts
// and listed, bounded to 1 MiB each and 32 MiB together with the least recently mounted evicted to a stub, the counts that
// cap them, what a Fork or Clone carries, and the Secrets redacted from what is kept.
// @effect-diagnostics asyncFunction:off globalDate:off strictEffectProvide:off missedPipeableOpportunity:off newPromise:off globalTimers:off -- plain fixtures.
import { Secrets } from "@cloudpid/extensions/secrets";
import {
  MAX_MCP_APP_RECORDS,
  MAX_MCP_APP_STUBS,
  type McpAppDraft,
  type McpAppEntry,
  type McpAppHtmlAnswer,
  type McpAppTool,
} from "@cloudpid/protocol";
import type { McpAppHtmlInput } from "@cloudpid/extensions/mcp";
import type { ConversationId } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";
import { McpApps, type McpAppsService } from "./mcp-apps.ts";
import { type McpAppsStorage, sessionMcpApps } from "./mcp-apps-store.ts";

const MiB = 1024 * 1024;

// SAFETY: a conversation's ID is a positive integer; the tests name 1 and 2.
const conversation = (id: number) => id as ConversationId;

/** Storage in a map, which also says how many values it holds. */
const memory = (): McpAppsStorage & { readonly size: () => number } => {
  const values = new Map<string, unknown>();

  return {
    // SAFETY: the store reads back what it put, under the same key.
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key, value) => {
      values.set(key, structuredClone(value));
    },
    delete: (key) => values.delete(key),
    size: () => values.size,
  };
};

/** The Secrets, of which the store reads `refresh` and `redact` only: `redact` replaces `secret`. */
const fakeSecrets = (secret: string) =>
  Layer.succeed(
    Secrets,
    // SAFETY: the store reads `refresh` and `redact` only, so the rest of the service is left out.
    {
      refresh: Effect.void,
      redact: <A>(value: A): A =>
        JSON.parse(JSON.stringify(value).replaceAll(secret, "[REDACTED]")),
    } as Secrets["Service"],
  );

/** A store over `storage` with a clock the test moves, and the Secrets it redacts `secret` with. */
const open = (storage: McpAppsStorage = memory(), secret = "s3cret") => {
  let clock = 1;

  const store = sessionMcpApps({
    storage,
    sockets: { getWebSockets: () => [] },
    html: () => Effect.succeed({ status: "missing", message: "none" }),
    now: () => clock,
  });

  const service: McpAppsService = Effect.runSync(
    Effect.service(McpApps).pipe(Effect.provide(Layer.provide(store.layer, fakeSecrets(secret)))),
  );

  return {
    service,
    storage,
    /** Move the clock on: mounts and writes after it are later than those before. */
    tick: () => {
      clock += 1;
    },
  };
};

const draft = (
  callId: string,
  size = 100,
  more: Partial<McpAppDraft> = {},
  convo = "1",
): McpAppDraft => ({
  callId,
  server: "docs",
  tool: "page",
  conversation: convo,
  arguments: { text: "hi" },
  htmlHash: `hash-${callId}`,
  result: {
    content: [{ type: "text", text: "ok" }],
    structuredContent: { blob: "a".repeat(size) },
  },
  ...more,
});

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect);

const statesOf = (entries: ReadonlyArray<McpAppEntry>) =>
  Arr.map(entries, (entry) => `${entry.callId}:${entry.state}`);

describe("the Session's App records", () => {
  it("keeps a record, lists it and mounts it, whole, beside the call's arguments and result", async () => {
    const { service } = open();

    await run(service.put(draft("call-1", 10)));

    expect(await run(service.list(conversation(1)))).toEqual([
      expect.objectContaining({ callId: "call-1", server: "docs", tool: "page", state: "kept" }),
    ]);
    expect(await run(service.list(conversation(2)))).toEqual([]);

    const mounted = await run(service.mount("call-1"));

    expect(mounted).toMatchObject({
      status: "record",
      record: {
        callId: "call-1",
        arguments: { text: "hi" },
        htmlHash: "hash-call-1",
        result: { structuredContent: { blob: "aaaaaaaaaa" } },
        audit: [],
      },
    });
    expect(await run(service.mount("nope"))).toEqual({ status: "none" });
  });

  it("redacts the Secrets held from what it keeps", async () => {
    const { service } = open();

    await run(
      service.put(
        draft("call-1", 1, {
          arguments: { token: "the s3cret" },
          result: { content: [{ type: "text", text: "key s3cret" }] },
        }),
      ),
    );

    const mounted = await run(service.mount("call-1"));

    expect(JSON.stringify(mounted)).not.toContain("s3cret");
    expect(JSON.stringify(mounted)).toContain("[REDACTED]");
  });

  it("keeps a record of several parts whole, and a replaced one leaves none behind", async () => {
    const storage = memory();
    const { service } = open(storage);

    await run(service.put(draft("big", 900 * 1024)));

    const mounted = await run(service.mount("big"));

    expect(mounted).toMatchObject({
      status: "record",
      record: { result: { structuredContent: { blob: "a".repeat(900 * 1024) } } },
    });

    const withParts = storage.size();

    await run(service.put(draft("big", 10)));

    expect(storage.size()).toBeLessThan(withParts);
    expect(await run(service.list(conversation(1)))).toHaveLength(1);
  });

  it("bounds a record to 1 MiB, marking it cut", async () => {
    const { service } = open();

    await run(service.put(draft("huge", 2 * MiB)));

    const [entry] = await run(service.list(conversation(1)));
    const mounted = await run(service.mount("huge"));

    expect(entry).toMatchObject({ state: "kept", truncated: true });
    expect(mounted).toMatchObject({ status: "record", record: { truncated: true } });
    expect(JSON.stringify(mounted).length).toBeLessThan(MiB + 4096);
  });

  it("evicts the least recently mounted record past 32 MiB to a stub, which still mounts as one", async () => {
    const { service, tick } = open();
    const size = 1_000_000;

    for (let at = 1; at <= 33; at++) {
      await run(service.put(draft(`call-${at}`, size)));
      tick();
    }

    // Everything fits so far: 33 of 1,000,000 bytes is under 32 MiB.
    expect(Arr.every(await run(service.list(conversation(1))), (e) => e.state === "kept")).toBe(
      true,
    );

    // The first call is mounted again, so it is the most recently mounted, and the second the least.
    expect(await run(service.mount("call-1"))).toMatchObject({ status: "record" });
    tick();
    await run(service.put(draft("call-34", size)));

    const listed = await run(service.list(conversation(1)));

    expect(Arr.filter(statesOf(listed), (each) => each.endsWith("evicted"))).toEqual([
      "call-2:evicted",
    ]);
    expect(await run(service.mount("call-2"))).toEqual({
      status: "stub",
      stub: {
        callId: "call-2",
        server: "docs",
        tool: "page",
        conversation: "1",
        at: expect.any(Number),
      },
    });
    expect(await run(service.mount("call-1"))).toMatchObject({ status: "record" });
    expect(await run(service.mount("call-34"))).toMatchObject({ status: "record" });
  });

  it("keeps a lone record of its own bound, and never evicts the one it just wrote", async () => {
    const { service } = open();

    await run(service.put(draft("only", 2 * MiB)));
    await run(service.put(draft("next", 2 * MiB)));

    const listed = await run(service.list(conversation(1)));

    expect(Arr.every(listed, (entry) => entry.state === "kept")).toBe(true);
  });

  it("caps the records at 1000 and the stubs at 2000, the oldest first", async () => {
    const { service, tick } = open();
    const total = MAX_MCP_APP_RECORDS + MAX_MCP_APP_STUBS + 5;

    for (let at = 0; at < total; at++) {
      await run(service.put(draft(`c${at}`, 1)));
      tick();
    }

    const listed = await run(service.list(conversation(1)));
    const kept = Arr.filter(listed, (entry) => entry.state === "kept");

    expect(kept).toHaveLength(MAX_MCP_APP_RECORDS);
    expect(listed).toHaveLength(MAX_MCP_APP_RECORDS + MAX_MCP_APP_STUBS);
    // The five oldest stubs are gone: they read as no record at all.
    expect(await run(service.mount("c0"))).toEqual({ status: "none" });
    expect(await run(service.mount("c5"))).toMatchObject({ status: "stub" });
    expect(await run(service.mount(`c${total - 1}`))).toMatchObject({ status: "record" });
  });

  it("serves a page by hash only when a record pins it, through the host for the record's server", async () => {
    const asked: Array<unknown> = [];
    const storage = memory();

    const store = sessionMcpApps({
      storage,
      sockets: { getWebSockets: () => [] },
      html: (input) =>
        Effect.sync(() => {
          asked.push(input);

          return { status: "missing", message: "gone" };
        }),
    });

    const service = Effect.runSync(
      Effect.service(McpApps).pipe(
        Effect.provide(Layer.provide(store.layer, fakeSecrets("s3cret"))),
      ),
    );

    expect(await run(service.html("hash-call-1"))).toMatchObject({ status: "missing" });
    expect(asked).toEqual([]);

    await run(service.put(draft("call-1", 1)));
    expect(await run(service.html("hash-call-1"))).toEqual({ status: "missing", message: "gone" });
    expect(asked).toEqual([
      { server: "docs", hash: "hash-call-1", callId: "call-1", conversation: "1" },
    ]);
  });

  it("puts the origin of the page's View on its answer, built from the host's view and never from anything the page sends", async () => {
    const bare = { status: "html" as const, hash: "hash-call-1", html: "<p>hi</p>", meta: {} };

    const page = (view?: string): McpAppHtmlAnswer =>
      view === undefined ? bare : { ...bare, view };

    const answered = async (
      answer: McpAppHtmlAnswer,
      viewOrigin: (view: string) => string,
    ): Promise<McpAppHtmlAnswer> => {
      const store = sessionMcpApps({
        storage: memory(),
        sockets: { getWebSockets: () => [] },
        html: () => Effect.succeed(answer),
        viewOrigin,
      });

      const service = Effect.runSync(
        Effect.service(McpApps).pipe(
          Effect.provide(Layer.provide(store.layer, fakeSecrets("s3cret"))),
        ),
      );

      await run(service.put(draft("call-1", 1)));

      return run(service.html("hash-call-1"));
    };

    const origin = (view: string) => `https://${view}.ianpascoe.app`;

    expect(await answered(page("abcd"), origin)).toEqual({
      ...page("abcd"),
      origin: "https://abcd.ianpascoe.app",
    });

    // A host that gave no view (an older one, or a source it does not know) gives the page no origin to be shown at.
    expect(await answered(page(), origin)).toEqual(page());

    // An origin that cannot be built (a bad label) leaves none, rather than failing the page.
    expect(
      await answered(page("abcd"), () => {
        throw new Error("no host");
      }),
    ).toEqual(page("abcd"));

    expect(await answered({ status: "failed", message: "no" }, origin)).toEqual({
      status: "failed",
      message: "no",
    });
  });

  describe("the page of a call's record", () => {
    const page = (hash: string): McpAppHtmlAnswer => ({
      status: "html",
      hash,
      html: "<p>hi</p>",
      meta: {},
      view: "abcd",
    });

    /** A call's draft whose page the host had not kept when it ended. */
    const noHash = (callId: string): McpAppDraft => {
      const { htmlHash: _pinned, ...rest } = draft(callId, 1);

      return rest;
    };

    const docsPage: McpAppTool = {
      name: "mcp__docs__page",
      server: "docs",
      tool: "page",
      uri: "ui://docs/page",
      visibility: ["model", "app"],
    };

    /** A store whose host answers `answer` and notes what it was asked. */
    const hosted = (answer: (input: McpAppHtmlInput) => McpAppHtmlAnswer) => {
      const asked: McpAppHtmlInput[] = [];

      const store = sessionMcpApps({
        storage: memory(),
        sockets: { getWebSockets: () => [] },
        html: (input) =>
          Effect.sync(() => {
            asked.push(input);

            return answer(input);
          }),
        viewOrigin: (view) => `https://${view}.ianpascoe.app`,
      });

      const service = Effect.runSync(
        Effect.service(McpApps).pipe(
          Effect.provide(Layer.provide(store.layer, fakeSecrets("s3cret"))),
        ),
      );

      return { asked, service, store };
    };

    it("is read through the pinned hash, for the call's own server, with its origin", async () => {
      const { asked, service } = hosted((input) => page("hash" in input ? input.hash : "x"));

      await run(service.put(draft("call-1", 1)));

      expect(await run(service.pageOf("call-1"))).toEqual({
        ...page("hash-call-1"),
        origin: "https://abcd.ianpascoe.app",
      });
      expect(asked).toEqual([
        { server: "docs", hash: "hash-call-1", callId: "call-1", conversation: "1" },
      ]);
    });

    it("is read by the URI the tool declares when the record pins no hash, and then pinned to the record", async () => {
      const { asked, service, store } = hosted((input) => page("uri" in input ? "found" : "x"));

      store.service.setTools([docsPage]);
      await run(service.put(noHash("call-1")));

      expect((await run(service.mount("call-1"))).status).toBe("record");
      expect(await run(service.pageOf("call-1"))).toMatchObject({ status: "html", hash: "found" });
      expect(asked).toEqual([
        { server: "docs", uri: "ui://docs/page", callId: "call-1", conversation: "1" },
      ]);

      // The mount after it is by the hash, and the record keeps everything else it had.
      expect(await run(service.mount("call-1"))).toMatchObject({
        status: "record",
        record: {
          htmlHash: "found",
          arguments: { text: "hi" },
          result: { content: [expect.anything()] },
        },
      });
      expect(await run(service.list(conversation(1)))).toEqual([
        expect.objectContaining({ callId: "call-1", htmlHash: "found" }),
      ]);

      await run(service.pageOf("call-1"));
      expect(asked.at(-1)).toEqual({
        server: "docs",
        hash: "found",
        callId: "call-1",
        conversation: "1",
      });
    });

    it("reads again by the URI when the host no longer keeps the pinned page", async () => {
      const { asked, service, store } = hosted((input) =>
        "hash" in input ? { status: "missing", message: "evicted" } : page("again"),
      );

      store.service.setTools([docsPage]);
      await run(service.put(draft("call-1", 1)));

      expect(await run(service.pageOf("call-1"))).toMatchObject({ status: "html", hash: "again" });
      expect(Arr.map(asked, (input) => ("hash" in input ? "hash" : "uri"))).toEqual([
        "hash",
        "uri",
      ]);
    });

    it("is missing for a call it has no record of", async () => {
      const { asked, service } = hosted(() => page("x"));

      await run(service.put(draft("call-1", 1)));
      expect(await run(service.pageOf("nope"))).toMatchObject({ status: "missing" });
      expect(asked).toEqual([]);
    });

    it("is missing, never read, when no tool of the server declares the App any more", async () => {
      const { asked, service, store } = hosted(() => page("x"));

      store.service.setTools([{ ...docsPage, server: "other" }]);
      await run(service.put(noHash("call-1")));

      expect(await run(service.pageOf("call-1"))).toMatchObject({ status: "missing" });
      expect(asked).toEqual([]);
    });

    it("pins nothing when the host fails, and passes its reason on", async () => {
      const { service, store } = hosted(() => ({ status: "failed", message: "server said no" }));

      store.service.setTools([docsPage]);
      await run(service.put(noHash("call-1")));

      expect(await run(service.pageOf("call-1"))).toEqual({
        status: "failed",
        message: "server said no",
      });
      const mounted = await run(service.mount("call-1"));

      expect(mounted).toMatchObject({ status: "record" });
      expect(JSON.stringify(mounted)).not.toContain("htmlHash");
    });
  });

  it("copies the records of the calls a Fork holds, and those nested in them, and a stub as a stub", async () => {
    const source = open();
    const size = 1_000_000;

    // `call-0` is evicted by the 33 that follow, one of them nested in `script`.
    await run(source.service.put(draft("call-0", size)));
    source.tick();

    for (let at = 1; at <= 33; at++) {
      await run(
        source.service.put(
          at === 5 ? draft("nested", size, { parentCall: "script" }) : draft(`call-${at}`, size),
        ),
      );
      source.tick();
    }

    const copies = source.service.copiesFor(["call-0", "call-9", "script"]);

    expect(
      Arr.map(copies, (copy) =>
        copy.kind === "record" && "record" in copy
          ? `record:${copy.record.callId}`
          : copy.kind === "stub" && "stub" in copy
            ? `stub:${copy.stub.callId}`
            : copy.kind,
      ),
    ).toEqual(["stub:call-0", "record:nested", "record:call-9"]);
    expect(source.service.copiesFor([])).toEqual([]);

    // The target keeps them as its root conversation's, and a record mounts as it did.
    const target = open();

    target.service.adopt(copies, conversation(1));

    expect(statesOf(await run(target.service.list(conversation(1))))).toEqual([
      "call-0:evicted",
      "nested:kept",
      "call-9:kept",
    ]);
    expect(await run(target.service.mount("call-9"))).toMatchObject({
      status: "record",
      record: { callId: "call-9", conversation: "1" },
    });
    expect(await run(target.service.mount("call-0"))).toMatchObject({ status: "stub" });
  });

  it("adopts what it knows of a Fork's copies and skips a kind it does not, whole and in one write of the index", async () => {
    const storage = memory();
    const writes: Array<string> = [];

    const counting: McpAppsStorage = {
      get: (key) => storage.get(key),
      put: (key, value) => {
        writes.push(key);
        storage.put(key, value);
      },
      delete: (key) => storage.delete(key),
    };

    const { service } = open(counting);
    const source = open();

    await run(source.service.put(draft("kept", 10)));

    const records = source.service.copiesFor(["kept"]);

    expect(records).toHaveLength(1);

    service.adopt(
      [
        { kind: "from-a-newer-session" },
        ...records,
        {
          kind: "stub",
          stub: { callId: "gone", server: "docs", tool: "page", conversation: "7", at: 42 },
        },
        { kind: "another-new-one" },
      ],
      conversation(2),
    );

    expect(Arr.filter(writes, (key) => key === "cloudpid:mcp-apps")).toHaveLength(1);
    // Both are the target conversation's, and the stub keeps the time of its call.
    expect(await run(service.list(conversation(2)))).toEqual([
      expect.objectContaining({ callId: "kept", state: "kept" }),
      expect.objectContaining({ callId: "gone", state: "evicted", at: 42 }),
    ]);
    expect(await run(service.list(conversation(7)))).toEqual([]);
    expect(await run(service.mount("gone"))).toEqual({
      status: "stub",
      stub: { callId: "gone", server: "docs", tool: "page", conversation: "2", at: 42 },
    });
  });

  it("leaves no parts behind when a copied stub takes the place of a record", async () => {
    const storage = memory();
    const { service } = open(storage);

    await run(service.put(draft("call-1", 600 * 1024)));

    const before = storage.size();

    service.adopt(
      [
        {
          kind: "stub",
          stub: { callId: "call-1", server: "docs", tool: "page", conversation: "1" },
        },
      ],
      conversation(1),
    );

    // The parts of the record went, and the index holds the stub.
    expect(storage.size()).toBeLessThan(before);
    expect(await run(service.mount("call-1"))).toMatchObject({ status: "stub" });
  });

  it("streams a conversation's App calls now and again as they change", async () => {
    const { service } = open();

    await run(service.put(draft("call-1", 1)));

    const seen = run(Stream.runCollect(Stream.take(service.updates(conversation(1)), 2)));

    // The stream is subscribed before the next write is made.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await run(service.put(draft("call-2", 1)));

    expect(Arr.map(await seen, statesOf)).toEqual([
      ["call-1:kept"],
      ["call-1:kept", "call-2:kept"],
    ]);
  });
});
