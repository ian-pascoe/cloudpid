// The Workspace's file search for the `ls`, `find`, and `grep` tools: computer's `fs.readdir`, `fs.find`, and
// `fs.grep`, answered inside the Workspace DO (docs/spec.md → Filesystem and tools, ADR-0008). A call takes a Workspace
// client and uses only its `fs`: this class has no way to run a command, so it can never start a Container.
// Results are copied to plain data before the client is disposed.
// pi-durable's tools are Promise-native and stay so (ADR-0003); this adapter follows them.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { getWorkspace, type WorkspaceClient, type WorkspaceHandle } from "@cloudflare/computer";
import type { ComputerWorkspaceStub } from "./env.ts";

/** An entry of a directory. */
export type DirectoryEntry = {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
};

/** An entry a glob found, at its absolute path. */
export type FoundEntry = { readonly path: string; readonly type: "file" | "dir" };

/** A line of a match's context. */
export type GrepLine = { readonly line: number; readonly text: string; readonly isMatch: boolean };

/** A matching line at an absolute path; `context` holds the lines around it when asked for. */
export type GrepMatch = {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly context?: ReadonlyArray<GrepLine> | undefined;
};

export type FindOptions = { readonly limit: number; readonly exclude: ReadonlyArray<string> };

export type GrepOptions = {
  readonly ignoreCase: boolean;
  readonly regex: boolean;
  readonly context: number;
  readonly limit: number;
  readonly include: string | undefined;
  readonly exclude: ReadonlyArray<string>;
};

/** Read-only file search over a Workspace DO stub. */
export class ComputerFiles {
  readonly #workspace: ComputerWorkspaceStub;

  constructor(workspace: ComputerWorkspaceStub) {
    this.#workspace = workspace;
  }

  /** Run `search` on a Workspace client's file system, then dispose the client. */
  async #onFiles<A>(search: (fs: WorkspaceClient["fs"]) => Promise<A>): Promise<A> {
    // SAFETY: the Workspace DO's `__getWorkspaceStub()` answers computer's `WorkspaceStub` over RPC, the handle
    // `getWorkspace()` takes; the stub's RPC types only rewrite its declared type.
    using client = await getWorkspace(this.#workspace as WorkspaceHandle);

    return await search(client.fs);
  }

  readdir(path: string): Promise<ReadonlyArray<DirectoryEntry>> {
    return this.#onFiles(async (fs) =>
      (await fs.readdir(path)).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
        isSymbolicLink: entry.isSymbolicLink,
      })),
    );
  }

  find(
    directory: string,
    pattern: string,
    options: FindOptions,
  ): Promise<ReadonlyArray<FoundEntry>> {
    return this.#onFiles(async (fs) =>
      (
        await fs.find(directory, pattern, { limit: options.limit, exclude: [...options.exclude] })
      ).map((entry) => ({ path: entry.path, type: entry.type })),
    );
  }

  grep(pattern: string, path: string, options: GrepOptions): Promise<ReadonlyArray<GrepMatch>> {
    const search: NonNullable<Parameters<WorkspaceClient["fs"]["grep"]>[2]> = {
      ignoreCase: options.ignoreCase,
      regex: options.regex,
      context: options.context,
      limit: options.limit,
      exclude: [...options.exclude],
    };

    if (options.include !== undefined) search.include = options.include;

    return this.#onFiles(async (fs) =>
      (await fs.grep(pattern, path, search)).map((match) => ({
        path: match.path,
        line: match.line,
        text: match.text,
        context: match.context?.map((line) => ({
          line: line.line,
          text: line.text,
          isMatch: line.isMatch,
        })),
      })),
    );
  }
}
