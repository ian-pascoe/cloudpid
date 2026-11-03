// The set part of `McpHost`'s storage (`docs/architecture/mcp-connections.md` → Storage): the MCP server set as
// received (`mcp_servers`), its hash and revision, and what `mcp_meta` keeps beside them (the versions, the last use,
// the MCP sign-ins revision). It changes when the set's shape or the host's bookkeeping does.
// @effect-diagnostics missingPipeableSignature:off -- store operations, not combinators.
import type { MigrationStorage } from "@cloudpid/effect-durable/sqlite";
import { type McpApplySet, McpSetSource, type McpSetRevision } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { nullable, optional } from "./sql.ts";

/** What `mcp_meta` holds beyond the set: the versions, the last use and the MCP sign-ins revision. */
export type MetaRow = {
  readonly version?: string | undefined;
  readonly promptsVersion?: string | undefined;
  readonly lastUsedAt?: number | undefined;
  readonly signInsRevision?: number | undefined;
};

/** A server of the stored set. */
export type StoredServer = {
  readonly name: string;
  readonly entryHash: string;
  readonly conn: string;
  readonly source: McpSetSource;
  readonly server: Readonly<Record<string, Schema.Json>>;
  readonly identity: string;
};

/** The stored set: its hash, and its servers in the order the Registry gave them. */
export type StoredSet = {
  readonly hash: string;
  readonly revision: number;
  readonly servers: ReadonlyArray<StoredServer>;
};

export type SetStore = {
  /** The stored set, or null before one was applied. A row that no longer decodes is left out. */
  readonly readSet: () => StoredSet | null;
  /** The hash and revision of the stored set; undefined before one was applied (which reads as the empty set). */
  readonly held: () => McpSetRevision | undefined;
  /** The revision the host was wiped at: a set no newer than it is never kept; undefined when it never was wiped. */
  readonly wipedAt: () => number | undefined;
  /** Replace the stored set with `set`, whole or not at all. */
  readonly replaceSet: (set: McpApplySet) => void;
  /** Keep the set as it is under a newer `revision`. */
  readonly setRevision: (revision: number) => void;
  /** The versions, last use and MCP sign-ins revision; all absent before a set was applied. */
  readonly meta: () => MetaRow;
  /** Keep what `meta` gives: only where a set was applied, since a host with none has no inventory. */
  readonly setMeta: (meta: MetaRow) => void;
};

/** What `entry_json` holds of a server: the rest of its row is the columns. A reader keeps only the keys it knows. */
const StoredEntry = Schema.Struct({
  source: McpSetSource,
  server: Schema.Record(Schema.String, Schema.Json),
  identity: Schema.String,
});

const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(StoredEntry));

type ServerSql = {
  readonly name: string;
  readonly entry_hash: string;
  readonly conn: string;
  readonly entry_json: string;
};

type MetaSql = {
  readonly version: string | null;
  readonly prompts_version: string | null;
  readonly last_used_at: number | null;
  readonly sign_ins_revision: number | null;
};

/** The set's store over the object's migrated SQLite storage. */
export const setStore = (storage: MigrationStorage): SetStore => {
  const { sql } = storage;

  const held = (): McpSetRevision | undefined => {
    const [meta] = sql
      .exec<{ set_hash: string; revision: number }>(
        "SELECT set_hash, revision FROM mcp_meta WHERE id = 1",
      )
      .toArray();

    return meta === undefined ? undefined : { hash: meta.set_hash, revision: meta.revision };
  };

  return {
    held,

    wipedAt: () =>
      sql.exec<{ revision: number }>("SELECT revision FROM mcp_wiped WHERE id = 1").toArray()[0]
        ?.revision,

    readSet: () => {
      const meta = held();

      if (meta === undefined) return null;

      const rows = sql
        .exec<ServerSql>(
          "SELECT name, entry_hash, conn, entry_json FROM mcp_servers ORDER BY position",
        )
        .toArray();

      return {
        hash: meta.hash,
        revision: meta.revision,
        servers: Arr.filterMap(rows, (row) => {
          const entry = decodeEntry(row.entry_json);

          return Option.isNone(entry)
            ? Result.failVoid
            : Result.succeed<StoredServer>({
                name: row.name,
                entryHash: row.entry_hash,
                conn: row.conn,
                ...entry.value,
              });
        }),
      };
    },

    replaceSet: (set) => {
      storage.transactionSync(() => {
        sql.exec("DELETE FROM mcp_servers");

        for (const [position, entry] of Arr.map(
          set.entries,
          (held, index) => [index, held] as const,
        )) {
          sql.exec(
            "INSERT INTO mcp_servers (name, entry_hash, conn, entry_json, position) VALUES (?, ?, ?, ?, ?)",
            entry.name,
            entry.hash,
            entry.conn,
            JSON.stringify({
              source: entry.source,
              server: entry.server,
              identity: entry.identity,
            }),
            position,
          );
        }

        sql.exec(
          `INSERT INTO mcp_meta (id, set_hash, revision) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET set_hash = excluded.set_hash, revision = excluded.revision`,
          set.hash,
          set.revision,
        );
      });
    },

    setRevision: (revision) => {
      sql.exec("UPDATE mcp_meta SET revision = ? WHERE id = 1", revision);
    },

    meta: () => {
      const [row] = sql
        .exec<MetaSql>(
          "SELECT version, prompts_version, last_used_at, sign_ins_revision FROM mcp_meta WHERE id = 1",
        )
        .toArray();

      return row === undefined
        ? {}
        : {
            version: optional(row.version),
            promptsVersion: optional(row.prompts_version),
            lastUsedAt: optional(row.last_used_at),
            signInsRevision: optional(row.sign_ins_revision),
          };
    },

    setMeta: (meta) => {
      sql.exec(
        `UPDATE mcp_meta SET version = coalesce(?, version), prompts_version = coalesce(?, prompts_version),
         last_used_at = coalesce(?, last_used_at), sign_ins_revision = coalesce(?, sign_ins_revision) WHERE id = 1`,
        nullable(meta.version),
        nullable(meta.promptsVersion),
        nullable(meta.lastUsedAt),
        nullable(meta.signInsRevision),
      );
    },
  };
};
