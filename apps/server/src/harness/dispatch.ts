// docs/architecture/mcp-endpoint.md → Environment and Settings tools → The dispatcher and `describe().harness`, → Retries:
// `request_id`, → After a change, and Notifications: the `api` target's one operation for the management tools. It runs
// the tool's shared core (`@cloudpid/extensions`) over the services of `./services.ts` with `surface: "endpoint"` and
// answers `{text, structured}`, which `McpServer` only wraps. It decodes the input again with the shared schema (the SDK
// validated it, but `McpServer` is a deploy apart), answers `unsupported` for a tool it does not serve, maps the cores'
// codes, and answers anything else `unavailable` with a fixed sentence, so no service's message reaches a caller that was
// not meant to read it. A change goes through one path: the probe (`agentChangeFeatures`, failing closed), the
// `request_id` (refused with the Registry's own `approval:` prefix; looked up, then claimed by the write's own transaction
// and settled before the answer is sent), then the notice and the upkeep after the answer.
// @effect-diagnostics missingPipeableSignature:off preferTypedSchemaDecoder:off cryptoRandomUUID:off -- the input is the caller's JSON, read again; an attempt is a plain UUID.
import { sha256Hex, sortedJson } from "@cloudpid/config";
import {
  type EnvironmentChangeCores,
  type EnvironmentChangeToolName,
  environmentChangeCores,
  REPLAYED,
  type Replayed,
} from "@cloudpid/extensions/environment-changes";
import { environmentGetRead, environmentListRead } from "@cloudpid/extensions/environment-reads";
import type { HarnessRead, HarnessWrite } from "@cloudpid/extensions/harness";
import {
  SETTINGS_REPLAYED,
  type SettingsEndpointCores,
  type SettingsEndpointToolName,
  settingsEndpointCores,
  mcpReloadCore,
} from "@cloudpid/extensions/settings-endpoint";
import { settingsGetRead } from "@cloudpid/extensions/settings-reads";
import { settingsMcpGetRead, settingsMcpListRead } from "@cloudpid/extensions/settings-mcp-reads";
import type { AgentChangeVia } from "@cloudpid/protocol";
import {
  type ApiResult,
  apiFailure,
  apiOk,
  type HarnessAnswer,
  type HarnessRequest,
} from "@cloudpid/protocol/mcp-api";
import {
  APPROVAL_REQUEST_PREFIX,
  HARNESS_TOOLS,
  type HarnessToolName,
} from "@cloudpid/protocol/harness-tools";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { ChangeClaim, ChangeRequest } from "../registry/change-requests.ts";
import type { AuthorSource } from "../session/change-author.ts";
import type { HarnessServices } from "./services.ts";

/** What a core's refusal carries that the dispatcher reads: the message the model sees, and the code that maps. */
type CoreError = {
  readonly message: string;
  readonly code?: "not_found" | "invalid_argument" | "unsupported" | "unavailable";
};

/** The answer of a failure no code names: fixed, so a service's own message (a Registry's, a host's) is never relayed. */
const unavailable = apiFailure(
  "unavailable",
  "cloudpid could not read that just now: try again shortly.",
);

/** The answer of a change that failed with no code: whether it was made is not known, so the caller is told how to find out. */
const unfinished = apiFailure(
  "unavailable",
  "cloudpid could not finish that change just now, so whether it was made is not known: environment_get shows the setting, or a retry with the same request_id answers what was done.",
);

/**
 * The answer of a failure before the write: the Registry cannot record who made a change (a deploy under way), or could
 * not be asked. Nothing was written.
 */
const notYet = apiFailure(
  "unavailable",
  "cloudpid cannot make changes over MCP just now, and nothing was changed: try again shortly.",
);

/** A tool as the dispatcher serves it: the request read again, and its core run on the endpoint's surface. */
type Served = (
  request: HarnessRequest,
  caller: AgentChangeVia,
) => Effect.Effect<ApiResult<HarnessAnswer>>;

/** What a tool's endpoint input decodes to. */
type InputOf<Name extends HarnessToolName> =
  (typeof HARNESS_TOOLS)[Name]["endpoint"]["input"]["Type"];

