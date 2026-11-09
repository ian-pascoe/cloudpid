// docs/architecture/mcp-endpoint.md → Environment and Settings tools → The dispatcher and `describe().harness`, → Retries:
// `request_id`, → After a change, and Notifications: the `api` target's one operation for the management tools. It runs
// the tool's shared core (`@cloudpid/extensions`) over the services of `./services.ts` with `surface: "endpoint"` and
// answers `{text, structured}`, which `McpServer` only wraps. It decodes the input again with the shared schema (the SDK
// validated it, but `McpServer` is a deploy apart), answers `unsupported` for a tool it does not serve, maps the cores'
// codes, and answers anything else `unavailable` with a fixed sentence, so no service's message reaches a caller that was
// not meant to read it. A change goes through one path: the probe (`agentChangeFeatures`, failing closed), the
// `request_id` (refused with the Registry's own `approval:` prefix; looked up, then claimed by the write's own transaction
// and settled before the answer is sent), then the notice and the upkeep after the answer. A tool whose change waits for
// the owner's Approval, and `settings_reset` of a Limit, goes to the ask instead (`./approval-ask.ts`).
// @effect-diagnostics missingPipeableSignature:off preferTypedSchemaDecoder:off cryptoRandomUUID:off -- the input is the caller's JSON, read again; an attempt is a plain UUID.
import { sha256Hex, sortedJson } from "@cloudpid/config";
import {
  environmentChangeCores,
  type Replayed,
  REPLAYED as SETTING_REPLAYED,
  replayedSetting,
} from "@cloudpid/extensions/environment-changes";
import {
  LIFECYCLE_REPLAYED,
  lifecycleCores,
} from "@cloudpid/extensions/environment-lifecycle-changes";
import { resetCore } from "@cloudpid/extensions/environment-reset";
import { SKILL_REPLAYED, skillCores } from "@cloudpid/extensions/environment-skill-changes";
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
  type ApprovalAskToolName,
  type DispatchedToolName,
  GLOBAL_ID,
  HARNESS_TOOLS,
  type HarnessToolName,
  RESET_LIMIT_SETTING,
  SETTINGS_LIMIT_FIELDS,
} from "@cloudpid/protocol/harness-tools";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { ChangeClaim, ChangeRequest } from "../registry/change-requests.ts";
import type { AuthorSource } from "../session/change-author.ts";
import { type ApprovalAskCall, askApproval } from "./approval-ask.ts";
import type { CoreError } from "./approval-tools.ts";
import type { HarnessChangeServices, HarnessServices } from "./services.ts";

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

/** Every change tool's core, by name: the Container settings' and the Secret marks', the Environment's record and Build, its Skills, and the reset. */
const changeCores = (services: HarnessChangeServices) => ({
  ...environmentChangeCores(services),
  ...lifecycleCores(services),
  ...skillCores(services),
  environment_setting_reset: resetCore(services),
});

type EnvironmentCores = ReturnType<typeof changeCores>;

type EnvironmentToolName = keyof EnvironmentCores;

/** Each Environment change tool's answer built from the records of an earlier call (#687 L17), by name. */
const ENVIRONMENT_REPLAYED: Readonly<Record<EnvironmentToolName, Replayed>> = {
  ...SETTING_REPLAYED,
  ...LIFECYCLE_REPLAYED,
  ...SKILL_REPLAYED,
  environment_setting_reset: replayedSetting,
};

/**
 * The words of what a tool is asked for that this stage does not serve (`unsupported`), or undefined for a call it does:
 * a change to the Skills kept Global waits for the owner's Approval (S3b), and a Test Build of `proposed` is S4a's. They are answered before anything is claimed or written.
 */
type Unsupported<Name extends HarnessToolName> = (args: InputOf<Name>) => string | undefined;

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

/** The refusal of a `request_id` the Registry keeps for the owner's Approvals' own claims. */
const approvalPrefix = apiFailure(
  "invalid_argument",
  `A request_id may not begin "${APPROVAL_REQUEST_PREFIX}": cloudpid keeps those for the owner's Approvals.`,
);

/** The ask of a change that waits for the owner's Approval, over the dispatcher's services (`askApproval`). */
type Ask = (call: ApprovalAskCall) => Effect.Effect<ApiResult<HarnessAnswer>>;

