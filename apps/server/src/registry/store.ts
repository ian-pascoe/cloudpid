import { DEFAULT_WORKSPACE } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import { SessionStatus } from "../session/status.ts";

// The Registry's tables over the Registry DO's SQLite storage (`docs/spec.md` → Durable Objects). Synchronous, as
// SQLite in a Durable Object is, and given the time by its caller so tests control it.

export type { SessionStatus };

/** A Session as the Registry lists it. Times are epoch milliseconds. */
export type SessionRecord = {
  /** The Session DO's name: a UUIDv7. */
  readonly id: string;
  /** Null until the user or the title task gives it one. */
  readonly title: string | null;
  /** The slug of the Workspace the Session works on, fixed when it is created. */
  readonly workspace: string;
  readonly status: SessionStatus;
  readonly createdAt: number;
  /** When the Session was created or its status last changed. */
  readonly updatedAt: number;
};

/** A Workspace as the Registry lists it. The Workspace DO behind the slug comes later. */
export type WorkspaceRecord = {
  readonly slug: string;
  readonly createdAt: number;
};

export type RegistryStore = {
  /** Register a Session, idle, bound to `workspace` (default `DEFAULT_WORKSPACE`), which is registered too. */
  readonly createSession: (
    input: {
      readonly id: string;
      readonly title: string | null;
      readonly workspace?: string | undefined;
    },
    now: number,
  ) => SessionRecord;
  /** The Session registered under `id`, or null. */
  readonly getSession: (id: string) => SessionRecord | null;
  /** Every Session, newest first. */
  readonly listSessions: () => SessionRecord[];
  /** Record that a Session's Run started or ended. A Session that is not registered is ignored. */
  readonly setSessionStatus: (id: string, status: SessionStatus, now: number) => void;
  /** Register a Workspace by slug; one that is already registered keeps its record. */
  readonly createWorkspace: (slug: string, now: number) => WorkspaceRecord;
  readonly listWorkspaces: () => WorkspaceRecord[];
};

type SessionRow = {
  id: string;
  title: string | null;
  /** Null for a Session stored before Sessions had Workspaces. */
  workspace: string | null;
  status: string;
  created_at: number;
  updated_at: number;
};

type WorkspaceRow = { slug: string; created_at: number };

const isStatus = Schema.is(SessionStatus);

/**
 * The status is plain text in the table, not a `CHECK` constraint, which SQLite cannot alter: the set of statuses
 * will grow, and the table would have to be rebuilt in every stage. It is checked here instead.
 */
const checkedStatus = (status: string): SessionStatus => {
  if (!isStatus(status)) throw new Error(`Unknown Session status in the Registry: ${status}`);

  return status;
};

const toSession = (row: SessionRow): SessionRecord => ({
  id: row.id,
  title: row.title,
  workspace: row.workspace ?? DEFAULT_WORKSPACE,
  status: checkedStatus(row.status),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toWorkspace = (row: WorkspaceRow): WorkspaceRecord => ({
  slug: row.slug,
  createdAt: row.created_at,
});

/** The part of a Durable Object's storage the store uses: its SQLite database, and transactions over it. */
export type RegistryStorage = {
  readonly sql: SqlStorage;
  /** Run `closure` in a transaction: a throw rolls back everything it wrote. */
  readonly transactionSync: <T>(closure: () => T) => T;
};

/**
 * The schema, one step per version, applied in order: version N is in place once step N has run. Steps only add
 * (tables, nullable columns, rows), and a step is never edited once released: add the next one. Each step and its
 * version record run in one transaction, so a step that fails partway leaves no trace and is retried whole.
 */
export const MIGRATIONS: ReadonlyArray<(sql: SqlStorage) => void> = [
  // 1: the first deployed schema, whose stores recorded no version.
  (sql) => {
    sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`);
    sql.exec(
      "CREATE INDEX IF NOT EXISTS sessions_by_created ON sessions (created_at DESC, id DESC)",
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS workspaces (
      slug TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    ) STRICT`);
  },
  // 2: the Workspace a Session works on. Null for Sessions stored before, which read as the default Workspace.
  (sql) => {
    sql.exec("ALTER TABLE sessions ADD COLUMN workspace TEXT");
  },
  // 3: the default Workspace is listed from the start, so a picker finds it before any Session is created in it.
  (sql) => {
    sql.exec(
      `INSERT OR IGNORE INTO workspaces (slug, created_at)
       VALUES (?, CAST(unixepoch('subsec') * 1000 AS INTEGER))`,
      DEFAULT_WORKSPACE,
    );
  },
];

/** Bring the tables up to the latest version, or to the end of `migrations`. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const migrate = (
  storage: RegistryStorage,
  migrations: typeof MIGRATIONS = MIGRATIONS,
): void => {
  const { sql } = storage;

  sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL) STRICT");

  const [current] = sql
    .exec<{ version: number | null }>("SELECT MAX(version) AS version FROM schema_version")
    .toArray();

  for (let version = (current?.version ?? 0) + 1; version <= migrations.length; version++) {
    storage.transactionSync(() => {
      migrations[version - 1]?.(sql);
      sql.exec("INSERT INTO schema_version (version) VALUES (?)", version);
    });
  }
};

/** Migrate the tables and return the store over them. Run it from the object's constructor. */
export const openRegistryStore = (storage: RegistryStorage): RegistryStore => {
  migrate(storage);

  const { sql } = storage;

  const createWorkspace = (slug: string, now: number): WorkspaceRecord => {
    sql.exec("INSERT OR IGNORE INTO workspaces (slug, created_at) VALUES (?, ?)", slug, now);

    return toWorkspace(
      sql.exec<WorkspaceRow>("SELECT * FROM workspaces WHERE slug = ?", slug).one(),
    );
  };

  return {
    createSession: (input, now) => {
      const workspace = input.workspace ?? DEFAULT_WORKSPACE;

      createWorkspace(workspace, now);
      sql.exec(
        "INSERT INTO sessions (id, title, workspace, status, created_at, updated_at) VALUES (?, ?, ?, 'idle', ?, ?)",
        input.id,
        input.title,
        workspace,
        now,
        now,
      );

      return {
        id: input.id,
        title: input.title,
        workspace,
        status: "idle",
        createdAt: now,
        updatedAt: now,
      };
    },

    getSession: (id) => {
      const [row] = sql.exec<SessionRow>("SELECT * FROM sessions WHERE id = ?", id).toArray();

      return row === undefined ? null : toSession(row);
    },

    listSessions: () =>
      Arr.map(
        sql.exec<SessionRow>("SELECT * FROM sessions ORDER BY created_at DESC, id DESC").toArray(),
        toSession,
      ),

    setSessionStatus: (id, status, now) => {
      checkedStatus(status);
      sql.exec(
        "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ? AND status != ?",
        status,
        now,
        id,
        status,
      );
    },

    createWorkspace,

    listWorkspaces: () =>
      Arr.map(
        sql.exec<WorkspaceRow>("SELECT * FROM workspaces ORDER BY created_at DESC, slug").toArray(),
        toWorkspace,
      ),
  };
};