/** Read `given` with `tool`'s endpoint schema, or the `invalid_argument` answer naming the tool. */
const decoder = <Name extends HarnessToolName>(tool: Name) => {
  const decode = Schema.decodeUnknownResult(HARNESS_TOOLS[tool].endpoint.input);

  return (given: HarnessRequest["input"]): Result.Result<InputOf<Name>, ApiResult<never>> =>
    Result.mapError(decode(given), (issue) =>
      apiFailure("invalid_argument", `${tool}: ${issue.message}`.slice(0, 500)),
    );
};

/** A core's answer as `harness` gives it. */
const answered = ({ text, structured }: { readonly text: string; readonly structured: unknown }) =>
  // SAFETY: a core's structured value is JSON (`asOutput`); chord's `JsonValue` and `Schema.Json` describe the same values.
  apiOk({ text, structured: structured as Schema.Json });

/** A core's refusal as `harness` gives it: its code and message, or `fallback` for one with no code. */
const refusedWith =
  (fallback: ApiResult<never>) =>
  (error: CoreError): ApiResult<never> =>
    Predicate.isUndefined(error.code) ? fallback : apiFailure(error.code, error.message);

/** `read` as `tool`'s served form: the input read again with the tool's endpoint schema, then the core on the endpoint's surface. */
const serveRead = <Name extends HarnessToolName, E extends CoreError>(
  tool: Name,
  read: HarnessRead<InputOf<Name>, E>,
): Served => {
  const decode = decoder(tool);

  return ({ input }) => {
    const decoded = decode(input);

    if (Result.isFailure(decoded)) return Effect.succeed(decoded.failure);

    return read(decoded.success, "endpoint").pipe(
      Effect.map(answered),
      Effect.catch((error: E) => Effect.succeed(refusedWith(unavailable)(error))),
    );
  };
};

/**
 * What a `request_id` digests: the tool and its arguments, the id itself left out, with the keys in order, so a repeat
 * with the same arguments has the same digest and one with other arguments does not.
 */
export const requestDigest = (tool: string, args: { readonly request_id?: string }): string =>
  // SAFETY: `args` is an endpoint input as its schema decoded it: JSON.
  sha256Hex(
    JSON.stringify(
      sortedJson({ tool, args: Record.remove(args as Record<string, Schema.Json>, "request_id") }),
    ),
  );

/** The refusal of a `request_id` an earlier call holds with another tool or other arguments. */
const otherArguments = (id: string) =>
  apiFailure(
    "invalid_argument",
    `The request_id ${JSON.stringify(id)} was used by an earlier call with other arguments: use a new request_id for a new change.`,
  );

/** The changing tools the dispatcher serves: the Environments', and the Settings' and MCP servers'. */
type ChangeToolName = EnvironmentChangeToolName | SettingsEndpointToolName;

/** What a family of changing tools is served over: its cores for an author, where its scope is named, and its replays. */
type ChangeFamily<Cores, Args> = {
  /** The family's cores over the services of a call made by `source`: the verified caller and its `request_id`'s claim. */
  readonly cores: (source: AuthorSource) => Cores;
  /** The answer built from the Agent changes an earlier call with the same `request_id` recorded. */
  readonly replay: Replayed;
  /** The Scope a call's arguments name (an Environment's id, or `*`). */
  readonly scope: (args: Args) => string;
};

/**
 * A change tool's served form. In order: the input read again; a `request_id` beginning `approval:` refused; the probe
 * (an older Registry, or one that cannot answer, fails it, and nothing is written); a `request_id` looked up, and a repeat
 * answered from what the earlier call left; the core, its write claiming the `request_id` in its own transaction (a call
 * that then fails, or records nothing, looks the claim up again: a claim made means the change was made); the settle of
 * the answer, awaited before it is sent; then the notice, after the answer. The Builds' and spares' upkeep the write
 * calls for runs after the answer too (`./services.ts`). A failure before the write says nothing was changed; one after
 * it, that whether the change was made is not known.
 */
