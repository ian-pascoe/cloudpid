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
  McpApplyDestroy,
  McpApplySet,
  McpDestroyed,
  type McpRequestStart,
  type McpRequestStartAnswer,
  type McpServerSetAnswer,
  McpStale,
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

const decodeDestroy = Schema.decodeUnknownOption(McpApplyDestroy);

const applied = (set: McpApplySet, changed: boolean): McpApplied =>
  McpApplied.make({ hash: set.hash, changed });

/**
 * Keep `set` as the Environment's set unless the host holds a later one: a set with a revision below the held one is
 * `Stale`, and the held set stays; so is any set no newer than the revision a wiped host was wiped at, which a push or
 * a pull answered after the wipe cannot fill again (`Stale` with no hash). The same hash under a newer revision only
 * moves the revision up. An empty set is kept like any other, so a host emptied of its servers holds the empty set,
 * not the one before.
 */
const applySet = (set: McpApplySet): Effect.Effect<McpApplied | McpStale, never, McpHostStore> =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const held = store.held();
    const wiped = store.wipedAt();

    if (held !== undefined && set.revision < held.revision) {
      return McpStale.make(held);
    }

    if (held === undefined && wiped !== undefined && set.revision <= wiped) {
      return McpStale.make({ hash: "", revision: wiped });
    }

    if (held?.hash === set.hash) {
      if (set.revision > held.revision) yield* Effect.sync(() => store.setRevision(set.revision));

      return applied(set, false);
    }

    yield* Effect.sync(() => store.replaceSet(set));

    return applied(set, true);
  });

/**
 * Wipe the storage, keeping the revision of the deletion (or the held set's when it is later) as the floor of what may
 * fill it again. A wipe the storage refuses is `HostFailed`: the Registry still has it to send.
 */
const destroy = (input: McpApply): Effect.Effect<McpApplyResult, never, McpHostStore> =>
  Effect.gen(function* () {
    const store = yield* McpHostStore;
    const wanted = decodeDestroy(input);

    if (Option.isNone(wanted)) {
      return HostFailed.make({ message: "The destroy has no revision" });
    }

    const revision = Math.max(
      wanted.value.revision,
      store.held()?.revision ?? 0,
      store.wipedAt() ?? 0,
    );

    yield* Effect.promise(() => store.destroy(revision));

    return McpDestroyed.make({});
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(HostFailed.make({ message: "The storage was not wiped" })),
    ),
  );

/**
 * `apply`: the pushes and teardown. `set` keeps the Environment's set and `destroy` wipes the storage; any other
 * `kind` fails as `HostUnsupported`, never as a decode error, so a newer caller's operation is refused loudly, and a
 * `set` that is malformed as `HostFailed`.
 */
export const apply = (input: McpApply): Effect.Effect<McpApplyResult, never, McpHostStore> =>
  Effect.gen(function* () {
    const kind = decodeKind(input);

    if (Option.isNone(kind)) {
      return HostFailed.make({ message: "apply takes an object with a kind" });
    }

    if (kind.value.kind === "destroy") {
      return yield* destroy(input);
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
    const answer = yield* registry.serverSet({ environment, heldHash: store.held()?.hash });

    const { revision } = answer;

    if (revision === undefined) return;

    const held = store.held();

    if (answer.set !== undefined) {
      yield* applySet({
        kind: "set",
        hash: answer.hash,
        revision,
        entries: answer.set,
      });
    } else if (held === undefined) {
      // The Registry noted the empty set as handed under this revision, which a push of an older set must not undo.
      yield* applySet({ kind: "set", hash: answer.hash, revision, entries: [] });
    } else if (held.hash === answer.hash) {
      // The Registry noted the set the host holds as handed under this revision: so does the host.
      yield* Effect.sync(() => {
        if (revision > held.revision) store.setRevision(revision);
      });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Environment ${environment}'s MCP server set was not pulled`, cause),
    ),
  );

/**
 * `requestStart`: marks the conversation active and says what the Session needs to build its tools. A Context Window's
 * first request (`windowOpened`) pulls the set first. The inventory is discovered later, so the answer has no servers
 * yet, and its `version` is the held set's hash, which changes with any change to the set (a placeholder until the
 * inventory's own version, #449); the features are those the host lists, the ones a Session may use. The Registry is
 * asked only here and never at the host's start: a host that no Session wakes holds the set it was last pushed, and
 * `windowOpened` heals what a lost push left.
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
      version: store.held()?.hash ?? "",
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
