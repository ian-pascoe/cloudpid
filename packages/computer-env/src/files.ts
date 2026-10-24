// `ComputerFiles`: the file search `ls`, `find`, and `grep` run on (`@cloudpid/extensions/files`). Each search is one
// of the Workspace DO's file operations (`host.ts`), answered as plain data. Without `reachContainer` it sees only the
// Workspace's files and can never start a Container; the model's own tools ask for `reachContainer`, which runs a
// search of a Container-only path on the Container (ADR-0018).
// pi-durable's tools are Promise-native and stay so (ADR-0003); this adapter follows them.
// @effect-diagnostics asyncFunction:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Call, caller } from "./client.ts";
import type { ComputerWorkspaceStub } from "./env.ts";
import type { DirectoryEntry, FindOptions, FoundEntry, GrepMatch, GrepOptions } from "./wire.ts";

export type {
  DirectoryEntry,
  FindOptions,
  FoundEntry,
  GrepLine,
  GrepMatch,
  GrepOptions,
} from "./wire.ts";

export type ComputerFilesOptions = {
  /** Whether a search of a Container-only path runs on the Container, starting it if it is stopped. */
  readonly reachContainer?: boolean;
};

/** File search over a Workspace DO stub. */
export class ComputerFiles {
  readonly #call: Call;

  constructor(
    workspace: Pick<ComputerWorkspaceStub, "fileOperation">,
    options: ComputerFilesOptions = {},
  ) {
    this.#call = caller(workspace, options.reachContainer === true);
  }

  async readdir(path: string): Promise<ReadonlyArray<DirectoryEntry>> {
    const listed = await this.#call(BACKGROUND_CONTEXT, "readdir", path);

    if (!listed.ok) throw listed.error;

    return listed.value;
  }

  async find(
    directory: string,
    pattern: string,
    options: FindOptions,
  ): Promise<ReadonlyArray<FoundEntry>> {
    const found = await this.#call(BACKGROUND_CONTEXT, "find", directory, pattern, options);

    if (!found.ok) throw found.error;

    return found.value;
  }

  async grep(
    pattern: string,
    path: string,
    options: GrepOptions,
  ): Promise<ReadonlyArray<GrepMatch>> {
    const matched = await this.#call(BACKGROUND_CONTEXT, "grep", pattern, path, options);

    if (!matched.ok) throw matched.error;

    return matched.value;
  }
}
