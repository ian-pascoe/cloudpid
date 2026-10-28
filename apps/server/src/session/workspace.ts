// A Session's Workspace (`docs/architecture/workspace.md` → Filesystem and tools, ADR-0001, ADR-0016): its conversations' execution
// environment is a `ComputerExecutionEnv` over the Workspace's own Durable Object (`workspaceObjectName`), and `ls`,
// `find`, and `grep` search the same Workspace's files. Every Session in a Workspace reaches the same DO, so they share
// one tree and one Container. A Session works in its Workspace's directory (its one repo's clone, or `/workspace`) unless
// a conversation names another `cwd`, once the Workspace is readied: its Repos cloned on its branch (`prepare.ts`). A
// conversation with a Subagent Workspace (its agent's own, or its nearest ancestor's) works in that one instead, as the
// Subagents document records it (ADR-0021).
// @effect-diagnostics asyncFunction:off globalDate:off missingPipeableSignature:off
import type { ComputerWorkspaceStub } from "@cloudpid/computer-env";
import type { ContainerControl } from "@cloudpid/extensions/container";
import type { ConversationTarget, FileSearch } from "@cloudpid/extensions/files";
import {
  type AgentWorkspace,
  conversationWorkspace,
  SubagentsDoc,
} from "@cloudpid/extensions/subagents";
import type { Context } from "@earendil-works/chord/context";
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
      | "skillSetHash"
      | "updateSkills"
      | "containerUsage"
      | "noteSessionActivity"
      | "containerHeldStops"
      | "changes"
      | "changeFile"
      | "comparisonSources"
      | "compare"
      | "comparisonFile"
      | "runStart"
      | "runEnd"
      | "runDiff"
      | "runFile"
      | "stopContainer"
      | "resizeContainer"
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

/** Where a conversation with a Subagent Workspace of its own works: that Workspace (`AgentWorkspace`). */
export const subagentPlacement = (workspace: AgentWorkspace): Placement => ({
  workspace: workspace.id,
  object: workspace.object,
  directory: workspace.directory,
});

/** How long a Workspace readied counts as ready before it is readied again, in milliseconds. */
export const WORKSPACE_CHECKED_FOR = 60_000;

/** Ready Workspace `id`: its settings, Build and Secrets handed over, then its Repos cloned (`prepareWorkspace`). */
export type PrepareWorkspace = (id: string) => Promise<void>;

