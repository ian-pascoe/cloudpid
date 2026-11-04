// The Session's list of the Resource watches its agent started (`docs/architecture/mcp-in-a-session.md` → Resource
// watches → UI): one entry per conversation, server and URI, with the Environment whose host holds it, kept in this
// object's key-value storage. The host holds the watches themselves; the list is what Session details shows, what a
// conversation's request start asks the host about when it has no server any more, and what ends them at the host
// (`apply({ kind: "end_watches" })`): the owner's ✕, a deleted subagent, an archived or deleted Session and a moved
// branch. An entry goes when the host reports the watch ended (`McpWatchRecorder.ended`) or accepts the end.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain storage reads, under Effect.sync.
import type { McpHostClientService, McpWatched } from "@cloudpid/extensions/mcp";
import {
  conversationOfText,
  MAX_MCP_WATCH_KEY,
  MAX_MCP_WATCHES,
  type McpWatchEntry,
} from "@cloudpid/protocol";
import type { McpApply } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import { McpWatches, type McpWatchesService } from "./mcp-watches.ts";
import { mcpWatchesMessage, send, type SocketState } from "./sockets.ts";
import type { SessionKv } from "./session-kv.ts";

/** The list, oldest first, as one stored value: at most `MAX_MCP_WATCHES` entries of short strings. */
const LIST_KEY = "cloudpid:mcp-watches";

/** How long ending a set of watches waits for the hosts. */
const END_TIMEOUT = "5 seconds";

/** One entry as kept: the shown entry and the Environment whose host holds the watch. */
type Kept = McpWatchEntry & { readonly environment: string };

export type SessionMcpWatchesOptions = {
  readonly storage: SessionKv;
  /** The object's sockets, which a changed list is sent to. */
  readonly sockets: Pick<SocketState, "getWebSockets">;
  /** The Session's name, its ID in the Registry; undefined when unknown: nothing can then be ended at a host. */
  readonly session: string | undefined;
  /** The `McpHostClient` of Environment `environment`'s host. */
  readonly host: (environment: string) => McpHostClientService;
};

/** The service the Session's MCP tools record through, and the layer that provides it. */
export type SessionMcpWatches = {
  readonly service: McpWatchesService;
  readonly layer: Layer.Layer<McpWatches>;
};

const isKept = (value: unknown): value is Kept =>
  Predicate.isObject(value) &&
  Predicate.hasProperty(value, "conversationId") &&
  Predicate.isNumber(value.conversationId) &&
  Predicate.hasProperty(value, "server") &&
  Predicate.isString(value.server) &&
  Predicate.hasProperty(value, "uri") &&
  Predicate.isString(value.uri) &&
  Predicate.hasProperty(value, "environment") &&
  Predicate.isString(value.environment);

export const sessionMcpWatches = (options: SessionMcpWatchesOptions): SessionMcpWatches => {
  const read = (): ReadonlyArray<Kept> => {
    const stored = options.storage.get<unknown>(LIST_KEY);

    return Array.isArray(stored) ? Arr.filter(stored, isKept) : [];
  };

  /** Keep `next` and tell every client, when it differs from the list kept. */
  const write = (next: ReadonlyArray<Kept>) =>
    Effect.suspend(() => {
      const before = read();

      if (
        next.length === before.length &&
        Arr.every(next, (entry, index) => sameEntry(entry, before[index]))
      ) {
        return Effect.void;
      }

      options.storage.put(LIST_KEY, next);

      return Effect.forEach(
        options.sockets.getWebSockets(),
        (socket) => send(socket, mcpWatchesMessage(shown(next))),
        { discard: true },
      );
    });

  const shown = (list: ReadonlyArray<Kept>): ReadonlyArray<McpWatchEntry> =>
    Arr.map(list, ({ conversationId, server, uri }) => ({ conversationId, server, uri }));

  const sameEntry = (a: Kept, b: Kept | undefined) =>
    b !== undefined &&
    a.conversationId === b.conversationId &&
    a.server === b.server &&
    a.uri === b.uri &&
    a.environment === b.environment;

  const same = (a: { conversationId: number; server: string; uri: string }) => (b: Kept) =>
    a.conversationId === b.conversationId && a.server === b.server && a.uri === b.uri;

  const started: McpWatchesService["started"] = (watch: McpWatched) =>
    Effect.suspend(() => {
      const conversationId = conversationOfText(watch.conversation);

      if (
        conversationId === undefined ||
        watch.server.length > MAX_MCP_WATCH_KEY ||
        watch.uri.length > MAX_MCP_WATCH_KEY
      ) {
        return Effect.void;
      }

      const entry: Kept = {
        conversationId,
        server: watch.server,
        uri: watch.uri,
        environment: watch.environment,
      };

      const list = read();

      return Arr.some(list, same(entry))
        ? Effect.void
        : write(Arr.take([...list, entry], MAX_MCP_WATCHES));
    });

  const ended: McpWatchesService["ended"] = (conversation, gone) =>
    Effect.suspend(() => {
      const id = conversationOfText(conversation);

      if (id === undefined) return Effect.void;

      return write(
        Arr.filter(
          read(),
          (kept) => !Arr.some(gone, (each) => same({ conversationId: id, ...each })(kept)),
        ),
      );
    });

  /**
   * End at the host what `apply` names for `entries` (one environment's), and drop them from the list once it has. A host
   * that could not end them leaves them listed, and says so in the log.
   */
  const endAtHost = (
    entries: ReadonlyArray<Kept>,
    environment: string,
    input: Omit<Extract<McpApply, { kind: "end_watches" }>, "kind" | "session">,
  ) =>
    Effect.gen(function* () {
      const { session } = options;

      if (session === undefined || entries.length === 0) return;

      const answer = yield* options
        .host(environment)
        .apply({ kind: "end_watches", session, ...input });

      if (!Predicate.isTagged(answer, "WatchesEnded")) {
        yield* Effect.logWarning("The host did not end the Resource watches", answer);

        return;
      }

      yield* write(Arr.filter(read(), (kept) => !Arr.some(entries, same(kept))));
    });

  /** End `entries` at their hosts, one call for each Environment and conversation. */
  const endEntries = (
    entries: ReadonlyArray<Kept>,
    input: Omit<Extract<McpApply, { kind: "end_watches" }>, "kind" | "session" | "conversation">,
  ) =>
    Effect.forEach(
      Record.toEntries(
        Arr.groupBy(entries, (entry) => `${entry.environment}\0${entry.conversationId}`),
      ),
      ([, group]) => {
        const [first] = group;

        return first === undefined
          ? Effect.void
          : endAtHost(group, first.environment, {
              ...input,
              conversation: String(first.conversationId),
            });
      },
      { discard: true },
    ).pipe(
      // A host that does not answer does not hold back an archive or a deletion.
      Effect.timeout(END_TIMEOUT),
      Effect.catchCause((cause) => Effect.logWarning("Resource watches were not ended", cause)),
    );

  const service: McpWatchesService = {
    started,
    ended,
    has: (conversation) => Arr.some(read(), (kept) => String(kept.conversationId) === conversation),
    list: Effect.sync(() => shown(read())),
    end: (watch) =>
      endEntries(Arr.filter(read(), same({ ...watch, conversationId: watch.conversation })), {
        server: watch.server,
        uri: watch.uri,
        reason: "ended by the owner",
      }),
    endConversation: (conversation) =>
      endEntries(
        Arr.filter(read(), (kept) => kept.conversationId === conversation),
        { silent: true },
      ),
    endAll: Effect.suspend(() => endEntries(read(), { silent: true })),
  };

  return { service, layer: Layer.succeed(McpWatches, service) };
};
