// What the main Worker answers the client about an Environment's MCP servers (`docs/architecture/mcp-connections.md` →
// Telemetry; #382 D12.3): `mcpServers`, `mcpServerLog` and `mcpReconnect` of `RegistryRpcs`, over the host objects. The
// Registry says which servers an Environment has first, so an Environment with none never wakes its host, and a name the
// set does not hold never reaches it. The host answers from its own storage (`serverLog` starts no Container, and neither
// does this); the main Worker adds each tool's Exposure with the pure resolver of `@cloudpid/config`, over the Environment's `tools.offered` too.
//
// Every answer has a fallback: a host that fails, or answers with a tag or shape this build does not know, is
// `Unavailable` (`docs/architecture/mcp.md` → Deploys), whose message never carries the cause.
// @effect-diagnostics missingPipeableSignature:off -- operations over plain values, not combinators.
import {
  MCP_EXPOSURES,
  type McpExposure,
  type McpExposureKeys,
  mcpToolNames,
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
import { type PromptCatalog, promptCatalog } from "../session/mcp-prompt-catalog.ts";
import { mcpHostName } from "./name.ts";

const NO_PROMPTS: PromptCatalog = { prompts: [], mcpServers: [] };

/** The Registry's method a status read uses, on its object. */
type StatusRegistry = Pick<RegistryMethods, "mcpServerNames" | "getSettingsOverrides">;

/** The Registry object and the host objects, by name, as the main Worker reaches them. */
export type McpStatusObjects = {
  readonly registry: () => StatusRegistry;
  readonly host: (name: string) => Pick<McpHostMethods, "servers" | "serverLog" | "apply">;
};

/** The client's MCP status reads. Each answers a value, never fails. */
export type McpStatus = {
  /**
   * The Environment's MCP prompts for a composer with no Session yet (`draftCatalog`): the host's inventory as it stands,
   * as a Session's catalog lists it. No prompts, whatever the reason there are none (no servers, a host that did not
   * answer): the composer only misses its `/` rows.
   */
  readonly prompts: (environment: string) => Effect.Effect<PromptCatalog>;
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

/**
 * The server's tools with the Exposure each has: its `exposure` and `toolExposure`, and a `tools.offered` entry of the
 * Environment's Settings (`offered`) that matches the tool's model-facing name and lifts `codemode` or `deferred` to `direct`.
 */
const toolViews = (
  inventory: McpServerInventory,
  offered: ReadonlyArray<string>,
): ReadonlyArray<McpToolView> => {
  const keys = exposureKeysOf(inventory.server);

  const tools = Arr.filterMap(inventory.tools ?? [], (raw) =>
    Option.match(decodeTool(raw), { onNone: () => Result.failVoid, onSome: Result.succeed }),
  );

  const names = mcpToolNames(
    inventory.name,
    Arr.map(tools, (tool) => tool.name),
  );

  return Arr.map(tools, (tool) => ({
    ...tool,
    exposure: resolveExposure({
      server: keys,
      tool: tool.name,
      modelName: names.get(tool.name),
      offered,
    }).exposure,
  }));
};

const promptViews = (inventory: McpServerInventory): ReadonlyArray<McpPromptView> =>
  Arr.filterMap(inventory.prompts ?? [], (raw) =>
    Option.match(decodeTool(raw), { onNone: () => Result.failVoid, onSome: Result.succeed }),
  );

/** One server as the client reads it: no entry (its `${NAME}` references and URL stay with the host), no hashes. */
const serverView = (
  inventory: McpServerInventory,
  offered: ReadonlyArray<string>,
): McpServerView => {
  const view: Mutable<McpServerView> = {
    name: inventory.name,
    source: inventory.source,
    state: readMcpServerState(inventory.state),
    counts: inventory.counts,
    resources: inventory.resources,
    problems: inventory.problems,
    tools: toolViews(inventory, offered),
    prompts: promptViews(inventory),
  };

  if (inventory.error !== undefined) view.error = inventory.error;

  if (inventory.protocolVersion !== undefined) view.protocolVersion = inventory.protocolVersion;

  if (inventory.discoveredAt !== undefined) view.discoveredAt = inventory.discoveredAt;

  if (inventory.status !== undefined) view.status = inventory.status;

  return view;
};

const NOT_LISTED = "The MCP servers could not be listed";

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

/**
 * The `tools.offered` of `environment`'s Settings in force (its Overrides over Global's, as a Session resolves them),
 * which lifts a tool's Exposure to `direct`; none for an Environment the Registry no longer has.
 */
const offeredOf = (objects: McpStatusObjects, environment: string) =>
  objects
    .registry()
    .getSettingsOverrides({ environment })
    .pipe(
      Effect.map((state) => (state === null ? [] : state.settings.tools.offered)),
      Effect.catchCause((cause) =>
        Effect.logWarning(`Environment ${environment}'s Settings could not be read`, cause).pipe(
          Effect.as(undefined),
        ),
      ),
    );

/**
 * Runs `read` over the names of `environment`'s servers, once the Registry has said it has some; the Registry's
 * answer for an Environment that is not listed, or one it could not give, is the answer; and a read that fails is
 * `Unavailable`, with the cause in the log and not in the answer (`what` says which read it was).
 */
const readSet = <A>(
  objects: McpStatusObjects,
  environment: string,
  what: string,
  read: (names: ReadonlyArray<string>) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const names = yield* namesOf(objects, environment);

    if (names === undefined) return unavailable(NOT_LISTED);

    if (Option.isNone(names)) return McpNoEnvironment.make({});

    return yield* read(names.value);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Environment ${environment}'s MCP ${what}`, cause).pipe(
        Effect.as(unavailable(NO_HOST)),
      ),
    ),
  );

