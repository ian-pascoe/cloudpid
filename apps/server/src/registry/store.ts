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
  /** Register a Session, idle. */
  readonly createSession: (
    input: { readonly id: string; readonly title: string | null },
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
  status: checkedStatus(row.status),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toWorkspace = (row: WorkspaceRow): WorkspaceRecord => ({
  slug: row.slug,
  createdAt: row.created_at,
});

/**
 * Create the tables if they are missing and return the store over them. Run it from the object's constructor. The
 * schema is only ever added to, so `IF NOT EXISTS` is the whole migration until a table has to change.
 */
export const openRegistryStore = (sql: SqlStorage): RegistryStore => {
  sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`);
  sql.exec("CREATE INDEX IF NOT EXISTS sessions_by_created ON sessions (created_at DESC, id DESC)");
  sql.exec(`CREATE TABLE IF NOT EXISTS workspaces (
    slug TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  ) STRICT`);

  return {
    createSession: (input, now) => {
      sql.exec(
        "INSERT INTO sessions (id, title, status, created_at, updated_at) VALUES (?, ?, 'idle', ?, ?)",
        input.id,
        input.title,
        now,
        now,
      );

      return { id: input.id, title: input.title, status: "idle", createdAt: now, updatedAt: now };
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

    createWorkspace: (slug, now) => {
      sql.exec("INSERT OR IGNORE INTO workspaces (slug, created_at) VALUES (?, ?)", slug, now);

      return toWorkspace(
        sql.exec<WorkspaceRow>("SELECT * FROM workspaces WHERE slug = ?", slug).one(),
      );
    },

    listWorkspaces: () =>
      Arr.map(
        sql.exec<WorkspaceRow>("SELECT * FROM workspaces ORDER BY created_at DESC, slug").toArray(),
        toWorkspace,
      ),
  };
};
