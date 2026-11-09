// The upkeep that follows an Agent change once it is recorded (`docs/architecture/mcp-endpoint.md` → Environment and
// Settings tools → After a change, and Notifications; `docs/architecture/agent-changes.md` → Reverting), as after the
// owner's save: the Builds' (a Build is made with the Container settings, the variables and the Secrets marked for it),
// the spares' (the Spare Workspace setting and the Repos) and the McpHosts' (an MCP server's key). `upkeepFor` reads it
// off the changes' Scope and field, so the owner's revert (`rpc.ts`), the endpoint's dispatch (`harness/dispatch.ts`)
// and a `request_id` replayed from its records all run the same steps. Every step runs under `background` and never
// fails: what goes wrong is logged, and heals as after the owner's save.
// @effect-diagnostics missingPipeableSignature:off
import { isContainerField, parseMcpField, SPARE_WORKSPACE_FIELD } from "@cloudpid/config";
import { fieldRepo, fieldSecret, fieldSkill, fieldTrigger, GLOBAL_SCOPE } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { McpPushes } from "../mcp/push.ts";
import type { Builds } from "./builds.ts";
import type { RegistryMethods } from "./Registry.ts";
import type { Spares } from "./rpc.ts";

/**
 * What the upkeep runs over: the Environments to look at, each kind of upkeep, and where the steps run (`R`: what
 * `background` needs of the request).
 */
export type UpkeepDeps<R = never> = {
  readonly registry: Pick<RegistryMethods, "listEnvironments">;
  readonly builds: Pick<Builds, "of">;
  readonly spares: Pick<Spares, "of" | "all">;
  readonly mcp: Pick<McpPushes, "sync">;
  /** Runs `effect` after the answer, keeping the request alive until it is done. */
  readonly background: (effect: Effect.Effect<void>) => Effect.Effect<void, never, R>;
};

/** One recorded change, as the upkeep reads it: its Scope (an Environment's id, or `*`) and its field. */
export type UpkeepChange = {
  readonly scope: string;
  readonly field: string;
};

/**
 * After a Secret or a Container setting kept Global changed: each Environment's Build is looked at again (their key
 * covers the Secrets and settings a Build gets; one that overrides the setting keeps its key, and no Build is asked
 * for), and with `spareChanged`, a change of the Spare Workspace setting, each Environment's spare too.
 */
export const globalChanged = <R>(
  { registry, builds, spares, background }: UpkeepDeps<R>,
  spareChanged = false,
): Effect.Effect<void, never, R> =>
  (spareChanged ? background(spares.all) : Effect.void).pipe(
    Effect.andThen(registry.listEnvironments()),
    Effect.flatMap((all) =>
      Effect.forEach(all, (item) => background(builds.of(item.id)), { discard: true }),
    ),
  );

/**
 * After a kept Secret changed: the Builds it may reach are looked at again (their key covers the Secrets a Build gets),
 * each Environment's for one kept Global (null).
 */
export const secretChanged = <R>(
  deps: UpkeepDeps<R>,
  environment: string | null,
): Effect.Effect<void, never, R> =>
  environment === null ? globalChanged(deps) : deps.background(deps.builds.of(environment));

/**
 * The upkeep one recorded change calls for. A Skill is not part of a Build, and a Trigger's object is the revert's own
 * concern (it schedules, and may fail): neither runs anything here.
 */
const upkeepOf = <R>(
  deps: UpkeepDeps<R>,
  { scope, field }: UpkeepChange,
): Effect.Effect<void, never, R> => {
  if (fieldSkill(field) !== null || fieldTrigger(field) !== null) return Effect.void;

  // A Container setting at Global: as after the owner's save, each Environment's Build is looked at again (and its
  // spare, for the Spare Workspace setting).
  if (scope === GLOBAL_SCOPE && isContainerField(field)) {
    return globalChanged(deps, field === SPARE_WORKSPACE_FIELD);
  }

  // A Build mark: as after the owner's switch, the Builds the Secret may reach are looked at again, each Environment's
  // for one kept Global.
  if (fieldSecret(field) !== null) {
    return secretChanged(deps, scope === GLOBAL_SCOPE ? null : scope);
  }

  // An MCP server's key changes the Environment's set: its host is handed it, as after the owner's save.
  if (parseMcpField(field) !== null) return deps.background(deps.mcp.sync(scope));

  // As after the owner's save: the variables are among what a Build is made with. A Repo added or taken out also makes
  // the spare stale, as the owner's `addRepo` and `removeRepo` do, and the Spare Workspace setting keeps or removes it.
  return (
    fieldRepo(field) === null && field !== SPARE_WORKSPACE_FIELD
      ? Effect.void
      : deps.background(deps.spares.of(scope))
  ).pipe(Effect.andThen(deps.background(deps.builds.of(scope))));
};

/**
 * The upkeep `changes` call for, each change's once: what the owner's revert runs after its write, and what the endpoint
 * runs after a call that recorded them, or after an answer built from the records of an earlier call.
 */
export const upkeepFor = <R>(
  deps: UpkeepDeps<R>,
  changes: ReadonlyArray<UpkeepChange>,
): Effect.Effect<void, never, R> =>
  Effect.forEach(
    Arr.dedupeWith(changes, (a, b) => a.scope === b.scope && a.field === b.field),
    (change) => upkeepOf(deps, change),
    { discard: true },
  );
