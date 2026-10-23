// A Session's Workspace (`docs/spec.md` → Filesystem and tools, ADR-0001, ADR-0015): its conversations' execution
// environment is a `ComputerExecutionEnv` over the Workspace DO named by the Session's Machine, and `ls`, `find`, and
// `grep` search the same Machine's files. Every Session on a Machine reaches the same DO, so they share one tree. A
// Session works in its Workspace unless a conversation names another `cwd`: a worktree of its repo of its own,
// `/workspace/.worktrees/<repo>/<id>` (made on first use), the repo's main checkout, `/workspace/<repo>`, or the root.
// @effect-diagnostics asyncFunction:off globalDate:off missingPipeableSignature:off
import type { ComputerWorkspaceStub } from "@cloudpid/computer-env";
import type { FileSearch } from "@cloudpid/extensions/files";
import { DEFAULT_MACHINE, repoDirectory, worktreeDirectory } from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import { WORKSPACE_ROOT } from "../workspace/binding.ts";
import type { Workspace } from "../workspace/Workspace.ts";

/**
 * `@cloudpid/computer-env` loads on first use. `@cloudflare/computer` imports `cloudflare:workers`, which Node cannot
 * load, and the deploy loads the Server's module graph, this file included, in Node.
 */
const computer = () => import("@cloudpid/computer-env");

/** The Workspace DO namespace, as a Session DO binds it: the raw namespace, whose stubs `ComputerExecutionEnv` needs. */
export type WorkspaceNamespace = {
  getByName(
    slug: string,
  ): ComputerWorkspaceStub & Pick<DurableObjectStub<Workspace>, "startContainerEarly">;
};

/** A Workspace of its own: a worktree of the Session's repo, on its branch. */
export type PlacedWorktree = { readonly id: string; readonly branch: string };

/**
 * Where a Session works: its Machine's slug, the repo it works in (null: the root), and its Workspace of its own in that
 * repo (null: the repo's main checkout).
 */
export type Placement = {
  readonly machine: string;
  readonly repo: string | null;
  readonly worktree: PlacedWorktree | null;
};

/** The directory a Session works in when a conversation names no `cwd`. */
export const placementDirectory = ({ repo, worktree }: Placement): string => {
  if (repo === null) return WORKSPACE_ROOT;

  return worktree === null ? repoDirectory(repo) : worktreeDirectory(repo, worktree.id);
};

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
const DEFAULT_PLACEMENT: Placement = { machine: DEFAULT_MACHINE, repo: null, worktree: null };

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

/** How long a worktree found or made counts as there before it is checked again, in milliseconds. */
export const WORKTREE_CHECKED_FOR = 60_000;

/** Make a worktree of `worktree.repo` on Machine `machine` unless it is there (`MachineWorktrees.prepare`). */
export type PrepareWorktree = (
  machine: string,
  worktree: PlacedWorktree & { readonly repo: string },
) => Promise<void>;

