// The Session's list of the Resource watches over plain key-value storage (`docs/architecture/mcp-in-a-session.md` →
// Resource watches → UI, Ends): kept and told to every client, bounded, and ended at the host: an entry goes only when
// the host answers that it ended them, silently for a deleted subagent, a moved branch and an archived Session.
// @effect-diagnostics asyncFunction:off strictEffectProvide:off missedPipeableOpportunity:off newPromise:off globalTimers:off schemaSync:off preferEffectArray:off -- plain fixtures.
import type { McpHostClientService } from "@cloudpid/extensions/mcp";
import {
  MAX_MCP_WATCHES,
  MAX_MCP_WATCH_KEY,
  type ServerMessage,
  ServerMessageJson,
} from "@cloudpid/protocol";
import {
  HostFailed,
  type McpApply,
  type McpApplyResult,
  McpWatchesEnded,
} from "@cloudpid/mcp/types";
import type { ConversationId } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { sessionMcpWatches } from "./mcp-watches-store.ts";
import type { SessionKv } from "./session-kv.ts";

// SAFETY: a conversation's ID is a positive integer; the tests name small ones.
const conversation = (id: number) => id as ConversationId;

const memory = (): SessionKv => {
  const values = new Map<string, unknown>();

  return {
    // SAFETY: the store reads back what it put, under the same key.
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key, value) => {
      values.set(key, structuredClone(value));
    },
    delete: (key) => values.delete(key),
  };
};

const decode = Schema.decodeUnknownSync(ServerMessageJson);

/** A store whose host answers `end_watches` as `answer` says, with the applies it was given and the messages sent. */
const open = (
  options: {
    readonly answer?: (input: McpApply) => McpApplyResult;
    readonly storage?: SessionKv;
    readonly session?: string | undefined;
  } = {},
) => {
  const applied: Array<{ environment: string; input: McpApply }> = [];
  const sent: ServerMessage[] = [];

  const socket = {
    send: (text: string) => {
      sent.push(decode(text));
    },
  };

  const store = sessionMcpWatches({
    storage: options.storage ?? memory(),
    // SAFETY: the store only sends to the sockets, and `send` is all of a socket it calls.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    sockets: { getWebSockets: () => [socket as unknown as WebSocket] },
    session: "session" in options ? options.session : "s-1",
    host: (environment) =>
      // SAFETY: the store only calls `apply`.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions
      ({
        apply: (input: McpApply) =>
          Effect.sync(() => {
            applied.push({ environment, input });

            return (options.answer ?? (() => McpWatchesEnded.make({ ended: 1 })))(input);
          }),
      }) as unknown as McpHostClientService,
  });

  const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect);

  return { ...store, applied, sent, run, list: () => run(store.service.list) };
};

const watch = (id: number, uri: string, server = "docs", environment = "env-1") => ({
  environment,
  conversation: String(id),
  server,
  uri,
});

describe("the list of Resource watches", () => {
  it("lists a started watch, oldest first, and tells every client the whole list", async () => {
    const store = open();

    await store.run(store.service.started(watch(1, "file:///a")));
    await store.run(store.service.started(watch(2, "file:///b")));
    // A watch read again is the same watch.
    await store.run(store.service.started(watch(1, "file:///a")));

    expect(await store.list()).toEqual([
      { conversationId: 1, server: "docs", uri: "file:///a" },
      { conversationId: 2, server: "docs", uri: "file:///b" },
    ]);
    expect(store.sent).toHaveLength(2);
    expect(store.sent.at(-1)).toEqual({
      type: "mcp_watches",
      watches: [
        { conversationId: 1, server: "docs", uri: "file:///a" },
        { conversationId: 2, server: "docs", uri: "file:///b" },
      ],
    });
    expect(store.service.has("1")).toBe(true);
    expect(store.service.has("3")).toBe(false);
  });

  it("is kept in storage, and read again by a store over the same one", async () => {
    const storage = memory();

    await Effect.runPromise(open({ storage }).service.started(watch(1, "file:///a")));
    expect(await open({ storage }).list()).toHaveLength(1);
  });

  it("holds at most 100 and lists no key past 2,048 characters", async () => {
    const store = open();

    for (let index = 0; index < MAX_MCP_WATCHES + 5; index++) {
      await store.run(store.service.started(watch(1, `file:///${index}`)));
    }

    await store.run(store.service.started(watch(1, "x".repeat(MAX_MCP_WATCH_KEY + 1))));
    expect(await store.list()).toHaveLength(MAX_MCP_WATCHES);
  });

  it("drops what the host says ended, and tells the clients", async () => {
    const store = open();

    await store.run(store.service.started(watch(1, "file:///a")));
    await store.run(store.service.started(watch(1, "file:///b")));
    await store.run(store.service.ended("1", [{ server: "docs", uri: "file:///a" }]));

    expect(await store.list()).toEqual([{ conversationId: 1, server: "docs", uri: "file:///b" }]);

    const told = store.sent.length;

    // Nothing left to drop: nothing is sent.
    await store.run(store.service.ended("1", [{ server: "docs", uri: "file:///a" }]));
    expect(store.sent).toHaveLength(told);
  });
});

