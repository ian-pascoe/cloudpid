// What the main Worker answers the client about an Environment's MCP servers (`docs/architecture/mcp-connections.md` →
// Telemetry; #382 D12.3): `mcpServers`, `mcpServerLog` and `mcpReconnect` of `RegistryRpcs`, over the host objects. The
// Registry says which servers an Environment has first, so an Environment with none never wakes its host, and a name the
// set does not hold never reaches it. The host answers from its own storage (`serverLog` starts no Container, and neither
// does this); the main Worker adds each tool's Exposure with the pure resolver of `@cloudpid/config`.
//
// Every answer has a fallback: a host that fails, or answers with a tag or shape this build does not know, is
// `Unavailable` (`docs/architecture/mcp.md` → Deploys), whose message never carries the cause.
// @effect-diagnostics missingPipeableSignature:off -- operations over plain values, not combinators.
import {
  MCP_EXPOSURES,
  type McpExposure,
  type McpExposureKeys,
  resolveExposure,
} from "@cloudpid/config";
import {
  readMcpApplyResult,
  McpServerLogResult,
  McpServersResult,
  type McpServerInventory,
} from "@cloudpid/mcp/types";
import {
  McpNoEnvironment,
  McpReconnecting,
  McpServerLogEntries,
  McpServerMissing,
  McpServersList,
  McpUnavailable,
  type McpReconnectView,
  type McpServerLogView,
  type McpServersView,
  type McpServerView,
  type McpToolView,
  type McpPromptView,
  readMcpServerState,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import type { RegistryMethods } from "../registry/Registry.ts";
import type { McpHostMethods } from "./host.ts";
import { mcpHostName } from "./name.ts";

/** The Registry's method a status read uses, on its object. */
type StatusRegistry = Pick<RegistryMethods, "mcpServerNames">;

/** The Registry object and the host objects, by name, as the main Worker reaches them. */
export type McpStatusObjects = {
  readonly registry: () => StatusRegistry;
  readonly host: (name: string) => Pick<McpHostMethods, "servers" | "serverLog" | "apply">;
};

/** The client's MCP status reads. Each answers a value, never fails. */
export type McpStatus = {
  readonly servers: (environment: string) => Effect.Effect<McpServersView>;
  readonly serverLog: (input: {
    readonly environment: string;
    readonly server: string;
    readonly workspace?: string | undefined;
  }) => Effect.Effect<McpServerLogView>;
  readonly reconnect: (input: {
    readonly environment: string;
    readonly servers?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<McpReconnectView>;
};

const unavailable = (message: string) => McpUnavailable.make({ message });

const NO_HOST = "The MCP host did not answer";

const COULD_NOT_ANSWER = "The MCP host could not answer";

const NOT_KNOWN = "The MCP host answered with something this build does not know";

const decodeServers = Schema.decodeUnknownOption(McpServersResult);

const decodeLog = Schema.decodeUnknownOption(McpServerLogResult);

const ToolFields = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
});

const decodeTool = Schema.decodeUnknownOption(ToolFields);

const Exposure = Schema.Literals(MCP_EXPOSURES);

const ExposureKeys = Schema.Struct({
  exposure: Schema.optionalKey(Exposure),
  toolExposure: Schema.optionalKey(Schema.Record(Schema.String, Exposure)),
});

const decodeKeys = Schema.decodeUnknownOption(ExposureKeys);

/** The default `exposure` of an entry in force: the set carries it, so only an entry this build cannot read falls back. */
const DEFAULT_EXPOSURE: McpExposure = "codemode";

/** The keys of `server`, the entry in force, that decide Exposure. */
const exposureKeysOf = (server: McpServerInventory["server"]): McpExposureKeys => {
  const keys = Option.getOrElse(decodeKeys(server), (): typeof ExposureKeys.Type => ({}));

  return { exposure: keys.exposure ?? DEFAULT_EXPOSURE, toolExposure: keys.toolExposure ?? {} };
};

const toolViews = (inventory: McpServerInventory): ReadonlyArray<McpToolView> => {
  const keys = exposureKeysOf(inventory.server);

  return Arr.filterMap(inventory.tools ?? [], (raw) =>
    Option.match(decodeTool(raw), {
      onNone: () => Result.failVoid,
      onSome: (tool) =>
        Result.succeed({
          ...tool,
          exposure: resolveExposure({ server: keys, tool: tool.name }).exposure,
        }),
    }),
  );
};

const promptViews = (inventory: McpServerInventory): ReadonlyArray<McpPromptView> =>
  Arr.filterMap(inventory.prompts ?? [], (raw) =>
    Option.match(decodeTool(raw), { onNone: () => Result.failVoid, onSome: Result.succeed }),
  );

/** One server as the client reads it: no entry (its `${NAME}` references and URL stay with the host), no hashes. */
const serverView = (inventory: McpServerInventory): McpServerView => {
  const view: Mutable<McpServerView> = {
    name: inventory.name,
    source: inventory.source,
    state: readMcpServerState(inventory.state),
    counts: inventory.counts,
    resources: inventory.resources,
    problems: inventory.problems,
    tools: toolViews(inventory),
    prompts: promptViews(inventory),
  };

  if (inventory.error !== undefined) view.error = inventory.error;

  if (inventory.protocolVersion !== undefined) view.protocolVersion = inventory.protocolVersion;

  if (inventory.discoveredAt !== undefined) view.discoveredAt = inventory.discoveredAt;

  if (inventory.status !== undefined) view.status = inventory.status;

  return view;
};

/** The names of `environment`'s servers, or why there are none to ask about. */
const namesOf = (objects: McpStatusObjects, environment: string) =>
  objects
    .registry()
    .mcpServerNames({ environment })
    .pipe(
      Effect.map((names) => Option.fromNullishOr(names)),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Environment ${environment}'s MCP servers could not be listed`,
          cause,
        ).pipe(Effect.as(undefined)),
      ),
    );

