// What `McpHost`'s methods do (`docs/architecture/mcp-connections.md` → The host object, RPC): take the Environment's MCP
// server set, and pull it from the Registry when a Context Window opens. Over `McpHostStore` and `McpRegistryPort`,
// so a workerd test drives them over real SQLite storage and a scripted Registry; the Durable Object (`McpHost.ts`)
// only gives them the object's own.
//
// Every edge only gains (`docs/architecture/mcp.md` → Deploys): an operation this build does not know fails as
// `HostUnsupported`, and a failure is a value, never a thrown error.
// @effect-diagnostics missingPipeableSignature:off -- methods of the object, not combinators.
import {
  HostFailed,
  HostUnsupported,
  MCP_HOST_FEATURES,
  McpApplied,
  type McpApply,
  type McpApplyResult,
  McpApplySet,
  type McpRequestStart,
  type McpRequestStartAnswer,
  type McpServerSetAnswer,
} from "@cloudpid/mcp/types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpHostStore, type McpHostStoreService } from "./store.ts";

/** The Registry could not be asked for the set (an RPC failure, or an answer this build cannot read). */
export class McpRegistryUnavailable extends Schema.TaggedError<
  McpRegistryUnavailable,
  { readonly brand: unique symbol }
>()("McpRegistryUnavailable", { message: Schema.String }) {}

export type McpRegistryPortService = {
  /**
   * The Environment's current set unless the host holds it (`heldHash`; undefined: it holds none, which is the empty
   * set), which runs the Registry's look at the Repos' `.pi/mcp.json` when it is due.
   */
  readonly serverSet: (input: {
    readonly environment: string;
    readonly heldHash: string | undefined;
  }) => Effect.Effect<McpServerSetAnswer, McpRegistryUnavailable>;
};

/** The Registry, as the host sees it: the Registry DO, or a fake. */
export class McpRegistryPort extends Context.Service<McpRegistryPort, McpRegistryPortService>()(
  "@cloudpid/server/mcp/host/McpRegistryPort",
) {}

const KindOnly = Schema.Struct({ kind: Schema.String });

const decodeKind = Schema.decodeUnknownOption(KindOnly);

const decodeSet = Schema.decodeUnknownOption(McpApplySet);

const applied = (set: McpApplySet, changed: boolean): McpApplied =>
  McpApplied.make({ hash: set.hash, changed });

/**
 * Keep `set` as the Environment's set. A set the host holds changes nothing, and neither does an empty one when it
 * holds none: it is never written for an Environment that never had a server.
 */
const applySet = (set: McpApplySet): Effect.Effect<McpApplied, never, McpHostStore> =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const held = store.heldHash();

    if (held === set.hash || (held === undefined && set.entries.length === 0)) {
      return applied(set, false);
    }

    yield* Effect.sync(() => store.replaceSet(set));

    return applied(set, true);
  });

/**
 * `apply`: the pushes and teardown. Only `set` exists so far; any other `kind` fails as `HostUnsupported`, never as
 * a decode error, so a newer caller's operation is refused loudly, and a `set` that is malformed as `HostFailed`.
 */
export const apply = (input: McpApply): Effect.Effect<McpApplyResult, never, McpHostStore> =>
  Effect.gen(function* () {
    const kind = decodeKind(input);

    if (Option.isNone(kind)) {
      return HostFailed.make({ message: "apply takes an object with a kind" });
    }

    if (kind.value.kind !== "set") {
      return HostUnsupported.make({
        message: `This host does not know apply ${kind.value.kind}`,
        op: kind.value.kind,
      });
    }

    const set = decodeSet(input);

    if (Option.isNone(set)) {
      return HostFailed.make({ message: "The MCP server set is malformed" });
    }

    return yield* applySet(set.value).pipe(
      Effect.catchCause(() => Effect.succeed(HostFailed.make({ message: "The set was not kept" }))),
    );
  });

/**
 * Ask the Registry for the set and keep it when it differs from the one held, so a push that was lost heals. A Registry
 * that cannot answer leaves the held set as it is: the next Context Window asks again. Logs no more than that it failed.
 */
const pull = (environment: string): Effect.Effect<void, never, McpHostStore | McpRegistryPort> =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const registry = yield* McpRegistryPort;
    const answer = yield* registry.serverSet({ environment, heldHash: store.heldHash() });

    if (answer.set !== undefined) {
      yield* applySet({ kind: "set", hash: answer.hash, entries: answer.set });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Environment ${environment}'s MCP server set was not pulled`, cause),
    ),
  );

/**
 * `requestStart`: marks the conversation active and says what the Session needs to build its tools. A Context Window's
 * first request (`windowOpened`) pulls the set first. The inventory is discovered later, so the answer has no servers
 * yet, and its `version` is the held set's hash, which changes with any change to the set; the features are those the
 * host lists, the ones a Session may use.
 */
export const requestStart = (
  environment: string | undefined,
  request: McpRequestStart,
): Effect.Effect<McpRequestStartAnswer, never, McpHostStore | McpRegistryPort> =>
  Effect.gen(function* () {
    // A host that no Environment names has none to ask the Registry about.
    if (request.windowOpened === true && environment !== undefined) yield* pull(environment);

    const store = yield* McpHostStore;

    return {
      version: store.heldHash() ?? "",
      promptsVersion: "",
      features: MCP_HOST_FEATURES,
      servers: {},
      watches: { changed: [], ended: [] },
    };
  });

/** What the host object answers over RPC. */
export type McpHostMethods = {
  /**
   * A Session's request starts (`docs/architecture/mcp-connections.md` → RPC). `windowOpened` makes the host ask the
   * Registry for the MCP server set.
   */
  readonly requestStart: (request: McpRequestStart) => Effect.Effect<McpRequestStartAnswer>;
  /** The pushes: the Environment's MCP server set. An operation this host does not know is `HostUnsupported`. */
  readonly apply: (input: McpApply) => Effect.Effect<McpApplyResult>;
};

/**
 * The methods of the host of `environment` over `store` and `registry`: one set of services, provided to each. A host
 * whose name is no `mcp:<environment>` has no Environment, and refuses with a failure.
 */
export const mcpHostMethods = (
  environment: string | undefined,
  store: McpHostStoreService,
  registry: McpRegistryPortService,
): McpHostMethods => {
  const provided = <A>(effect: Effect.Effect<A, never, McpHostStore | McpRegistryPort>) =>
    effect.pipe(
      Effect.provideService(McpHostStore, store),
      Effect.provideService(McpRegistryPort, registry),
    );

  return {
    requestStart: (request) => provided(requestStart(environment, request)),
    apply: (input) =>
      environment === undefined
        ? Effect.succeed(HostFailed.make({ message: "The MCP host's name is unknown" }))
        : provided(apply(input)),
  };
};
