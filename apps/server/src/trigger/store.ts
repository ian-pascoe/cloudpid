// The `Trigger` object's storage (`docs/architecture/triggers.md` → The Trigger object and the Registry): the definition
// it caches at a revision, how far its Schedule was handled, its pending Fires and its fire log (the last
// `MAX_FIRE_LOG`). Synchronous over the object's SQLite. Migrations only add, and each shipped one has its digest in
// `migrations.manifest.ts`.
// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off -- store operations over SQLite and JSON text.
import { type Migration, migrate, type MigrationStorage } from "@cloudpid/effect-durable/sqlite";
import {
  FireOutcome,
  type FireRecord,
  FireSource,
  MAX_FIRE_LOG,
  TriggerDefinition,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const MIGRATIONS: ReadonlyArray<Migration> = [
  // 1: the object's one row (`trigger_meta`: the definition as last read, JSON `TriggerDefinition`, and `cursor`, the
  // time the Schedule was handled up to, null while none is), its pending Fires (`trigger_pending`, by the Fire's key,
  // with when to try each next and how many times it was tried) and its fire log (`trigger_fires`, in order).
  (sql) => {
    sql.exec(`CREATE TABLE trigger_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      definition TEXT NOT NULL,
      cursor INTEGER
    ) STRICT`);
    sql.exec(`CREATE TABLE trigger_pending (
      key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      next_try_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    ) STRICT`);
    sql.exec(`CREATE TABLE trigger_fires (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      at INTEGER NOT NULL,
      source TEXT NOT NULL,
      outcome TEXT NOT NULL
    ) STRICT`);
  },
];

/** A Fire waiting in the object: its key, what made it, and when to try it next. */
export type PendingFire = {
  readonly key: string;
  readonly source: FireSource;
  readonly queuedAt: number;
  readonly nextTryAt: number;
  readonly attempts: number;
};

type MetaRow = { readonly definition: string; readonly cursor: number | null };

type PendingRow = {
  readonly key: string;
  readonly source: string;
  readonly queued_at: number;
  readonly next_try_at: number;
  readonly attempts: number;
};

type FireRow = {
  readonly key: string;
  readonly at: number;
  readonly source: string;
  readonly outcome: string;
};

const decodeDefinition = Schema.decodeUnknownOption(Schema.fromJsonString(TriggerDefinition));

const decodeSource = Schema.decodeUnknownOption(Schema.fromJsonString(FireSource));

const decodeOutcome = Schema.decodeUnknownOption(Schema.fromJsonString(FireOutcome));

const toPending = (row: PendingRow): PendingFire => ({
  key: row.key,
  source: Option.getOrElse(decodeSource(row.source), () => ({ type: "unknown" as const })),
  queuedAt: row.queued_at,
  nextTryAt: row.next_try_at,
  attempts: row.attempts,
});

/** The store over a Trigger object's storage, its tables migrated first. Open it from the object's constructor. */
export const openTriggerStore = (storage: MigrationStorage) => {
  migrate(storage, MIGRATIONS);

  const { sql } = storage;

  const meta = (): MetaRow | undefined =>
    sql.exec<MetaRow>("SELECT definition, cursor FROM trigger_meta WHERE id = 1").toArray()[0];

  return {
    /** The definition as last read, or undefined before the first (or once it no longer reads). */
    definition: (): TriggerDefinition | undefined => {
      const row = meta();

      return row === undefined
        ? undefined
        : Option.getOrUndefined(decodeDefinition(row.definition));
    },

    /** The time the Schedule was handled up to, or undefined while none is (new, paused). */
    cursor: (): number | undefined => meta()?.cursor ?? undefined,

    /** Keep `definition` and the cursor (`undefined`: none). */
    keep: (definition: TriggerDefinition, cursor: number | undefined): void => {
      sql.exec(
        `INSERT INTO trigger_meta (id, definition, cursor) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET definition = excluded.definition, cursor = excluded.cursor`,
        JSON.stringify(definition),
        cursor ?? null,
      );
    },

    /** The pending Fires, oldest first. */
    pending: (): Array<PendingFire> =>
      Arr.map(
        sql.exec<PendingRow>("SELECT * FROM trigger_pending ORDER BY queued_at, key").toArray(),
        toPending,
      ),

    /** Keep a pending Fire, unless one of its key is pending already. */
    enqueue: (key: string, source: FireSource, now: number): void => {
      sql.exec(
        `INSERT INTO trigger_pending (key, source, queued_at, next_try_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (key) DO NOTHING`,
        key,
        JSON.stringify(source),
        now,
        now,
      );
    },

    /** Try pending Fire `key` again at `at`, one more attempt counted. */
    retry: (key: string, at: number): void => {
      sql.exec(
        "UPDATE trigger_pending SET attempts = attempts + 1, next_try_at = ? WHERE key = ?",
        at,
        key,
      );
    },

    /** Drop every pending Fire. */
    clearPending: (): void => {
      sql.exec("DELETE FROM trigger_pending");
    },

    /** Record what came of a Fire, dropping it from the pending ones, and keep the last `MAX_FIRE_LOG` records. */
    record: (fire: FireRecord): void => {
      storage.transactionSync(() => {
        sql.exec("DELETE FROM trigger_pending WHERE key = ?", fire.key);
        sql.exec(
          "INSERT INTO trigger_fires (key, at, source, outcome) VALUES (?, ?, ?, ?)",
          fire.key,
          fire.at,
          JSON.stringify(fire.source),
          JSON.stringify(fire.outcome),
        );
        sql.exec(
          "DELETE FROM trigger_fires WHERE seq <= (SELECT MAX(seq) FROM trigger_fires) - ?",
          MAX_FIRE_LOG,
        );
      });
    },

    /** The fire log, newest first, at most `limit` records. */
    fires: (limit: number = MAX_FIRE_LOG): Array<FireRecord> =>
      Arr.map(
        sql
          .exec<FireRow>(
            "SELECT key, at, source, outcome FROM trigger_fires ORDER BY seq DESC LIMIT ?",
            limit,
          )
          .toArray(),
        (row) => ({
          key: row.key,
          at: row.at,
          source: Option.getOrElse(decodeSource(row.source), () => ({ type: "unknown" as const })),
          outcome: Option.getOrElse(decodeOutcome(row.outcome), () => ({
            type: "unknown" as const,
          })),
        }),
      ),
  };
};

/** A Trigger object's store. */
export type TriggerStore = ReturnType<typeof openTriggerStore>;