const serveChange = <Name extends ChangeToolName, Cores>(
  services: HarnessServices,
  tool: Name,
  family: ChangeFamily<Cores, InputOf<Name>>,
  coreOf: (cores: Cores) => HarnessWrite<InputOf<Name>, CoreError>,
  newAttempt: () => string,
): Served => {
  const decode = decoder(tool);

  /** The owner's Notification of the caller's changes, after the answer: one per call, its tag replacing the last. */
  const notice = (caller: AgentChangeVia) =>
    services.background(services.registry.notifyMcpChanges({ via: caller }).pipe(Effect.asVoid));

  /** What a repeat of a `request_id` an earlier call claimed answers: its settled answer, or one built from its records. */
  const repeated = (
    id: string,
    digest: string,
    found: ChangeRequest,
    scope: string,
    caller: AgentChangeVia,
  ) =>
    Effect.gen(function* () {
      if (found.tool !== tool || found.digest !== digest) return otherArguments(id);

      if (found.answer !== null) return apiOk(found.answer);

      // The earlier call was cut after its write and before its settle: its changes stand, so the answer is built from
      // them, and the upkeep and the notice it may not have run are run again (both are idempotent).
      const built = family.replay(found.changes, scope);

      yield* services.background(services.upkeep(found.changes));
      yield* notice(caller);

      return answered(built);
    });

  /**
   * Look `claim` up again after this call's write, to answer as the call that made the change: another attempt's (a call
   * with the same `request_id` that made it first), or, with `ownClaimApplied`, this call's own, whose write committed
   * before its answer was lost (claimed means applied). None, or a lookup that fails, answers `otherwise`.
   */
  const answerFromClaim = ({
    claim,
    digest,
    scope,
    caller,
    otherwise,
    ownClaimApplied,
  }: {
    readonly claim: ChangeClaim;
    readonly digest: string;
    readonly scope: string;
    readonly caller: AgentChangeVia;
    readonly otherwise: ApiResult<HarnessAnswer>;
    readonly ownClaimApplied: boolean;
  }) =>
    services.registry.changeRequest({ id: claim.id }).pipe(
      Effect.flatMap((found) =>
        found === null || (!ownClaimApplied && found.attempt === claim.attempt)
          ? Effect.succeed(otherwise)
          : repeated(claim.id, digest, found, scope, caller),
      ),
      Effect.catchCause(() => Effect.succeed(otherwise)),
    );

  /**
   * The probe, then a `request_id`'s lookup: the claim an earlier call left (null for none, or no `request_id`), or the
   * `notYet` answer when the Registry cannot record who makes a change or cannot be asked. Nothing has been written yet,
   * so a failure here says nothing was changed.
   */
  const probeAndLookUp = (
    requestId: string | undefined,
  ): Effect.Effect<Result.Result<ChangeRequest | null, ApiResult<never>>> =>
    Effect.gen(function* () {
      // An older Registry would record the change with no `via` and check no kept Secret: nothing is written then.
      const features = yield* services.registry
        .agentChangeFeatures()
        .pipe(Effect.catchCause(() => Effect.succeed({ via: false })));

      if (!features.via) return Result.fail(notYet);

      return Result.succeed(
        requestId === undefined ? null : yield* services.registry.changeRequest({ id: requestId }),
      );
    }).pipe(Effect.catchCause(() => Effect.succeed(Result.fail(notYet))));

  /** The write and what follows it: from here, a failure may come after the change was made. */
  const writeAndAnswer = (
    args: InputOf<Name>,
    digest: string,
    claim: ChangeClaim | undefined,
    caller: AgentChangeVia,
  ) =>
    Effect.gen(function* () {
      const core = coreOf(family.cores({ kind: "endpoint", via: caller, request: claim }));

      const outcome = yield* core(args, "endpoint").pipe(
        Effect.map((answer) => Result.succeed(answer)),
        Effect.catch((error: CoreError) =>
          Effect.succeed(Result.fail(refusedWith(unfinished)(error))),
        ),
        // A write whose claim met another call's (`ChangeRequestConflict`) is rolled back and reaches here as a defect.
        Effect.catchCause(() => Effect.succeed(Result.fail(unfinished))),
      );

      // A failure of a call with a `request_id`: if the id is claimed now, by another call or by this one (whose write
      // committed before the failure), the change was made, and the call answers as its repeat does.
      if (Result.isFailure(outcome)) {
        return claim === undefined
          ? outcome.failure
          : yield* answerFromClaim({
              claim,
              digest,
              scope: family.scope(args),
              caller,
              otherwise: outcome.failure,
              ownClaimApplied: true,
            });
      }

      const answer = outcome.success;
      const reply = answered(answer);

      // Nothing recorded: another call with the same `request_id` may have made the change between this call's lookup
      // and its write, so this one found it made; that call's answer is this one's.
      if (answer.logged === undefined) {
        return claim === undefined
          ? reply
          : yield* answerFromClaim({
              claim,
              digest,
              scope: family.scope(args),
              caller,
              otherwise: reply,
              ownClaimApplied: false,
            });
      }

      // A call that recorded a change: its claim gets the answer before the caller does, so a repeat that follows the
      // answer gets these bytes.
      if (claim !== undefined && reply.ok) {
        yield* services.registry
          .settleChangeRequest({ id: claim.id, attempt: claim.attempt, answer: reply.value })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "Settling a request_id failed; a repeat is answered from its changes",
                cause,
              ),
            ),
          );
      }

      yield* notice(caller);

      return reply;
    }).pipe(Effect.catchCause(() => Effect.succeed(unfinished)));

  return ({ input, requestId: given }, caller) =>
    Effect.gen(function* () {
      const decoded = decode(input);

      if (Result.isFailure(decoded)) return decoded.failure;

      const args = decoded.success;
      // The dispatcher reads the `request_id` from the request (`McpServer` copies it there), else from the input.
      const requestId = given ?? args.request_id;

      if (requestId?.startsWith(APPROVAL_REQUEST_PREFIX) === true) {
        return apiFailure(
          "invalid_argument",
          `A request_id may not begin "${APPROVAL_REQUEST_PREFIX}": cloudpid keeps those for the owner's Approvals.`,
        );
      }

      const digest = requestDigest(tool, args);
      const lookedUp = yield* probeAndLookUp(requestId);

      if (Result.isFailure(lookedUp)) return lookedUp.failure;

      // A repeat: the earlier call's change stands, so a failure answering it says whether it was made is not known.
      if (requestId !== undefined && lookedUp.success !== null) {
        return yield* repeated(
          requestId,
          digest,
          lookedUp.success,
          family.scope(args),
          caller,
        ).pipe(Effect.catchCause(() => Effect.succeed(unfinished)));
      }

      const claim =
        requestId === undefined
          ? undefined
          : { id: requestId, tool, digest, attempt: newAttempt() };

      return yield* writeAndAnswer(args, digest, claim, caller);
    });
};

