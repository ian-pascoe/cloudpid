import {
  DEFAULT_MACHINE,
  type PushSubscription,
  TitleSource,
  worktreeDirectory,
} from "@cloudpid/protocol";
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
  /** Who set the title: null while there is none. A title the owner set is never replaced; a generated one is set once. */
  readonly titleSource: TitleSource | null;
  /** The slug of the Machine the Session works on, fixed when it is created. */
  readonly machine: string;
  /** The repo directory below `/workspace` that is the Session's `cwd`, fixed when it is created; null for the root. */
  readonly repo: string | null;
  /** The Workspace of its own the Session works in (a worktree of `repo`), fixed when it is created; null for none. */
  readonly workspace: string | null;
  readonly status: SessionStatus;
  readonly createdAt: number;
  /** When the Session was created or its status last changed. */
  readonly updatedAt: number;
  /** When the owner archived the Session, or null while it is not archived. */
  readonly archivedAt: number | null;
};

/** A Machine as the Registry lists it. */
export type MachineRecord = {
  /** Its fixed identifier: the Workspace DO's name, and what its Sessions are bound to. */
  readonly slug: string;
  /** The owner's label for it, unique among Machines whatever the case. It starts as the slug. */
  readonly name: string;
  readonly createdAt: number;
};

/** A Workspace of its own (ADR-0015): a worktree of a repo on a Machine, on one branch. */
export type WorkspaceRecord = {
  /** Eight lowercase hex digits, also its worktree's directory name. */
  readonly id: string;
  readonly machine: string;
  readonly repo: string;
  readonly branch: string;
  /** Its worktree: `worktreeDirectory(repo, id)`. */
  readonly directory: string;
  readonly createdAt: number;
};

/** What became of a Workspace's record: deleted, not registered, or kept because a Session is still bound to it. */
/** A Session's Workspace of its own, as `createSession` is told it: one that exists, or a new one. */
export type StoredWorkspaceChoice =
  | { readonly kind: "existing"; readonly id: string }
  | { readonly kind: "new"; readonly id: string; readonly branch: string };

export type WorkspaceDeletion = "deleted" | "missing" | "in-use";

/** How renaming a Machine went. */
export type MachineRename =
  | { readonly status: "renamed"; readonly machine: MachineRecord }
  | { readonly status: "missing" }
  | { readonly status: "taken" };

/** What became of a Machine's record: deleted, not registered, or kept because a Session is still bound to it. */
export type MachineDeletion = "deleted" | "missing" | "in-use";

export type RegistryStore = {
  /** Register a Session, idle, bound to `machine` (default `DEFAULT_MACHINE`), which is registered too. */
  readonly createSession: (
    input: {
      readonly id: string;
      readonly title: string | null;
      readonly machine?: string | undefined;
      readonly repo?: string | undefined;
      /**
       * The Session's Workspace of its own: one that exists (which must be of `machine` and `repo`), or a new one to
       * register with it, in the same transaction. Without it the Session works in the repo's main checkout.
       */
      readonly workspace?: StoredWorkspaceChoice | undefined;
    },
    now: number,
  ) => SessionRecord;
  /** The Session registered under `id`, or null. */
  readonly getSession: (id: string) => SessionRecord | null;
  /** Every Session, newest first. */
  readonly listSessions: () => SessionRecord[];
  /** Record that a Session's Run started or ended. A Session that is not registered is ignored. */
  readonly setSessionStatus: (id: string, status: SessionStatus, now: number) => void;
  /** Give a Session the owner's title, replacing any other; null when the Session is not registered. */
  readonly renameSession: (id: string, title: string) => SessionRecord | null;
  /**
   * Give a Session a generated title, only if it has none: a Session the owner named, or one already titled, keeps its
   * title. Says whether the title was set.
   */
  readonly setGeneratedTitle: (id: string, title: string) => boolean;
  /** Archive a Session; one already archived keeps the time it was. Null when the Session is not registered. */
  readonly archiveSession: (id: string, now: number) => SessionRecord | null;
  /** Put an archived Session back in the list; null when the Session is not registered. */
  readonly unarchiveSession: (id: string) => SessionRecord | null;
  /** Forget a Session; says whether it was registered. */
  readonly deleteSession: (id: string) => boolean;
  /**
   * Register a Machine by slug, named after it; one that is already registered keeps its record. When another
   * Machine already has that name, the new one is named `<slug> 2` (or 3, …).
   */
  readonly createMachine: (slug: string, now: number) => MachineRecord;
  /** The Machine registered under `slug`, or null. */
  readonly getMachine: (slug: string) => MachineRecord | null;
  readonly listMachines: () => MachineRecord[];
  /** Give a Machine a new name, which no other Machine may have in any case. */
  readonly renameMachine: (slug: string, name: string) => MachineRename;
  /** Forget a Machine's record and its Workspaces', only while no Session is bound to it (they are never touched). */
  readonly deleteMachine: (slug: string) => MachineDeletion;
  /** The Workspace registered under `id`, or null. */
  readonly getWorkspace: (id: string) => WorkspaceRecord | null;
  /** Every Workspace, newest first. */
  readonly listWorkspaces: () => WorkspaceRecord[];
  /** Forget a Workspace's record, only while no Session is bound to it. */
  readonly deleteWorkspace: (id: string) => WorkspaceDeletion;
  /**
   * Forget the records of the Workspaces of Machine `machine` (of its repo `repo` only, when given) that no Session is
   * bound to, once their worktrees are gone with the Machine's files or the repo.
   */
  readonly deleteWorkspacesOf: (machine: string, repo?: string) => void;
  /** The JSON text of the document called `name`, or null. Documents hold the Registry's own settings. */
  readonly getDocument: (name: string) => string | null;
  /** Save a document, replacing the one with its name. */
  readonly putDocument: (name: string, body: string, now: number) => void;
  /** Keep a browser's Web Push subscription, replacing the one with the same endpoint. */
  readonly putPushSubscription: (subscription: PushSubscription, now: number) => void;
  /** Forget the subscription at `endpoint`; one that is not kept is ignored. */
  readonly deletePushSubscription: (endpoint: string) => void;
  /** Whether a subscription at `endpoint` is kept. */
  readonly hasPushSubscription: (endpoint: string) => boolean;
  /** Every kept subscription, oldest first. */
  readonly listPushSubscriptions: () => PushSubscription[];
};

