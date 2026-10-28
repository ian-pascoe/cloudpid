// The Session's Subagent Workspaces (GLOSSARY.md → Subagent Workspace; `docs/architecture/agent-capabilities.md` → Subagents): the subagents
// extension's `SubagentWorkspaces`, over the Registry and the Workspace DOs. A Subagent Workspace is registered by the
// Registry as the Session's (`createSubagentWorkspace`, which takes the Environment's spare as a new Session's Workspace
// does, and counts it against the Subagent Workspace limit), readied by the Session when its subagent first works in it
// (`sessionWorkspace`), read for what it has not pushed (by its Workspace DO, or its Container), and removed as a
// Workspace is.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off
import type {
  AgentWorkspace,
  RepoWorkState,
  SubagentWorkspaceHost,
} from "@cloudpid/extensions/subagents";
import { ownBranchProblem } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { Builds } from "../registry/builds.ts";
import type { RegistryMethods } from "../registry/Registry.ts";
import type { Spares } from "../registry/rpc.ts";
import type { SubagentWorkspaceRefusal, WorkspaceRecord } from "../registry/store.ts";
import { workspaceObjectName } from "../workspace/binding.ts";
import type { WorkspaceObjects } from "../workspace/lifecycle.ts";
import type { Placement } from "./workspace.ts";

/** What the Subagent Workspaces use of the Registry. */
export type SubagentWorkspacesRegistry = Pick<
  RegistryMethods,
  "createSubagentWorkspace" | "getWorkspace"
>;

export type SessionSubagentWorkspacesOptions = {
  readonly registry: SubagentWorkspacesRegistry;
  /** The Session's id in the Registry; undefined when unknown, for a Session that then has none. */
  readonly session: string | undefined;
  /** Where the Session works: the Workspace a spawner without one of its own works in. */
  readonly placement: () => Promise<Placement>;
  /** What the Workspaces' clones have not pushed, read by their Workspace DOs (a Container only when it runs or must). */
  readonly objects: Pick<WorkspaceObjects, "workState">;
  /** Workspace removal of a Subagent Workspace: its object, then its record (`removals`). */
  readonly remove: (
    workspace: WorkspaceRecord,
  ) => Effect.Effect<void, { readonly message: string }>;
  /** The upkeep that makes the next spare behind a spare taken, and keeps the Build current. */
  readonly spares: Pick<Spares, "of">;
  readonly builds: Pick<Builds, "of">;
  /** Runs the Registry's calls: the Session's runtime. */
  readonly run: <A>(effect: Effect.Effect<A>) => Promise<A>;
};

/** Why a spawn with `workspace: "new"` was refused in a Session the Registry does not list. */
export const UNLISTED_REFUSAL =
  'This Session is not listed by the Registry, so a subagent cannot have a Workspace of its own here: start it with workspace "shared".';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Why the Registry refused a Subagent Workspace, for the model. */
export const refusalMessage = (
  refusal: SubagentWorkspaceRefusal,
  limit: number,
  branch: string | null,
): string => {
  switch (refusal.refused) {
    case "no-session":
      return UNLISTED_REFUSAL;
    case "limit":
      return `This Session has ${plural(refusal.count, "Subagent Workspace", "Subagent Workspaces")}, the Subagent Workspace limit (${limit}): delete one with subagent_delete, or ask for a higher limit with settings_subagent_workspaces_set.`;
    case "branch-taken":
      return `Workspace "${refusal.workspace}" is already on branch ${branch ?? ""}: name another branch.`;
  }
};

/**
 * What the spawner should know about its own Workspace at a spawn: work on `base` that has not reached the remote does
 * not reach the child either, since the child starts from the remote's `base` and nothing is copied across.
 */