/** The dispatcher's options: where a claim's attempt comes from (a fresh UUID; a test names its own). */
export type DispatchOptions = {
  readonly newAttempt?: () => string;
};

/**
 * The dispatcher over `services`: `harness(request, caller)`, where `caller` is the verified caller a change is recorded
 * as made by. A defect of a service (a Registry call that threw) is `unavailable`, which may heal.
 */
export const harnessDispatch = (
  services: HarnessServices,
  { newAttempt = () => crypto.randomUUID() }: DispatchOptions = {},
) => {
  const change = <Name extends EnvironmentChangeToolName>(
    tool: Name,
    coreOf: (cores: EnvironmentChangeCores) => HarnessWrite<InputOf<Name>, CoreError>,
  ) =>
    serveChange(
      services,
      tool,
      {
        cores: (source) => environmentChangeCores(services.changes(source)),
        replay: REPLAYED[tool],
        scope: (args) => args.id,
      },
      coreOf,
      newAttempt,
    );

  // The Settings' and the MCP servers' tools: their scope is `scope`. A push of a server set that fails is handed on to
  // `background` by the services (`settingsChanges`' `pushFailed`), once per host.
  const settingsChange = <Name extends SettingsEndpointToolName>(
    tool: Name,
    coreOf: (cores: SettingsEndpointCores) => HarnessWrite<InputOf<Name>, CoreError>,
  ) =>
    serveChange(
      services,
      tool,
      {
        cores: (source) => settingsEndpointCores(services.settingsChanges(source)),
        replay: SETTINGS_REPLAYED[tool],
        scope: (args) => args.scope,
      },
      coreOf,
      newAttempt,
    );

  // The tools `harness` serves: the same names as `HARNESS_TOOLS_SERVED` (`../mcp/api.ts`), which `dispatch.test.ts` checks.
  const table: Record<HarnessToolName, Served> = {
    environment_list: serveRead("environment_list", environmentListRead(services.environments)),
    environment_get: serveRead("environment_get", environmentGetRead(services.environments)),
    settings_get: serveRead("settings_get", settingsGetRead(services.settings)),
    settings_mcp_list: serveRead("settings_mcp_list", settingsMcpListRead(services.settingsMcp)),
    settings_mcp_get: serveRead("settings_mcp_get", settingsMcpGetRead(services.settingsMcp)),
    environment_variable_set: change(
      "environment_variable_set",
      (cores) => cores.environment_variable_set,
    ),
    environment_variable_unset: change(
      "environment_variable_unset",
      (cores) => cores.environment_variable_unset,
    ),
    environment_container_resize: change(
      "environment_container_resize",
      (cores) => cores.environment_container_resize,
    ),
    environment_idle_time_set: change(
      "environment_idle_time_set",
      (cores) => cores.environment_idle_time_set,
    ),
    environment_setup_script_set: change(
      "environment_setup_script_set",
      (cores) => cores.environment_setup_script_set,
    ),
    environment_start_script_set: change(
      "environment_start_script_set",
      (cores) => cores.environment_start_script_set,
    ),
    environment_toolchains_set: change(
      "environment_toolchains_set",
      (cores) => cores.environment_toolchains_set,
    ),
    environment_ignore_set: change(
      "environment_ignore_set",
      (cores) => cores.environment_ignore_set,
    ),
    environment_spare_workspace_set: change(
      "environment_spare_workspace_set",
      (cores) => cores.environment_spare_workspace_set,
    ),
    environment_secret_build: change(
      "environment_secret_build",
      (cores) => cores.environment_secret_build,
    ),
    settings_model_set: settingsChange("settings_model_set", (cores) => cores.settings_model_set),
    settings_role_set: settingsChange("settings_role_set", (cores) => cores.settings_role_set),
    settings_tool_offer: settingsChange(
      "settings_tool_offer",
      (cores) => cores.settings_tool_offer,
    ),
    settings_tool_defer: settingsChange(
      "settings_tool_defer",
      (cores) => cores.settings_tool_defer,
    ),
    settings_compaction_set: settingsChange(
      "settings_compaction_set",
      (cores) => cores.settings_compaction_set,
    ),
    settings_branch_summary_set: settingsChange(
      "settings_branch_summary_set",
      (cores) => cores.settings_branch_summary_set,
    ),
    settings_extension_set: settingsChange(
      "settings_extension_set",
      (cores) => cores.settings_extension_set,
    ),
    settings_reset: settingsChange("settings_reset", (cores) => cores.settings_reset),
    settings_mcp_reload: serveRead(
      "settings_mcp_reload",
      mcpReloadCore(services.settingsMcpReload),
    ),
    settings_mcp_disable: settingsChange(
      "settings_mcp_disable",
      (cores) => cores.settings_mcp_disable,
    ),
    settings_mcp_exposure_set: settingsChange(
      "settings_mcp_exposure_set",
      (cores) => cores.settings_mcp_exposure_set,
    ),
    settings_mcp_tool_exposure_set: settingsChange(
      "settings_mcp_tool_exposure_set",
      (cores) => cores.settings_mcp_tool_exposure_set,
    ),
    settings_mcp_remove: settingsChange(
      "settings_mcp_remove",
      (cores) => cores.settings_mcp_remove,
    ),
  };

  // Looked up by a name the caller sent: only the table's own keys are tools.
  const served: Readonly<Record<string, Served>> = table;

  return (
    request: HarnessRequest,
    caller: AgentChangeVia,
  ): Effect.Effect<ApiResult<HarnessAnswer>> => {
    const run = Record.get(served, request.tool);

    if (Option.isNone(run)) {
      return Effect.succeed(
        apiFailure("unsupported", `The server does not serve ${request.tool}: it is not offered.`),
      );
    }

    return Effect.suspend(() => run.value(request, caller)).pipe(
      Effect.catchCause(() => Effect.succeed(unavailable)),
    );
  };
};
