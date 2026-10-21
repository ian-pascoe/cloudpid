// The Workspace DO side of `ComputerExecutionEnv`: file operations on the object's own `@cloudflare/computer`
// Workspace, where a failure still carries its POSIX code, answered as plain data (see `wire.ts`).
// pi-durable's `ExecutionEnv` is Promise-native and stays so (ADR-0003); this adapter follows it.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off globalDate:off preferEffectArray:off
import type { Workspace } from "@cloudflare/computer";
import { type FileInfo, type FileKind, LineScanner } from "@earendil-works/pi-durable/env";
import { HostFailure, posixCode, toWireError } from "./failure.ts";
import { listFiles } from "./list-files.ts";
import { ancestors, basename, dirname } from "./paths.ts";
import type {
  EnvRequest,
  EnvResponse,
  HostOperation,
  HostOperations,
  ScanTarget,
  WireResult,
} from "./wire.ts";

/** Where open binary readers keep their hard links. */
export const READERS_DIR = "/.computer/readers";

/** A reader link older than this belongs to a reader whose client went away without closing it. */
const STALE_READER_MS = 60 * 60 * 1000;

/** Where `createTempDir` and `createTempFile` (and so exec spills) create their paths. */
const TEMP_DIR = "/tmp";

/**
 * A temp entry not modified for this long is removed when the Workspace DO starts: no OS cleans the Workspace's `/tmp`,
 * and its files would otherwise stay in the Workspace's storage, listings and (with a Container) synced tree.
 */
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;

/** The Workspace's metadata for one path, as `fs.stat` and `fs.lstat` return it. */
type Stat = {
  readonly inode: number;
  readonly mtime: number;
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
};

/** Run `operation` on `path`, turning a thrown Workspace error into a failure with its pi-durable code. */
const attempt = async <T>(path: string, operation: () => Promise<T>): Promise<WireResult<T>> => {
  try {
    return { ok: true, value: await operation() };
  } catch (cause) {
    return { ok: false, error: toWireError(cause, path) };
  }
};

const kindOf = (
  stat: Pick<Stat, "isFile" | "isDirectory" | "isSymbolicLink">,
): FileKind | undefined =>
  stat.isFile
    ? "file"
    : stat.isDirectory
      ? "directory"
      : stat.isSymbolicLink
        ? "symlink"
        : undefined;

const fileInfo = (path: string, stat: Stat): FileInfo => {
  const kind = kindOf(stat);

  if (kind === undefined) throw new HostFailure("invalid", "Unsupported file type", path);

  return { name: basename(path), path, kind, size: stat.size, mtimeMs: stat.mtime };
};

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
};

const encoder = new TextEncoder();

/**
 * `fs.mkdir(path, { recursive: true })`, except that a directory that is already there is left alone. computer refuses
 * the call on any path above a read-only mount (`/workspace`, with the bundled skills mounted below it), though it would
 * change nothing, and every write into the Workspace root makes its parents this way.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain async helper, not an Effect combinator.
export const ensureDirectory = async (
  fs: Pick<Workspace["fs"], "stat" | "mkdir">,
  path: string,
): Promise<void> => {
  try {
    if ((await fs.stat(path)).isDirectory) return;
  } catch (cause) {
    if (posixCode(cause) !== "ENOENT") throw cause;
  }

  await fs.mkdir(path, { recursive: true });
};

/** Answers `ComputerExecutionEnv`'s requests from the Workspace it holds. */
export class WorkspaceEnvHost {
  readonly #workspace: Workspace;
  readonly #operations: HostOperations;

  constructor(workspace: Workspace) {
    this.#workspace = workspace;
    this.#operations = this.#makeOperations();
  }

  /** Answer one request. */
  handle(request: EnvRequest): Promise<EnvResponse<HostOperation>> {
    // SAFETY: `EnvRequest` pairs each operation with its own parameters, so the arguments fit the operation called.
    const operation = this.#operations[request.op] as (
      ...args: EnvRequest["args"]
    ) => Promise<EnvResponse<HostOperation>>;

