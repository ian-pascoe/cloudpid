// What `ComputerExecutionEnv` asks of the Workspace Durable Object, and how the answers cross Workers RPC. The
// Workspace's file errors carry their POSIX code only in the object that raised them, so every file operation runs in
// the Workspace DO and returns plain data: a result, or a failure with its pi-durable code. Plain data also means no
// RPC stub is created for any of them, so there is nothing to dispose.
import {
  type FileErrorCode,
  type FileInfo,
  type FileListing,
  type LineScan,
  type ListFilesOptions,
  FileError,
  err,
  ok,
  type Result,
} from "@earendil-works/pi-durable/env";

/** A failure as it crosses RPC. */
export type WireError = {
  readonly code: FileErrorCode;
  readonly message: string;
  readonly path?: string;
};

export type WireResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WireError };

/**
 * A skill the Workspace DO found (the extensions package's `Skill`, which this package does not import): the answer to
 * `skills`.
 */
export type WireSkill = {
  readonly name: string;
  readonly description: string;
  /** The absolute path of its `SKILL.md`. */
  readonly filePath: string;
  readonly disableModelInvocation: boolean;
};

/** A watch target, resolved, as the Workspace DO scans it. */
export type ScanTarget = {
  readonly path: string;
  readonly recursive: boolean;
  readonly hidden: boolean;
  readonly names: readonly string[];
};

/** One snapshot of everything a watch covers: each path with its identity, kind, size and modification time. */
export type Snapshot = ReadonlyArray<readonly [path: string, entry: string]>;

/** An open binary reader: a hard link the Workspace DO keeps to the opened file, and that file's metadata. */
export type OpenedReader = { readonly handle: string; readonly info: FileInfo };

/** The file operations the Workspace DO runs for `ComputerExecutionEnv`. Every path is absolute and normalized. */
export type HostOperations = {
  /** Metadata of `path`, following a final symbolic link when `follow`. */
  readonly info: (path: string, follow: boolean) => Promise<WireResult<FileInfo>>;
  /** Metadata of each path without following links, or `null` for a path that does not exist. */
  readonly infos: (paths: readonly string[]) => Promise<WireResult<ReadonlyArray<FileInfo | null>>>;
  /** The names in directory `path`. */
  readonly names: (path: string) => Promise<WireResult<readonly string[]>>;
  /** The entries of directory `path`, without following links. */
  readonly listDir: (path: string) => Promise<WireResult<readonly FileInfo[]>>;
  readonly canonical: (path: string) => Promise<WireResult<string>>;
  readonly readFile: (path: string) => Promise<WireResult<Uint8Array>>;
  /** Write or append `content`, creating missing parent directories. */
  readonly writeFile: (
    path: string,
    content: string | Uint8Array,
    append: boolean,
  ) => Promise<WireResult<null>>;
  readonly truncate: (path: string, size: number) => Promise<WireResult<null>>;
  /** Check that `path` is a file that can be flushed; the Workspace's storage is durable once written. */
  readonly flush: (path: string) => Promise<WireResult<null>>;
  readonly rename: (source: string, destination: string) => Promise<WireResult<null>>;
  readonly createDir: (path: string, recursive: boolean) => Promise<WireResult<null>>;
  readonly remove: (path: string, recursive: boolean, force: boolean) => Promise<WireResult<null>>;
  readonly createTempDir: (prefix: string) => Promise<WireResult<string>>;
  readonly openReader: (path: string, noFollow: boolean) => Promise<WireResult<OpenedReader>>;
  readonly readerInfo: (handle: string) => Promise<WireResult<FileInfo>>;
  readonly read: (
    handle: string,
    offset: number,
    length: number,
  ) => Promise<WireResult<Uint8Array>>;
  readonly scanLines: (
    handle: string,
    startLine: number,
    endLine: number | null,
  ) => Promise<WireResult<LineScan>>;
  readonly closeReader: (handle: string) => Promise<WireResult<null>>;
  /** What every watch target covers now, for a polling watcher to compare with its last snapshot. */
  readonly scan: (
    targets: readonly ScanTarget[],
    maxDirectories: number,
  ) => Promise<WireResult<Snapshot>>;
  readonly listFiles: (path: string, options: ListFilesOptions) => Promise<WireResult<FileListing>>;
};

export type HostOperation = keyof HostOperations;

/** One call of a host operation, as `ComputerEnvHost.fileOperation` receives it. */
export type EnvRequest = {
  readonly [Operation in HostOperation]: {
    readonly op: Operation;
    readonly args: Parameters<HostOperations[Operation]>;
  };
}[HostOperation];

/** What the answer to `request` holds. */
export type EnvResponse<Operation extends HostOperation> = Awaited<
  ReturnType<HostOperations[Operation]>
>;

export const fromFileError = (error: FileError): WireError =>
  error.path === undefined
    ? { code: error.code, message: error.message }
    : { code: error.code, message: error.message, path: error.path };

export const toFileError = (error: WireError): FileError =>
  new FileError(error.code, error.message, error.path);

export const fromResult = <T>(result: WireResult<T>): Result<T, FileError> =>
  result.ok ? ok(result.value) : err(toFileError(result.error));