describe("ending the watches at the host", () => {
  it("ends one watch by the owner's ✕, naming it and saying so, and drops it once the host has", async () => {
    const store = open();

    await store.run(store.service.started(watch(1, "file:///a")));
    await store.run(store.service.started(watch(1, "file:///b")));
    await store.run(
      store.service.end({ conversation: conversation(1), server: "docs", uri: "file:///a" }),
    );

    expect(store.applied).toEqual([
      {
        environment: "env-1",
        input: {
          kind: "end_watches",
          session: "s-1",
          conversation: "1",
          server: "docs",
          uri: "file:///a",
          reason: "ended by the owner",
        },
      },
    ]);
    expect(await store.list()).toEqual([{ conversationId: 1, server: "docs", uri: "file:///b" }]);
  });

  it("keeps the watch listed when the host could not end it", async () => {
    const store = open({ answer: () => HostFailed.make({ message: "no" }) });

    await store.run(store.service.started(watch(1, "file:///a")));
    await store.run(
      store.service.end({ conversation: conversation(1), server: "docs", uri: "file:///a" }),
    );
    expect(await store.list()).toHaveLength(1);
  });

  it("ends a conversation's watches silently, leaving the others", async () => {
    const store = open();

    await store.run(store.service.started(watch(1, "file:///a")));
    await store.run(store.service.started(watch(2, "file:///b")));
    await store.run(store.service.endConversation(conversation(1)));

    expect(store.applied.map(({ input }) => input)).toEqual([
      { kind: "end_watches", session: "s-1", conversation: "1", silent: true },
    ]);
    expect(await store.list()).toEqual([{ conversationId: 2, server: "docs", uri: "file:///b" }]);
  });

  it("ends every watch silently with one call for each Environment and conversation", async () => {
    const store = open();

    await store.run(store.service.started(watch(1, "file:///a")));
    await store.run(store.service.started(watch(1, "file:///b")));
    await store.run(store.service.started(watch(2, "file:///c", "docs", "env-2")));
    await store.run(store.service.endAll);

    expect(store.applied).toEqual([
      {
        environment: "env-1",
        input: { kind: "end_watches", session: "s-1", conversation: "1", silent: true },
      },
      {
        environment: "env-2",
        input: { kind: "end_watches", session: "s-1", conversation: "2", silent: true },
      },
    ]);
    expect(await store.list()).toEqual([]);
  });

  it("asks nothing of a host for a Session whose name is unknown, and never fails", async () => {
    const store = open({ session: undefined });

    await store.run(store.service.started(watch(1, "file:///a")));
    await store.run(store.service.endAll);
    expect(store.applied).toEqual([]);
    expect(await store.list()).toHaveLength(1);
  });

  it("never fails for a host that fails", async () => {
    const store = open({
      answer: () => {
        throw new Error("The host is gone");
      },
    });

    await store.run(store.service.started(watch(1, "file:///a")));
    await store.run(store.service.endAll);
    expect(await store.list()).toHaveLength(1);
  });
});
