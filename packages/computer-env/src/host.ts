// The Workspace DO side of `ComputerExecutionEnv`: file operations on the object's own `@cloudflare/computer`
// Workspace, where a failure still carries its POSIX code, answered as plain data (see `wire.ts`).
// pi-durable's `ExecutionEnv` is Promise-native and stays so (ADR-0003); this adapter follows it.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off globalDate:off preferEffectArray:off
import type { Workspace } from "@cloudflare/computer";
import {
  err,
  type ExecutionEnv,
  type FileInfo,
  type FileKind,
  LineScanner,
  ok,
} from "@earendil-works/pi-durable/env";
import { type ContainerAccess, ContainerFiles } from "./container-files.ts";
import { HARNESS_ROOT, isContainerOnly } from "./container-paths.ts";
import { HostFailure, posixCode, toWireError } from "./failure.ts";
import { listFiles } from "./list-files.ts";
import { ancestors, basename, dirname, resolve } from "./paths.ts";
import {
  type DirectoryEntry,
  type EnvRequest,
  type EnvResponse,
  type HostOperation,
  fromResult,
  type HostOperations,
  type ScanTarget,
  toFileError,
  type WireResult,
} from "./wire.ts";

/** Where open binary readers keep their hard links. */
export const READERS_DIR = "/.computer/readers";

/** A reader link older than this belongs to a reader whose client went away without closing it. */
const STALE_READER_MS = 60 * 60 * 1000;

/**
 * Where `createTempDir` and `createTempFile` (and so exec spills) create their paths: the harness's own directory in
 * the Workspace, synced, so the Worker Shell, the Container and the file tools all see them (outside the Workspace, every
 * path is the Container's: ADR-0018).
 */
export const TEMP_DIR = `${HARNESS_ROOT}/tmp`;

/**
 * A temp entry not modified for this long is removed when the Workspace DO starts: nothing else cleans the harness's temp
 * directory, and its files would otherwise stay in the Workspace's storage, listings and the Container's synced tree.
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
const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/** The part of an environment that reads files, which code running next to them (the discovery of skills
 * and Prompt templates) needs. */
export type ReadEnv = Pick<ExecutionEnv, "cwd" | "fileInfo" | "listFiles" | "readTextFile">;

/**
 * `fs.mkdir(path, { recursive: true })`, except that a directory that is already there is left alone. computer refuses
 * the call on any path above a read-only mount (`/workspace`, with the Skill set mounted below it), though it would
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

/** The paths an operation works on, which decide whether it runs on the Container. Readers and temp paths never do. */
const pathsOf = (request: EnvRequest): readonly string[] => {
  switch (request.op) {
    case "readerInfo":
    case "read":
    case "scanLines":
    case "closeReader":
    case "createTempDir":
    case "containerOnly":
      return [];
    case "infos":
      return request.args[0];
    case "scan":
      return request.args[0].map((target) => target.path);
    case "rename":
      return [request.args[0], request.args[1]];
    case "grep":
      return [request.args[1]];
    default:
      return [request.args[0]];
  }
};

/** Answers `ComputerExecutionEnv`'s requests from the Workspace it holds, and from its Container when asked to. */
export class WorkspaceEnvHost {
  readonly #workspace: Workspace;
  readonly #operations: HostOperations;
  readonly #container: ContainerFiles | undefined;

  /**
   * @param container How the Container's file operations reach it; without it, a request that asks to reach the
   *   Container sees the Workspace's files only.
   */
  constructor(workspace: Workspace, container?: ContainerAccess) {
    this.#workspace = workspace;
    this.#operations = this.#makeOperations();

    const fs = workspace.fs;

    this.#container =
      container === undefined
        ? undefined
        : new ContainerFiles(container, {
            read: async (path) =>
              new Uint8Array(await new Response(await fs.readFile(path)).arrayBuffer()),
            write: async (path, bytes) => {
              await ensureDirectory(fs, dirname(path));
              await fs.writeFile(path, bytes);
            },
            remove: async (path) => {
              await fs.rm(path, { force: true });
            },
          });
  }

  /** Answer one request. */
  async handle(request: EnvRequest): Promise<EnvResponse<HostOperation>> {
    if (request.op === "containerOnly") return this.#classify(request.args[0]);

    if (request.reachContainer === true && this.#container !== undefined) {
      const routed = await this.#onContainer(this.#container, request);

      if (routed !== undefined) return routed;
    }

    // SAFETY: `EnvRequest` pairs each operation with its own parameters, so the arguments fit the operation called.
    const operation = this.#operations[request.op] as (
      ...args: EnvRequest["args"]
    ) => Promise<EnvResponse<HostOperation>>;

