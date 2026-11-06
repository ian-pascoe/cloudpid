// The Session's MCP App records (`docs/architecture/mcp-apps.md` → App records, Socket messages): one bounded record for
// each completed call of an App tool, written by the `mcp` extension's tool (`McpAppRecorder.put`) into this object's
// key-value storage, outside History, and read by the same path for a live mount and a replay (`mcp_app_mount`). The
// extension hands over a draft; the record is redacted of the Secrets held, then bounded (`boundAppRecord`: 1 MiB), kept
// in parts under `cloudpid:mcp-app:<callId>:<n>`, with an index of every record and stub, oldest first, under
// `cloudpid:mcp-apps`, by the chunked-record primitive (`./call-records.ts`, which Visuals' store shares). Past 32 MiB, or
// `MAX_MCP_APP_RECORDS` records, the least recently mounted record is evicted and leaves a stub (who the call was and
// nothing of its data); the oldest stubs are dropped past `MAX_MCP_APP_STUBS`, and read as no record. The whole of a write
// is one synchronous run, so no reader sees half of it.
// Fork and Clone copy the records of the calls they copy (`copiesFor`, `adopt`). Also the Session's App tools
// (`mcp_app_tools`), which are not kept: the `mcp` extension tells them at each install. The tools that write are built
// outside the Session's runtime (`./mcp-host.ts`), so the service is made synchronously, and the Secrets it redacts with
// are bound when the runtime builds its layer, as the MCP questions' are (`./mcp-questions.ts`).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain storage reads,
// under Effect.sync.
import type { McpAppHtmlInput, McpAppReply, McpAppRequestInput } from "@cloudpid/extensions/mcp";
import { Secrets, type SecretsService } from "@cloudpid/extensions/secrets";
import {
  appRecordBytes,
  boundAppRecord,
  type ConversationId,
  type McpAppCopy,
  type McpAppDraft,
  type McpAppAuditEntry,
  type McpAppEntry,
  type McpAppHtmlAnswer,
  McpAppRecord,
  type McpAppMounted,
  type McpAppStub,
  type McpAppTool,
  MAX_MCP_APP_AUDIT,
  MAX_MCP_APP_RECORDS,
  MAX_MCP_APP_RECORDS_BYTES,
  MAX_MCP_APP_STUBS,
  MCP_APP_INTERNAL_ERROR,
  mcpAppError,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Mutable } from "effect/Types";
import { appContextsOver } from "./mcp-app-context.ts";
import { appCallsOver } from "./mcp-app-calls.ts";
import { McpApps, type McpAppsService } from "./mcp-apps.ts";
import type { SessionKv } from "./session-kv.ts";
import { callRecords, type CallRecordEntry } from "./call-records.ts";
import { mcpAppToolsMessage, send, type SocketState } from "./sockets.ts";

/** The object's synchronous key-value storage, as the records use it. */
export type McpAppsStorage = SessionKv;

/** The index of every record and stub, oldest first. */
const INDEX_KEY = "cloudpid:mcp-apps";

const partKey = (callId: string, part: number) => `cloudpid:mcp-app:${callId}:${part}`;

/**
 * Where a call's audit log is kept (`docs/architecture/mcp-apps.md` → An App View's calls): a value of its own, so a request
 * of a View rewrites a few KiB and never the record (up to 1 MiB) or the index. A mount reads it into the record it answers.
 */
const auditKey = (callId: string) => `cloudpid:mcp-app-audit:${callId}`;

/**
 * One call's entry of the index: a record's (`kept`, with its size and parts) or a stub's (`evicted`). `mountedAt` orders
 * the eviction.
 */