/** The MCP status reads over `objects`. */
export const mcpStatus = (objects: McpStatusObjects): McpStatus => ({
  prompts: (environment) =>
    namesOf(objects, environment).pipe(
      Effect.flatMap((names) =>
        names === undefined || Option.isNone(names) || names.value.length === 0
          ? Effect.succeed(NO_PROMPTS)
          : objects
              .host(mcpHostName(environment))
              .servers({ parts: ["prompts"] })
              .pipe(
                Effect.map((answer) => {
                  const decoded = decodeServers(answer);

                  return Option.isNone(decoded) || Predicate.isTagged(decoded.value, "HostFailed")
                    ? NO_PROMPTS
                    : promptCatalog(decoded.value.servers);
                }),
              ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning(`Environment ${environment}'s MCP prompts were not read`, cause).pipe(
          Effect.as(NO_PROMPTS),
        ),
      ),
    ),

  servers: (environment) =>
    readSet(objects, environment, "servers were not read", (names) =>
      names.length === 0
        ? Effect.succeed(McpServersList.make({ version: "", servers: [] }))
        : Effect.gen(function* () {
            const offered = yield* offeredOf(objects, environment);

            // Settings that cannot be read leave the tools' Exposure unknown, so the servers are not listed at all.
            if (offered === undefined) return unavailable(NOT_LISTED);

            const answer = yield* objects
              .host(mcpHostName(environment))
              .servers({ parts: ["tools", "prompts", "status"] });

            const decoded = decodeServers(answer);

            if (Option.isNone(decoded)) return unavailable(NOT_KNOWN);

            if (Predicate.isTagged(decoded.value, "HostFailed")) {
              return unavailable(COULD_NOT_ANSWER);
            }

            return McpServersList.make({
              version: decoded.value.version,
              servers: Arr.map(decoded.value.servers, (each) => serverView(each, offered)),
            });
          }),
    ),

  serverLog: ({ environment, server, workspace }) =>
    readSet(objects, environment, "server log was not read", (names) =>
      // A name the set does not hold never wakes the host.
      !Arr.contains(names, server)
        ? Effect.succeed(McpServerMissing.make({}))
        : objects
            .host(mcpHostName(environment))
            .serverLog(workspace === undefined ? { server } : { server, workspace })
            .pipe(
              Effect.map((answer): McpServerLogView => {
                const decoded = decodeLog(answer);

                if (Option.isNone(decoded)) return unavailable(NOT_KNOWN);

                return Match.value(decoded.value).pipe(
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
              }),
            ),
    ),

  reconnect: ({ environment, servers }) =>
    readSet(objects, environment, "reconnect was not sent", (names) => {
      const wanted = servers === undefined ? names : Arr.intersection(servers, names);

      return wanted.length === 0
        ? Effect.succeed(McpReconnecting.make({ servers: [] }))
        : objects
            .host(mcpHostName(environment))
            .apply({ kind: "reload", servers: Arr.fromIterable(wanted) })
            .pipe(
              Effect.map((answer): McpReconnectView => {
                const applied = readMcpApplyResult(answer);

                return Predicate.isTagged(applied, "Reloaded")
                  ? McpReconnecting.make({ servers: applied.servers })
                  : unavailable(COULD_NOT_ANSWER);
              }),
            );
    }),
});
