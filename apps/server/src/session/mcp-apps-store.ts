// The Session's MCP App records (`docs/architecture/mcp-apps.md` → App records, Socket messages): one bounded record for
// each completed call of an App tool, written by the `mcp` extension's tool (`McpAppRecorder.put`) into this object's
// key-value storage, outside History, and read by the same path for a live mount and a replay (`mcp_app_mount`). The
// extension hands over a draft; the record is redacted of the Secrets held, then bounded (`boundAppRecord`: 1 MiB), kept
// in parts of at most `PART_LENGTH` characters under `cloudpid:mcp-app:<callId>:<n>`, with an index of every record and
// stub, oldest first, under `cloudpid:mcp-apps`. Past 32 MiB, or `MAX_MCP_APP_RECORDS` records, the least recently
// mounted record is evicted and leaves a stub (who the call was and nothing of its data); the oldest stubs are dropped
// past `MAX_MCP_APP_STUBS`, and read as no record. The whole of a write is one synchronous run, so no reader sees half of it.
// Fork and Clone copy the records of the calls they copy (`copiesFor`, `adopt`). Also the Session's App tools
// (`mcp_app_tools`), which are not kept: the `mcp` extension tells them at each install. The tools that write are built
// outside the Session's runtime (`./mcp-host.ts`), so the service is made synchronously, and the Secrets it redacts with
// are bound when the runtime builds its layer, as the MCP questions' are (`./mcp-questions.ts`).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain storage reads,
// under Effect.sync.
import type { McpAppHtmlInput } from "@cloudpid/extensions/mcp";
import { Secrets, type SecretsService } from "@cloudpid/extensions/secrets";
import {
  appRecordBytes,
  boundAppRecord,
  type ConversationId,
  type McpAppCopy,
  type McpAppDraft,
  type McpAppEntry,
  type McpAppHtmlAnswer,
  McpAppRecord,
  type McpAppMounted,
  type McpAppStub,
  type McpAppTool,
  MAX_MCP_APP_RECORDS,
  MAX_MCP_APP_RECORDS_BYTES,
  MAX_MCP_APP_STUBS,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Mutable } from "effect/Types";
import { McpApps, type McpAppsService } from "./mcp-apps.ts";
import { mcpAppToolsMessage, send, type SocketState } from "./sockets.ts";

/** The object's synchronous key-value storage, as the records use it. */
export type McpAppsStorage = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
};

/** The index of every record and stub, oldest first. */
const INDEX_KEY = "cloudpid:mcp-apps";

/** The most characters one stored value holds: a record's JSON over it is kept in parts. */
const PART_LENGTH = 256 * 1024;

const partKey = (callId: string, part: number) => `cloudpid:mcp-app:${callId}:${part}`;

/**
 * One call's entry of the index: a record's (`kept`, with its size and parts) or a stub's (`evicted`). `mountedAt` orders
 * the eviction.
 */
type IndexEntry = {
  readonly callId: string;
  readonly server: string;
  readonly tool: string;
  readonly conversation: string;
  readonly parentCall?: string;
  readonly state: "kept" | "evicted";
  readonly htmlHash?: string;
  readonly truncated?: boolean;
  readonly bytes: number;
  readonly parts: number;
  readonly at: number;
  readonly mountedAt: number;
};

const decodeRecord = Schema.decodeUnknownOption(McpAppRecord);

export type SessionMcpAppsOptions = {
  readonly storage: McpAppsStorage;
  /** The object's sockets, which a changed set of App tools is sent to. */
  readonly sockets: Pick<SocketState, "getWebSockets">;
  /**
   * The page the host keeps under a hash, of a call of `server`: the Session's MCP tools ask the host's `ui/html`, only
   * when the host lists `app_html` (`McpTools.appHtml`).
   */
  readonly html: (input: McpAppHtmlInput) => Effect.Effect<McpAppHtmlAnswer>;
  /** The time in epoch milliseconds, `Date.now` unless a test sets it. */
  readonly now?: () => number;
};