    return operation(...request.args);
  }

  /** Whether each path is Container-only: by the current launch's patterns, or (with no Container) outside the Workspace. */
  #classify(paths: readonly string[]): Promise<WireResult<readonly boolean[]>> {
    const container = this.#container;

    return attempt(paths[0] ?? "/", async () =>
      container === undefined
        ? paths.map((path) => isContainerOnly(path, undefined))
        : container.classify(paths),
    );
  }

  /**
   * `request` answered on the Container when it works on a Container-only path; undefined when it is the Workspace's to
   * answer. A `readdir` of a synced directory is the Workspace's, with the Container-only entries the running Container
   * has added.
   */
  async #onContainer(
    container: ContainerFiles,
    request: EnvRequest,
  ): Promise<EnvResponse<HostOperation> | undefined> {
    const paths = pathsOf(request);

    if (paths.length === 0) return undefined;

    const classified = await attempt(paths[0] ?? "/", () => container.classify(paths));

    if (!classified.ok) return classified;

    if (!classified.value.some(Boolean)) {
      return request.op === "readdir"
        ? this.#withContainerEntries(container, request.args[0])
        : undefined;
    }

    const path = paths[classified.value.indexOf(true)] ?? paths[0] ?? "/";

    switch (request.op) {
      case "info":
        return attempt(path, () => container.info(...request.args));
      case "canonical":
        return attempt(path, () => container.canonical(...request.args));
      case "readFile":
        return attempt(path, () => container.readFile(...request.args));
      case "writeFile": {
        const [target, content, append] = request.args;

        return attempt(path, async () => {
          await container.writeFile(
            target,
            content instanceof Uint8Array ? content : encoder.encode(content),
            append,
          );

          return null;
        });
      }

      case "openReader":
        return attempt(path, async () => {
          const { opened, info } = await container.openReader(
            request.args[0],
            request.args[1],
            (stage) => this.#operations.openReader(stage, false),
          );

          if (!opened.ok) throw new HostFailure(opened.error.code, opened.error.message, path);

          return { handle: opened.value.handle, info };
        });
      case "readdir":
        return attempt(path, () => container.readdir(...request.args));
      case "find":
        return attempt(path, () => container.find(...request.args));
      case "grep":
        return attempt(path, () => container.grep(...request.args));
      default:
        return {
          ok: false,
          error: {
            code: "not_supported",
            message: `${path} is only on the Container, where the file tools cannot ${request.op} it: use bash`,
            path,
          },
        };
    }
  }

  /** The Workspace's entries of directory `path`, then the Container-only ones the running Container has there. */
  async #withContainerEntries(
    container: ContainerFiles,
    path: string,
  ): Promise<WireResult<readonly DirectoryEntry[]>> {
    const own = await this.#operations.readdir(path);

    if (!own.ok) return own;

    const names = new Set(own.value.map((entry) => entry.name));

    const extra = (await container.containerOnlyEntries(path)).filter(
      (entry) => !names.has(entry.name),
    );

    return { ok: true, value: [...own.value, ...extra] };
  }

  /**
   * A read-only environment over this Workspace's files in `cwd`, answering in process what `ComputerExecutionEnv`
   * asks over RPC (paths resolve against `cwd` as there): for code that runs in the Workspace DO and wants no RPC call per file.
   */
  readEnv(cwd: string): ReadEnv {
    return {
      cwd,
      fileInfo: async (path) => fromResult(await this.#operations.info(resolve(cwd, path), true)),
      listFiles: async (path, options) =>
        fromResult(await this.#operations.listFiles(resolve(cwd, path), options ?? {})),
      readTextFile: async (path) => {
        const bytes = await this.#operations.readFile(resolve(cwd, path));

        return bytes.ok ? ok(decoder.decode(bytes.value)) : err(toFileError(bytes.error));
      },
    };
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

    await ensureDirectory(fs, TEMP_DIR);

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

          // Only an append joins the file to the new bytes: a write passes them on as they are, so a large file (an
          // Attachment of up to 25 MB) is not held twice.
          const written = append
            ? concat([...(await readAll(path).then((existing) => [existing], absent)), bytes])
            : bytes;

          await fs.writeFile(path, written);

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
      // Answered in `handle`, which knows the Container's patterns.
      containerOnly: (paths) => this.#classify(paths),
      readdir: (path) =>
        attempt(path, async () =>
          (await fs.readdir(path)).map((entry) => ({
            name: entry.name,
            isDirectory: entry.isDirectory,
            isSymbolicLink: entry.isSymbolicLink,
          })),
        ),
      find: (directory, pattern, options) =>
        attempt(directory, async () =>
          (
            await fs.find(directory, pattern, {
              limit: options.limit,
              exclude: [...options.exclude],
            })
          ).map((entry) => ({ path: entry.path, type: entry.type })),
        ),
      grep: (pattern, path, options) =>
        attempt(path, async () => {
          const search: NonNullable<Parameters<Workspace["fs"]["grep"]>[2]> = {
            ignoreCase: options.ignoreCase,
            regex: options.regex,
            context: options.context,
            limit: options.limit,
            exclude: [...options.exclude],
          };

          if (options.include !== undefined) search.include = options.include;

          return (await fs.grep(pattern, path, search)).map((match) => ({
            path: match.path,
            line: match.line,
            text: match.text,
            context: match.context?.map((line) => ({
              line: line.line,
              text: line.text,
              isMatch: line.isMatch,
            })),
          }));
        }),
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
