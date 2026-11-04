// The Resource watches of `McpHost`'s storage (`docs/architecture/mcp-connections.md` → Storage;
// `docs/architecture/mcp-in-a-session.md` → Resource watches): per (Session, conversation, server, URI) the watch, with
// the `conn` and Workspace it is held on, the spawn id of the stdio process it belongs to, the SHA-256 of what the agent
// last read (its baseline) and its mark; and the ends not yet told to their conversation (`mcp_watch_ends`), which the
// next `requestStart` of that conversation takes. At most 20 watches per conversation and 100 per Environment; the
// store only keeps them, the caps are the caller's (`watches.ts`).
// @effect-diagnostics missingPipeableSignature:off -- store operations, not combinators.
import type { MigrationStorage } from "@cloudpid/effect-durable/sqlite";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { nullable, optional } from "./sql.ts";

/** At most this many Resource watches per conversation. */
export const MAX_WATCHES_PER_CONVERSATION = 20;

/** At most this many Resource watches per Environment. */
export const MAX_WATCHES_PER_ENVIRONMENT = 100;

/** At most this many sub-resource URIs are kept per watch. */
export const MAX_SUB_URIS = 3;

/** What a watch says of the resource: unchanged, changed (an event, or a re-read whose hash differs) or unchecked (a re-read failed). */
export const WATCH_MARK = { none: 0, changed: 1, unchecked: 2 } as const;

export type WatchMark = (typeof WATCH_MARK)[keyof typeof WATCH_MARK];

/** A watch's identity: who holds it, on which server and resource. */
export type WatchKey = {
  readonly session: string;
  readonly conversation: string;
  readonly server: string;
  readonly uri: string;
};

export type WatchRow = WatchKey & {
  /** The connection key the watch is held on. */
  readonly conn: string;
  /** The Workspace of a stdio server's process, `""` for an HTTP server. */
  readonly workspace: string;
  /** The stdio process's spawn id once the read that made the watch active heard it. */
  readonly spawn: string | undefined;
  /** `pending` until the read returns contents; then `active`, with `hash` the baseline. */
  readonly state: "pending" | "active";
  readonly hash: string | undefined;
  readonly mark: WatchMark;
  readonly subUris: ReadonlyArray<string>;
  readonly startedAt: number;
  readonly lastRequestAt: number;
};

/** A watch's end, told to its conversation at its next `requestStart`. */
export type WatchEnd = WatchKey & { readonly reason: string; readonly at: number };

export type WatchStore = {
  /** Every watch, pending ones included (at most 100 are ever kept). */
  readonly watches: () => ReadonlyArray<WatchRow>;
  /** Keep `row`, replacing the watch of its key. */
  readonly putWatch: (row: WatchRow) => void;
  /** Drop the watches of `keys`; the ones that were there. */
  readonly dropWatches: (keys: ReadonlyArray<WatchKey>) => void;
  /** Note `ends` for their conversations, a later end of the same watch replacing the earlier. */
  readonly putWatchEnds: (ends: ReadonlyArray<WatchEnd>) => void;
  /** The ends noted for `conversation` of `session`, which are forgotten once taken. */
  readonly takeWatchEnds: (session: string, conversation: string) => ReadonlyArray<WatchEnd>;
};

type WatchSql = {
  readonly session: string;
  readonly conversation: string;
  readonly server: string;
  readonly uri: string;
  readonly conn: string;
  readonly workspace: string;
  readonly spawn: string | null;
  readonly state: string;
  readonly hash: string | null;
  readonly mark: number;
  readonly sub_uris: string;
  readonly started_at: number;
  readonly last_request_at: number;
};

const decodeUris = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));

const markOf = (mark: number): WatchMark =>
  mark === WATCH_MARK.changed
    ? WATCH_MARK.changed
    : mark === WATCH_MARK.unchecked
      ? WATCH_MARK.unchecked
      : WATCH_MARK.none;

const rowOf = (row: WatchSql): WatchRow => ({
  session: row.session,
  conversation: row.conversation,
  server: row.server,
  uri: row.uri,
  conn: row.conn,
  workspace: row.workspace,
  spawn: optional(row.spawn),
  state: row.state === "active" ? "active" : "pending",
  hash: optional(row.hash),
  mark: markOf(row.mark),
  subUris: Option.getOrElse(decodeUris(row.sub_uris), () => []),
  startedAt: row.started_at,
  lastRequestAt: row.last_request_at,
});

/** The watches' store over the object's migrated SQLite storage. */
export const watchStore = (storage: MigrationStorage): WatchStore => ({
  watches: () =>
    Arr.map(
      storage.sql
        .exec<WatchSql>("SELECT * FROM mcp_watches ORDER BY started_at, session, conversation, uri")
        .toArray(),
      rowOf,
    ),

  putWatch: (row) => {
    storage.sql.exec(
      `INSERT INTO mcp_watches (session, conversation, server, uri, conn, workspace, spawn, state, hash, mark, sub_uris, started_at, last_request_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session, conversation, server, uri) DO UPDATE SET
         conn = excluded.conn, workspace = excluded.workspace, spawn = excluded.spawn, state = excluded.state,
         hash = excluded.hash, mark = excluded.mark, sub_uris = excluded.sub_uris,
         started_at = excluded.started_at, last_request_at = excluded.last_request_at`,
      row.session,
      row.conversation,
      row.server,
      row.uri,
      row.conn,
      row.workspace,
      nullable(row.spawn),
      row.state,
      nullable(row.hash),
      row.mark,
      JSON.stringify(row.subUris),
      row.startedAt,
      row.lastRequestAt,
    );
  },

  dropWatches: (keys) => {
    storage.transactionSync(() => {
      for (const key of keys) {
        storage.sql.exec(
          "DELETE FROM mcp_watches WHERE session = ? AND conversation = ? AND server = ? AND uri = ?",
          key.session,
          key.conversation,
          key.server,
          key.uri,
        );
      }
    });
  },

  putWatchEnds: (ends) => {
    storage.transactionSync(() => {
      for (const end of ends) {
        storage.sql.exec(
          `INSERT INTO mcp_watch_ends (session, conversation, server, uri, reason, at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (session, conversation, server, uri) DO UPDATE SET reason = excluded.reason, at = excluded.at`,
          end.session,
          end.conversation,
          end.server,
          end.uri,
          end.reason,
          end.at,
        );
      }
    });
  },

  takeWatchEnds: (session, conversation) =>
    storage.transactionSync(() => {
      const taken = storage.sql
        .exec<WatchKey & { readonly reason: string; readonly at: number }>(
          "SELECT session, conversation, server, uri, reason, at FROM mcp_watch_ends WHERE session = ? AND conversation = ? ORDER BY at, server, uri",
          session,
          conversation,
        )
        .toArray();

      storage.sql.exec(
        "DELETE FROM mcp_watch_ends WHERE session = ? AND conversation = ?",
        session,
        conversation,
      );

      return taken;
    }),
});
