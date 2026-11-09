// The `Trigger` object's storage (`docs/architecture/triggers.md` → The Trigger object and the Registry): the definition
// it caches at a revision, how far its Schedule was handled, its pending Fires and its fire log (the last
// `MAX_FIRE_LOG`). Synchronous over the object's SQLite. Migrations only add, and each shipped one has its digest in
// `migrations.manifest.ts`. The webhook parts (migration 2): the token and Signing secret, sealed, with the token's
// keyed hash; the per-day counts of refused and filtered deliveries (kept `COUNT_DAYS`); the time of the last delivery
// and of GitHub's ping; the last delivered body, for Fire again; and the payload a pending Fire carries. The object opens it at its first use (`object.ts`), and a read of an object that has no
// storage (never synced, or wiped) answers empty without opening it (`hasTriggerStore`), so a read never makes the
// tables of a removed Trigger again.
// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off globalDate:off -- store operations over SQLite and JSON text.
import { type Migration, migrate, type MigrationStorage } from "@cloudpid/effect-durable/sqlite";
import { SealedValue } from "@cloudpid/extensions/secrets/core";
import {
  FireOutcome,
  FirePayload,
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
  // 3: the webhook parts, all additive: a pending Fire's `payload` (JSON `FirePayload` without its body), `body` (the
  // body's bytes as received, when kept), `revision` (the revision of the definition whose `match` the delivery passed)
  // and `facts` (JSON, when the body was not kept: what that `match` read of it, nested by path); `trigger_secrets`, the one row of the sealed token and Signing secret (JSON
  // `SealedValue`s) with the token's keyed hash; `trigger_counts`, the deliveries refused or filtered, per UTC day and
  // outcome; `trigger_hook`, the one row with the time of the last authentic delivery, of GitHub's last ping, and the
  // last accepted delivery's payload and body bytes (what Fire again sends).
  (sql) => {
    sql.exec("ALTER TABLE trigger_pending ADD COLUMN payload TEXT");
    sql.exec("ALTER TABLE trigger_pending ADD COLUMN body BLOB");
    sql.exec("ALTER TABLE trigger_pending ADD COLUMN revision INTEGER");
    sql.exec("ALTER TABLE trigger_pending ADD COLUMN facts TEXT");
    sql.exec(`CREATE TABLE trigger_secrets (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token TEXT NOT NULL,
      secret TEXT NOT NULL,
      token_hash TEXT NOT NULL
    ) STRICT`);
    sql.exec(`CREATE TABLE trigger_counts (
      day TEXT NOT NULL,
      outcome TEXT NOT NULL,
      n INTEGER NOT NULL,
      PRIMARY KEY (day, outcome)
    ) STRICT`);
    sql.exec(`CREATE TABLE trigger_hook (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_delivery_at INTEGER,
      ping_at INTEGER,
      last_payload TEXT,
      last_body BLOB
    ) STRICT`);
  },
];

/** How long a delivery's Fire is held against a repeat once it is in the fire log: the Registry's memory of its key. */
export const DEDUPE_MS = 24 * 60 * 60_000;

/** How many UTC days the per-day counts of refused and filtered deliveries are kept, today's included. */
export const COUNT_DAYS = 30;

/** What the object keeps of a Trigger's token and Signing secret: both sealed, and the token's keyed hash. */
export type KeptSecrets = {
  readonly token: SealedValue;
  readonly secret: SealedValue;
  readonly tokenHash: string;
};

/** The deliveries refused or filtered on one UTC day (`day`, `YYYY-MM-DD`), by outcome. */
export type DayCount = { readonly day: string; readonly outcome: string; readonly n: number };

/** What the object says of the deliveries it took: its last authentic delivery's time, and GitHub's last ping's. */
export type HookState = {
  readonly lastDeliveryAt: number | undefined;
  readonly pingAt: number | undefined;
};

/** What a webhook delivery gave a pending Fire: its payload (without the body), the body's bytes when kept, and what its `match` passed. */
export type KeptDelivery = {
  readonly payload: FirePayload;
  /** The body as received, when it was within `MAX_KEPT_BODY_BYTES`. */
  readonly body?: Uint8Array | undefined;
  /** The revision of the definition whose `match` the delivery passed: the Fire is admitted at it, and checked again once stale. */
  readonly revision?: number | undefined;
  /** What that `match` read of a body that was not kept, nested by path, so a later `match` can be checked as far as it goes. */
  readonly facts?: Schema.Json | undefined;
};

