// `McpHost`'s storage (`docs/architecture/mcp-connections.md` → Storage): the MCP server set as received, with the hash
// the Registry gave it. What the host holds is what the Registry pushed, `${NAME}` unresolved, so no resolved value is
// ever here; the rest of the tables (inventories, status, eras, sessions, watches, App HTML) come with the slices that
// use them. Migrations only add, and each shipped one has its digest in `migrations.manifest.ts`.
// @effect-diagnostics missingPipeableSignature:off -- store operations, not combinators.
import { type Migration, migrate, type MigrationStorage } from "@cloudpid/effect-durable/sqlite";
import { McpSetSource, type McpApplySet } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export const MIGRATIONS: ReadonlyArray<Migration> = [
  // 1: the set as received (`mcp_meta` is one row, which exists once a set has been applied).
  (sql) => {
    sql.exec(`CREATE TABLE mcp_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      set_hash TEXT NOT NULL,
      sign_ins_revision INTEGER NOT NULL DEFAULT 0
    ) STRICT`);
    sql.exec(`CREATE TABLE mcp_servers (
      name TEXT PRIMARY KEY,
      entry_hash TEXT NOT NULL,
      conn TEXT NOT NULL,
      entry_json TEXT NOT NULL,
      position INTEGER NOT NULL
    ) STRICT`);
  },
];

/** What `entry_json` holds of a server: the rest of its row is the columns. A reader keeps only the keys it knows. */
const StoredEntry = Schema.Struct({
  source: McpSetSource,
  server: Schema.Record(Schema.String, Schema.Json),
  identity: Schema.String,
});

const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(StoredEntry));

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
  readonly signInsRevision: number;
  readonly servers: ReadonlyArray<StoredServer>;
};

export type McpHostStoreService = {
  /** The stored set, or null before one was applied. A row that no longer decodes is left out. */
  readonly readSet: () => StoredSet | null;
  /** The hash of the stored set; undefined before one was applied (which reads as the empty set). */
  readonly heldHash: () => string | undefined;
  /** Replace the stored set with `set`, whole or not at all. */
  readonly replaceSet: (set: McpApplySet, signInsRevision?: number) => void;
};

/** The host's storage, as its methods use it: the object's SQLite store, or a fake that fails on demand. */
export class McpHostStore extends Context.Service<McpHostStore, McpHostStoreService>()(
  "@cloudpid/server/mcp/store/McpHostStore",
) {}

/** The part of the object's storage the store uses: its SQLite database and transactions over it. */
export type McpHostStorage = MigrationStorage;

type ServerRow = {
  readonly name: string;
  readonly entry_hash: string;
  readonly conn: string;
  readonly entry_json: string;
};

/** Migrate the tables and return the store over them. Run it from the object's constructor. */
export const openMcpHostStore = (storage: McpHostStorage): McpHostStoreService => {
  migrate(storage, MIGRATIONS);

  const { sql } = storage;

  const heldHash = (): string | undefined =>
    sql.exec<{ set_hash: string }>("SELECT set_hash FROM mcp_meta WHERE id = 1").toArray()[0]
      ?.set_hash;

  return {
    heldHash,

    readSet: () => {
      const [meta] = sql
        .exec<{
          set_hash: string;
          sign_ins_revision: number;
        }>("SELECT set_hash, sign_ins_revision FROM mcp_meta WHERE id = 1")
        .toArray();

      if (meta === undefined) return null;

      const rows = sql
        .exec<ServerRow>(
          "SELECT name, entry_hash, conn, entry_json FROM mcp_servers ORDER BY position",
        )
        .toArray();

      return {
        hash: meta.set_hash,
        signInsRevision: meta.sign_ins_revision,
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

    replaceSet: (set, signInsRevision) => {
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
          `INSERT INTO mcp_meta (id, set_hash, sign_ins_revision) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET set_hash = excluded.set_hash,
             sign_ins_revision = CASE WHEN ? THEN excluded.sign_ins_revision ELSE sign_ins_revision END`,
          set.hash,
          signInsRevision ?? 0,
          signInsRevision === undefined ? 0 : 1,
        );
      });
    },
  };
};
