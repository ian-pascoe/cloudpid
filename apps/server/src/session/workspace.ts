// A Session's Workspace (`docs/spec.md` → Filesystem and tools, ADR-0001, ADR-0016): its conversations' execution
// environment is a `ComputerExecutionEnv` over the Workspace's own Durable Object (`workspaceObjectName`), and `ls`,
// `find`, and `grep` search the same Workspace's files. Every Session in a Workspace reaches the same DO, so they share
// one tree and one Container. A Session works in its Workspace's directory (its one repo's clone, or `/workspace`) unless
// a conversation names another `cwd`, once the Workspace is readied: its Repos cloned on its branch (`prepare.ts`).
// @effect-diagnostics asyncFunction:off globalDate:off missingPipeableSignature:off
import type { ComputerWorkspaceStub } from "@cloudpid/computer-env";
import type { FileSearch } from "@cloudpid/extensions/files";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
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
      | "startContainerEarly"
      | "containerSettings"
      | "updateContainerSettings"
      | "environmentBuild"
      | "updateEnvironmentBuild"
      | "updateEnvironmentSecrets"
      | "environmentSecretsUnavailable"
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

/**
 * Ready Workspace `id`: its settings, Build and Secrets handed over, then its Repos cloned (`prepareWorkspace`).
 * `handedOver` is called once the hand-over is done, before the clones; a readying that resolves without calling it had
 * nothing to hand over.
 */
export type PrepareWorkspace = (id: string, handedOver: () => void) => Promise<void>;

/** What `readyPlacement` checks: where the Session works, and how its Workspace is readied. */
export type ReadyPlacementOptions = {
  readonly placement: () => Promise<Placement>;
  readonly prepare: PrepareWorkspace;
  /** The time in milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
};

/** The Session's placement once its Workspace is readied (`ready`), or once only its set-up is handed over (`handedOver`). */
export type ReadyPlacement = {
  /**
   * The placement once the Workspace is ready: readied when the Session first works in it, and again at most every
   * `WORKSPACE_CHECKED_FOR`, so a Repo whose clone failed is tried again and changed settings reach the Workspace.
   * Callers meanwhile wait for the one readying in flight. One that fails fails the call and is tried again at the next.
   */
  readonly ready: () => Promise<Placement>;
  /**
   * The placement once a readying has handed the Workspace its settings, Build and Secrets, which needs no Container:
   * at once when one of this Session's readyings has done so before, else once the readying in flight (begun here if
   * there is none) has, without waiting for its clones. It fails when that readying fails before the hand-over.
   */
  readonly handedOver: () => Promise<Placement>;
};

export const readyPlacement = ({
  placement,
  prepare,
  now = Date.now,
}: ReadyPlacementOptions): ReadyPlacement => {
  let checkedAt: number | undefined;
  // Whether a readying of this Session has handed the Workspace its set-up: a later change waits for the next readying.
  let handed = false;
  let checking: { readonly done: Promise<void>; readonly handedOver: Promise<void> } | undefined;

  const readying = (workspace: string) => {
    if (checking !== undefined) return checking;

    const { promise: handedOver, resolve } = Promise.withResolvers<void>();

    const signal = () => {
      handed = true;
      resolve();
    };

    const done = prepare(workspace, () => {
      signal();
    })
      .then(() => {
        signal();
        checkedAt = now();
      })
      .finally(() => {
        checking = undefined;
      });

    // A readying that fails before its hand-over fails the wait for it, which only the early start makes: the failure
    // is `done`'s, which every other caller gets.
    const waited = Promise.race([handedOver, done]);

    waited.catch(() => undefined);
    checking = { done, handedOver: waited };

    return checking;
  };

  return {
    ready: async () => {
      const placed = await placement();
      const { workspace } = placed;

      if (workspace === null) return placed;

      if (checkedAt !== undefined && now() - checkedAt < WORKSPACE_CHECKED_FOR) return placed;

      await readying(workspace).done;

      return placed;
    },
    handedOver: async () => {
      const placed = await placement();
      const { workspace } = placed;

      if (workspace === null || handed) return placed;

      await readying(workspace).handedOver;

      return placed;
    },
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
   * Ask the Workspace for the early start of its Container, for a message the owner sent (docs/spec.md → Backends), once
   * the readying has handed the Workspace its settings, Build and Secrets (`ReadyPlacement.handedOver`). It answers once
   * the Workspace has the request, not once the Container is up. It fails when the hand-over does.
   */
  readonly startContainerEarly: () => Promise<void>;
};

export const sessionWorkspace = (options: SessionWorkspaceOptions): SessionWorkspace => {
  const { ready, handedOver } = readyPlacement(options);

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
    startContainerEarly: async () => {
      // A Container launched before the hand-over would start with the default settings, no variables or Environment
      // scripts and no Build: the hand-over needs no Container, so it comes first.
      const placed = await handedOver();

      await options.namespace.getByName(placed.object).startContainerEarly();
      // The rest of the readying (the clones) goes on meanwhile: the turn's first use waits for this same readying, and
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