/**
 * An asking tool's served form (`./approval-ask.ts`): the input read again, a `request_id` beginning `approval:` refused,
 * then the ask, which answers `pending` (or `unchanged`) and claims and settles the `request_id` itself.
 */
const serveAsk = <
  Name extends ApprovalAskToolName | "settings_reset" | "environment_setting_reset",
>(
  ask: Ask,
  tool: Name,
  newAttempt: () => string,
): Served => {
  const decode = decoder(tool);

  return ({ input, requestId: given }, caller) => {
    const decoded = decode(input);

    if (Result.isFailure(decoded)) return Effect.succeed(decoded.failure);

    const args = decoded.success;
    const requestId = given ?? args.request_id;

    if (requestId?.startsWith(APPROVAL_REQUEST_PREFIX) === true) {
      return Effect.succeed(approvalPrefix);
    }

    return ask({
      tool,
      args,
      caller,
      requestId,
      requestDigest: requestDigest(tool, args),
      // SAFETY: an endpoint input as its schema decoded it: JSON.
      digest: requestDigest(tool, Record.remove(args as Record<string, Schema.Json>, "reason")),
      attempt: newAttempt(),
    });
  };
};

/** What `settings_reset`'s routing reads of its input: the field. */
const decodeResetField = Schema.decodeUnknownOption(Schema.Struct({ field: Schema.String }));

/** What `environment_setting_reset`'s routing reads of its input: the setting. */
const decodeResetSetting = Schema.decodeUnknownOption(Schema.Struct({ setting: Schema.String }));

/** Whether a `settings_reset` input names a Limit, whose reset waits for the owner's Approval. */
const resetsLimit = (input: HarnessRequest["input"]): boolean =>
  Option.match(decodeResetField(input), {
    onNone: () => false,
    onSome: ({ field }) => Arr.contains(SETTINGS_LIMIT_FIELDS, field),
  });

/** Whether an `environment_setting_reset` input names the size limit, whose reset waits for the owner's Approval. */
const resetsSizeLimit = (input: HarnessRequest["input"]): boolean =>
  Option.match(decodeResetSetting(input), {
    onNone: () => false,
    onSome: ({ setting }) => setting === RESET_LIMIT_SETTING,
  });

/** An answer's structured value as a JSON object, or none for any other value. */
const decodeJsonObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));

/** The keys a Settings change's endpoint answer always has, as an ask that changed nothing yet gives them. */
const SETTINGS_CHANGE_KEYS = { changes: [], changes_truncated: false, unchanged: [] };

/** The keys an Environment change's endpoint answer always has, as an ask that changed nothing yet gives them. */
const ENVIRONMENT_CHANGE_KEYS = { ...SETTINGS_CHANGE_KEYS, global: null };

/**
 * An ask's answer as a reset's endpoint output has it (`SettingsResetEndpointOutput`, `EnvironmentResetEndpointOutput`):
 * no change made yet, with `keys`, which a change's answer always has.
 */
const asChangeAnswer =
  (keys: Readonly<Record<string, Schema.Json>>) =>
  (result: ApiResult<HarnessAnswer>): ApiResult<HarnessAnswer> => {
    if (!result.ok) return result;

    return Option.match(decodeJsonObject(result.value.structured), {
      onNone: () => result,
      onSome: (structured) => apiOk({ ...result.value, structured: { ...keys, ...structured } }),
    });
  };

/** The refusal of a `request_id` an earlier call holds with another tool or other arguments. */
const otherArguments = (id: string) =>
  apiFailure(
    "invalid_argument",
    `The request_id ${JSON.stringify(id)} was used by an earlier call with other arguments: use a new request_id for a new change.`,
  );