/** The MCP status reads over `objects`. */
export const mcpStatus = (objects: McpStatusObjects): McpStatus => {
  /** Run `read` against the host of `environment` once the Registry says it has servers; `empty` answers one with none. */
  const withHost = <A>(
    environment: string,
    names: ReadonlyArray<string>,
    read: () => Effect.Effect<A>,
    empty: A,
  ) => (names.length === 0 ? Effect.succeed(empty) : read());

  return {
    servers: (environment) =>
      Effect.gen(function* () {
        const names = yield* namesOf(objects, environment);

        if (names === undefined) return unavailable("The MCP servers could not be listed");

        if (Option.isNone(names)) return McpNoEnvironment.make({});

        return yield* withHost(
          environment,
          names.value,
          () =>
            objects
              .host(mcpHostName(environment))
              .servers({ parts: ["tools", "prompts", "status"] })
              .pipe(
                Effect.map((answer): McpServersView => {
                  const decoded = decodeServers(answer);

                  if (Option.isNone(decoded)) return unavailable(NOT_KNOWN);

                  if (Predicate.isTagged(decoded.value, "HostFailed")) {
                    return unavailable(COULD_NOT_ANSWER);
                  }

                  return McpServersList.make({
                    version: decoded.value.version,
                    servers: Arr.map(decoded.value.servers, serverView),
                  });
                }),
              ),
          McpServersList.make({ version: "", servers: [] }),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Environment ${environment}'s MCP servers were not read`, cause).pipe(
            Effect.as(unavailable(NO_HOST)),
          ),
        ),
      ),

    serverLog: ({ environment, server, workspace }) =>
      Effect.gen(function* () {
        const names = yield* namesOf(objects, environment);

        if (names === undefined) return unavailable("The MCP servers could not be listed");

        if (Option.isNone(names)) return McpNoEnvironment.make({});

        // A name the set does not hold never wakes the host.
        if (!Arr.contains(names.value, server)) return McpServerMissing.make({});

        const answer = yield* objects
          .host(mcpHostName(environment))
          .serverLog(workspace === undefined ? { server } : { server, workspace });

        const decoded = decodeLog(answer);

        if (Option.isNone(decoded)) return unavailable(NOT_KNOWN);

        const log = decoded.value;

        return Match.value(log).pipe(
          Match.tagsExhaustive({
            NoServer: () => McpServerMissing.make({}),
            HostFailed: () => unavailable(COULD_NOT_ANSWER),
            ServerLog: (found) => {
              const view: Mutable<McpServerLogEntries> = McpServerLogEntries.make({
                entries: found.entries,
              });

              if (found.stderr !== undefined) view.stderr = found.stderr;

              return view;
            },
          }),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Environment ${environment}'s MCP server log was not read`, cause).pipe(
            Effect.as(unavailable(NO_HOST)),
          ),
        ),
      ),

    reconnect: ({ environment, servers }) =>
      Effect.gen(function* () {
        const names = yield* namesOf(objects, environment);

        if (names === undefined) return unavailable("The MCP servers could not be listed");

        if (Option.isNone(names)) return McpNoEnvironment.make({});

        const wanted = servers === undefined ? names.value : Arr.intersection(servers, names.value);

        if (wanted.length === 0) return McpReconnecting.make({ servers: [] });

        const answer = readMcpApplyResult(
          yield* objects
            .host(mcpHostName(environment))
            .apply({ kind: "reload", servers: Arr.fromIterable(wanted) }),
        );

        return Predicate.isTagged(answer, "Reloaded")
          ? McpReconnecting.make({ servers: answer.servers })
          : unavailable(COULD_NOT_ANSWER);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Environment ${environment}'s MCP reconnect was not sent`, cause).pipe(
            Effect.as(unavailable(NO_HOST)),
          ),
        ),
      ),
  };
};
