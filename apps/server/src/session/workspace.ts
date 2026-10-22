// A Session's Workspace (`docs/spec.md` → Filesystem and tools, ADR-0001): its conversations' execution environment is a
// `ComputerExecutionEnv` over the Workspace DO named by the Session's slug, and `ls`, `find`, and `grep` search the same
// Workspace's files. Every Session bound to a slug reaches the same DO, so they share one tree (ADR-0006). A Session
// bound to a repo works in its directory, `/workspace/<repo>`, unless a conversation names another `cwd`.
// @effect-diagnostics asyncFunction:off
import type { ComputerWorkspaceStub } from "@cloudpid/computer-env";
import type { FileSearch } from "@cloudpid/extensions/files";
import { DEFAULT_WORKSPACE, repoDirectory } from "@cloudpid/protocol";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import { WORKSPACE_ROOT } from "../workspace/binding.ts";

/**
 * `@cloudpid/computer-env` loads on first use. `@cloudflare/computer` imports `cloudflare:workers`, which Node cannot
 * load, and the deploy loads the Server's module graph, this file included, in Node.
 */
const computer = () => import("@cloudpid/computer-env");

/** The Workspace DO namespace, as a Session DO binds it: the raw namespace, whose stubs `ComputerExecutionEnv` needs. */
export type WorkspaceNamespace = {
  getByName(slug: string): ComputerWorkspaceStub & {
    /** Start the Container for a message, answering at once (`Workspace.warmContainer`). */
    warmContainer(): Promise<void>;
  };
};

/** Where a Session works: its Workspace's slug, and the repo directory below `/workspace` it works in (null: the root). */
export type Placement = { readonly slug: string; readonly repo: string | null };

export type CachedPlacementOptions = {
  /** The Session's name, its ID in the Registry; undefined when unknown. */
  readonly name: string | undefined;
  /** The placement kept from an earlier lookup. */
  readonly get: () => Placement | undefined;
  /** Keeps the placement of a lookup. */
  readonly put: (placement: Placement) => void;
  /** The Workspace and repo the Registry lists the Session with, or null when it does not list it. */
  readonly lookup: (name: string) => Promise<Placement | null>;
};

/** Where a Session the Registry does not list works: the root of the default Workspace. */
const DEFAULT_PLACEMENT: Placement = { slug: DEFAULT_WORKSPACE, repo: null };

/**
 * Where a Session works. It is fixed when the Registry creates the Session, so it is asked once and kept. A Session the
 * Registry does not list (or whose name is unknown) works at the root of the default Workspace, and is asked again. A
 * failed lookup fails the call and keeps nothing.
 */
export const cachedPlacement =
  ({ name, get, put, lookup }: CachedPlacementOptions): (() => Promise<Placement>) =>
  async () => {
    const known = get();

    if (known !== undefined) return known;

    if (name === undefined) return DEFAULT_PLACEMENT;

    const placement = await lookup(name);

    if (placement === null) return DEFAULT_PLACEMENT;

    put(placement);

    return placement;
  };

export type SessionWorkspaceOptions = {
  readonly namespace: WorkspaceNamespace;
  /** The Workspace and repo the Session is bound to. Called at each use, so it may look them up. */
  readonly placement: () => Promise<Placement>;
};

/** What a Session runs its tools on. */
export type SessionWorkspace = {
  /** `HarnessOptions.env`: a conversation's environment, in its `cwd` or at the Workspace root. */
  readonly env: NonNullable<HarnessOptions["env"]>;
  /** The Workspace's file search, for `ls`, `find`, and `grep`. */
  readonly files: FileSearch;
  /**
   * Ask the Workspace to start its Container for a message the owner sent (docs/spec.md → Backends). It answers once
   * the Workspace has the request, not once the Container is up.
   */
  readonly warm: () => Promise<void>;
};

export const sessionWorkspace = (options: SessionWorkspaceOptions): SessionWorkspace => {
  const search = async () => {
    const { ComputerFiles } = await computer();

    return new ComputerFiles(options.namespace.getByName((await options.placement()).slug));
  };

  const files: FileSearch = {
    readdir: async (path) => (await search()).readdir(path),
    find: async (directory, pattern, found) => (await search()).find(directory, pattern, found),
    grep: async (pattern, path, matched) => (await search()).grep(pattern, path, matched),
  };

  return {
    env: async (target) => {
      const { ComputerExecutionEnv } = await computer();
      const { slug, repo } = await options.placement();

      return new ComputerExecutionEnv({
        workspace: options.namespace.getByName(slug),
        // Environments with equal ids see the same files: one per Workspace.
        id: `computer:${slug}`,
        // A conversation's own `cwd` first, then the Session's repo, then the Workspace root.
        cwd: target.cwd ?? (repo === null ? WORKSPACE_ROOT : repoDirectory(repo)),
      });
    },
    files,
    warm: async () => {
      const { slug } = await options.placement();

      await options.namespace.getByName(slug).warmContainer();
    },
  };
};
