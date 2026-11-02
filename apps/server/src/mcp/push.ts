// The main Worker's push of the MCP server set to an Environment's host (`docs/architecture/mcp-configuration.md` → From
// the Registry to the host): after a save at either Scope, `addRepo`, `removeRepo` or an Environment's deletion, it asks
// the Registry which sets differ from what each host was last handed, and which deleted Environments' hosts are to be
// wiped (`mcpPending`), and calls `McpHost.apply({ kind: "set" })` or `apply({ kind: "destroy" })` on the host's RPC
// stub. A set is recorded as told (`mcpPushed`, with its revision) only once its host took it, so a push that failed is
// made again by the next one, and a host that never answers is healed at the next `windowOpened`; a wipe is recorded
// (`mcpDestroyed`) only once done. The Registry never calls out; a push never fails the save that caused it
// (`docs/architecture/mcp.md` → Deploys: a loud failure that heals).
import { type McpApplyResult, type McpPush, readMcpApplyResult } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { McpHostMethods } from "./host.ts";
import { mcpHostName } from "./name.ts";
import type { RegistryMethods } from "../registry/Registry.ts";

/** The Registry's methods a push uses, on its object. */
type PushRegistry = Pick<RegistryMethods, "mcpPending" | "mcpPushed" | "mcpDestroyed">;

/** The Registry object and the host objects, by name, as the main Worker reaches them. */
export type McpPushObjects = {
  readonly registry: () => PushRegistry;
  readonly host: (name: string) => Pick<McpHostMethods, "apply">;
};

/** What a push does for the owner's saves. It never fails: what goes wrong is logged. */
export type McpPushes = {
  /** Push the set of `environment` (every Environment's when undefined) if its hash changed, and wipe deleted hosts. */
  readonly sync: (environment: string | undefined) => Effect.Effect<void>;
};

/** Why a push did not reach its host, for the log: tags and messages only, never a set. */
const failureText = (result: McpApplyResult): string =>
  Predicate.isTagged(result, "HostFailed") || Predicate.isTagged(result, "HostUnsupported")
    ? `${result._tag}: ${result.message}`
    : result._tag;

/**
 * Push one set, and note it as told once the host took it. A host that refused it as `Stale` holds a later set, which
 * the Registry has recorded already (it handed that one out later): nothing is noted, and nothing is wrong.
 */
const pushOne = (objects: McpPushObjects, { environment, set }: McpPush): Effect.Effect<void> =>
  Effect.gen(function* () {
    const answer = yield* objects.host(mcpHostName(environment)).apply(set);
    const result = readMcpApplyResult(answer);

    if (Predicate.isTagged(result, "Applied")) {
      return yield* objects
        .registry()
        .mcpPushed({ environment, hash: result.hash, revision: set.revision });
    }

    if (Predicate.isTagged(result, "Stale") || Predicate.isTagged(result, "Destroyed")) return;

    yield* Effect.logWarning(
      `Environment ${environment}'s MCP host did not take its server set (${failureText(result)})`,
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Environment ${environment}'s MCP server set was not pushed`, cause),
    ),
  );

/** Wipe the host of a deleted Environment, and note it done once the host answered. */
const destroyOne = (objects: McpPushObjects, environment: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const answer = yield* objects.host(mcpHostName(environment)).apply({ kind: "destroy" });
    const result = readMcpApplyResult(answer);

    if (Predicate.isTagged(result, "Destroyed")) {
      return yield* objects.registry().mcpDestroyed({ environment });
    }

    yield* Effect.logWarning(
      `Environment ${environment}'s MCP host was not wiped (${failureText(result)})`,
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Environment ${environment}'s MCP host was not wiped`, cause),
    ),
  );

/** The pushes of the owner's saves, over the Registry and host objects. */
export const mcpPushes = (objects: McpPushObjects): McpPushes => ({
  sync: (environment) =>
    objects
      .registry()
      .mcpPending({ environment })
      .pipe(
        Effect.flatMap(({ pushes, destroys }) =>
          Effect.forEach(Arr.fromIterable(pushes), (push) => pushOne(objects, push), {
            discard: true,
          }).pipe(
            Effect.andThen(
              Effect.forEach(Arr.fromIterable(destroys), (id) => destroyOne(objects, id), {
                discard: true,
              }),
            ),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("The MCP server sets to push could not be read", cause),
        ),
      ),
});
