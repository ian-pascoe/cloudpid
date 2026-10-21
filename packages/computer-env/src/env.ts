// `ComputerExecutionEnv`: pi-durable's `ExecutionEnv` over a Workspace DO stub (docs/spec.md → Filesystem and tools).
// File operations run in the Workspace DO and answer plain data (`host.ts`); commands run on the Workspace's runtime
// through `@cloudflare/computer`'s RPC client (`exec.ts`).
// pi-durable's `ExecutionEnv` is Promise-native and stays so (ADR-0003); this adapter follows it.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off preferEffectArray:off
import type { WorkspaceHandle } from "@cloudflare/computer";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type BinaryReader,
  type DirReader,
  err,
  type ExecutionEnv,
  type ExecutionError,
  FileError,
  type FileInfo,
  type FileListing,
  type FileWatcher,
  type ListFilesOptions,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { abortedResult, type Call, caller, type ComputerEnvHost } from "./client.ts";
import { exec, killAll } from "./exec.ts";
import { join, resolve } from "./paths.ts";
import { inBash } from "./shell.ts";
import { ComputerBinaryReader, ComputerDirReader, ComputerTextLineReader } from "./readers.ts";
import { type PollingOptions, PollingWatcher } from "./watch.ts";
import type { WireSkill } from "./wire.ts";

/**
 * A Workspace DO stub: computer's `__getWorkspaceStub()`, which `getWorkspace()` calls for exec, and the file operations
 * of `WorkspaceEnvHost`.
 */
export type ComputerWorkspaceStub = ComputerEnvHost & {
  __getWorkspaceStub(): Promise<Disposable>;
};

// SAFETY: the Workspace DO's `__getWorkspaceStub()` answers computer's `WorkspaceStub` over RPC, the handle
// `getWorkspace()` takes; the stub's RPC types only rewrite its declared type.
const workspaceHandle = (stub: ComputerWorkspaceStub) => stub as WorkspaceHandle;

export type ComputerExecutionEnvOptions = {
  /** The Workspace DO, as a stub. */
  readonly workspace: ComputerWorkspaceStub;
  /** The file namespace, one per Workspace: environments with equal ids see the same files. */
  readonly id: string;
  /** The absolute directory relative paths resolve against. */
  readonly cwd: string;
  readonly watch?: PollingOptions;
};

/** A backend a command is sent to: its id in the Workspace, and how a command is made to run in bash on it. */
export type BackendTarget = {
  readonly id: string;
  readonly script: (command: string) => string;
};

/**
 * The backends a command can be sent to, by the names `bash` gives them: the ids of the backends the Workspace DO
 * registers (`@cloudflare/computer`'s defaults for the Worker Shell and the Container). The Worker Shell is bash; the
 * Container's `/bin/sh` is dash, so its commands are wrapped.
 */
const BACKENDS = {
  worker: { id: "worker-shell", script: (command) => command },
  container: { id: "container-shell", script: inBash },
} as const satisfies Record<string, BackendTarget>;

export type ComputerBackend = keyof typeof BACKENDS;

const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

