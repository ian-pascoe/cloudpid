// A Session's Workspace (`docs/spec.md` → Filesystem and tools, ADR-0001, ADR-0016): its conversations' execution
// environment is a `ComputerExecutionEnv` over the Workspace's own Durable Object (`workspaceObjectName`), and `ls`,
// `find`, and `grep` search the same Workspace's files. Every Session in a Workspace reaches the same DO, so they share
// one tree and one Container. A Session works in its Workspace's directory (its one repo's clone, or `/workspace`) unless
// a conversation names another `cwd`, once the Workspace is readied: its Repos cloned on its branch (`prepare.ts`).
// @effect-diagnostics asyncFunction:off globalDate:off missingPipeableSignature:off
import type { ComputerWorkspaceStub } from "@cloudpid/computer-env";
import type { ContainerControl } from "@cloudpid/extensions/container";
import type { FileSearch } from "@cloudpid/extensions/files";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import { WORKSPACE_ROOT, workspaceObjectName } from "../workspace/binding.ts";
import type { Workspace } from "../workspace/Workspace.ts";

/**
 * `@cloudpid/computer-env` loads on first use. `@cloudflare/computer` imports `cloudflare:workers`, which Node cannot
 * load, and the deploy loads the Server's module graph, this file included, in Node.
 */
const computer = () => import("@cloudpid/computer-env");

/** The Workspace DO namespace, as a Session DO binds it: the raw namespace, whose stubs `ComputerExecutionEnv` needs. */
export type WorkspaceNamespace = {
  getByName(
    objectName: string,
  ): ComputerWorkspaceStub &
    Pick<
      DurableObjectStub<Workspace>,
      | "containerSettings"
      | "updateContainerSettings"
      | "environmentBuild"
      | "updateEnvironmentBuild"
      | "updateEnvironmentSecrets"
      | "environmentSecretsUnavailable"
      | "containerUsage"
      | "stopContainer"
    >;
};

/**
 * Where a Session works: its Workspace's id (null for a Session the Registry does not list, whose Workspace is never
 * readied), the name of the Workspace's Durable Object (`workspaceObjectName`), and the directory the Session works in
 * when a conversation names no `cwd`.
 */
export type Placement = {
  readonly workspace: string | null;
  readonly object: string;
  readonly directory: string;
};

/** Where the Session in Workspace `id` works, in `directory`. */
export const workspacePlacement = (id: string, directory: string): Placement => ({
  workspace: id,
  object: workspaceObjectName(id),
  directory,
});

export type CachedPlacementOptions = {
  /** The Session's name, its ID in the Registry; undefined when unknown. */
  readonly name: string | undefined;
  /** The placement kept from an earlier lookup. */
  readonly get: () => Placement | undefined;
  /** Keeps the placement of a lookup. */
  readonly put: (placement: Placement) => void;
  /** The Workspace the Registry lists the Session in, or null when it does not list it. */
  readonly lookup: (name: string) => Promise<Placement | null>;
};

/** Where a Session the Registry does not list works: the root of a Workspace nobody readies. */
const UNLISTED_PLACEMENT: Placement = {
  workspace: null,
  object: workspaceObjectName("unlisted"),
  directory: WORKSPACE_ROOT,
};

/**
 * Where a Session works. It is fixed when the Registry creates the Session, so it is asked once and kept. A Session the
 * Registry does not list (or whose name is unknown) works in `UNLISTED_PLACEMENT`, and is asked again. A failed lookup
 * fails the call and keeps nothing.
 */
export const cachedPlacement =
  ({ name, get, put, lookup }: CachedPlacementOptions): (() => Promise<Placement>) =>
  async () => {
    const known = get();

    if (known !== undefined) return known;

    if (name === undefined) return UNLISTED_PLACEMENT;

    const placement = await lookup(name);

    if (placement === null) return UNLISTED_PLACEMENT;

    put(placement);

    return placement;
  };

/** How long a Workspace readied counts as ready before it is readied again, in milliseconds. */
export const WORKSPACE_CHECKED_FOR = 60_000;