    return operation(...request.args);
  }

  /** Create the Workspace root, and remove reader links that no client will close and stale temp files. */
  async prepare(root: string, now: number): Promise<void> {
    const fs = this.#workspace.fs;

    await ensureDirectory(fs, root);
    await fs.mkdir(READERS_DIR, { recursive: true });

    for (const entry of await fs.readdir(READERS_DIR)) {
      const openedAt = Number.parseInt(entry.name, 10);

      if (Number.isNaN(openedAt) || now - openedAt > STALE_READER_MS) {
        await fs.rm(`${READERS_DIR}/${entry.name}`, { force: true });
      }
    }

    await fs.mkdir(TEMP_DIR, { recursive: true });

    for (const entry of await fs.readdir(TEMP_DIR)) {
      const path = `${TEMP_DIR}/${entry.name}`;

      if (now - (await fs.lstat(path)).mtime > STALE_TEMP_MS) {
        await fs.rm(path, { recursive: true, force: true });
      }
    }
  }

  #makeOperations(): HostOperations {
    const fs = this.#workspace.fs;

    const stat = (path: string, follow: boolean): Promise<Stat> =>
      follow ? fs.stat(path) : fs.lstat(path);

    const readAll = async (path: string): Promise<Uint8Array> =>
      new Uint8Array(await new Response(await fs.readFile(path)).arrayBuffer());

    const readerPath = (handle: string): string => {
      if (dirname(handle) !== READERS_DIR) {
        throw new HostFailure("invalid", "Not a binary reader", handle);
      }

      return handle;
    };

    return {
      info: (path, follow) => attempt(path, async () => fileInfo(path, await stat(path, follow))),
      infos: (paths) =>
        attempt(paths[0] ?? "/", async () => {
          const infos: Array<FileInfo | null> = [];

          for (const path of paths) {
            try {
              infos.push(fileInfo(path, await fs.lstat(path)));
            } catch (cause) {
              // Removed since it was listed: no longer an entry.
              if (posixCode(cause) !== "ENOENT") throw cause;
              infos.push(null);
            }
          }

          return infos;
        }),
      names: (path) =>
        attempt(path, async () => {
          if (!(await fs.stat(path)).isDirectory) {
            throw new HostFailure("not_directory", "Not a directory", path);
          }

          return (await fs.readdir(path)).map((entry) => entry.name);
        }),
      listDir: (path) =>
        attempt(path, async () => {
          if (!(await fs.stat(path)).isDirectory) {
            throw new HostFailure("not_directory", "Not a directory", path);
          }

          const infos: FileInfo[] = [];

          for (const entry of await fs.readdir(path)) {
            const entryPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
            const kind = kindOf(entry);

            if (kind !== undefined) {
              infos.push({
                name: entry.name,
                path: entryPath,
                kind,
                size: entry.size,
                mtimeMs: entry.mtime,
              });
            }
          }

          return infos;
        }),
      canonical: (path) => attempt(path, () => this.#workspace.provider().realpath(path)),
      readFile: (path) => attempt(path, () => readAll(path)),
      writeFile: (path, content, append) =>
        attempt(path, async () => {
          const bytes = content instanceof Uint8Array ? content : encoder.encode(content);

          await ensureDirectory(fs, dirname(path));

          const existing = append ? await readAll(path).then((bytes) => [bytes], absent) : [];

          await fs.writeFile(path, concat([...existing, bytes]));

          return null;
        }),
      truncate: (path, size) =>
        attempt(path, async () => {
          const bytes = await readAll(path);
          const resized = new Uint8Array(size);

          resized.set(bytes.subarray(0, size));
          await fs.writeFile(path, resized);

          return null;
        }),
      flush: (path) =>
        attempt(path, async () => {
          if ((await fs.stat(path)).isDirectory) {
            throw new HostFailure("is_directory", "Is a directory", path);
          }

          return null;
        }),
      rename: (source, destination) =>
        attempt(source, async () => {
          await fs.rename(source, destination);

          return null;
        }),
      createDir: (path, recursive) =>
        attempt(path, async () => {
          if (recursive) await ensureDirectory(fs, path);
          else await fs.mkdir(path, { recursive });

          return null;
        }),
      remove: (path, recursive, force) =>
        attempt(path, async () => {
          await fs.rm(path, { recursive, force });

          return null;
        }),
      createTempDir: (prefix) => {
        const path = `${TEMP_DIR}/${prefix}${crypto.randomUUID()}`;

        return attempt(path, async () => {
          await fs.mkdir(path, { recursive: true });

          return path;
        });
      },
      openReader: (path, noFollow) =>
        attempt(path, async () => {
          if (noFollow && (await fs.lstat(path)).isSymbolicLink) {
            throw new HostFailure("invalid", "Refusing to follow a symbolic link", path);
          }

          const opened = await fs.stat(path);

          if (opened.isDirectory) throw new HostFailure("is_directory", "Is a directory", path);

          if (!opened.isFile) throw new HostFailure("invalid", "Not a regular file", path);

          // A hard link keeps the opened file readable, as an open descriptor would, after its path is renamed,
          // replaced or removed.
          const handle = `${READERS_DIR}/${Date.now()}-${crypto.randomUUID()}`;

          await fs.mkdir(READERS_DIR, { recursive: true });

          await this.#workspace
            .provider()
            .link(await this.#workspace.provider().realpath(path), handle);

          return { handle, info: fileInfo(path, opened) };
        }),
      readerInfo: (handle) =>
        attempt(handle, async () => fileInfo(handle, await fs.stat(readerPath(handle)))),
      read: (handle, offset, length) =>
        attempt(handle, async () => {
          const size = (await fs.stat(readerPath(handle))).size;

          if (length === 0 || offset >= size) return new Uint8Array();

          const stream = await fs.readFile(handle, { byteOffset: offset, byteLength: length });

          return new Uint8Array(await new Response(stream).arrayBuffer());
        }),
      scanLines: (handle, startLine, endLine) =>
        attempt(handle, async () => {
          const scanner =
            endLine === null ? new LineScanner(startLine) : new LineScanner(startLine, endLine);

          for await (const chunk of await fs.readFile(readerPath(handle))) scanner.push(chunk);

          return scanner.finish();
        }),
      closeReader: (handle) =>
        attempt(handle, async () => {
          await fs.rm(readerPath(handle), { force: true });

          return null;
        }),
      scan: (targets, maxDirectories) =>
        attempt(targets[0]?.path ?? "/", () => scan(stat, fs, targets, maxDirectories)),
      listFiles: (path, options) => attempt(path, () => listFiles(fs, path, options)),
    };
  }
}