type IndexEntry = CallRecordEntry & {
  readonly server: string;
  readonly tool: string;
  readonly parentCall?: string;
  readonly htmlHash?: string;
  /** What named the origin of the server's Views when the call ran (`McpAppRecord.viewHash`). */
  readonly viewHash?: string;
  readonly truncated?: boolean;
  readonly at: number;
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
  /**
   * The origin an App View of the host's `view` is served on (`viewOrigin`, from the deploy-time label), put on a page's
   * answer. It may throw for a `view` that is not a host's label of a View; the answer then has no origin.
   */
  readonly viewOrigin?: (view: string) => string;
  /**
   * An App View's request to its server, once the Session's checks pass (`McpTools.appRequest`): the MCP tools check it
   * against the inventory and send it to the host as an `app` request.
   */
  readonly request?: (input: McpAppRequestInput) => Effect.Effect<McpAppReply>;
  /** Whether the Session is archived: its App Views may read, and call no tool. Absent: never. */
  readonly archived?: Effect.Effect<boolean>;
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
    at: entry.at,
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

  if (record.viewHash !== undefined) entry.viewHash = record.viewHash;

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

  const records = callRecords<IndexEntry>({
    storage,
    indexKey: INDEX_KEY,
    partKey,
    // Everything kept of a record is its parts and its audit log.
    alsoKeys: (callId) => [auditKey(callId)],
    bounds: {
      bytes: MAX_MCP_APP_RECORDS_BYTES,
      records: MAX_MCP_APP_RECORDS,
      stubs: MAX_MCP_APP_STUBS,
    },
    evicted: (entry) => evictedOf(entry, entry.mountedAt),
  });

  const { index, dropParts } = records;

  const readAudit = (callId: string): ReadonlyArray<McpAppAuditEntry> =>
    storage.get<ReadonlyArray<McpAppAuditEntry>>(auditKey(callId)) ?? [];

  /** The record of a kept entry with its audit log, or none when its parts are gone or unreadable. */
  const readRecord = (entry: IndexEntry) => {
    try {
      return Option.map(decodeRecord(JSON.parse(records.text(entry))), (record) => ({
        ...record,
        audit: readAudit(entry.callId),
      }));
    } catch {
      return Option.none();
    }
  };

  const changed = (conversations: ReadonlySet<string>) => {
    for (const listener of listeners) listener(conversations);
  };

  /** The App contexts the Views sent (`./mcp-app-context.ts`): held beside the records, never in them. */
  const contexts = appContextsOver({
    storage,
    call: (callId) =>
      Option.map(
        Arr.findFirst(index(), (entry) => entry.callId === callId),
        (entry) => ({
          server: entry.server,
          tool: entry.tool,
          conversation: entry.conversation,
          parentCall: entry.parentCall,
        }),
      ),
    secrets,
    changed,
    now,
  });

  /** `entries` with `record` as call `record.callId`'s, replacing an earlier one, its parts written; its `mountedAt` is `mountedAt`. */
  const withRecord = (
    entries: ReadonlyArray<IndexEntry>,
    record: McpAppRecord,
    mountedAt: number,
  ): ReadonlyArray<IndexEntry> => {
    // The audit log has a value of its own: the record's JSON, which is all the parts hold, carries none.
    const stored: McpAppRecord = { ...record, audit: [] };

    // The primitive drops an earlier record's parts, and its audit log, first.
    const written = records.write(entries, record.callId, JSON.stringify(stored), (count) =>
      keptOf(stored, count, mountedAt),
    );

    if (record.audit.length > 0) {
      storage.put(auditKey(record.callId), Arr.takeRight(record.audit, MAX_MCP_APP_AUDIT));
    }

    return written;
  };

  /** Keep `record` as call `record.callId`'s: the bounds then hold, the record just written never the one evicted. */
  const keepRecord = (record: McpAppRecord, mountedAt: number) => {
    const touched = records.settle(withRecord(index(), record, mountedAt), record.callId);

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
      (entry): McpAppEntry => {
        const context = contexts.contextOf(entry.callId);

        return context === undefined ? entryOf(entry) : { ...entryOf(entry), context };
      },
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
        const touched = records.settle(records.evict(entries, entry), undefined);

        touched.add(entry.conversation);
        changed(touched);

        return { status: "stub", stub: stubOf(entry) };
      }

      // The most recently mounted last to go.
      records.touch(entries, entry, now());

      const context = contexts.contextOf(callId);

      return {
        status: "record",
        record: context === undefined ? record.value : { ...record.value, context },
      };
    });

  /** A page's answer with the origin its View is served on, when the host named the server's and the stage can build it. */
  const withOrigin = (answer: McpAppHtmlAnswer): McpAppHtmlAnswer => {
    if (answer.status !== "html" || !("view" in answer) || answer.view === undefined) return answer;

    const { view } = answer;
    const origin = Result.getOrUndefined(Result.try(() => options.viewOrigin?.(view)));

    return origin === undefined ? answer : { ...answer, origin };
  };

  /**
   * `answer` unless it is a page of another server than the one that made the call: a record names its server by name, so
   * an owner's `docs` that shadows a Repo's would serve the old call a page at the new server's origin. The record pins
   * what named its server's origin (`viewHash`); a page whose host named another is "unavailable". A record that pins none
   * (it predates this, or the host did not know) is not checked: there is nothing to compare.
   */
  const ofTheCallsServer = (entry: IndexEntry, answer: McpAppHtmlAnswer): McpAppHtmlAnswer =>
    entry.viewHash !== undefined &&
    answer.status === "html" &&
    "view" in answer &&
    answer.view !== undefined &&
    answer.view !== entry.viewHash
      ? {
          status: "unavailable",
          message: `The server ${entry.server} is no longer the one that made this call`,
        }
      : answer;

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
        : options
            .html({
              server: pin.value.server,
              hash,
              callId: pin.value.callId,
              conversation: pin.value.conversation,
            })
            .pipe(
              Effect.map((answer) => ofTheCallsServer(pin.value, answer)),
              Effect.map(withOrigin),
            );
    });

  /**
   * Pin `hash` as the page of call `callId`'s record, as the first mount that read it by its URI found it (the host did
   * not wait for the read when the call ended). The record is rewritten as it was kept, its mount time unchanged.
   */
  const pin = (callId: string, hash: string) =>
    Effect.sync(() => {
      const found = Arr.findFirst(index(), (entry) => entry.callId === callId);

      if (Option.isNone(found) || found.value.state !== "kept") return;

      const record = readRecord(found.value);

      if (Option.isNone(record) || record.value.htmlHash === hash) return;

      changed(keepRecord({ ...record.value, htmlHash: hash }, found.value.mountedAt));
    });

  /** The page of the `ui://` resource an App tool declares, through the host, for call `callId` of it. */
  const readDeclared = (declared: McpAppTool, callId: string, conversation: string) =>
    options.html({ server: declared.server, uri: declared.uri, callId, conversation });

  const pageOf: McpAppsService["pageOf"] = (callId) =>
    Effect.suspend(() => {
      const found = Arr.findFirst(index(), (entry) => entry.callId === callId);

      if (Option.isNone(found) || found.value.state !== "kept") {
        return Effect.succeed<McpAppHtmlAnswer>({
          status: "missing",
          message: "No App record of this Session keeps that call",
        });
      }

      const { server, tool, conversation, htmlHash } = found.value;

      // Read by the resource the server's tool declares: the call's own server, whatever the page's hash was at.
      const byUri = Effect.suspend(() => {
        const declared = Arr.findFirst(
          tools,
          (each) => each.server === server && each.tool === tool,
        );

        if (Option.isNone(declared)) {
          return Effect.succeed<McpAppHtmlAnswer>({
            status: "missing",
            message: `The server ${server} no longer declares an App for ${tool}`,
          });
        }

        return readDeclared(declared.value, callId, conversation).pipe(
          Effect.map((answer) => ofTheCallsServer(found.value, answer)),
          Effect.tap((answer) => {
            const hash = answer.status === "html" && "hash" in answer ? answer.hash : undefined;

            return Predicate.isString(hash) ? pin(callId, hash) : Effect.void;
          }),
        );
      });

      return (
        htmlHash === undefined
          ? byUri
          : options.html({ server, hash: htmlHash, callId, conversation }).pipe(
              // Evicted from the host, or never kept there: the mount reads it again.
              Effect.filterOrElse(
                (answer) => answer.status !== "missing",
                () => byUri,
              ),
              Effect.map((answer) => ofTheCallsServer(found.value, answer)),
            )
      ).pipe(Effect.map(withOrigin));
    });

  const pageOfTool: McpAppsService["pageOfTool"] = (name, callId) =>
    Effect.suspend(() => {
      const declared = Arr.findFirst(tools, (each) => each.name === name);

      if (Option.isNone(declared)) {
        return Effect.succeed<McpAppHtmlAnswer>({
          status: "missing",
          message: `The inventory has no App tool ${name}`,
        });
      }

      // The call has no record, so no conversation of its own is known here: the host's log names the call only.
      return readDeclared(declared.value, callId, "").pipe(Effect.map(withOrigin));
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
    const root = String(conversation);
    let entries = index();

    for (const copy of copies) {
      if (copy.kind === "record" && "record" in copy) {
        // Bounded as any record is; one that is within its bound is kept as it is.
        entries = withRecord(entries, boundAppRecord({ ...copy.record, conversation: root }), at);
      } else if (copy.kind === "stub" && "stub" in copy) {
        const { stub } = copy;
        const old = Arr.findFirst(entries, (entry) => entry.callId === stub.callId);

        // A call that has a record here keeps no parts once it is a stub.
        if (Option.isSome(old)) dropParts(old.value);

        entries = [
          ...Arr.filter(entries, (entry) => entry.callId !== stub.callId),
          evictedOf({ ...stub, conversation: root, at: stub.at ?? at }, at),
        ];
      }

      // A kind a newer Session sends is skipped: the rest of the Fork is still made.
    }

    // The index is written once, after the bounds hold of every copy together.
    const touched = records.settle(entries, undefined);

    touched.add(root);
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

  /** Add `entry` to the audit log of call `callId`'s record, the last `MAX_MCP_APP_AUDIT` kept; none for a call with no record kept. */
  const audit = (callId: string, entry: McpAppAuditEntry) =>
    Effect.sync(() => {
      const found = Arr.findFirst(index(), (each) => each.callId === callId);

      if (Option.isNone(found) || found.value.state !== "kept") return;

      storage.put(
        auditKey(callId),
        Arr.takeRight([...readAudit(callId), entry], MAX_MCP_APP_AUDIT),
      );
    });

  const calls = appCallsOver({
    record: (callId) =>
      Option.map(
        Arr.findFirst(index(), (entry) => entry.callId === callId && entry.state === "kept"),
        (entry) => ({
          server: entry.server,
          conversation: entry.conversation,
          viewHash: entry.viewHash,
        }),
      ),
    request:
      options.request ??
      (() =>
        Effect.succeed<McpAppReply>({
          answer: mcpAppError("failed", "This Session has no MCP tools", MCP_APP_INTERNAL_ERROR),
          notes: [],
        })),
    audit,
    secrets,
    archived: options.archived,
    now,
  });

  const service: McpAppsService = {
    ...calls,
    contexts,
    serversOf: (callIds) =>
      Effect.sync(() =>
        Arr.map(
          callIds,
          (callId) =>
            Arr.findFirst(index(), (entry) => entry.callId === callId).pipe(Option.getOrUndefined)
              ?.server,
        ),
      ),
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
    pageOf,
    pageOfTool,
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
