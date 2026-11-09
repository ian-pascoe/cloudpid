// The cores of the MCP servers' tools the endpoint serves besides the reads (`docs/architecture/mcp-endpoint.md` →
// Environment and Settings tools → Shared definitions and the core/wrapper split, Names and surfaces, Retries:
// `request_id`; `docs/architecture/mcp-configuration.md` → The agent's changes): `settings_mcp_disable`,
// `_exposure_set`, `_tool_exposure_set`, `_remove` and the reset of an adjustment's key, as they narrow what is reachable,
// and `settings_mcp_reload`, which is no Agent change. The key-changing and the definition tools are the Session's own
// engines (`./settings-mcp-changes.ts`, `./settings-mcp-definitions.ts`) built over the endpoint's surface, with no
// Approvals: these cores make only the change that narrows, recorded, with the push of the new set to each host it reaches
// left to the main Worker's `mcp.sync` after the answer (`./settings-mcp-commit.ts`). One that would widen what is reachable
// asks the owner first (`./settings-mcp-approvals.ts`, which the dispatcher consults before it runs these), so one that
// reaches here widening only because the state changed since is refused, `unavailable`, and nothing is changed. The words
// name the owner and no Session. The dispatcher calls these with `surface: "endpoint"`; the Session's tools call the engines
// directly, since they ask through the Session's task.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off globalJsonInEffect:off
import {
  GLOBAL_SETTINGS_SCOPE,
  type HARNESS_TOOLS,
  type SessionHarnessToolName,
  SettingsMcpReloadEndpointOutput,
  type Surface,
} from "@cloudpid/protocol/harness-tools";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RunChange } from "./environment.ts";
import type { ApprovalsError } from "./approvals.ts";
import {
  cutNote,
  cutText,
  type HarnessRead,
  type HarnessWrite,
  type HarnessWriteAnswer,
} from "./harness.ts";
import type { McpHostClientService } from "./mcp/client.ts";
import { asOutput } from "./outputs.ts";
import { pushMcpSet, type SettingsMcpAccessService } from "./settings-mcp-access.ts";
import { mcpChanges } from "./settings-mcp-changes.ts";
import { mcpCommit } from "./settings-mcp-commit.ts";
import { mcpDefinitions } from "./settings-mcp-definitions.ts";
import { SettingsMcpReloadOutput } from "./settings-mcp-outputs.ts";
import { type ReloadHost, reloadOutput } from "./settings-mcp-values.ts";
import { describeReload } from "./settings-mcp-words.ts";
import {
  NOT_PICKED,
  SettingsAccessError,
  type SettingsAccessService,
  settingsAnswer,
  settingsChanges,
} from "./settings.ts";

/** The arguments of tool `Name`, as a Session's call decodes them (the endpoint's add only `request_id`). */
type ArgsOf<Name extends SessionHarnessToolName> =
  (typeof HARNESS_TOOLS)[Name]["session"]["input"]["Type"];

/** What the cores run over: the Registry's MCP read and checks and the hosts, the Settings, and the check of a text. */
export type McpChangeCoreServices = {
  readonly access: SettingsMcpAccessService;
  readonly settings: SettingsAccessService;
  /** Whether `value` holds a Secret's value or a credential (the endpoint's: the deploy-time credentials only). */
  readonly holdsSecret: (value: string) => Effect.Effect<boolean>;
  /** The main Worker's push of an Environment's new set to its host (`McpCommitServices.sync`). */
  readonly sync?: ((environment: string) => Effect.Effect<void>) | undefined;
};

/** What `settings_reset` of an MCP server's key takes. */
export type McpResetArgs = {
  readonly scope: string;
  readonly field: string;
  readonly reason: string;
};

/**
 * The cores of the MCP servers' changing tools, by name, and `resetField`, which `settings_reset` of an MCP key routes
 * to. Each answers as every changing core does (`HarnessWrite`), with the Agent changes it made for the dispatcher.
 */