/** The changing tools the dispatcher serves: the Environments', and the Settings' and MCP servers'. */
type ChangeToolName = EnvironmentToolName | SettingsEndpointToolName;

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
  unsupported: Unsupported<Name> = () => undefined,
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
      const refusedAsUnsupported = unsupported(args);

      if (refusedAsUnsupported !== undefined)
        return apiFailure("unsupported", refusedAsUnsupported);

      // The dispatcher reads the `request_id` from the request (`McpServer` copies it there), else from the input.
      const requestId = given ?? args.request_id;

      if (requestId?.startsWith(APPROVAL_REQUEST_PREFIX) === true) return approvalPrefix;

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
  const change = <Name extends EnvironmentToolName>(
    tool: Name,
    coreOf: (cores: EnvironmentCores) => HarnessWrite<InputOf<Name>, CoreError>,
    unsupported?: Unsupported<Name>,
  ) =>
    serveChange(
      services,
      tool,
      {
        cores: (source) => changeCores(services.changes(source)),
        replay: ENVIRONMENT_REPLAYED[tool],
        // `environment_create` names no Environment: its change is recorded at the one it makes.
        scope: (args) => ("id" in args ? args.id : ""),
      },
      coreOf,
      newAttempt,
      unsupported,
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

  /** The words of a Skill tool's call at Global, or none for a call at an Environment: the Skills kept Global wait for the owner's Approval, which is S3b's. */
  const globalSkillsWords = ({ id }: { readonly id: string }) =>
    id === GLOBAL_ID
      ? `The Skills kept Global (id "${GLOBAL_ID}") wait for the owner's Approval, which is not offered yet: name an Environment's id.`
      : undefined;

  const ask = askApproval(services);

  const asking = <Name extends ApprovalAskToolName>(tool: Name) =>
    serveAsk(ask, tool, newAttempt);

  // `settings_reset` of a Limit asks the owner, as the Limit tools do; any other field is reset at once.
  const resetChange = settingsChange("settings_reset", (cores) => cores.settings_reset);
  const resetAsk = serveAsk(ask, "settings_reset", newAttempt);

  const settingsReset: Served = (request, caller) =>
    resetsLimit(request.input)
      ? Effect.map(resetAsk(request, caller), asChangeAnswer(SETTINGS_CHANGE_KEYS))
      : resetChange(request, caller);

  // `environment_setting_reset` of the size limit asks the owner, as `environment_container_size_limit_set` does; any
  // other setting is reset at once.
  const sizeLimitReset = serveAsk(ask, "environment_setting_reset", newAttempt);

  const settingReset = change(
    "environment_setting_reset",
    (cores) => cores.environment_setting_reset,
  );

  const environmentSettingReset: Served = (request, caller) =>
    resetsSizeLimit(request.input)
      ? Effect.map(sizeLimitReset(request, caller), asChangeAnswer(ENVIRONMENT_CHANGE_KEYS))
      : settingReset(request, caller);

  // The tools `harness` serves: the same names as `HARNESS_TOOLS_SERVED` (`../mcp/api.ts`), which `dispatch.test.ts` checks.
  // `approval_wait` and `approval_withdraw` have operations of their own.
  const table: Record<DispatchedToolName, Served> = {
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
    settings_reset: settingsReset,
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
    environment_create: change("environment_create", (cores) => cores.environment_create),
    environment_rename: change("environment_rename", (cores) => cores.environment_rename),
    environment_repo_add: change("environment_repo_add", (cores) => cores.environment_repo_add),
    environment_repo_remove: change(
      "environment_repo_remove",
      (cores) => cores.environment_repo_remove,
    ),
    environment_rebuild: change(
      "environment_rebuild",
      (cores) => cores.environment_rebuild,
      ({ proposed }) =>
        proposed === undefined
          ? undefined
          : "A Test Build of proposed changes is not offered yet: call environment_rebuild without proposed for a Build of the saved settings.",
    ),
    environment_skill_install: change(
      "environment_skill_install",
      (cores) => cores.environment_skill_install,
      globalSkillsWords,
    ),
    environment_skill_update: change(
      "environment_skill_update",
      (cores) => cores.environment_skill_update,
      globalSkillsWords,
    ),
    environment_skill_remove: change(
      "environment_skill_remove",
      (cores) => cores.environment_skill_remove,
      globalSkillsWords,
    ),
    environment_setting_reset: environmentSettingReset,
    // The tools that wait for the owner's Approval: they ask, and answer `pending` (`./approval-ask.ts`).
    settings_spend_limit_set: asking("settings_spend_limit_set"),
    settings_subagent_depth_set: asking("settings_subagent_depth_set"),
    settings_subagent_workspaces_set: asking("settings_subagent_workspaces_set"),
    settings_instructions_set: asking("settings_instructions_set"),
    environment_container_size_limit_set: asking("environment_container_size_limit_set"),
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
