// The `Trigger` object's storage (`docs/architecture/triggers.md` → The Trigger object and the Registry): the definition
// it caches at a revision, how far its Schedule was handled, its pending Fires and its fire log (the last
// `MAX_FIRE_LOG`). Synchronous over the object's SQLite. Migrations only add, and each shipped one has its digest in
// `migrations.manifest.ts`. The object opens it at its first use (`object.ts`), and a read of an object that has no
// storage (never synced, or wiped) answers empty without opening it (`hasTriggerStore`), so a read never makes the
// tables of a removed Trigger again.
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
  // with when to try each next, how many times it was tried, and `session`, the Session `admitFire` registered for it,
  // null until then) and its fire log (`trigger_fires`, in order).
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
      attempts INTEGER NOT NULL DEFAULT 0,
      session TEXT
    ) STRICT`);
    sql.exec(`CREATE TABLE trigger_fires (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      at INTEGER NOT NULL,
      source TEXT NOT NULL,
      outcome TEXT NOT NULL
    ) STRICT`);
  },
  // 2: how many later Fires were merged into a pending Fire that is waiting for its Workspace to be idle (a Workspace
  // trigger's `wait`, `docs/architecture/triggers.md` → Overlap): null until it first waited. Null for every Fire stored
  // before.
  (sql) => {
    sql.exec("ALTER TABLE trigger_pending ADD COLUMN coalesced INTEGER");
  },
];

/**
 * A Fire waiting in the object: its key, what made it, when to try it next, and the Session `admitFire` registered for
 * it, once it did (an admitted Fire is completed whatever comes after: a pause, a removal).
 */
export type PendingFire = {
  readonly key: string;
  readonly source: FireSource;
  readonly queuedAt: number;
  readonly nextTryAt: number;
  readonly attempts: number;
  readonly session: string | undefined;
  /**
   * Undefined until the Fire first waited for a busy Workspace (`wait`); then how many later Fires were recorded
   * `coalesced` into it, which the Session that finally starts is told.
   */
  readonly coalesced: number | undefined;
};

type MetaRow = { readonly definition: string; readonly cursor: number | null };

type PendingRow = {
  readonly key: string;
  readonly source: string;
  readonly queued_at: number;
  readonly next_try_at: number;
  readonly attempts: number;
  readonly session: string | null;
  readonly coalesced: number | null;
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

/** A kept source as it reads, or `unknown` for one that no longer does. */
const sourceOf = (text: string): FireSource =>
  Option.getOrElse(decodeSource(text), () => ({ type: "unknown" as const }));

const toPending = (row: PendingRow): PendingFire => ({
  key: row.key,
  source: sourceOf(row.source),
  queuedAt: row.queued_at,
  nextTryAt: row.next_try_at,
  attempts: row.attempts,
  session: row.session ?? undefined,
  coalesced: row.coalesced ?? undefined,
});

/**
 * Whether the object's storage holds its tables: false for one never synced, or wiped. Reads nothing but the schema,
 * and writes nothing.
 */
export const hasTriggerStore = (storage: MigrationStorage): boolean =>
  storage.sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trigger_meta'")
    .toArray().length > 0;

/** The store over a Trigger object's storage, its tables migrated first. */
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

    /** Whether a Fire of `key` is pending, or in the fire log. */
    holds: (key: string): boolean =>
      sql
        .exec<{ found: number }>(
          `SELECT EXISTS (SELECT 1 FROM trigger_pending WHERE key = ?)
             OR EXISTS (SELECT 1 FROM trigger_fires WHERE key = ?) AS found`,
          key,
          key,
        )
        .one().found === 1,

    /** Try pending Fire `key` again at `at`, one more attempt counted. */
    retry: (key: string, at: number): void => {
      sql.exec(
        "UPDATE trigger_pending SET attempts = attempts + 1, next_try_at = ? WHERE key = ?",
        at,
        key,
      );
    },

    /**
     * Pending Fire `key` waits for its Workspace to be idle (`admitFire` answered `busy`): tried again at `at`, which
     * counts no attempt, since waiting is no failure. A Fire already waiting keeps its count of merged Fires.
     */
    wait: (key: string, at: number): void => {
      sql.exec(
        "UPDATE trigger_pending SET coalesced = COALESCE(coalesced, 0), next_try_at = ? WHERE key = ?",
        at,
        key,
      );
    },

    /** One more later Fire was merged into the waiting pending Fire `key`. */
    coalesce: (key: string): void => {
      sql.exec(
        "UPDATE trigger_pending SET coalesced = COALESCE(coalesced, 0) + 1 WHERE key = ?",
        key,
      );
    },

    /** Pending Fire `key` was let through to `session`: it is completed whatever comes after. */
    admitted: (key: string, session: string): void => {
      sql.exec("UPDATE trigger_pending SET session = ? WHERE key = ?", session, key);
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
          source: sourceOf(row.source),
          outcome: Option.getOrElse(decodeOutcome(row.outcome), () => ({
            type: "unknown" as const,
          })),
        }),
      ),
  };
};

/** A Trigger object's store. */
export type TriggerStore = ReturnType<typeof openTriggerStore>;