/**
 * A Fire waiting in the object: its key, what made it, when to try it next, and the Session `admitFire` registered for
 * it, once it did (an admitted Fire is completed whatever comes after: a pause, a removal). A webhook's carries what the
 * delivery gave it (`delivery`).
 */
export type PendingFire = {
  readonly key: string;
  readonly source: FireSource;
  readonly queuedAt: number;
  readonly nextTryAt: number;
  readonly attempts: number;
  readonly session: string | undefined;
  /**
   * Undefined until the Fire first waited for a busy Workspace (`wait`); then `merged` counts the later Fires recorded
   * `coalesced` into it, which the Session that finally starts is told. Stored in `trigger_pending.coalesced`, null
   * while it does not wait.
   */
  readonly waiting: { readonly merged: number } | undefined;
  readonly delivery: KeptDelivery | undefined;
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
  readonly payload: string | null;
  readonly body: ArrayBuffer | null;
  readonly revision: number | null;
  readonly facts: string | null;
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

const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(FirePayload));

const decodeSealed = Schema.decodeUnknownOption(Schema.fromJsonString(SealedValue));

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** A kept payload (without its body), or undefined when there is none or it no longer reads. */
const payloadOf = (payload: string | null): FirePayload | undefined =>
  payload === null ? undefined : Option.getOrUndefined(decodePayload(payload));

/** A kept body's bytes, or undefined for none. */
const bodyOf = (body: ArrayBuffer | null): Uint8Array<ArrayBuffer> | undefined =>
  body === null ? undefined : new Uint8Array(body);

/** `payload` as its row keeps it: the JSON without a body (a `FirePayload` that has one is stored without it). */
const payloadJson = (payload: FirePayload): string => {
  const { body: _body, ...rest } = payload;

  return JSON.stringify(rest);
};

/** `body` as a value a row takes: its own bytes, not a view of a larger buffer. */
const blobOf = (body: Uint8Array | undefined): ArrayBuffer | null =>
  body === undefined ? null : Uint8Array.from(body).buffer;

/** The UTC day of `at` (ms), `YYYY-MM-DD`. */
export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** The delivery a pending row keeps, or undefined for a Fire that has none (or one that no longer reads). */
const deliveryOf = (row: PendingRow): KeptDelivery | undefined => {
  const payload = payloadOf(row.payload);

  if (payload === undefined) return undefined;

  return {
    payload,
    body: bodyOf(row.body),
    revision: row.revision ?? undefined,
    facts: row.facts === null ? undefined : Option.getOrUndefined(decodeJson(row.facts)),
  };
};

