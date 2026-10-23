import type { SealedValue } from "@cloudpid/extensions/secrets/core";
import {
  DEFAULT_ENVIRONMENT,
  type EnvironmentRepo,
  type EnvironmentSecretRecord,
  MAX_ENVIRONMENT_SECRETS,
  type PushSubscription,
  SPARE_BRANCH,
  TitleSource,
  workspaceDirectory,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import { SessionStatus } from "../session/status.ts";
import type { BuildProgress, EnvironmentBuild } from "../workspace/build-record.ts";

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
  /** The Environment its Workspace was made from, fixed when it is created. */
  readonly environment: string;
  /** The Workspace it works in, fixed when it is created. */
  readonly workspace: string;
  readonly status: SessionStatus;
  readonly createdAt: number;
  /** When the Session was created or its status last changed. */
  readonly updatedAt: number;
  /** When the owner archived the Session, or null while it is not archived. */
  readonly archivedAt: number | null;
};

/** An Environment as the Registry lists it (ADR-0016). */
export type EnvironmentRecord = {
  readonly id: string;
  /** The owner's label for it, unique among Environments whatever the case. */
  readonly name: string;
  /** Its Repos, in the order they were added. */
  readonly repos: ReadonlyArray<EnvironmentRepo>;
  readonly createdAt: number;
};

/** A Workspace (ADR-0016): a working copy of an Environment, with clones of its own on one branch. */
export type WorkspaceRecord = {
  /** Eight lowercase hex digits. */
  readonly id: string;
  readonly environment: string;
  readonly branch: string;
  /** The branch its own was made from; null for each Repo's default branch. */
  readonly base: string | null;
  /** The Repos it holds, by directory name: the Environment's when it was made. */
  readonly repos: ReadonlyArray<string>;
  /** Where its Sessions work: `workspaceDirectory(repos)`. */
  readonly directory: string;
  readonly createdAt: number;
};

/** What a Workspace's Durable Object is told to set itself up with: its Repos' addresses, its branch and its base. */
export type WorkspaceSetup = {
  readonly id: string;
  readonly environment: string;
  readonly branch: string;
  readonly base: string | null;
  readonly repos: ReadonlyArray<EnvironmentRepo>;
};

/**
 * A Session's Workspace, as `createSession` is told it: one that exists, or a new one of an Environment, under `id`
 * unless the Environment's spare is taken. A null `branch` is `cloudpid/<id>` of the Workspace it gets.
 */
export type StoredWorkspaceChoice =
  | { readonly kind: "existing"; readonly id: string }
  | {
      readonly kind: "new";
      readonly id: string;
      readonly environment: string;
      readonly branch: string | null;
      readonly base: string | null;
    };

/** Why the store refused to create a Session: what it names is not there, or the branch is another Workspace's. */
export type SessionRefusal =
  | { readonly refused: "no-environment" }
  | { readonly refused: "no-workspace" }
  | { readonly refused: "branch-taken"; readonly workspace: string };

/** What became of a record: deleted, not registered, or kept because something is still bound to it. */
export type Deletion = "deleted" | "missing" | "in-use";

/** How naming an Environment went. */
export type EnvironmentNaming =
  | { readonly status: "named"; readonly environment: EnvironmentRecord }
  | { readonly status: "missing" }
  | { readonly status: "taken" };

/** How changing an Environment's Repos went. */
export type RepoChange = "changed" | "missing" | "taken" | "absent";

/**
 * What keeps Environments' spare Workspaces current: the stale spares (whose Repos are no longer their Environment's) to
 * remove, by id, and the spares registered now, for their Durable Objects to prepare.
 */
export type SpareUpkeep = {
  readonly stale: ReadonlyArray<string>;
  readonly made: ReadonlyArray<WorkspaceSetup>;
};

/**
 * What the Registry knows of an Environment's Build (docs/spec.md → Builds), as the Build's object last answered: its
 * last good Build, which new Workspaces start from, and the one in progress or the last failure.
 */
