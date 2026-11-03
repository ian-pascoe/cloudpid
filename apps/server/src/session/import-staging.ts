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
  /** When the import expires (epoch ms): an hour after its last append, then after what ended it badly. Absent once it ended. */
  readonly expiresAt?: number | undefined;
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

/** The staging over `storage`, its tables brought up to date. */
export const importStaging = (storage: MigrationStorage): ImportStaging => {
  migrate(storage, MIGRATIONS);

  const { sql } = storage;

  const received = (): number => {
    const [row] = sql
      .exec<{ end: number | null }>("SELECT MAX(start + length(bytes)) AS end FROM import_slices")
      .toArray();

    return row?.end ?? 0;
  };

  return {
    record: () => {
      const [row] = sql
        .exec<{ json: string }>("SELECT json FROM import_state WHERE id = 1")
        .toArray();

      // SAFETY: only `save` writes this row, from an `ImportRecord`.
      return row === undefined ? undefined : (JSON.parse(row.json) as ImportRecord);
    },
    save: (record) => {
      sql.exec(
        "INSERT OR REPLACE INTO import_state (id, json) VALUES (1, ?)",
        JSON.stringify(record),
      );
    },
    received,
    append: (offset, bytes) => {
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
      for (const row of sql.exec<{ bytes: ArrayBuffer }>(
        "SELECT bytes FROM import_slices ORDER BY start",
      )) {
        yield new Uint8Array(row.bytes);
      }
    },
    clear: () => {
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