const toPending = (row: PendingRow): PendingFire => ({
  key: row.key,
  source: sourceOf(row.source),
  queuedAt: row.queued_at,
  nextTryAt: row.next_try_at,
  attempts: row.attempts,
  session: row.session ?? undefined,
  waiting: row.coalesced === null ? undefined : { merged: row.coalesced },
  delivery: deliveryOf(row),
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

    /** Keep a pending Fire (with a webhook's `delivery`), unless one of its key is pending already. */
    enqueue: (key: string, source: FireSource, now: number, delivery?: KeptDelivery): void => {
      sql.exec(
        `INSERT INTO trigger_pending (key, source, queued_at, next_try_at, payload, body, revision, facts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (key) DO NOTHING`,
        key,
        JSON.stringify(source),
        now,
        now,
        delivery === undefined ? null : payloadJson(delivery.payload),
        blobOf(delivery?.body),
        delivery?.revision ?? null,
        delivery?.facts === undefined ? null : JSON.stringify(delivery.facts),
      );
    },

    /** Drop pending Fire `key`, recording nothing (a delivery that no longer matches). */
    drop: (key: string): void => {
      sql.exec("DELETE FROM trigger_pending WHERE key = ?", key);
    },

    /** Pending Fire `key`'s delivery passes the `match` of revision `revision` now. */
    matched: (key: string, revision: number): void => {
      sql.exec("UPDATE trigger_pending SET revision = ? WHERE key = ?", revision, key);
    },

    /**
     * Whether a Fire of `key` is pending, or was recorded in the last `DEDUPE_MS` before `now`: a sender's redelivery
     * a day later fires again, as the Registry's memory of the key (`REQUEST_MEMORY_MS`) ends too.
     */
    holds: (key: string, now: number): boolean =>
      sql
        .exec<{ found: number }>(
          `SELECT EXISTS (SELECT 1 FROM trigger_pending WHERE key = ?)
             OR EXISTS (SELECT 1 FROM trigger_fires WHERE key = ? AND at > ?) AS found`,
          key,
          key,
          now - DEDUPE_MS,
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

    /**
     * The sealed token and Signing secret; undefined while the object holds no row, and `unreadable` for a row that is
     * there and no longer reads (a later version's shape): it is never replaced but by the owner's rotation.
     */
    secrets: (): KeptSecrets | "unreadable" | undefined => {
      const row = sql
        .exec<{ token: string; secret: string; token_hash: string }>(
          "SELECT token, secret, token_hash FROM trigger_secrets WHERE id = 1",
        )
        .toArray()[0];

      if (row === undefined) return undefined;

      const token = decodeSealed(row.token);
      const secret = decodeSealed(row.secret);

      return Option.isSome(token) && Option.isSome(secret)
        ? { token: token.value, secret: secret.value, tokenHash: row.token_hash }
        : "unreadable";
    },

    /** Keep `secrets` as the object's token and Signing secret, in place of any it held. */
    keepSecrets: (secrets: KeptSecrets): void => {
      sql.exec(
        `INSERT INTO trigger_secrets (id, token, secret, token_hash) VALUES (1, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET token = excluded.token, secret = excluded.secret, token_hash = excluded.token_hash`,
        JSON.stringify(secrets.token),
        JSON.stringify(secrets.secret),
        secrets.tokenHash,
      );
    },

    /** Count a delivery refused or filtered, on the UTC day of `at`; days older than `COUNT_DAYS` are dropped. */
    count: (outcome: string, at: number): void => {
      storage.transactionSync(() => {
        sql.exec(
          `INSERT INTO trigger_counts (day, outcome, n) VALUES (?, ?, 1)
             ON CONFLICT (day, outcome) DO UPDATE SET n = n + 1`,
          dayOf(at),
          outcome,
        );
        sql.exec("DELETE FROM trigger_counts WHERE day <= ?", dayOf(at - COUNT_DAYS * 86_400_000));
      });
    },

    /** The counts of the last `COUNT_DAYS` days before `at`, oldest day first. */
    counts: (at: number): Array<DayCount> =>
      sql
        .exec<DayCount>(
          "SELECT day, outcome, n FROM trigger_counts WHERE day > ? ORDER BY day, outcome",
          dayOf(at - COUNT_DAYS * 86_400_000),
        )
        .toArray(),

    /** The time of the last authentic delivery and of GitHub's last ping. */
    hook: (): HookState => {
      const row = sql
        .exec<{ last_delivery_at: number | null; ping_at: number | null }>(
          "SELECT last_delivery_at, ping_at FROM trigger_hook WHERE id = 1",
        )
        .toArray()[0];

      return {
        lastDeliveryAt: row?.last_delivery_at ?? undefined,
        pingAt: row?.ping_at ?? undefined,
      };
    },

    /** Note an authentic delivery at `at`, and, for GitHub's `ping`, the ping's time. */
    delivered: (at: number, ping: boolean): void => {
      sql.exec(
        `INSERT INTO trigger_hook (id, last_delivery_at, ping_at) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET last_delivery_at = excluded.last_delivery_at,
             ping_at = COALESCE(excluded.ping_at, trigger_hook.ping_at)`,
        at,
        ping ? at : null,
      );
    },

    /** Keep `payload` (without its body) and `body`, when it was kept, as the last accepted delivery, for Fire again. */
    keepLast: (payload: FirePayload, body: Uint8Array | undefined): void => {
      sql.exec(
        `INSERT INTO trigger_hook (id, last_payload, last_body) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET last_payload = excluded.last_payload, last_body = excluded.last_body`,
        payloadJson(payload),
        blobOf(body),
      );
    },

    /** The last accepted delivery's payload and body, or undefined while none was accepted. */
    last: ():
      | { readonly payload: FirePayload; readonly body: Uint8Array | undefined }
      | undefined => {
      const row = sql
        .exec<{ last_payload: string | null; last_body: ArrayBuffer | null }>(
          "SELECT last_payload, last_body FROM trigger_hook WHERE id = 1",
        )
        .toArray()[0];

      const payload = payloadOf(row?.last_payload ?? null);

      return payload === undefined ? undefined : { payload, body: bodyOf(row?.last_body ?? null) };
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