export type BuildRecord = {
  readonly build: EnvironmentBuild | null;
  readonly status: BuildProgress | null;
};

/** A kept Secret's sealed value with what it is kept as (`docs/spec.md` → Secrets): the Registry DO opens it. */
export type StoredEnvironmentSecret = EnvironmentSecretRecord & { readonly sealed: SealedValue };

/** How keeping a Secret went: its record, or its Environment does not exist, or its scope holds as many as it may. */
export type SecretPut = EnvironmentSecretRecord | "missing" | "full";

/** The scope column of the Secrets kept for every Environment; no Environment id can be it. */
export const EVERY_ENVIRONMENT_SCOPE = "*";

/** Something left from before Environments (ADR-0016) whose Durable Object is still to be wiped. */
export type LegacyObject = { readonly kind: "session" | "machine"; readonly id: string };

export type RegistryStore = {
  /**
   * Register a Session, idle, in a Workspace that exists, or in a new one, in the same transaction: the Environment's
   * spare when its Repos are the Environment's (it stops being spare and gets the branch and base), else one registered
   * under the id given. A refusal says why and registers nothing.
   */
  readonly createSession: (
    input: {
      readonly id: string;
      readonly title: string | null;
      readonly workspace: StoredWorkspaceChoice;
    },
    now: number,
  ) => SessionRecord | SessionRefusal;
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
  /** Register an Environment, with no Repos and no settings overrides, unless another has the name in any case. */
  readonly createEnvironment: (id: string, name: string, now: number) => EnvironmentNaming;
  /** The Environment registered under `id`, or null. */
  readonly getEnvironment: (id: string) => EnvironmentRecord | null;
  /** Every Environment, newest first. */
  readonly listEnvironments: () => EnvironmentRecord[];
  /** Give an Environment a new name, which no other may have in any case. */
  readonly renameEnvironment: (id: string, name: string) => EnvironmentNaming;
  /** Forget an Environment, only while no Workspace is made from it. */
  readonly deleteEnvironment: (id: string) => Deletion;
  /** Add a Repo to an Environment; `taken` when it has one with that directory name. */
  readonly addRepo: (environment: string, repo: EnvironmentRepo) => RepoChange;
  /** Take a Repo out of an Environment; `absent` when it has none of that name. */
  readonly removeRepo: (environment: string, name: string) => RepoChange;
  /** The Container settings overrides saved for an Environment, or null when it is not registered. */
  readonly getEnvironmentSettings: (environment: string) => Schema.Json | null;
  /** Save an Environment's Container settings overrides; says whether it is registered. */
  readonly putEnvironmentSettings: (environment: string, overrides: Schema.Json) => boolean;
  /** What the Registry knows of an Environment's Build, or null when the Environment is not registered. */
  readonly getBuild: (environment: string) => BuildRecord | null;
  /** Keep what an Environment's Build object answered; says whether the Environment is registered. */
  readonly putBuild: (environment: string, record: BuildRecord) => boolean;
  /** Every Environment's Build, by Environment id, newest Environment first. */
  readonly listBuilds: () => Array<BuildRecord & { readonly environment: string }>;
  /** The Workspace registered under `id`, or null; a spare is not one until it is taken. */
  readonly getWorkspace: (id: string) => WorkspaceRecord | null;
  /** What Workspace `id` sets itself up with, or null when it is not registered. */
  readonly getWorkspaceSetup: (id: string) => WorkspaceSetup | null;
  /** Every Workspace but the spares, newest first. */
  readonly listWorkspaces: () => WorkspaceRecord[];
  /** Forget a Workspace's record, only while no Session is bound to it. */
  readonly deleteWorkspace: (id: string) => Deletion;
  /**
   * Keep a spare for each of `environments` that exists (every one when undefined), in one transaction: an Environment
   * whose spare is stale has it listed, to remove, and one with none gets one registered, under an id from `newId` that
   * no Workspace has, on `SPARE_BRANCH` with the Environment's Repos.
   */
  readonly upkeepSpares: (
    environments: ReadonlyArray<string> | undefined,
    newId: () => string,
    now: number,
  ) => SpareUpkeep;
  /** The id of an Environment's spare, current or stale, or null. */
  readonly getSpare: (environment: string) => string | null;
  /** Forget a spare's record, only while it is a spare; says whether it was. */
  readonly forgetSpare: (id: string) => boolean;
  /**
   * Up to `limit` of the objects left from before Environments that no caller took in the last `leaseMs`, each taken
   * from `now`, so two callers do not wipe the same one at once.
   */
  readonly takeLegacy: (limit: number, now: number, leaseMs: number) => LegacyObject[];
  /** Forget a legacy object once it is wiped. */
  readonly forgetLegacy: (object: LegacyObject) => void;
  /** Every kept Secret, without its value: those for every Environment first, then by Environment, each by name. */
  readonly listEnvironmentSecrets: () => EnvironmentSecretRecord[];
  /** The sealed Secrets `environment` uses: those kept for every Environment, and its own. */
  readonly getEnvironmentSecrets: (environment: string) => StoredEnvironmentSecret[];
  /**
   * Keep a sealed value under `name` for `environment` (null: every Environment), replacing the one kept there; `build`
   * left out keeps a replaced one's flag (false for a new one).
   */
  readonly putEnvironmentSecret: (
    input: {
      readonly environment: string | null;
      readonly name: string;
      readonly sealed: SealedValue;
      readonly build?: boolean | undefined;
    },
    now: number,
  ) => SecretPut;
  /** Set whether a kept Secret reaches the Build; null when none is kept under that scope and name. */
  readonly setEnvironmentSecretBuild: (
    environment: string | null,
    name: string,
    build: boolean,
    now: number,
  ) => EnvironmentSecretRecord | null;
  /** Delete a kept Secret; says whether one was kept. */
  readonly deleteEnvironmentSecret: (environment: string | null, name: string) => boolean;
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
  environment: string;
  workspace: string;
  status: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

type EnvironmentRow = {
  id: string;
  name: string;
  /** JSON: `EnvironmentRepo[]`. */
  repos: string;
  /** JSON: the Container settings overrides. */
  settings: string;
  created_at: number;
  /** JSON: the last good Build (`EnvironmentBuild`), or null for none yet. */
  build: string | null;
  /** JSON: the Build in progress or the last that failed (`BuildProgress`), or null. */
  build_status: string | null;
};

type WorkspaceRow = {
  id: string;
  environment: string;
  branch: string;
  base: string | null;
  /** JSON: `EnvironmentRepo[]`, as the Environment had them when the Workspace was made. */
  repos: string;
  created_at: number;
  /** 1 while it is its Environment's spare, made ahead and not yet taken; 0 once it is a Session's. */
  spare: number;
};

type PushSubscriptionRow = { endpoint: string; p256dh: string; auth: string };

type EnvironmentSecretRow = {
  /** An Environment's id, or `EVERY_ENVIRONMENT_SCOPE`. */
  scope: string;
  name: string;
  /** Base64: the AES-GCM nonce and ciphertext of the value (`SealedValue`). */
  iv: string;
  ciphertext: string;
  /** 1 when it reaches the Environment's Build. */
  build: number;
  updated_at: number;
};

const scopeOf = (environment: string | null): string => environment ?? EVERY_ENVIRONMENT_SCOPE;

const toSecretRecord = (row: EnvironmentSecretRow): EnvironmentSecretRecord => ({
  environment: row.scope === EVERY_ENVIRONMENT_SCOPE ? null : row.scope,
  name: row.name,
  build: row.build === 1,
  updatedAt: row.updated_at,
});

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

// @effect-diagnostics-next-line schemaSync:off -- the store is synchronous, as SQLite in a Durable Object is, and only reads what it wrote.
const decodeRepos = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.String }))),
);

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** A JSON column the store wrote itself, as `A`; null when it is null or not JSON. */
const jsonColumn = <A>(text: string | null): A | null => {
  if (text === null) return null;

  // SAFETY: only the store writes these columns, from values of type `A`.
  return Option.getOrNull(decodeJson(text)) as A | null;
};

