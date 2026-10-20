// A Session's Workspace (`docs/spec.md` → Filesystem and tools, ADR-0001): its conversations' execution environment is a
// `ComputerExecutionEnv` over the Workspace DO named by the Session's slug, and `ls`, `find`, and `grep` search the same
// Workspace's files. Every Session bound to a slug reaches the same DO, so they share one tree (ADR-0006).
// @effect-diagnostics asyncFunction:off
import type { ComputerWorkspaceStub } from "@cloudpid/computer-env";
import type { FileSearch } from "@cloudpid/extensions/files";
import { DEFAULT_WORKSPACE } from "@cloudpid/protocol";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import { WORKSPACE_ROOT } from "../workspace/binding.ts";

/**
 * `@cloudpid/computer-env` loads on first use. `@cloudflare/computer` imports `cloudflare:workers`, which Node cannot
 * load, and the deploy loads the Server's module graph, this file included, in Node.
 */
const computer = () => import("@cloudpid/computer-env");

/** The Workspace DO namespace, as a Session DO binds it: the raw namespace, whose stubs `ComputerExecutionEnv` needs. */
export type WorkspaceNamespace = {
  getByName(slug: string): ComputerWorkspaceStub;
};

export type CachedSlugOptions = {
  /** The Session's name, its ID in the Registry; undefined when unknown. */
  readonly name: string | undefined;
  /** The slug kept from an earlier lookup. */
  readonly get: () => string | undefined;
  /** Keeps the slug of a lookup. */
  readonly put: (slug: string) => void;
  /** The slug of the Workspace the Registry lists the Session with, or null when it does not list it. */
  readonly lookup: (name: string) => Promise<string | null>;
};

/**
 * The slug of a Session's Workspace. It is fixed when the Registry creates the Session, so it is asked once and kept. A
 * Session the Registry does not list (or whose name is unknown) works on the default Workspace, and is asked again. A
 * failed lookup fails the call and keeps nothing.
 */
export const cachedSlug =
  ({ name, get, put, lookup }: CachedSlugOptions): (() => Promise<string>) =>
  async () => {
    const known = get();

    if (known !== undefined) return known;

    if (name === undefined) return DEFAULT_WORKSPACE;

    const slug = await lookup(name);

    if (slug === null) return DEFAULT_WORKSPACE;

    put(slug);

    return slug;
  };

export type SessionWorkspaceOptions = {
  readonly namespace: WorkspaceNamespace;
  /** The slug of the Workspace the Session is bound to. Called at each use, so it may look the slug up. */
  readonly slug: () => Promise<string>;
};

/** What a Session runs its tools on. */
export type SessionWorkspace = {
  /** `HarnessOptions.env`: a conversation's environment, in its `cwd` or at the Workspace root. */
  readonly env: NonNullable<HarnessOptions["env"]>;
  /** The Workspace's file search, for `ls`, `find`, and `grep`. */
  readonly files: FileSearch;
};

export const sessionWorkspace = (options: SessionWorkspaceOptions): SessionWorkspace => {
  const search = async () => {
    const { ComputerFiles } = await computer();

    return new ComputerFiles(options.namespace.getByName(await options.slug()));
  };

  const files: FileSearch = {
    readdir: async (path) => (await search()).readdir(path),
    find: async (directory, pattern, found) => (await search()).find(directory, pattern, found),
    grep: async (pattern, path, matched) => (await search()).grep(pattern, path, matched),
  };

  return {
    env: async (target) => {
      const { ComputerExecutionEnv } = await computer();
      const slug = await options.slug();

      return new ComputerExecutionEnv({
        workspace: options.namespace.getByName(slug),
        // Environments with equal ids see the same files: one per Workspace.
        id: `computer:${slug}`,
        cwd: target.cwd ?? WORKSPACE_ROOT,
      });
    },
    files,
  };
};
