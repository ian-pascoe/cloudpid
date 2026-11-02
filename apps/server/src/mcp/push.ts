// The main Worker's push of the MCP server set to an Environment's host (`docs/architecture/mcp-configuration.md` → From
// the Registry to the host): after a save at either Scope, `addRepo` or `removeRepo`, it asks the Registry which sets
// differ from what each host was last told (`mcpPending`) and calls `McpHost.apply({ kind: "set" })` on the host's RPC
// stub. A set is recorded as told (`mcpPushed`) only once its host answered, so a push that failed is made again by the
// next one, and a host that never answers is healed at the next `windowOpened`. The Registry never calls out; a push
// never fails the save that caused it (`docs/architecture/mcp.md` → Deploys: a loud failure that heals).
import {
  type McpApplied,
  type McpApplyResult,
  type McpApplySet,
  type McpPush,
  readMcpApplyResult,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { McpHostMethods } from "./host.ts";
import { mcpHostName } from "./name.ts";
import type { RegistryMethods } from "../registry/Registry.ts";

/** The Registry's methods a push uses, on its object. */
type PushRegistry = Pick<RegistryMethods, "mcpPending" | "mcpPushed">;

/** The Registry object and the host objects, by name, as the main Worker reaches them. */
export type McpPushObjects = {
  readonly registry: () => PushRegistry;
  readonly host: (name: string) => Pick<McpHostMethods, "apply">;
};

/** What a push does for the owner's saves. It never fails: what goes wrong is logged. */
export type McpPushes = {
  /** Push the set of `environment` (every Environment's when undefined) if its hash changed. */
  readonly sync: (environment: string | undefined) => Effect.Effect<void>;
};

/** Why a push did not reach its host, for the log: tags and messages only, never a set. */
const failureText = (result: Exclude<McpApplyResult, McpApplied>): string =>
  `${result._tag}: ${result.message}`;

/** Push one set, and note it as told once the host took it. */
const pushOne = (objects: McpPushObjects, { environment, set }: McpPush): Effect.Effect<void> =>
  Effect.gen(function* () {
    const sent: McpApplySet = set;
    const answer = yield* objects.host(mcpHostName(environment)).apply(sent);
    const result = readMcpApplyResult(answer);

    if (!Predicate.isTagged(result, "Applied")) {
      return yield* Effect.logWarning(
        `Environment ${environment}'s MCP host did not take its server set (${failureText(result)})`,
      );
    }

    yield* objects.registry().mcpPushed({ environment, hash: result.hash });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Environment ${environment}'s MCP server set was not pushed`, cause),
    ),
  );

/** The pushes of the owner's saves, over the Registry and host objects. */
export const mcpPushes = (objects: McpPushObjects): McpPushes => ({
  sync: (environment) =>
    objects
      .registry()
      .mcpPending({ environment })
      .pipe(
        Effect.flatMap((pending) =>
          Effect.forEach(Arr.fromIterable(pending), (push) => pushOne(objects, push), {
            discard: true,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("The MCP server sets to push could not be read", cause),
        ),
      ),
});