const toBuild = (row: Pick<EnvironmentRow, "build" | "build_status">): BuildRecord => ({
  build: jsonColumn<EnvironmentBuild>(row.build),
  status: jsonColumn<BuildProgress>(row.build_status),
});

const toSession = (row: SessionRow): SessionRecord => ({
  id: row.id,
  title: row.title,
  titleSource: checkedTitleSource(row.title_source),
  environment: row.environment,
  workspace: row.workspace,
  status: checkedStatus(row.status),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at,
});

const toEnvironment = (row: EnvironmentRow): EnvironmentRecord => ({
  id: row.id,
  name: row.name,
  repos: decodeRepos(row.repos),
  createdAt: row.created_at,
});

/** Repos in the order of their directory names. */
const byName = Order.mapInput(Order.String, (repo: EnvironmentRepo) => repo.name);

/** Whether two lists of Repos have the same names and addresses, in any order. */
const sameRepos = (
  left: ReadonlyArray<EnvironmentRepo>,
  right: ReadonlyArray<EnvironmentRepo>,
): boolean => {
  const others = Arr.sort(right, byName);

  return (
    left.length === right.length &&
    Arr.every(
      Arr.sort(left, byName),
      (repo, index) => repo.name === others[index]?.name && repo.url === others[index]?.url,
    )
  );
};

