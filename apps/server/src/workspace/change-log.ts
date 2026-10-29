// What computer's sync has sent the Container, read from its change log in the Workspace DO's SQLite (dofs, inside
// `@cloudflare/computer`), for the file-change notify (docs/architecture/container.md → File-change notifications;
// `notify.ts`). Every write to the Workspace's files takes the next revision (`vfs_meta.rev`) and stamps it on the
// node it changed (`vfs_nodes.rev`; a new directory gets its own); a removal leaves a tombstone with its path
// (`vfs_changes`); and a push to a backend moves that backend's cursor (`_vfs_push_cursor`, `_vfs_watermark.pushRev`)
// to the revision it sent through. So the paths a push sent are those of the nodes and tombstones whose revision lies
// between the cursor before it and the cursor after.
//
// The model's file tools reach the files directly (`WorkspaceEnvHost` over `Workspace.fs`), not through the Workspace
// stub, so computer reports no `workspace.fs.*` span for them: this log is the one record of every change, whoever made
// it. These are dofs' private tables, as of `@cloudflare/computer` 0.8.0: re-check them when upgrading it
// (docs/development/dependencies.md). Reads only; a table that cannot be read throws, and the notify logs it.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off

/** A path a push sent: still there (a file or directory, or a symlink), or gone (removed, or renamed away). */
export type ChangedPath = {
  readonly path: string;
  readonly state: "present" | "symlink" | "gone";
};

/** A range of revisions, `(after, through]`. */
export type RevisionRange = readonly [after: number, through: number];

/** The SQL the Workspace DO's storage answers (`ctx.storage.sql`). */
export type ChangeLogSql = Pick<SqlStorage, "exec">;

/** The root's inode in dofs: every path is walked up to it. */
const ROOT_INODE = 1;

/** The revision the Workspace's files are at: the last one a write took. */
export const currentRevision = (sql: ChangeLogSql): number => {
  const [row] = sql.exec<{ v: number }>("SELECT v FROM vfs_meta WHERE k = 'rev'").toArray();

  return row?.v ?? 0;
};

/**
 * The revision `backend` has been sent everything through: its push cursor (the later of the cursor row and the
 * watermark, as dofs reads it), less one while a push is part way through a revision.
 */
export const pushedThrough = (sql: ChangeLogSql, backend: string): number => {
  const [cursor] = sql
    .exec<{ rev: number; path: string | null }>(
      "SELECT rev, path FROM _vfs_push_cursor WHERE k = 'push' AND backend = ?",
      backend,
    )
    .toArray();

  const [watermark] = sql
    .exec<{ v: number }>(
      "SELECT v FROM _vfs_watermark WHERE k = 'pushRev' AND backend = ?",
      backend,
    )
    .toArray();

  const mark = watermark?.v ?? 0;

  if (cursor === undefined || mark > cursor.rev) return mark;

  return cursor.path === null ? cursor.rev : cursor.rev - 1;
};

const inRanges = (rev: number, ranges: ReadonlyArray<RevisionRange>) =>
  ranges.some(([after, through]) => rev > after && rev <= through);

/**
 * The paths whose latest change has a revision in `(after, through]` and in none of `skip`: each node's paths (a hard
 * link has several) as present, or as a symlink, and each tombstone's path that no such node has as gone.
 */
export const changedBetween = (
  sql: ChangeLogSql,
  after: number,
  through: number,
  skip: ReadonlyArray<RevisionRange> = [],
): ChangedPath[] => {
  if (through <= after) return [];

  const nodes = sql
    .exec<{ path: string; rev: number; type: string }>(
      `WITH RECURSIVE walk(target, parent, path) AS (
         SELECT d.child_inode, d.parent_inode, '/' || d.name
           FROM vfs_nodes n
           JOIN vfs_dirents d ON d.child_inode = n.inode
          WHERE n.rev > ? AND n.rev <= ?
         UNION ALL
         SELECT w.target, d.parent_inode, '/' || d.name || w.path
           FROM walk w
           JOIN vfs_dirents d ON d.child_inode = w.parent
          WHERE w.parent <> ?
       )
       SELECT w.path AS path, n.rev AS rev, n.type AS type
         FROM walk w
         JOIN vfs_nodes n ON n.inode = w.target
        WHERE w.parent = ?`,
      after,
      through,
      ROOT_INODE,
      ROOT_INODE,
    )
    .toArray();

  const changed = new Map<string, ChangedPath>();

  for (const { path, rev, type } of nodes) {
    if (!inRanges(rev, skip)) {
      changed.set(path, { path, state: type === "symlink" ? "symlink" : "present" });
    }
  }

  const tombstones = sql
    .exec<{ path: string; rev: number }>(
      "SELECT path, MAX(rev) AS rev FROM vfs_changes WHERE op = 'delete' AND rev > ? AND rev <= ? GROUP BY path",
      after,
      through,
    )
    .toArray();

  for (const { path, rev } of tombstones) {
    if (!changed.has(path) && !inRanges(rev, skip)) changed.set(path, { path, state: "gone" });
  }

  return [...changed.values()];
};