/** Ready Workspace `id`: its settings, Build and Secrets handed over, then its Repos cloned (`prepareWorkspace`). */
export type PrepareWorkspace = (id: string) => Promise<void>;

/** What `readyPlacement` checks: where the Session works, and how its Workspace is readied. */
export type ReadyPlacementOptions = {
  readonly placement: () => Promise<Placement>;
  readonly prepare: PrepareWorkspace;
  /** The time in milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
};

/**
 * The Session's placement once its Workspace is ready: readied when the Session first works in it, and again at most
 * every `WORKSPACE_CHECKED_FOR`, so a Repo whose clone failed is tried again and changed settings reach the Workspace.
 * Callers meanwhile wait for the one readying in flight. One that fails fails the call and is tried again at the next.
 */
export const readyPlacement = ({
  placement,
  prepare,
  now = Date.now,
}: ReadyPlacementOptions): (() => Promise<Placement>) => {
  let checkedAt: number | undefined;
  let checking: Promise<void> | undefined;

  const readying = (workspace: string) => {
    checking ??= prepare(workspace)
      .then(() => {
        checkedAt = now();
      })
      .finally(() => {
        checking = undefined;
      });

    return checking;
  };

  return async () => {
    const placed = await placement();
    const { workspace } = placed;

    if (workspace === null) return placed;

    if (checkedAt !== undefined && now() - checkedAt < WORKSPACE_CHECKED_FOR) return placed;

    await readying(workspace);

    return placed;
  };
};

export type SessionWorkspaceOptions = {
  readonly namespace: WorkspaceNamespace;
  /** The Workspace the Session is bound to. Called at each use, so it may look it up. */
  readonly placement: () => Promise<Placement>;
  /** Readies the Session's Workspace before its files are used. */
  readonly prepare: PrepareWorkspace;
};

/** What a Session runs its tools on. */
export type SessionWorkspace = {
  /** `HarnessOptions.env`: a conversation's environment, in its `cwd` or in the Workspace's directory. */
  readonly env: NonNullable<HarnessOptions["env"]>;
  /**
   * A conversation's environment for the composer's lookups (its catalog of Skills and Prompt templates, its `@` menu),
   * as `env` but without readying the Workspace first: lookups only read files, so they never wait for the clones and
   * their Setup Scripts, which can take minutes on a Container that has to start first.
   */
  readonly lookupEnv: NonNullable<HarnessOptions["env"]>;
  /** The Workspace's file search, for `ls`, `find`, and `grep`. */
  readonly files: FileSearch;
  /**
   * The Workspace's Container, for `restart_container`. It does not ready the Workspace first: readying may need the
   * Container, which is what a restart is for when it no longer answers.
   */
  readonly container: ContainerControl;
};

export const sessionWorkspace = (options: SessionWorkspaceOptions): SessionWorkspace => {
  const ready = readyPlacement(options);

  const search = async () => {
    const { ComputerFiles } = await computer();

    return new ComputerFiles(options.namespace.getByName((await ready()).object));
  };

  const files: FileSearch = {
    readdir: async (path) => (await search()).readdir(path),
    find: async (directory, pattern, found) => (await search()).find(directory, pattern, found),
    grep: async (pattern, path, matched) => (await search()).grep(pattern, path, matched),
  };

  const envIn = async (placed: Placement, cwd: string) => {
    const { ComputerExecutionEnv } = await computer();

    return new ComputerExecutionEnv({
      workspace: options.namespace.getByName(placed.object),
      // Environments with equal ids see the same files: one per Workspace.
      id: `computer:${placed.object}`,
      cwd,
    });
  };

  const container: ContainerControl = {
    restart: async ({ fresh }) => {
      const placed = await options.placement();

      return options.namespace.getByName(placed.object).stopContainer({ forgetSnapshot: fresh });
    },
  };

  return {
    env: async (target) => {
      const placed = await ready();

      // A conversation's own `cwd` first, then the Session's Workspace.
      return envIn(placed, target.cwd ?? placed.directory);
    },
    lookupEnv: async (target) => {
      const placed = await options.placement();

      return envIn(placed, target.cwd ?? placed.directory);
    },
    files,
    container,
  };
};