const toWorkspace = (row: WorkspaceRow): WorkspaceRecord => {
  const repos = Arr.map(decodeRepos(row.repos), (repo) => repo.name);

  return {
    id: row.id,
    environment: row.environment,
    branch: row.branch,
    base: row.base,
    repos,
    directory: workspaceDirectory(repos),
    createdAt: row.created_at,
  };
};

/** The part of a Durable Object's storage the store uses: its SQLite database, and transactions over it. */
export type RegistryStorage = {
  readonly sql: SqlStorage;
  /** Run `closure` in a transaction: a throw rolls back everything it wrote. */
  readonly transactionSync: <T>(closure: () => T) => T;
};

/** The default Machine before Environments (ADR-0016), which migration 3 listed. */
const LEGACY_DEFAULT_MACHINE = "default";

/**
 * The schema, one step per version, applied in order: version N is in place once step N has run. Steps only add
 * (tables, nullable or defaulted columns, rows), but for step 11, the cutover to Environments, and a step is never edited once
 * released: add the next one. Each step and its version record run in one transaction, so a step that fails partway
 * leaves no trace and is retried whole.
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
      LEGACY_DEFAULT_MACHINE,
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
    // git checks a branch out in one worktree of a repo at a time.
    sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS worktrees_by_branch ON worktrees (machine, repo, branch)",
    );
    sql.exec("ALTER TABLE sessions ADD COLUMN worktree TEXT");
  },
  // 11: Environments, and a Container per Workspace (ADR-0016). Machines and their Sessions are reset rather than
  // migrated, so this step is the one that drops: the old tables go, and what their rows named is kept in `legacy`
  // until its Durable Object is wiped. The `default` Environment is there from the start.
  (sql) => {
    sql.exec(`CREATE TABLE legacy (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      taken_at INTEGER,
      PRIMARY KEY (kind, id)
    ) STRICT`);
    sql.exec("INSERT INTO legacy (kind, id) SELECT 'session', id FROM sessions");
    sql.exec("INSERT INTO legacy (kind, id) SELECT 'machine', slug FROM workspaces");
    sql.exec("DROP TABLE sessions");
    sql.exec("DROP TABLE workspaces");
    sql.exec("DROP TABLE worktrees");
    sql.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      title_source TEXT,
      environment TEXT NOT NULL,
      workspace TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    ) STRICT`);
    sql.exec("CREATE INDEX sessions_by_created ON sessions (created_at DESC, id DESC)");
    sql.exec("CREATE INDEX sessions_by_workspace ON sessions (workspace)");
    sql.exec(`CREATE TABLE environments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repos TEXT NOT NULL,
      settings TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`);
    sql.exec("CREATE UNIQUE INDEX environments_by_name ON environments (name COLLATE NOCASE)");
    sql.exec(`CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      environment TEXT NOT NULL,
      branch TEXT NOT NULL,
      base TEXT,
      repos TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`);
    // Two Workspaces of an Environment on one branch would push over each other.
    sql.exec("CREATE UNIQUE INDEX workspaces_by_branch ON workspaces (environment, branch)");
    sql.exec(
      `INSERT INTO environments (id, name, repos, settings, created_at)
       VALUES (?, 'Default', '[]', '{}', CAST(unixepoch('subsec') * 1000 AS INTEGER))`,
      DEFAULT_ENVIRONMENT,
    );
  },
  // 12: spare Workspaces (ADR-0016), one per Environment, made ahead of the Session that takes one. Every Workspace
  // stored before is a Session's.
  (sql) => {
    sql.exec("ALTER TABLE workspaces ADD COLUMN spare INTEGER NOT NULL DEFAULT 0");
  },
  // 13: each Environment's Build (ADR-0016), as its Build object last answered: the last good one, and the one in
  // progress or the last failure. Every Environment stored before has none yet.
  (sql) => {
    sql.exec("ALTER TABLE environments ADD COLUMN build TEXT");
    sql.exec("ALTER TABLE environments ADD COLUMN build_status TEXT");
  },
  // 14: the Secrets kept for an Environment, or for every Environment (`*`), each value sealed by the Registry DO
  // under a key bound to its scope and name (docs/spec.md → Secrets). None before.
  (sql) => {
    sql.exec(`CREATE TABLE environment_secrets (
      scope TEXT NOT NULL,
      name TEXT NOT NULL,
      iv TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      build INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, name)
    ) STRICT`);
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

  const getEnvironment = (id: string): EnvironmentRecord | null => {
    const [row] = sql.exec<EnvironmentRow>("SELECT * FROM environments WHERE id = ?", id).toArray();

    return row === undefined ? null : toEnvironment(row);
  };

  /**
   * Whether an Environment other than `id` is named `name`, whatever the case. The names are compared here, folded as
   * the web app folds them (`toLowerCase`), since the index's `NOCASE` folds only ASCII letters; there are few.
   */
  const nameTaken = (name: string, id: string): boolean => {
    const folded = name.toLowerCase();

    return Arr.some(
      sql.exec<{ name: string }>("SELECT name FROM environments WHERE id != ?", id).toArray(),
      (row) => row.name.toLowerCase() === folded,
    );
  };

  /** Workspace `id`'s row, a spare's too. */
  const getWorkspaceRow = (id: string): WorkspaceRow | undefined =>
    sql.exec<WorkspaceRow>("SELECT * FROM workspaces WHERE id = ?", id).toArray()[0];

  const getSpareRow = (environment: string): WorkspaceRow | undefined =>
    sql
      .exec<WorkspaceRow>(
        "SELECT * FROM workspaces WHERE environment = ? AND spare = 1",
        environment,
      )
      .toArray()[0];

  const toSetup = (row: WorkspaceRow): WorkspaceSetup => ({
    id: row.id,
    environment: row.environment,
    branch: row.branch,
    base: row.base,
    repos: decodeRepos(row.repos),
  });

  const getSession = (id: string): SessionRecord | null => {
    const [row] = sql.exec<SessionRow>("SELECT * FROM sessions WHERE id = ?", id).toArray();

    return row === undefined ? null : toSession(row);
  };

  const writeRepos = (environment: string, repos: ReadonlyArray<EnvironmentRepo>) => {
    sql.exec("UPDATE environments SET repos = ? WHERE id = ?", JSON.stringify(repos), environment);
  };

  return {
    createSession: (input, now) =>
      storage.transactionSync((): SessionRecord | SessionRefusal => {
        const choice = input.workspace;
        let environment: string;

        let workspace = choice.id;

        if (choice.kind === "existing") {
          const known = getWorkspaceRow(choice.id);

          // A spare is no Workspace a Session can name.
          if (known === undefined || known.spare === 1) return { refused: "no-workspace" };

          environment = known.environment;
        } else {
          const made = getEnvironment(choice.environment);

          if (made === null) return { refused: "no-environment" };

          // The spare is taken only while it holds the Environment's Repos; a stale one is left to be removed.
          const spare = getSpareRow(made.id);

          const taking =
            spare !== undefined && sameRepos(decodeRepos(spare.repos), made.repos)
              ? spare
              : undefined;

          workspace = taking?.id ?? choice.id;

          const branch = choice.branch ?? `cloudpid/${workspace}`;

          const [taken] = sql
            .exec<{ id: string }>(
              "SELECT id FROM workspaces WHERE environment = ? AND branch = ?",
              choice.environment,
              branch,
            )
            .toArray();

          if (taken !== undefined) return { refused: "branch-taken", workspace: taken.id };

          environment = made.id;

          if (taking === undefined) {
            sql.exec(
              "INSERT INTO workspaces (id, environment, branch, base, repos, created_at) VALUES (?, ?, ?, ?, ?, ?)",
              workspace,
              environment,
              branch,
              choice.base,
              JSON.stringify(made.repos),
              now,
            );
          } else {
            sql.exec(
              "UPDATE workspaces SET spare = 0, branch = ?, base = ?, created_at = ? WHERE id = ?",
              branch,
              choice.base,
              now,
              workspace,
            );
          }
        }

        sql.exec(
          "INSERT INTO sessions (id, title, title_source, environment, workspace, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)",
          input.id,
          input.title,
          input.title === null ? null : "owner",
          environment,
          workspace,
          now,
          now,
        );

        return {
          id: input.id,
          title: input.title,
          titleSource: input.title === null ? null : "owner",
          environment,
          workspace,
          status: "idle",
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        };
      }),

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

    createEnvironment: (id, name, now) => {
      if (nameTaken(name, id) || getEnvironment(id) !== null) return { status: "taken" };

      sql.exec(
        "INSERT INTO environments (id, name, repos, settings, created_at) VALUES (?, ?, '[]', '{}', ?)",
        id,
        name,
        now,
      );

      return { status: "named", environment: { id, name, repos: [], createdAt: now } };
    },

    getEnvironment,

    listEnvironments: () =>
      Arr.map(
        sql
          .exec<EnvironmentRow>("SELECT * FROM environments ORDER BY created_at DESC, id")
          .toArray(),
        toEnvironment,
      ),

    renameEnvironment: (id, name) => {
      const known = getEnvironment(id);

      if (known === null) return { status: "missing" };

      if (nameTaken(name, id)) return { status: "taken" };

      sql.exec("UPDATE environments SET name = ? WHERE id = ?", name, id);

      return { status: "named", environment: { ...known, name } };
    },

    deleteEnvironment: (id) => {
      if (getEnvironment(id) === null) return "missing";

      if (
        sql.exec("SELECT 1 FROM workspaces WHERE environment = ? LIMIT 1", id).toArray().length > 0
      ) {
        return "in-use";
      }

      sql.exec("DELETE FROM environments WHERE id = ?", id);
      // Its Secrets go with it; those kept for every Environment stay.
      sql.exec("DELETE FROM environment_secrets WHERE scope = ?", id);

      return "deleted";
    },

    addRepo: (environment, repo) =>
      storage.transactionSync((): RepoChange => {
        const known = getEnvironment(environment);

        if (known === null) return "missing";

        if (Arr.some(known.repos, (held) => held.name === repo.name)) return "taken";

        writeRepos(environment, [...known.repos, { name: repo.name, url: repo.url }]);

        return "changed";
      }),

    removeRepo: (environment, name) =>
      storage.transactionSync((): RepoChange => {
        const known = getEnvironment(environment);

        if (known === null) return "missing";

        if (!Arr.some(known.repos, (held) => held.name === name)) return "absent";

        writeRepos(
          environment,
          Arr.filter(known.repos, (held) => held.name !== name),
        );

        return "changed";
      }),

    getEnvironmentSettings: (environment) => {
      const [row] = sql
        .exec<{ settings: string }>("SELECT settings FROM environments WHERE id = ?", environment)
        .toArray();

      // Text that is not JSON (never written so) reads as no overrides.
      return row === undefined ? null : Option.getOrElse(decodeJson(row.settings), () => ({}));
    },

    putEnvironmentSettings: (environment, overrides) =>
      sql.exec(
        "UPDATE environments SET settings = ? WHERE id = ?",
        JSON.stringify(overrides),
        environment,
      ).rowsWritten > 0,

    getBuild: (environment) => {
      const [row] = sql
        .exec<Pick<EnvironmentRow, "build" | "build_status">>(
          "SELECT build, build_status FROM environments WHERE id = ?",
          environment,
        )
        .toArray();

      return row === undefined ? null : toBuild(row);
    },

    putBuild: (environment, { build, status }) =>
      sql.exec(
        "UPDATE environments SET build = ?, build_status = ? WHERE id = ?",
        build === null ? null : JSON.stringify(build),
        status === null ? null : JSON.stringify(status),
        environment,
      ).rowsWritten > 0,

    listBuilds: () =>
      Arr.map(
        sql
          .exec<Pick<EnvironmentRow, "id" | "build" | "build_status">>(
            "SELECT id, build, build_status FROM environments ORDER BY created_at DESC, id",
          )
          .toArray(),
        (row) => ({ environment: row.id, ...toBuild(row) }),
      ),

    getWorkspace: (id) => {
      const row = getWorkspaceRow(id);

      return row === undefined || row.spare === 1 ? null : toWorkspace(row);
    },

    getWorkspaceSetup: (id) => {
      const row = getWorkspaceRow(id);

      return row === undefined ? null : toSetup(row);
    },

    listWorkspaces: () =>
      Arr.map(
        sql
          .exec<WorkspaceRow>(
            "SELECT * FROM workspaces WHERE spare = 0 ORDER BY created_at DESC, id",
          )
          .toArray(),
        toWorkspace,
      ),

    upkeepSpares: (environments, newId, now) =>
      storage.transactionSync((): SpareUpkeep => {
        const stale: string[] = [];
        const made: WorkspaceSetup[] = [];

        const kept = Arr.filter(
          Arr.map(
            sql
              .exec<EnvironmentRow>("SELECT * FROM environments ORDER BY created_at DESC, id")
              .toArray(),
            toEnvironment,
          ),
          (environment) => environments === undefined || environments.includes(environment.id),
        );

        for (const environment of kept) {
          const spare = getSpareRow(environment.id);

          if (spare !== undefined) {
            if (!sameRepos(decodeRepos(spare.repos), environment.repos)) stale.push(spare.id);

            continue;
          }

          // Eight hex digits rarely collide; one that does is drawn again.
          let id = newId();

          while (getWorkspaceRow(id) !== undefined) id = newId();

          sql.exec(
            "INSERT INTO workspaces (id, environment, branch, base, repos, created_at, spare) VALUES (?, ?, ?, NULL, ?, ?, 1)",
            id,
            environment.id,
            SPARE_BRANCH,
            JSON.stringify(environment.repos),
            now,
          );
          made.push({
            id,
            environment: environment.id,
            branch: SPARE_BRANCH,
            base: null,
            repos: environment.repos,
          });
        }

        return { stale, made };
      }),

    getSpare: (environment) => getSpareRow(environment)?.id ?? null,

    forgetSpare: (id) =>
      sql.exec("DELETE FROM workspaces WHERE id = ? AND spare = 1", id).rowsWritten > 0,

    deleteWorkspace: (id) => {
      if (getWorkspaceRow(id) === undefined) return "missing";

      if (sql.exec("SELECT 1 FROM sessions WHERE workspace = ? LIMIT 1", id).toArray().length > 0) {
        return "in-use";
      }

      sql.exec("DELETE FROM workspaces WHERE id = ?", id);

      return "deleted";
    },

    takeLegacy: (limit, now, leaseMs) =>
      storage.transactionSync(() => {
        const taken = sql
          .exec<LegacyObject>(
            "SELECT kind, id FROM legacy WHERE taken_at IS NULL OR taken_at <= ? ORDER BY kind DESC, id LIMIT ?",
            now - leaseMs,
            limit,
          )
          .toArray();

        for (const object of taken) {
          sql.exec(
            "UPDATE legacy SET taken_at = ? WHERE kind = ? AND id = ?",
            now,
            object.kind,
            object.id,
          );
        }

        return Arr.map(taken, ({ kind, id }) => ({ kind, id }));
      }),

    forgetLegacy: ({ kind, id }) => {
      sql.exec("DELETE FROM legacy WHERE kind = ? AND id = ?", kind, id);
    },

    listEnvironmentSecrets: () =>
      Arr.map(
        sql
          .exec<EnvironmentSecretRow>(
            "SELECT * FROM environment_secrets ORDER BY scope != ?, scope, name",
            EVERY_ENVIRONMENT_SCOPE,
          )
          .toArray(),
        toSecretRecord,
      ),

    getEnvironmentSecrets: (environment) =>
      Arr.map(
        sql
          .exec<EnvironmentSecretRow>(
            "SELECT * FROM environment_secrets WHERE scope IN (?, ?) ORDER BY scope != ?, name",
            EVERY_ENVIRONMENT_SCOPE,
            environment,
            EVERY_ENVIRONMENT_SCOPE,
          )
          .toArray(),
        (row) => ({
          ...toSecretRecord(row),
          sealed: { version: 1, iv: row.iv, ciphertext: row.ciphertext },
        }),
      ),

    putEnvironmentSecret: ({ environment, name, sealed, build }, now) =>
      storage.transactionSync((): SecretPut => {
        if (environment !== null && getEnvironment(environment) === null) return "missing";

        const scope = scopeOf(environment);

        const [known] = sql
          .exec<EnvironmentSecretRow>(
            "SELECT * FROM environment_secrets WHERE scope = ? AND name = ?",
            scope,
            name,
          )
          .toArray();

        if (known === undefined) {
          const [count] = sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM environment_secrets WHERE scope = ?",
              scope,
            )
            .toArray();

          if ((count?.count ?? 0) >= MAX_ENVIRONMENT_SECRETS) return "full";
        }

        const flag = build ?? known?.build === 1;

        sql.exec(
          "INSERT OR REPLACE INTO environment_secrets (scope, name, iv, ciphertext, build, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          scope,
          name,
          sealed.iv,
          sealed.ciphertext,
          flag ? 1 : 0,
          now,
        );

        return { environment, name, build: flag, updatedAt: now };
      }),

    setEnvironmentSecretBuild: (environment, name, build, now) => {
      const written = sql.exec(
        "UPDATE environment_secrets SET build = ?, updated_at = ? WHERE scope = ? AND name = ?",
        build ? 1 : 0,
        now,
        scopeOf(environment),
        name,
      ).rowsWritten;

      return written > 0 ? { environment, name, build, updatedAt: now } : null;
    },

    deleteEnvironmentSecret: (environment, name) =>
      sql.exec(
        "DELETE FROM environment_secrets WHERE scope = ? AND name = ?",
        scopeOf(environment),
        name,
      ).rowsWritten > 0,

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