/** What `readyPlacement` checks: where the Session works, and how its worktree is made. */
export type ReadyPlacementOptions = {
  readonly placement: () => Promise<Placement>;
  readonly prepare: PrepareWorktree;
  /** The time in milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
};

/**
 * The Session's placement once its Workspace's worktree is there: made when the Session first works in it, and again
 * after it was removed. A worktree found or made is not checked again for `WORKTREE_CHECKED_FOR`; callers meanwhile wait
 * for the one check in flight. A check that fails fails the call and is tried again at the next.
 */
export const readyPlacement = ({
  placement,
  prepare,
  now = Date.now,
}: ReadyPlacementOptions): (() => Promise<Placement>) => {
  let checkedAt: number | undefined;
  let checking: Promise<void> | undefined;

  return async () => {
    const placed = await placement();
    const { repo, worktree } = placed;

    if (repo === null || worktree === null) return placed;

    if (checkedAt !== undefined && now() - checkedAt < WORKTREE_CHECKED_FOR) return placed;

    checking ??= prepare(placed.machine, { ...worktree, repo })
      .then(() => {
        checkedAt = now();
      })
      .finally(() => {
        checking = undefined;
      });

    await checking;

    return placed;
  };
};

export type SessionWorkspaceOptions = {
  readonly namespace: WorkspaceNamespace;
  /** The Machine, repo and Workspace the Session is bound to. Called at each use, so it may look them up. */
  readonly placement: () => Promise<Placement>;
  /** Makes the Session's worktree, if it has one, before its files are used. */
  readonly prepare: PrepareWorktree;
};

/**
 * The directory the composer's lookups (its catalog of Skills and Prompt templates, its `@` menu) read when a
 * conversation names no `cwd`: the Session's Workspace once its worktree is there (`made`), and the repo's main checkout
 * until then, which has the same Skills and templates. Lookups only read files, so they never wait for the worktree to
 * be made and its Setup Script to run, which can take minutes on a Container that has to start first.
 */
export const lookupDirectory = async (
  placed: Placement,
  made: (directory: string) => Promise<boolean>,
): Promise<string> => {
  const { repo, worktree } = placed;

  if (repo === null || worktree === null) return placementDirectory(placed);

  const directory = worktreeDirectory(repo, worktree.id);

  return (await made(directory)) ? directory : repoDirectory(repo);
};

/** What a Session runs its tools on. */
export type SessionWorkspace = {
  /** `HarnessOptions.env`: a conversation's environment, in its `cwd` or at the Workspace root. */
  readonly env: NonNullable<HarnessOptions["env"]>;
  /**
   * A conversation's environment for the composer's lookups, as `env` but without making the Session's worktree first:
   * until it is there, a conversation that names no `cwd` reads the repo's main checkout (`lookupDirectory`).
   */
  readonly lookupEnv: NonNullable<HarnessOptions["env"]>;
  /** The Workspace's file search, for `ls`, `find`, and `grep`. */
  readonly files: FileSearch;
  /**
   * Ask the Workspace for the early start of its Container, for a message the owner sent (docs/spec.md → Backends). It
   * answers once the Workspace has the request, not once the Container is up.
   */
  readonly startContainerEarly: () => Promise<void>;
};

export const sessionWorkspace = (options: SessionWorkspaceOptions): SessionWorkspace => {
  const ready = readyPlacement(options);

  const search = async () => {
    const { ComputerFiles } = await computer();

    return new ComputerFiles(options.namespace.getByName((await ready()).machine));
  };

  const files: FileSearch = {
    readdir: async (path) => (await search()).readdir(path),
    find: async (directory, pattern, found) => (await search()).find(directory, pattern, found),
    grep: async (pattern, path, matched) => (await search()).grep(pattern, path, matched),
  };

  /** Worktree directories seen with their `.git`: a worktree is not removed while a Session works in it. */
  const made = new Set<string>();

  const envIn = async (machine: string, cwd: string) => {
    const { ComputerExecutionEnv } = await computer();

    return new ComputerExecutionEnv({
      workspace: options.namespace.getByName(machine),
      // Environments with equal ids see the same files: one per Machine.
      id: `computer:${machine}`,
      cwd,
    });
  };

  const isMade = async (machine: string, directory: string): Promise<boolean> => {
    if (made.has(directory)) return true;

    const env = await envIn(machine, WORKSPACE_ROOT);
    const info = await env.fileInfo(`${directory}/.git`, BACKGROUND_CONTEXT).catch(() => undefined);

    // Not there yet, or it cannot be told: the main checkout answers meanwhile.
    if (info?.ok !== true) return false;

    made.add(directory);

    return true;
  };

  return {
    env: async (target) => {
      const placed = await ready();

      // A conversation's own `cwd` first, then the Session's Workspace.
      return envIn(placed.machine, target.cwd ?? placementDirectory(placed));
    },
    lookupEnv: async (target) => {
      const placed = await options.placement();

      return envIn(
        placed.machine,
        target.cwd ??
          (await lookupDirectory(placed, (directory) => isMade(placed.machine, directory))),
      );
    },
    files,
    startContainerEarly: async () => {
      const { machine } = await options.placement();

      await options.namespace.getByName(machine).startContainerEarly();
      // The worktree, if it is not there yet, is made meanwhile: the turn's first use waits for this same check, and
      // one that fails is tried again there, and reported to it.
      void ready().catch(() => undefined);
    },
  };
};

/**
 * The early start for each message the owner sends (`SessionHostOptions.onSubmit`). A request that fails is logged and
 * fails nothing: the turn's first command starts the Container as it would have.
 */
export const earlyStartOnSubmit = (
  workspace: Pick<SessionWorkspace, "startContainerEarly">,
): Effect.Effect<void> =>
  Effect.tryPromise(() => workspace.startContainerEarly()).pipe(
    Effect.catch((error) => Effect.logWarning("The early start of the Container failed", error)),
  );
