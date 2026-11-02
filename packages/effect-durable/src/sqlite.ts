// Versioned SQLite schemas for Durable Objects (`docs/architecture/mcp-connections.md` → Storage; `docs/development/workers.md` → Deploys and Durable Object code updates).

/** One schema step. It only adds (tables, nullable or defaulted columns, rows), except where its own comment says it drops. */
export type Migration = (sql: SqlStorage) => void;

/** The part of a Durable Object's storage `migrate` uses: its SQLite database, and transactions over it. */
export type MigrationStorage = {
  readonly sql: SqlStorage;
  /** Run `closure` in a transaction: a throw rolls back everything it wrote. */
  readonly transactionSync: <T>(closure: () => T) => T;
};

/**
 * Bring a Durable Object's tables up to the end of `migrations`: step N (`migrations[N - 1]`) has run once the
 * `schema_version` table holds N. Steps are numbered by position, so a step is never edited, reordered or dropped once
 * released: add the next one (the manifest check in `@cloudpid/effect-durable/sqlite/testing` guards this). Each step
 * and its version record run in one transaction, so a step that fails partway leaves no trace and is retried whole.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const migrate = (storage: MigrationStorage, migrations: ReadonlyArray<Migration>): void => {
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