/** How Workspaces are readied, and the clock their readiness is counted by. */
export type ReadinessOptions = {
  readonly prepare: PrepareWorkspace;
  /** The time in milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
};

/**
 * Ready a Workspace before it is worked in: when it is first used, and again at most every `WORKSPACE_CHECKED_FOR`, so
 * a Repo whose clone failed is tried again and changed settings reach the Workspace. Each Workspace (the Session's, and
 * each Subagent Workspace) is counted apart; callers meanwhile wait for its one readying in flight. One that fails
 * fails the call and is tried again at the next.
 */
export const workspaceReadiness = ({
  prepare,
  now = Date.now,
}: ReadinessOptions): ((workspace: string) => Promise<void>) => {
  const checkedAt = new Map<string, number>();
  const checking = new Map<string, Promise<void>>();

  return (workspace) => {
    const checked = checkedAt.get(workspace);

    if (checked !== undefined && now() - checked < WORKSPACE_CHECKED_FOR) return Promise.resolve();

    const inFlight =
      checking.get(workspace) ??
      prepare(workspace)
        .then(() => {
          checkedAt.set(workspace, now());
        })
        .finally(() => {
          checking.delete(workspace);
        });

    checking.set(workspace, inFlight);

    return inFlight;
  };
};

/** What `readyPlacement` checks: where the Session works, and how its Workspace is readied. */
export type ReadyPlacementOptions = ReadinessOptions & {
  readonly placement: () => Promise<Placement>;
};

/** The Session's placement once its Workspace is ready (`workspaceReadiness`). */
export const readyPlacement = ({
  placement,
  ...readiness
}: ReadyPlacementOptions): (() => Promise<Placement>) => {
  const ready = workspaceReadiness(readiness);

  return async () => {
    const placed = await placement();

    if (placed.workspace !== null) await ready(placed.workspace);

    return placed;
  };
};

export type SessionWorkspaceOptions = {
  readonly namespace: WorkspaceNamespace;
  /** The Workspace the Session is bound to. Called at each use, so it may look it up. */
  readonly placement: () => Promise<Placement>;
  /** Readies a Workspace (the Session's, or a Subagent Workspace) before its files are used. */
  readonly prepare: PrepareWorkspace;
  /** The time in milliseconds, for the readiness; defaults to `Date.now`. */
  readonly now?: () => number;
};

/** A conversation, with what reads the Subagents document that says where it works. */
type Conversation = Pick<ConversationTarget, "conversationId" | "read">;

/** What a Session runs its tools on: each conversation's on its Subagent Workspace if it has one, else the Session's. */
export type SessionWorkspace = {
  /** `HarnessOptions.env`: a conversation's environment, in its `cwd` or in its Workspace's directory. */
  readonly env: NonNullable<HarnessOptions["env"]>;
  /**
   * A conversation's environment for the composer's lookups (its catalog of Skills and Prompt templates, its `@` menu),
   * as `env` but without readying the Workspace first: lookups only read files, so they never wait for the clones and
   * their Setup Scripts, which can take minutes on a Container that has to start first.
   */
  readonly lookupEnv: NonNullable<HarnessOptions["env"]>;
  /** A conversation's Workspace's file search, for `ls`, `find`, and `grep`. */
  readonly files: (target: ConversationTarget) => FileSearch;
  /**
   * The Workspace's Container, for `container_restart` and `container_resize`. It does not ready the Workspace first:
   * readying may need the Container, which is what a restart is for when it no longer answers. A resize is decided by
   * the Environment's settings as the Workspace DO last had them handed over (at most a minute old while the Session
   * works), as its launches are.
   */
  readonly container: ContainerControl;
};

export const sessionWorkspace = (options: SessionWorkspaceOptions): SessionWorkspace => {
  const readiness = workspaceReadiness(options);

  /**
   * Where `conversation` works: its Subagent Workspace (its own, or the nearest ancestor's), as the Subagents document
   * records it, so it survives an eviction; else the Session's.
   */
  const placementOf = async (conversation: Conversation, context: Context): Promise<Placement> => {
    const state = await conversation.read.snapshot(SubagentsDoc, context);

    const own =
      state === undefined ? undefined : conversationWorkspace(state, conversation.conversationId);

    return own === undefined ? options.placement() : subagentPlacement(own);
  };

  /** Where `conversation` works, once that Workspace is ready. */
  const ready = async (conversation: Conversation, context: Context): Promise<Placement> => {
    const placed = await placementOf(conversation, context);

    if (placed.workspace !== null) await readiness(placed.workspace);

    return placed;
  };

  const files = (target: ConversationTarget): FileSearch => {
    const search = async () => {
      const { ComputerFiles } = await computer();

      // The model's `ls`, `find` and `grep`: a search of a Container-only path runs on the Container (ADR-0018).
      return new ComputerFiles(
        options.namespace.getByName((await ready(target, target.context)).object),
        { reachContainer: true },
      );
    };

    return {
      readdir: async (path) => (await search()).readdir(path),
      find: async (directory, pattern, found) => (await search()).find(directory, pattern, found),
      grep: async (pattern, path, matched) => (await search()).grep(pattern, path, matched),
    };
  };

  /** An environment in `cwd`; with `reachContainer`, its file operations on Container-only paths run on the Container. */
  const envIn = async (placed: Placement, cwd: string, reachContainer: boolean) => {
    const { ComputerExecutionEnv } = await computer();

    return new ComputerExecutionEnv({
      workspace: options.namespace.getByName(placed.object),
      // Environments with equal ids see the same files: one per Workspace.
      id: `computer:${placed.object}`,
      cwd,
      reachContainer,
    });
  };

  // A conversation's Container: a child's restart or resize stops only its own Subagent Workspace's.
  const container: ContainerControl = {
    restart: async ({ fresh, target }) => {
      const placed = await placementOf(target, target.context);

      return options.namespace.getByName(placed.object).stopContainer({ forgetSnapshot: fresh });
    },
    resize: async ({ size, target }) => {
      const placed = await placementOf(target, target.context);

      return options.namespace.getByName(placed.object).resizeContainer({ size });
    },
  };

  return {
    env: async (target, context) => {
      const placed = await ready(target, context);

      // A conversation's own `cwd` first, then its Workspace's directory. The model's tools run on it, so a file of
      // theirs on a Container-only path is reached through the Container (ADR-0018).
      return envIn(placed, target.cwd ?? placed.directory, true);
    },
    // Lookups never start the Container: they see the Workspace's files only.
    lookupEnv: async (target, context) => {
      const placed = await placementOf(target, context);

      return envIn(placed, target.cwd ?? placed.directory, false);
    },
    files,
    container,
  };
};