export const mcpChangeCores = (services: McpChangeCoreServices) => {
  /** Run `make` over the engines of `surface` with no call to ask through, and answer as a core does. */
  const written = (
    surface: Surface,
    make: (engines: {
      readonly keys: ReturnType<typeof mcpChanges>;
      readonly definitions: ReturnType<typeof mcpDefinitions>;
    }) => Effect.Effect<Parameters<typeof settingsAnswer>[1], SettingsAccessError | ApprovalsError>,
  ): Effect.Effect<HarnessWriteAnswer, SettingsAccessError> =>
    Effect.suspend(() => {
      const logged: Array<RunChange> = [];

      const changes = settingsChanges({
        surface,
        access: services.settings,
        // The endpoint has no Session to read the Settings again.
        reload: Effect.succeed(NOT_PICKED),
        log: { record: (change) => Effect.sync(() => void logged.push(change)) },
        holdsSecret: services.holdsSecret,
      });

      const engine = mcpCommit({
        surface,
        access: services.access,
        settings: services.settings,
        changes,
        approvals: undefined,
        sync: services.sync,
      });

      return make({ keys: mcpChanges(engine), definitions: mcpDefinitions(engine) }).pipe(
        // Nothing asks the owner here, so no approval fails; the type says it could.
        Effect.catchTag("ApprovalsError", (error) =>
          SettingsAccessError.make({ message: error.message, code: "unavailable" }),
        ),
        Effect.map((result) => settingsAnswer(surface, result, logged)),
      );
    });

  const disable: HarnessWrite<ArgsOf<"settings_mcp_disable">, SettingsAccessError> = (
    { scope, name, reason },
    surface,
  ) => written(surface, ({ keys }) => keys.disable({ scope, name, reason, api: undefined }));

  const exposureSet: HarnessWrite<ArgsOf<"settings_mcp_exposure_set">, SettingsAccessError> = (
    { scope, name, exposure, reason },
    surface,
  ) =>
    written(surface, ({ keys }) =>
      keys.exposureSet({ scope, name, exposure, reason, api: undefined }),
    );

  const toolExposureSet: HarnessWrite<
    ArgsOf<"settings_mcp_tool_exposure_set">,
    SettingsAccessError
  > = ({ scope, name, tool, exposure, before, reason }, surface) =>
    written(surface, ({ keys }) =>
      keys.toolExposureSet({ scope, name, tool, exposure, before, reason, api: undefined }),
    );

  const remove: HarnessWrite<ArgsOf<"settings_mcp_remove">, SettingsAccessError> = (
    { scope, name, reason },
    surface,
  ) =>
    written(surface, ({ definitions }) =>
      definitions.remove({ scope, name, reason, api: undefined }),
    );

  const resetField: HarnessWrite<McpResetArgs, SettingsAccessError> = (
    { scope, field, reason },
    surface,
  ) => written(surface, ({ keys }) => keys.resetField({ scope, field, reason, api: undefined }));

  return {
    settings_mcp_disable: disable,
    settings_mcp_exposure_set: exposureSet,
    settings_mcp_tool_exposure_set: toolExposureSet,
    settings_mcp_remove: remove,
    resetField,
  };
};

export type McpChangeCores = ReturnType<typeof mcpChangeCores>;

/** The tools these cores serve, by name. */
export type McpChangeToolName = Exclude<keyof McpChangeCores, "resetField">;

// ─── settings_mcp_reload ─────────────────────────────────────────────────────

/** How the host answered a reload, as a value gives it. */
const reloadHost = (
  answer: Effect.Success<ReturnType<McpHostClientService["apply"]>> | undefined,
): ReloadHost => {
  if (answer === undefined) {
    return { status: "not_reached", servers: [], note: "the set has no servers" };
  }

  if (Predicate.isTagged(answer, "Reloaded")) {
    return { status: "reloaded", servers: answer.servers, note: null };
  }

  return Predicate.isTagged(answer, "HostUnsupported")
    ? {
        status: "unsupported",
        servers: [],
        note: "the host is an older build that does not reload yet: it heals at the next deploy",
      }
    : { status: "failed", servers: [], note: "the host did not answer" };
};

/**
 * `settings_mcp_reload`'s core over the Registry's MCP read and the hosts: it reads the Environment's Repos' files again,
 * sends the set the Registry now computes to its host (awaited, as every push here), has the host reload, and answers what
 * it found. It is no Agent change: nothing is recorded, and it takes no `request_id`.
 */
export const mcpReloadCore =
  (
    access: SettingsMcpAccessService,
  ): HarnessRead<ArgsOf<"settings_mcp_reload">, SettingsAccessError> =>
  ({ scope }, surface) =>
    Effect.gen(function* () {
      if (scope === GLOBAL_SETTINGS_SCOPE) {
        return yield* SettingsAccessError.make({
          message:
            "settings_mcp_reload takes an Environment's id: Global has no Repos to read and no MCP host to reload. Give the id as environment_list shows it.",
          code: "invalid_argument",
        });
      }

      const report = yield* access.reload(scope);
      const push = yield* pushMcpSet(access, scope);

      // A set with no server has nothing to rediscover, and the host is not woken for none.
      const reloaded =
        report.servers > 0 ? yield* access.host(scope).apply({ kind: "reload" }) : undefined;

      const out = reloadOutput(report, push, reloadHost(reloaded));
      const text = describeReload(out, surface);

      return {
        text:
          surface === "session"
            ? text
            : cutText(
                text,
                cutNote("settings_mcp_list shows the servers as they are now, with their problems"),
              ),
        structured: asOutput(
          surface === "session" ? SettingsMcpReloadOutput : SettingsMcpReloadEndpointOutput,
          out,
        ),
        details: { scope: report.scope, servers: report.servers },
      };
    });