export const spawnWarnings = (
  base: string,
  states: ReadonlyArray<RepoWorkState> | Error,
): string[] => {
  if (states instanceof Error) {
    return [
      `What your Workspace has not pushed could not be read (${states.message}): what is not pushed to ${base} does not reach the child.`,
    ];
  }

  const cloned: ReadonlyArray<RepoWorkState> = Arr.filter(states, (state) => state.cloned);

  return Arr.flatMap(cloned, (state: RepoWorkState): string[] => [
    ...(state.onRemote
      ? []
      : [
          `${state.repo}: origin has no branch ${base}, so the child's clone of it cannot start until you push ${base}.`,
        ]),
    ...(state.unpushed > 0
      ? [
          `${state.repo}: ${plural(state.unpushed, "commit", "commits")} on ${base} not pushed, which the child does not have.`,
        ]
      : []),
    ...(state.uncommitted > 0
      ? [
          `${state.repo}: ${plural(state.uncommitted, "uncommitted change", "uncommitted changes")} in your Workspace, which the child does not have.`,
        ]
      : []),
  ]);
};

/** A Subagent Workspace's record, as its subagent's record keeps it. */
export const agentWorkspace = (record: WorkspaceRecord): AgentWorkspace => ({
  id: record.id,
  branch: record.branch,
  object: workspaceObjectName(record.id),
  directory: record.directory,
});

/** `SubagentWorkspaces` of Session `session`. */
export const sessionSubagentWorkspaces = (
  options: SessionSubagentWorkspacesOptions,
): SubagentWorkspaceHost => {
  const { registry, session } = options;

  // A failure rejects with its message, which is what the model is shown.
  const run = <A>(effect: Effect.Effect<A, { readonly message: string }>): Promise<A> =>
    options.run(effect.pipe(Effect.catch((error) => Effect.die(new Error(error.message)))));

  /** The Workspace `id`'s record; a Workspace the Registry no longer lists fails with `gone`. */
  const recordOf = (id: string, gone: string) =>
    registry.getWorkspace({ id }).pipe(
      Effect.filterOrElse(
        (record): record is WorkspaceRecord => record !== null,
        () => Effect.die(new Error(gone)),
      ),
    );

  /** What `object`'s clones of `repos` have not pushed of `branch`, or the error the read failed with. */
  const readState = async (object: string, branch: string, repos: ReadonlyArray<string>) => {
    try {
      return await options.objects.workState(object, branch, repos);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };

  return {
    create: async ({ agent, parent, base, branch, limit }) => {
      if (session === undefined) throw new Error(UNLISTED_REFUSAL);

      const problem = branch === undefined ? undefined : ownBranchProblem(branch);

      if (problem !== undefined) throw new Error(problem);

      // The spawner's Workspace: its own Subagent Workspace, else the Session's.
      const placed = await options.placement();
      const from = parent?.id ?? placed.workspace;

      if (from === null) throw new Error(UNLISTED_REFUSAL);

      const spawner = await run(recordOf(from, "The Workspace you work in is no longer listed"));
      const start = base ?? spawner.branch;

      const created = await run(
        registry.createSubagentWorkspace({
          session,
          agent,
          branch: branch ?? null,
          base: start,
          limit,
        }),
      );

      if ("refused" in created) throw new Error(refusalMessage(created, limit, branch ?? null));

      // A spare taken leaves its Environment without one: the next is made ahead, as after a new Session.
      await run(
        Effect.all([
          options.spares.of(created.environment),
          options.builds.of(created.environment),
        ]),
      );

      const states = await readState(workspaceObjectName(spawner.id), start, spawner.repos);

      return { workspace: agentWorkspace(created), warnings: spawnWarnings(start, states) };
    },
    workState: async (workspace) => {
      const record = await run(
        recordOf(workspace.id, "The Subagent Workspace is no longer listed"),
      );

      return options.objects.workState(workspace.object, workspace.branch, record.repos);
    },
    remove: async (workspace) => {
      const record = await run(registry.getWorkspace({ id: workspace.id }));

      // Removed already (with its Session, or by the owner): nothing is left to remove.
      if (record === null) return;

      if (record.subagent?.session !== session) {
        throw new Error(`Workspace "${workspace.id}" is not a Subagent Workspace of this Session`);
      }

      await run(options.remove(record));
    },
  };
};