type SessionRow = {
  id: string;
  title: string | null;
  title_source: string | null;
  /** Null for a Session stored before Sessions had Machines. */
  workspace: string | null;
  /** Null for the Machine root, and for a Session stored before Sessions had repos. */
  repo: string | null;
  /** The Session's Workspace of its own; null for none, and for a Session stored before Workspaces had worktrees. */
  worktree: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

/** `name` is null only between migration 8's two statements. */
// The `workspaces` table and the `sessions.workspace` column predate the rename of Workspaces to Machines. Their
// names are kept (migrations are released and immutable); `SessionRow.workspace` is the machine's slug.
type MachineRow = { slug: string; name: string | null; created_at: number };

/** A Workspace of its own. The table is named for the worktree it is, since `workspaces` holds the Machines. */
type WorkspaceRow = {
  id: string;
  machine: string;
  repo: string;
  branch: string;
  created_at: number;
};

type PushSubscriptionRow = { endpoint: string; p256dh: string; auth: string };

const isStatus = Schema.is(SessionStatus);

/**
 * The status is plain text in the table, not a `CHECK` constraint, which SQLite cannot alter: the set of statuses
 * will grow, and the table would have to be rebuilt in every stage. It is checked here instead.
 */
const checkedStatus = (status: string): SessionStatus => {
  if (!isStatus(status)) throw new Error(`Unknown Session status in the Registry: ${status}`);

  return status;
};

const isTitleSource = Schema.is(TitleSource);

const checkedTitleSource = (source: string | null): TitleSource | null => {
  if (source === null) return null;

  if (!isTitleSource(source)) throw new Error(`Unknown title source in the Registry: ${source}`);

  return source;
};

const toSession = (row: SessionRow): SessionRecord => ({
  id: row.id,
  title: row.title,
  titleSource: checkedTitleSource(row.title_source),
  machine: row.workspace ?? DEFAULT_MACHINE,
  repo: row.repo,
  workspace: row.worktree ?? null,
  status: checkedStatus(row.status),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at,
});

const toMachine = (row: MachineRow): MachineRecord => ({
  slug: row.slug,
  name: row.name ?? row.slug,
  createdAt: row.created_at,
});

const toWorkspace = (row: WorkspaceRow): WorkspaceRecord => ({
  id: row.id,
  machine: row.machine,
  repo: row.repo,
  branch: row.branch,
  directory: worktreeDirectory(row.repo, row.id),
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
      DEFAULT_MACHINE,
    );
  },
  // 4: documents by name, which hold the settings overrides.
  (sql) => {
    sql.exec(`CREATE TABLE IF NOT EXISTS documents (
      name TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`);
  },
  // 5: the browsers Web Push notifies, one row per push endpoint.
  (sql) => {
    sql.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`);
  },
  // 6: the repo directory a Session works in. Null for Sessions stored before, which work at the Workspace root.
  (sql) => {
    sql.exec("ALTER TABLE sessions ADD COLUMN repo TEXT");
  },
  // 7: who set the title. A title stored before this was the owner's (it could only be given at creation).
  (sql) => {
    sql.exec("ALTER TABLE sessions ADD COLUMN title_source TEXT");
    sql.exec("UPDATE sessions SET title_source = 'owner' WHERE title IS NOT NULL");
  },
  // 8: the owner's name for a Workspace, unique whatever the case. Each is named after its slug, and slugs are unique
  // lowercase text, so no two collide.
  (sql) => {
    sql.exec("ALTER TABLE workspaces ADD COLUMN name TEXT");
    sql.exec("UPDATE workspaces SET name = slug");
    sql.exec("CREATE UNIQUE INDEX workspaces_by_name ON workspaces (name COLLATE NOCASE)");
  },
  // 9: when the owner archived a Session. Null for Sessions stored before, which are not archived.
  (sql) => {
    sql.exec("ALTER TABLE sessions ADD COLUMN archived_at INTEGER");
  },
  // 10: the Workspaces of their own (worktrees, ADR-0015), and the one a Session works in. Null for Sessions stored
  // before, which work in their repo's main checkout.
  (sql) => {
    sql.exec(`CREATE TABLE IF NOT EXISTS worktrees (
      id TEXT PRIMARY KEY,
      machine TEXT NOT NULL,
      repo TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`);
    sql.exec("ALTER TABLE sessions ADD COLUMN worktree TEXT");
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

  const getMachine = (slug: string): MachineRecord | null => {
    const [row] = sql.exec<MachineRow>("SELECT * FROM workspaces WHERE slug = ?", slug).toArray();

    return row === undefined ? null : toMachine(row);
  };

  /**
   * Whether a Machine other than `slug` is named `name`, whatever the case. The names are compared here, folded as
   * the web app folds them (`toLowerCase`), since the index's `NOCASE` folds only ASCII letters; there are few.
   */
  const nameTaken = (name: string, slug: string): boolean => {
    const folded = name.toLowerCase();

    return Arr.some(
      sql
        .exec<{ name: string | null }>("SELECT name FROM workspaces WHERE slug != ?", slug)
        .toArray(),
      (row) => row.name?.toLowerCase() === folded,
    );
  };

  const createMachine = (slug: string, now: number): MachineRecord => {
    const known = getMachine(slug);

    if (known !== null) return known;

    let name = slug;

    for (let suffix = 2; nameTaken(name, slug); suffix++) name = `${slug} ${suffix}`;

    sql.exec("INSERT INTO workspaces (slug, name, created_at) VALUES (?, ?, ?)", slug, name, now);

    return { slug, name, createdAt: now };
  };

  const getWorkspace = (id: string): WorkspaceRecord | null => {
    const [row] = sql.exec<WorkspaceRow>("SELECT * FROM worktrees WHERE id = ?", id).toArray();

    return row === undefined ? null : toWorkspace(row);
  };

  /** Whether a Session is bound to Workspace `id`. */
  const workspaceInUse = (id: string): boolean =>
    sql.exec("SELECT 1 FROM sessions WHERE worktree = ? LIMIT 1", id).toArray().length > 0;

  const getSession = (id: string): SessionRecord | null => {
    const [row] = sql.exec<SessionRow>("SELECT * FROM sessions WHERE id = ?", id).toArray();

    return row === undefined ? null : toSession(row);
  };

  return {
    createSession: (input, now) => {
      const machine = input.machine ?? DEFAULT_MACHINE;
      const repo = input.repo ?? null;
      const workspace = input.workspace;
      const worktree = workspace?.id ?? null;

      storage.transactionSync(() => {
        createMachine(machine, now);

        if (workspace?.kind === "new") {
          if (repo === null) throw new Error("A Workspace of its own needs a repo");

          sql.exec(
            "INSERT INTO worktrees (id, machine, repo, branch, created_at) VALUES (?, ?, ?, ?, ?)",
            workspace.id,
            machine,
            repo,
            workspace.branch,
            now,
          );
        }

        sql.exec(
          "INSERT INTO sessions (id, title, title_source, workspace, repo, worktree, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?)",
          input.id,
          input.title,
          input.title === null ? null : "owner",
          machine,
          repo,
          worktree,
          now,
          now,
        );
      });

      return {
        id: input.id,
        title: input.title,
        titleSource: input.title === null ? null : "owner",
        machine,
        repo,
        workspace: worktree,
        status: "idle",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
    },

    getSession,

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

    renameSession: (id, title) => {
      sql.exec("UPDATE sessions SET title = ?, title_source = 'owner' WHERE id = ?", title, id);

      return getSession(id);
    },

    archiveSession: (id, now) => {
      sql.exec("UPDATE sessions SET archived_at = ? WHERE id = ? AND archived_at IS NULL", now, id);

      return getSession(id);
    },

    unarchiveSession: (id) => {
      sql.exec("UPDATE sessions SET archived_at = NULL WHERE id = ?", id);

      return getSession(id);
    },

    deleteSession: (id) => sql.exec("DELETE FROM sessions WHERE id = ?", id).rowsWritten > 0,

    setGeneratedTitle: (id, title) =>
      sql.exec(
        "UPDATE sessions SET title = ?, title_source = 'generated' WHERE id = ? AND title_source IS NULL",
        title,
        id,
      ).rowsWritten > 0,

    createMachine,

    getMachine,

    listMachines: () =>
      Arr.map(
        sql.exec<MachineRow>("SELECT * FROM workspaces ORDER BY created_at DESC, slug").toArray(),
        toMachine,
      ),

    renameMachine: (slug, name) => {
      const known = getMachine(slug);

      if (known === null) return { status: "missing" };

      if (nameTaken(name, slug)) return { status: "taken" };

      sql.exec("UPDATE workspaces SET name = ? WHERE slug = ?", name, slug);

      return { status: "renamed", machine: { ...known, name } };
    },

    deleteMachine: (slug) => {
      if (getMachine(slug) === null) return "missing";

      if (
        sql.exec("SELECT 1 FROM sessions WHERE workspace = ? LIMIT 1", slug).toArray().length > 0
      ) {
        return "in-use";
      }

      // Its Workspaces' worktrees went with its files.
      sql.exec("DELETE FROM worktrees WHERE machine = ?", slug);
      sql.exec("DELETE FROM workspaces WHERE slug = ?", slug);

      return "deleted";
    },

    getWorkspace,

    listWorkspaces: () =>
      Arr.map(
        sql.exec<WorkspaceRow>("SELECT * FROM worktrees ORDER BY created_at DESC, id").toArray(),
        toWorkspace,
      ),

    deleteWorkspace: (id) => {
      if (getWorkspace(id) === null) return "missing";

      if (workspaceInUse(id)) return "in-use";

      sql.exec("DELETE FROM worktrees WHERE id = ?", id);

      return "deleted";
    },

    deleteWorkspacesOf: (machine, repo) => {
      sql.exec(
        "DELETE FROM worktrees WHERE machine = ? AND (? IS NULL OR repo = ?) AND id NOT IN (SELECT worktree FROM sessions WHERE worktree IS NOT NULL)",
        machine,
        repo ?? null,
        repo ?? null,
      );
    },

    getDocument: (name) => {
      const [row] = sql
        .exec<{ body: string }>("SELECT body FROM documents WHERE name = ?", name)
        .toArray();

      return row === undefined ? null : row.body;
    },

    putDocument: (name, body, now) => {
      sql.exec(
        "INSERT OR REPLACE INTO documents (name, body, updated_at) VALUES (?, ?, ?)",
        name,
        body,
        now,
      );
    },

    putPushSubscription: ({ endpoint, keys }, now) => {
      sql.exec(
        "INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)",
        endpoint,
        keys.p256dh,
        keys.auth,
        now,
      );
    },

    deletePushSubscription: (endpoint) => {
      sql.exec("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
    },

    hasPushSubscription: (endpoint) =>
      sql.exec("SELECT 1 FROM push_subscriptions WHERE endpoint = ?", endpoint).toArray().length >
      0,

    listPushSubscriptions: () =>
      Arr.map(
        sql
          .exec<PushSubscriptionRow>(
            "SELECT endpoint, p256dh, auth FROM push_subscriptions ORDER BY created_at, endpoint",
          )
          .toArray(),
        ({ endpoint, p256dh, auth }) => ({ endpoint, keys: { p256dh, auth } }),
      ),
  };
};