/** The service the Session's MCP tools record through, and the layer that provides it once the Secrets are built. */
export type SessionMcpApps = {
  readonly service: McpAppsService;
  readonly layer: Layer.Layer<McpApps, never, Secrets>;
};

const entryOf = (entry: IndexEntry): McpAppEntry => {
  const shown: Mutable<McpAppEntry> = {
    callId: entry.callId,
    server: entry.server,
    tool: entry.tool,
    state: entry.state,
    at: entry.at,
  };

  if (entry.parentCall !== undefined) shown.parentCall = entry.parentCall;

  if (entry.state === "kept" && entry.htmlHash !== undefined) shown.htmlHash = entry.htmlHash;

  if (entry.state === "kept" && entry.truncated === true) shown.truncated = true;

  return shown;
};

const stubOf = (entry: IndexEntry): McpAppStub => {
  const stub: Mutable<McpAppStub> = {
    callId: entry.callId,
    server: entry.server,
    tool: entry.tool,
    conversation: entry.conversation,
  };

  if (entry.parentCall !== undefined) stub.parentCall = entry.parentCall;

  return stub;
};

/** The entry of a call that has no record: what an evicted record, and a copied stub, are left as. */
const evictedOf = (
  call: Pick<IndexEntry, "callId" | "server" | "tool" | "conversation" | "parentCall" | "at">,
  mountedAt: number,
): IndexEntry => {
  const entry: Mutable<IndexEntry> = {
    callId: call.callId,
    server: call.server,
    tool: call.tool,
    conversation: call.conversation,
    state: "evicted",
    bytes: 0,
    parts: 0,
    at: call.at,
    mountedAt,
  };

  if (call.parentCall !== undefined) entry.parentCall = call.parentCall;

  return entry;
};

/** The entry of a call whose record, `count` parts long, was just kept. */
const keptOf = (record: McpAppRecord, count: number, mountedAt: number): IndexEntry => {
  const entry: Mutable<IndexEntry> = {
    callId: record.callId,
    server: record.server,
    tool: record.tool,
    conversation: record.conversation,
    state: "kept",
    bytes: appRecordBytes(record),
    parts: count,
    at: record.at,
    mountedAt,
  };

  if (record.parentCall !== undefined) entry.parentCall = record.parentCall;

  if (record.htmlHash !== undefined) entry.htmlHash = record.htmlHash;

  if (record.truncated === true) entry.truncated = true;

  return entry;
};