/** The identity a polling watcher compares: a directory by inode, anything else also by size and modification. */
const entryOf = (stat: Stat): string =>
  stat.isDirectory
    ? `d:${stat.inode}`
    : `${kindOf(stat) ?? "other"}:${stat.inode}:${stat.size}:${stat.mtime}`;

/** No bytes for a file that does not exist yet; any other failure stands. */
const absent = (cause: unknown): Uint8Array[] => {
  if (posixCode(cause) === "ENOENT") return [];
  throw cause;
};

const missing = (cause: unknown): boolean => {
  const code = posixCode(cause);

  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * Everything the targets cover: their ancestors (a renamed or replaced ancestor moves the target), each target itself
 * following a link, and the entries of a target directory, all of them below a recursive one. Symbolic links below a
 * target are recorded, not followed.
 */
const scan = async (
  stat: (path: string, follow: boolean) => Promise<Stat>,
  fs: Workspace["fs"],
  targets: readonly ScanTarget[],
  maxDirectories: number,
): Promise<ReadonlyArray<readonly [string, string]>> => {
  const snapshot = new Map<string, string>();
  const counted = new Set<string>();
  const traversed = new Set<string>();

  const record = async (path: string, follow: boolean): Promise<Stat | undefined> => {
    try {
      const found = await stat(path, follow);

      if (!snapshot.has(path)) snapshot.set(path, entryOf(found));

      return found;
    } catch (cause) {
      if (missing(cause)) return undefined;
      throw cause;
    }
  };

  const scanDirectory = async (index: number, target: ScanTarget, directory: string) => {
    const key = `${index}\0${directory}`;

    if (traversed.has(key)) return;
    traversed.add(key);

    let names: string[];

    try {
      names = (await fs.readdir(directory)).map((entry) => entry.name);
    } catch (cause) {
      if (missing(cause)) return;
      throw cause;
    }

    for (const name of names) {
      if ((target.hidden && name.startsWith(".")) || target.names.includes(name)) continue;

      const path = directory === "/" ? `/${name}` : `${directory}/${name}`;
      const found = await record(path, false);

      if (target.recursive && found?.isDirectory === true) {
        counted.add(path);

        if (counted.size > maxDirectories) {
          throw new HostFailure(
            "invalid",
            `Watched paths exceed ${maxDirectories} directories`,
            target.path,
          );
        }

        await scanDirectory(index, target, path);
      }
    }
  };

  for (const [index, target] of targets.entries()) {
    for (const ancestor of ancestors(target.path)) await record(ancestor, false);

    const found = await record(target.path, true);

    if (found?.isDirectory === true) await scanDirectory(index, target, target.path);
  }

  return [...snapshot];
};
