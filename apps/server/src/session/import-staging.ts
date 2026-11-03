// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- store operations over a few rows, not combinators.
// What a Session keeps of a Session import while it is staged (`docs/architecture/mcp-endpoint.md` → Session import → The
// import channel): the import's own record, and the file's bytes as they come, in rows of the Session's SQLite storage.
// The Session is the first object of its kind with tables of its own beside the Harness's (`pi_*`), so it has migrations
// and a manifest (`migrations.manifest.ts`). Migrations only add.
import { type Migration, migrate, type MigrationStorage } from "@cloudpid/effect-durable/sqlite";
import type { ImportRepo, ImportSummary, SessionVia } from "@cloudpid/protocol";

export const MIGRATIONS: ReadonlyArray<Migration> = [
  // 1: the import's record (one row, once begun), and the file's bytes by the offset each row starts at. A row stays well
  // under the object's 2 MB a row may hold, so a slice of up to 2 MiB is more than one.
  (sql) => {
    sql.exec(`CREATE TABLE import_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL
    ) STRICT`);
    sql.exec(`CREATE TABLE import_slices (
      start INTEGER PRIMARY KEY,
      bytes BLOB NOT NULL
    ) STRICT`);
  },
];

/** The most bytes one `import_slices` row holds. */
export const SLICE_ROW_BYTES = 1024 * 1024;

/**
 * Where an import is: `staging` while slices come, `finishing` once finish accepted the file and its translation runs
 * (or is to run again), `ended` once it is in the Session, `failed` when the file could not be translated, `cancelled`
 * when the Local agent gave it up.
 */
export type ImportPhase = "staging" | "finishing" | "ended" | "failed" | "cancelled";

/** What finish ended with, kept so finishing again answers the same. */
export type ImportOutcome = {
  readonly summary: ImportSummary;
  readonly warnings: ReadonlyArray<string>;
  /** The cursor the Local agent waits from: the instruction's, when one was sent. */
  readonly cursor?: string | undefined;
};

/** The import's record. */
export type ImportRecord = {
  readonly phase: ImportPhase;
  /** The size the file was declared to have, in bytes. */
  readonly size: number;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
  /** The instruction, kept until it is sent or the import is discarded. */
  readonly text?: string | undefined;
  readonly via: SessionVia;
  readonly workspace: { readonly branch: string; readonly repos: ReadonlyArray<ImportRepo> };
  /** When the import expires (epoch ms): an hour after its last append, then after what ended it badly. Absent once it ended, or once the entries are held. */
  readonly expiresAt?: number | undefined;
  /**
   * The translated entries are in the Session (a Run may be working from them): the import is no longer counted in
   * attempts, never given up, and never expires. It only waits for the Registry to be told it ended.
   */
  readonly held?: true | undefined;
  /** How many times finishing has been started over, so one that keeps failing is given up. */
  readonly attempts: number;
  /** Why it failed, for a `failed` import. */
  readonly failure?: string | undefined;
  readonly outcome?: ImportOutcome | undefined;
};

/** The staging rows and the import's record. */
export type ImportStaging = {
  /** The import's record, or none before it began. */
  readonly record: () => ImportRecord | undefined;
  readonly save: (record: ImportRecord) => void;
  /** How many bytes of the file are held: the end of the last row. */
  readonly received: () => number;
  /** Add `bytes` at `offset`, which must be the end of what is held. */
  readonly append: (offset: number, bytes: Uint8Array) => void;
  /** The held bytes, in order, a row at a time. */
  readonly rows: () => Iterable<Uint8Array>;
  /** Forget the held bytes. */
  readonly clear: () => void;
};

/** The phases this version writes; a stored one that is none of them (a newer version's) reads as `failed`. */
const PHASES: ReadonlySet<string> = new Set<ImportPhase>([
  "staging",
  "finishing",
  "ended",
  "failed",
  "cancelled",
]);

/**
 * The staging over `storage`, whose tables `migrations` make. They are made by the first write (the first `begin`),
 * never by opening it, so a Session that is no import, and one whose storage was wiped, keep no table of this file: a
 * read of a store that was never written finds nothing. Once they are made (`schema_version` is there), every read and
 * write first brings them up to the end of `migrations`, so a migration added later reaches an object that has them.
 */
export const importStaging = (
  storage: MigrationStorage,
  migrations: ReadonlyArray<Migration> = MIGRATIONS,
): ImportStaging => {
  const { sql } = storage;

  /** Make the tables, or bring them up to date (`migrate` is idempotent, and starts over on storage that was wiped). */
  const open = () => {
    migrate(storage, migrations);
  };

  /** Whether the tables were ever made, brought up to date if so: a read before the first write finds none, and makes none. */
  const present = (): boolean => {
    const made =
      sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
        .toArray().length > 0;

    if (made) open();

    return made;
  };

  const received = (): number => {
    if (!present()) return 0;

    const [row] = sql
      .exec<{ end: number | null }>("SELECT MAX(start + length(bytes)) AS end FROM import_slices")
      .toArray();

    return row?.end ?? 0;
  };

  return {
    record: () => {
      if (!present()) return undefined;

      const [row] = sql
        .exec<{ json: string }>("SELECT json FROM import_state WHERE id = 1")
        .toArray();

      if (row === undefined) return undefined;

      // SAFETY: only `save` writes this row, from an `ImportRecord`; a phase it does not know is read as `failed` below.
      const record = JSON.parse(row.json) as ImportRecord;

      return PHASES.has(record.phase) ? record : { ...record, phase: "failed" };
    },
    save: (record) => {
      open();
      sql.exec(
        "INSERT OR REPLACE INTO import_state (id, json) VALUES (1, ?)",
        JSON.stringify(record),
      );
    },
    received,
    append: (offset, bytes) => {
      open();
      storage.transactionSync(() => {
        for (let at = 0; at < bytes.length; at += SLICE_ROW_BYTES) {
          sql.exec(
            "INSERT OR REPLACE INTO import_slices (start, bytes) VALUES (?, ?)",
            offset + at,
            bytes.slice(at, at + SLICE_ROW_BYTES),
          );
        }
      });
    },
    rows: function* () {
      if (!present()) return;

      for (const row of sql.exec<{ bytes: ArrayBuffer }>(
        "SELECT bytes FROM import_slices ORDER BY start",
      )) {
        yield new Uint8Array(row.bytes);
      }
    },
    clear: () => {
      if (!present()) return;

      sql.exec("DELETE FROM import_slices");
    },
  };
};

/** The lines of the file the rows hold, decoded as the bytes come: a row may end inside a character or a line. */
export function* linesOf(rows: Iterable<Uint8Array>): Generator<string> {
  const decoder = new TextDecoder();
  let rest = "";

  for (const row of rows) {
    rest += decoder.decode(row, { stream: true });

    let newline = rest.indexOf("\n");

    while (newline !== -1) {
      yield rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      newline = rest.indexOf("\n");
    }
  }

  rest += decoder.decode();

  if (rest !== "") yield rest;
}