export class ComputerExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  readonly #workspace: ComputerWorkspaceStub;
  readonly #call: Call;
  readonly #watch: PollingOptions;
  readonly #running: Set<string>;
  readonly #options: ComputerExecutionEnvOptions;
  readonly #backend: BackendTarget | undefined;

  /**
   * @param running The commands running, shared with the environments this one makes with `onBackend()`, so one
   *   `cleanup()` kills them all.
   * @param backend The backend commands run on; undefined for the Workspace's default.
   */
  constructor(
    options: ComputerExecutionEnvOptions,
    running = new Set<string>(),
    backend?: BackendTarget,
  ) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.#options = options;
    this.#workspace = options.workspace;
    this.#call = caller(options.workspace);
    this.#watch = options.watch ?? {};
    this.#running = running;
    this.#backend = backend;
  }

  /**
   * This environment with its commands sent to `backend`: the Worker Shell (`worker`) or the Container
   * (`container`). Both see the Workspace's files. The result shares this environment's working directory at the
   * time of the call, and its running commands, which this environment's `cleanup()` kills.
   */
  onBackend(backend: ComputerBackend): ComputerExecutionEnv {
    return new ComputerExecutionEnv(
      { ...this.#options, cwd: this.cwd },
      this.#running,
      BACKENDS[backend],
    );
  }

  #resolve(path: string): string {
    return resolve(this.cwd, path);
  }

  async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return ok(this.#resolve(path));
  }

  async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    return ok(join(parts));
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const bytes = await this.#call(context, "readFile", this.#resolve(path));

    return bytes.ok ? ok(decoder.decode(bytes.value)) : bytes;
  }

  async openTextLineReader(
    path: string,
    context: Context,
  ): Promise<Result<TextLineReader, FileError>> {
    const reader = await this.openBinaryReader(path, undefined, context);

    return reader.ok ? ok(new ComputerTextLineReader(reader.value, this.#resolve(path))) : reader;
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);

    const opened = await this.openTextLineReader(path, context);

    if (!opened.ok) return opened;

    const lines: string[] = [];

    try {
      while (options?.maxLines === undefined || lines.length < options.maxLines) {
        const line = await opened.value.readLine(context);

        if (!line.ok) return line;

        if (line.value === undefined) break;
        lines.push(line.value.text);
      }

      return ok(lines);
    } finally {
      await opened.value.close(context);
    }
  }

  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.#call(context, "readFile", this.#resolve(path));
  }

  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const resolved = this.#resolve(path);
    const opened = await this.#call(context, "openReader", resolved, options?.noFollow === true);

    return opened.ok
      ? ok(new ComputerBinaryReader(this.#call, opened.value.handle, resolved))
      : opened;
  }

  writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.#void(this.#call(context, "writeFile", this.#resolve(path), content, false));
  }

  appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.#void(this.#call(context, "writeFile", this.#resolve(path), content, true));
  }

  async truncateFile(
    path: string,
    size: number,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = this.#resolve(path);

    if (!Number.isSafeInteger(size) || size < 0) {
      return err(
        new FileError("invalid", "File size must be a non-negative safe integer", resolved),
      );
    }

    return this.#void(this.#call(context, "truncate", resolved, size));
  }

  flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.#void(this.#call(context, "flush", this.#resolve(path)));
  }

  renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.#void(
      this.#call(context, "rename", this.#resolve(sourcePath), this.#resolve(destinationPath)),
    );
  }

  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.#call(context, "info", this.#resolve(path), false);
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const listed = await this.#call(context, "listDir", this.#resolve(path));

    return listed.ok ? ok([...listed.value]) : listed;
  }

  listFiles(
    path: string,
    options: ListFilesOptions | undefined,
    context: Context,
  ): Promise<Result<FileListing, FileError>> {
    return this.#call(context, "listFiles", this.#resolve(path), options ?? {});
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const resolved = this.#resolve(path);
    const names = await this.#call(context, "names", resolved);

    return names.ok ? ok(new ComputerDirReader(this.#call, resolved, names.value)) : names;
  }

  async watch(
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    const resolved = targets.map((target) => ({
      path: this.#resolve(target.path),
      recursive: target.recursive === true,
      hidden: target.exclude?.hidden === true,
      names: target.exclude?.names ?? [],
    }));

    const watcher = await PollingWatcher.open(this.#call, resolved, onChange, this.#watch, context);

    if (!watcher.ok) return watcher;

    const aborted = abortedResult<FileWatcher>(context);

    if (aborted === undefined) return watcher;
    await watcher.value.close(context);

    return aborted;
  }

  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#call(context, "canonical", this.#resolve(path));
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path, context);

    if (info.ok) return ok(true);

    return info.error.code === "not_found" ? ok(false) : info;
  }

  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.#void(
      this.#call(context, "createDir", this.#resolve(path), options?.recursive ?? true),
    );
  }

  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.#void(
      this.#call(
        context,
        "remove",
        this.#resolve(path),
        options?.recursive ?? false,
        options?.force ?? false,
      ),
    );
  }

  createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.#call(context, "createTempDir", prefix ?? "tmp-");
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    const dir = await this.createTempDir("tmp-", context);

    if (!dir.ok) return dir;

    const path = `${dir.value}/${options?.prefix ?? ""}${crypto.randomUUID()}${options?.suffix ?? ""}`;
    const written = await this.writeFile(path, "", context);

    return written.ok ? ok(path) : written;
  }

  exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    return exec(
      {
        workspace: workspaceHandle(this.#workspace),
        backend: this.#backend,
        cwd: this.cwd,
        running: this.#running,
        // The spill of a command that was aborted is still written, so it runs outside the caller's context.
        spill: async (output) => {
          const path = await this.createTempFile({ suffix: ".log" }, BACKGROUND_CONTEXT);

          if (!path.ok) return undefined;

          const written = await this.writeFile(path.value, output, BACKGROUND_CONTEXT);

          return written.ok ? path.value : undefined;
        },
      },
      command,
      options,
      context,
    );
  }

  /**
   * The skills a conversation in this environment's `cwd` can use, found by the Workspace DO next to the files: one
   * RPC call however many directories and skills there are (the extensions package's `SkillSource`).
   */
  async discoverSkills(context: Context): Promise<ReadonlyArray<WireSkill>> {
    if (context.abortSignal?.aborted === true) throw new Error("aborted");

    // SAFETY: the Workspace DO answers `skills` with the array of plain data it found; a stub's RPC types only
    // rewrite its declared type.
    return (await this.#workspace.skills(this.cwd)) as ReadonlyArray<WireSkill>;
  }

  /** Kill the commands this environment still runs. */
  async cleanup(_context: Context): Promise<void> {
    await killAll(workspaceHandle(this.#workspace), this.#running);
  }

  async #void(result: Promise<Result<null, FileError>>): Promise<Result<void, FileError>> {
    const settled = await result;

    return settled.ok ? ok(undefined) : settled;
  }
}