export const sessionMcpApps = (options: SessionMcpAppsOptions): SessionMcpApps => {
  const { storage } = options;
  const now = options.now ?? Date.now;
  let bound: SecretsService | undefined;
  let tools: ReadonlyArray<McpAppTool> = [];
  let toolsKey = "[]";
  const listeners = new Set<(conversations: ReadonlySet<string>) => void>();

  /** The Secrets, asked for again if they are due; a record is never kept before the runtime is built. */
  const secrets = Effect.suspend(() =>
    bound === undefined
      ? Effect.die("The Session's Secrets are not built yet")
      : Effect.as(bound.refresh, bound),
  );

  const index = (): ReadonlyArray<IndexEntry> =>
    storage.get<ReadonlyArray<IndexEntry>>(INDEX_KEY) ?? [];

  const parts = (entry: IndexEntry): ReadonlyArray<string> =>
    Arr.makeBy(entry.parts, (part) => storage.get<string>(partKey(entry.callId, part)) ?? "");

  const dropParts = (entry: IndexEntry) => {
    for (let part = 0; part < entry.parts; part++) storage.delete(partKey(entry.callId, part));
  };

  /** The record of a kept entry, or none when its parts are gone or unreadable. */
  const readRecord = (entry: IndexEntry) => {
    try {
      return decodeRecord(JSON.parse(Arr.join(parts(entry), "")));
    } catch {
      return Option.none();
    }
  };

  const changed = (conversations: ReadonlySet<string>) => {
    for (const listener of listeners) listener(conversations);
  };

  /**
   * Write `entries` as the index after the bounds held: the least recently mounted record past the byte and count bounds
   * is evicted (never `keep`, the one just written, so a lone record at its own bound stays), the oldest stubs past theirs
   * dropped. The index is written last.
   */
  const settle = (entries: ReadonlyArray<IndexEntry>, keep: string | undefined) => {
    const next = [...entries];
    const touched = new Set<string>();
    const kept = () => Arr.filter(next, (entry) => entry.state === "kept");
    const bytes = () => Arr.reduce(kept(), 0, (sum, entry) => sum + entry.bytes);

    while (bytes() > MAX_MCP_APP_RECORDS_BYTES || kept().length > MAX_MCP_APP_RECORDS) {
      let oldest: IndexEntry | undefined;

      for (const entry of kept()) {
        if (entry.callId !== keep && (oldest === undefined || entry.mountedAt < oldest.mountedAt)) {
          oldest = entry;
        }
      }

      if (oldest === undefined) break;

      dropParts(oldest);
      touched.add(oldest.conversation);
      next[next.indexOf(oldest)] = evictedOf(oldest, oldest.mountedAt);
    }

    let stubs = Arr.filter(next, (entry) => entry.state === "evicted").length;

    for (let at = 0; stubs > MAX_MCP_APP_STUBS && at < next.length;) {
      const entry = next[at];

      if (entry?.state === "evicted") {
        touched.add(entry.conversation);
        next.splice(at, 1);
        stubs -= 1;
      } else at += 1;
    }

    storage.put(INDEX_KEY, next);

    return touched;
  };

  /** Keep `record` as call `record.callId`'s, replacing an earlier one; its entry's `mountedAt` is `mountedAt`. */
  const keepRecord = (record: McpAppRecord, mountedAt: number) => {
    const text = JSON.stringify(record);
    const before = index();
    const old = Arr.findFirst(before, (entry) => entry.callId === record.callId);

    if (Option.isSome(old)) dropParts(old.value);

    const count = Math.max(1, Math.ceil(text.length / PART_LENGTH));

    for (let part = 0; part < count; part++) {
      storage.put(
        partKey(record.callId, part),
        text.slice(part * PART_LENGTH, (part + 1) * PART_LENGTH),
      );
    }

    const entry = keptOf(record, count, mountedAt);

    const after = Option.isSome(old)
      ? Arr.map(before, (each) => (each.callId === record.callId ? entry : each))
      : [...before, entry];

    const touched = settle(after, record.callId);

    touched.add(record.conversation);

    return touched;
  };

  const put: McpAppsService["put"] = (draft: McpAppDraft) =>
    Effect.gen(function* () {
      const held = yield* secrets;
      const at = now();

      const record = boundAppRecord({ ...draft, audit: [], at }, (value) => held.redact(value));

      const touched = keepRecord(record, at);

      changed(touched);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`The App record of call ${draft.callId} could not be kept`, cause),
      ),
    );

  const list = (conversation: ConversationId): ReadonlyArray<McpAppEntry> =>
    Arr.map(
      Arr.filter(index(), (entry) => entry.conversation === String(conversation)),
      entryOf,
    );

  const mount: McpAppsService["mount"] = (callId) =>
    Effect.sync((): McpAppMounted => {
      const entries = index();
      const found = Arr.findFirst(entries, (entry) => entry.callId === callId);

      if (Option.isNone(found)) return { status: "none" };

      const entry = found.value;

      if (entry.state !== "kept") return { status: "stub", stub: stubOf(entry) };

      const record = readRecord(entry);

      if (Option.isNone(record)) {
        // Its parts are gone or unreadable: all that is left of it is a stub.
        dropParts(entry);

        const touched = settle(
          Arr.map(entries, (each) => (each === entry ? evictedOf(entry, entry.mountedAt) : each)),
          undefined,
        );

        touched.add(entry.conversation);
        changed(touched);

        return { status: "stub", stub: stubOf(entry) };
      }

      // The most recently mounted last to go.
      storage.put(
        INDEX_KEY,
        Arr.map(entries, (each) => (each === entry ? { ...entry, mountedAt: now() } : each)),
      );

      return { status: "record", record: record.value };
    });

  const html: McpAppsService["html"] = (hash) =>
    Effect.suspend(() => {
      // The newest record that pins the hash names the server to ask: a hash is not tied to a server at the host.
      const pin = Arr.findLast(
        index(),
        (entry) => entry.state === "kept" && entry.htmlHash === hash,
      );

      return Option.isNone(pin)
        ? Effect.succeed<McpAppHtmlAnswer>({
            status: "missing",
            message: "No App record of this Session pins that page",
          })
        : options.html({
            server: pin.value.server,
            hash,
            callId: pin.value.callId,
            conversation: pin.value.conversation,
          });
    });

  const copiesFor: McpAppsService["copiesFor"] = (callIds) => {
    if (callIds.length === 0) return [];

    const wanted = new Set(callIds);

    return Arr.flatMap(index(), (entry): ReadonlyArray<McpAppCopy> => {
      if (
        !wanted.has(entry.callId) &&
        !(entry.parentCall !== undefined && wanted.has(entry.parentCall))
      ) {
        return [];
      }

      if (entry.state !== "kept") return [{ kind: "stub", stub: stubOf(entry) }];

      const record = readRecord(entry);

      return Option.isSome(record) ? [{ kind: "record", record: record.value }] : [];
    });
  };

  const adopt: McpAppsService["adopt"] = (copies, conversation) => {
    const at = now();
    const touched = new Set<string>();

    for (const copy of copies) {
      if (copy.kind === "record") {
        // Bounded as any record is; one that is within its bound is kept as it is.
        const record = boundAppRecord({ ...copy.record, conversation: String(conversation) });

        for (const each of keepRecord(record, at)) touched.add(each);

        continue;
      }

      const { stub } = copy;
      const before = Arr.filter(index(), (entry) => entry.callId !== stub.callId);

      const entry = evictedOf({ ...stub, at }, at);

      for (const each of settle([...before, entry], undefined)) touched.add(each);

      touched.add(String(conversation));
    }

    changed(touched);
  };

  const updates: McpAppsService["updates"] = (conversation) =>
    Stream.callback<ReadonlyArray<McpAppEntry>>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = (conversations: ReadonlySet<string>) => {
            if (conversations.has(String(conversation)))
              Queue.offerUnsafe(queue, list(conversation));
          };

          listeners.add(listener);
          Queue.offerUnsafe(queue, list(conversation));

          return listener;
        }),
        (listener) =>
          Effect.sync(() => {
            listeners.delete(listener);
          }),
      ),
    ).pipe(
      // A mount only moves a record's time, which no client shows.
      Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)),
    );

  const service: McpAppsService = {
    put,
    setTools: (next) => {
      const key = JSON.stringify(next);

      if (key === toolsKey) return;

      toolsKey = key;
      tools = next;

      // Every client is told the inventory's App tools whenever they change.
      Effect.runFork(
        Effect.forEach(options.sockets.getWebSockets(), (socket) =>
          send(socket, mcpAppToolsMessage(next)),
        ),
      );
    },
    list: (conversation) => Effect.sync(() => list(conversation)),
    updates,
    tools: Effect.sync(() => tools),
    mount,
    html,
    copiesFor,
    adopt,
  };

  return {
    service,
    layer: Layer.effect(
      McpApps,
      Effect.gen(function* () {
        bound = yield* Secrets;

        return service;
      }),
    ),
  };
};
