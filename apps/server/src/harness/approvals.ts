// docs/architecture/mcp-endpoint.md → Environment and Settings tools → Approvals with no Session (ADR-0050; #685 D5, L2,
// L4, L5, L18; #688 C2, C3): the main Worker's side of an Approval asked over `/mcp`, which no Session holds. The Registry
// keeps the request (`../registry/approvals.ts`); this runs the tools' shared cores (`@cloudpid/extensions`) around it:
//
// - **Ask** (`askApproval`, from the dispatcher): the core's `prepare` reads the target and refuses what the tool would
//   refuse; a target that has the value already answers `unchanged`, asking nothing. Otherwise the Registry keeps the
//   request (checking every text of the arguments against the kept Secrets, deduping, superseding, capping), the owner is
//   pushed a Notification for a new one, and the call answers `pending` with the request's id and its card's `url`.
// - **Apply** (`approvalRunner().apply`): an approved request is claimed under a 60 s lease, then its claim
//   (`approval:<id>`, whose attempt is the request's own id) is read first: an answer kept finishes it; changes recorded
//   with no answer (a write that committed before its run was cut) finish it with an answer `render` builds from them;
//   nothing runs the core's `apply` against `expected` and the endpoint author, then `render`. The claim is settled,
//   then the request. A run cut anywhere leaves it approved, and the next (Try again, `approval_wait`, the owner's next
//   visit: `resumeStale`) picks it up from the claim.
// - **Follow** (`approvalWait`, `approvalWithdraw`): the caller's wait for the owner's answer, which applies an approved
//   request no run is applying, and its withdrawal while the request waits.
// @effect-diagnostics missingPipeableSignature:off globalDate:off globalJsonInEffect:off preferTypedSchemaDecoder:off cryptoRandomUUID:off -- ISO times of epoch numbers; stored arguments read again; a run's token is a plain UUID.
import {
  type Applied,
  type ApprovalCore,
  instructionsCore,
  type PlainText,
  type Prepared,
  resetLimitCore as resetSettingsLimitCore,
  SETTINGS_LIMITS,
  type SettingsCoreServices,
  type SettingsHow,
  spendLimitCore,
  subagentDepthCore,
  subagentWorkspacesCore,
} from "@cloudpid/extensions/approval-cores";
import {
  type ChangeAuthor,
  EnvironmentsError,
  type EnvironmentsService,
} from "@cloudpid/extensions/environment";
import { resetLimitCore as resetSizeLimitCore } from "@cloudpid/extensions/environment-reset";
import { sizeLimitCore } from "@cloudpid/extensions/environment-size-limit";
import type { AppliedSettingsChange, SettingsView } from "@cloudpid/extensions/settings";
import {
  type AgentChange,
  type AgentChangeVia,
  approvalPath,
  approvalSettled,
} from "@cloudpid/protocol";
import {
  APPROVAL_ASK_TOOLS,
  APPROVAL_REQUEST_PREFIX,
  DEFAULT_APPROVAL_WAIT_S,
  GLOBAL_ID,
  GLOBAL_NAME,
  GLOBAL_SETTINGS_SCOPE,
  MAX_APPROVAL_WAIT_S,
} from "@cloudpid/protocol/harness-tools";
import {
  type ApiResult,
  type ApprovalState,
  apiFailure,
  apiOk,
  type HarnessAnswer,
} from "@cloudpid/protocol/mcp-api";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import type { ApprovalEnd, StoredApproval } from "../registry/approvals.ts";
import type { ChangeAnswer, ChangeClaim, ChangeRequest } from "../registry/change-requests.ts";
import type { UpkeepChange } from "../registry/upkeep.ts";
import type { AuthorSource } from "../session/change-author.ts";
import type { ApprovalsRegistry, EndpointWrites } from "./services.ts";

/** What a core's refusal carries: the message the caller reads, and the code that maps, if any. */
type CoreError = {
  readonly message: string;
  readonly code?: "not_found" | "invalid_argument" | "unavailable";
};

/** An Agent change a claim recorded, as the Registry's lookup gives it (`ChangeRequest["changes"]`). */
type RecordedChange = ChangeRequest["changes"][number];

/** How an approved request's apply ended: settled as `status`, with the change's answer or why nothing was changed. */
type ApplyOutcome =
  | { readonly status: "finished"; readonly answer: HarnessAnswer; readonly recorded: boolean }
  | { readonly status: Exclude<ApprovalEnd, "finished">; readonly reason: string };

/** A tool that waits for the owner's Approval, as the endpoint asks and applies it: its arguments are its endpoint input. */
export type ApprovalTool = {
  readonly tool: string;
  /** The Settings page section its card shows in. */
  readonly section: string;
  /** The Scope the change is at, `*` for Global; none for arguments the tool does not read. */
  readonly scopeOf: (args: Schema.Json) => string | undefined;
  /** The core's `prepare`, with where the change is (the Scope by id and name). */
  readonly prepare: (
    args: Schema.Json,
  ) => Effect.Effect<
    Prepared<unknown> & { readonly scope: { readonly id: string; readonly name: string } },
    CoreError
  >;
  /** The core's `apply` against `expected` as `author`, then its `render`. */
  readonly apply: (
    args: Schema.Json,
    expected: Schema.Json | null,
    author: ChangeAuthor,
  ) => Effect.Effect<ApplyOutcome, CoreError>;
  /** The answer of a write that committed before its run was cut: `render` of the Agent changes it recorded. */
  readonly fromRecords: (
    args: Schema.Json,
    expected: Schema.Json | null,
    changes: ReadonlyArray<RecordedChange>,
  ) => Effect.Effect<HarnessAnswer, CoreError>;
};

/** The refusal of arguments a tool cannot read (a request kept by a build with another schema). */
const unreadable = (tool: string): CoreError => ({
  message: `The request's arguments are not ones ${tool} reads now, so nothing was changed: ask again.`,
  code: "invalid_argument",
});

/**
 * The tool over `core`: `decode` reads its arguments (the endpoint input, as the dispatcher decoded and the Registry
 * kept it), `how` is what its `render` is told, and `known` and `recorded` rebuild what `apply` would have answered
 * from the Agent changes a committed write recorded.
 */
const approvalTool = <
  Args extends { readonly reason: string },
  Known,
  Res,
  E extends CoreError,
  How,
>({
  core,
  section,
  decode,
  scopeOf,
  scopeRef,
  how,
  status,
  recorded,
}: {
  readonly core: ApprovalCore<Args, Known, Res, E, How>;
  readonly section: string;
  readonly decode: (args: Schema.Json) => Option.Option<NoInfer<Args>>;
  readonly scopeOf: (args: NoInfer<Args>) => string;
  readonly scopeRef: (known: NoInfer<Known>) => { readonly id: string; readonly name: string };
  readonly how: (args: NoInfer<Args>) => How;
  /** How the write went, by its result's status. */
  readonly status: (result: NoInfer<Res>) => "made" | ApprovalEnd;
  /**
   * What `apply` would have answered of the write, rebuilt from the changes it recorded (`changes`, as Agent changes, and
   * as the claim's lookup gives them, with their Scopes' names).
   */
  readonly recorded: (
    args: NoInfer<Args>,
    changes: Arr.NonEmptyReadonlyArray<AgentChange>,
    records: Arr.NonEmptyReadonlyArray<RecordedChange>,
  ) => Effect.Effect<Applied<Known, Res>, E>;
}): ApprovalTool => {
  const read = (args: Schema.Json) =>
    Effect.fromOption(decode(args)).pipe(Effect.mapError(() => unreadable(core.tool)));

  /** `render`'s answer, or for a write that was not made, its refusal as the reason the request ends with. */
  const rendered = (args: Args, expected: Schema.Json | null, applied: Applied<Known, Res>) =>
    core.render(args, expected, applied, how(args)).pipe(Effect.result);

  return {
    tool: core.tool,
    section,
    scopeOf: (args) => Option.getOrUndefined(Option.map(decode(args), scopeOf)),
    prepare: (args) =>
      Effect.flatMap(read(args), (decoded) =>
        Effect.map(core.prepare(decoded), (prepared) => ({
          ...prepared,
          scope: scopeRef(prepared.known),
        })),
      ),
    apply: (args, expected, author) =>
      Effect.gen(function* () {
        const decoded = yield* read(args);
        const applied = yield* core.apply(decoded, expected, author);
        const made = status(applied.result);

        const answer = yield* rendered(decoded, expected, applied);

        if (Result.isFailure(answer)) {
          return {
            status: made === "made" || made === "finished" ? "refused" : made,
            reason: answer.failure.message,
          };
        }

        return made === "made" || made === "finished"
          ? { status: "finished", answer: answer.success, recorded: made === "made" }
          : { status: made, reason: answer.success.text };
      }),
    fromRecords: (args, expected, changes) =>
      Effect.gen(function* () {
        const decoded = yield* read(args);

        if (!Arr.isReadonlyArrayNonEmpty(changes)) return notKept(core.tool);

        const applied = yield* recorded(
          decoded,
          Arr.map(changes, (change) => agentChangeOf(core.tool, decoded.reason, change)),
          changes,
        );

        const answer = yield* rendered(decoded, expected, applied);

        return Result.getOrElse(answer, () => notKept(core.tool));
      }),
  };
};

/** The answer of an applied request whose recorded changes are no longer kept: the read tools show the target now. */
const notKept = (tool: string): HarnessAnswer => ({
  text: `The owner approved, and ${tool}'s change was made; its record is no longer kept, so settings_get or environment_get shows the target as it is now.`,
  structured: { replayed: true },
});

/** A change a claim recorded, as an Agent change: made over the endpoint, approved, by `tool` with `reason`. */
const agentChangeOf = (tool: string, reason: string, change: RecordedChange): AgentChange => ({
  id: change.id,
  scope: change.scope,
  at: 0,
  actor: "agent",
  session: null,
  conversation: null,
  tool,
  reason,
  field: change.field,
  before: change.before,
  after: change.after,
  reverts: null,
  revertedBy: null,
});

/** What a Settings change reaches, as the endpoint says it: no Session of the caller's runs with them. */
const settingsReach = (scope: string): SettingsHow => ({
  reach:
    scope === GLOBAL_SETTINGS_SCOPE
      ? "Each Session whose Environment does not override it takes it when it next admits input; a Run going keeps what it started with."
      : "The Environment's Sessions take it when they next admit input; a Run going keeps what it started with.",
});

/** A Settings view's Scope, by id and name. */
const settingsScopeRef = (view: SettingsView) =>
  "name" in view ? { id: view.scope, name: view.name } : { id: GLOBAL_ID, name: GLOBAL_NAME };

/** How a Settings write went. */
const settingsStatus = (result: { readonly status: string }): "made" | ApprovalEnd => {
  switch (result.status) {
    case "changed":
      return "made";
    case "unchanged":
      return "finished";
    case "changed-since":
      return "changed_since";
    default:
      return "refused";
  }
};

/** How an Environment's write went: as a Settings write, with `missing` (the Environment gone) refused. */
const environmentStatus = settingsStatus;

/**
 * A Settings core's tool over `access`: its card at `section`, and its write rebuilt from the recorded changes over the
 * Scope as it is now.
 */
const settingsToolOver =
  (access: SettingsCoreServices["access"]) =>
  <Args extends { readonly scope: string; readonly reason: string }>(
    core: ApprovalCore<Args, SettingsView, AppliedSettingsChange, CoreError, SettingsHow>,
    section: string,
    decode: (args: Schema.Json) => Option.Option<Args>,
  ): ApprovalTool =>
    approvalTool({
      core,
      section,
      decode,
      scopeOf: (args) => args.scope,
      scopeRef: settingsScopeRef,
      how: (args) => settingsReach(args.scope),
      status: settingsStatus,
      recorded: (args, changes) =>
        Effect.map(
          access.get(args.scope),
          (view): Applied<SettingsView, AppliedSettingsChange> => ({
            known: view,
            result: { status: "changed", changes },
          }),
        ),
    });

/** The arguments of the reset of a Limit of the Settings (`settings_reset`'s Limit path). */
const SettingsResetArgs = Schema.Struct({
  scope: Schema.String,
  field: Schema.String,
  reason: Schema.String,
});

/** The arguments of the reset of an Environment's size limit (`environment_setting_reset` with `maxInstance`). */
const SizeLimitResetArgs = Schema.Struct({
  id: Schema.String,
  setting: Schema.Literal("maxInstance"),
  reason: Schema.String,
});

/** The tools that ask for an Approval on the endpoint, by name, over the writes made as `source`. */
export const approvalTools = (
  writes: EndpointWrites,
  source: AuthorSource,
): Readonly<Record<string, ApprovalTool>> => {
  const plainText: PlainText = (text, what, fix) =>
    writes.holdsSecret(text).pipe(
      Effect.flatMap((held) =>
        held
          ? Effect.fail(
              EnvironmentsError.make({
                message: `Nothing was asked or saved: ${what} holds a GitHub token or the GitHub App's key. ${fix}`,
                code: "invalid_argument",
              }),
            )
          : Effect.void,
      ),
    );

  const access = writes.settings(source);
  const settings: SettingsCoreServices = { access, plainText };
  const environments: EnvironmentsService = writes.environments(source);
  const settingsTool = settingsToolOver(access);

  const sizeLimit = sizeLimitCore({ environments, plainText });

  const resetSizeLimit = resetSizeLimitCore({
    environments,
    refuseSecrets: (texts) =>
      Effect.forEach(texts, ({ what, text }) => plainText(text, what, "Say it without it."), {
        discard: true,
      }),
    target: (id) => Effect.succeed({ environment: id, own: false }),
  });

  return {
    settings_spend_limit_set: settingsTool(
      spendLimitCore(settings),
      "limits",
      Schema.decodeUnknownOption(APPROVAL_ASK_TOOLS.settings_spend_limit_set.endpoint.input),
    ),
    settings_subagent_depth_set: settingsTool(
      subagentDepthCore(settings),
      "limits",
      Schema.decodeUnknownOption(APPROVAL_ASK_TOOLS.settings_subagent_depth_set.endpoint.input),
    ),
    settings_subagent_workspaces_set: settingsTool(
      subagentWorkspacesCore(settings),
      "limits",
      Schema.decodeUnknownOption(
        APPROVAL_ASK_TOOLS.settings_subagent_workspaces_set.endpoint.input,
      ),
    ),
    settings_instructions_set: settingsTool(
      instructionsCore(settings),
      "instructions",
      Schema.decodeUnknownOption(APPROVAL_ASK_TOOLS.settings_instructions_set.endpoint.input),
    ),
    environment_container_size_limit_set: approvalTool({
      core: sizeLimit,
      section: "container",
      decode: Schema.decodeUnknownOption(
        APPROVAL_ASK_TOOLS.environment_container_size_limit_set.endpoint.input,
      ),
      scopeOf: (args) => args.id,
      scopeRef: (known) => known.environment,
      how: () => undefined,
      status: environmentStatus,
      recorded: (_args, changes, records) => {
        const record = Arr.headNonEmpty(records);
        const environment = { id: record.scope, name: record.scopeName };

        return Effect.succeed({
          known: { environment, own: false },
          result: { status: "changed" as const, environment, change: Arr.headNonEmpty(changes) },
        });
      },
    }),
    // `settings_reset`'s Limit path (S2b serves the tool): one core per Limit, by its field.
    settings_reset: settingsReset(settings),
    // `environment_setting_reset`'s path for the size limit (S2a-4 serves the tool).
    environment_setting_reset: approvalTool({
      core: resetSizeLimit,
      section: "container",
      decode: Schema.decodeUnknownOption(SizeLimitResetArgs),
      scopeOf: (args) => args.id,
      scopeRef: (known) => ({ id: known.details.id, name: known.details.name }),
      how: () => undefined,
      status: environmentStatus,
      recorded: (args, changes) =>
        Effect.gen(function* () {
          const details = yield* environments.get(args.id);

          if (details === null) {
            return yield* EnvironmentsError.make({
              message: `No Environment has the id ${JSON.stringify(args.id)}.`,
              code: "not_found",
            });
          }

          const environment = { id: details.id, name: details.name };

          return {
            known: { details, own: false },
            result: {
              status: "changed" as const,
              environment,
              change: Arr.headNonEmpty(changes),
            },
          };
        }),
    }),
  };
};

/**
 * `settings_reset`'s Limit path: the core of the Limit the arguments' `field` names. A field that is no Limit is not asked
 * for (the tool resets it at once), and its arguments are refused here.
 */
const settingsReset = (settings: SettingsCoreServices): ApprovalTool => {
  const decode = Schema.decodeUnknownOption(SettingsResetArgs);
  const settingsTool = settingsToolOver(settings.access);

  // One tool per Limit; the request's arguments say which.
  const byField = Record.fromEntries(
    Arr.map(SETTINGS_LIMITS, (limit) => [
      limit.field,
      settingsTool(resetSettingsLimitCore(settings, limit), "limits", decode),
    ]),
  );

  const pick = (args: Schema.Json): Option.Option<ApprovalTool> =>
    Option.flatMap(decode(args), ({ field }) => Record.get(byField, field));

  const missing = Effect.fail(unreadable("settings_reset"));

  return {
    tool: "settings_reset",
    section: "limits",
    scopeOf: (args) =>
      Option.getOrUndefined(
        Option.flatMap(pick(args), (tool) => Option.fromNullishOr(tool.scopeOf(args))),
      ),
    prepare: (args) =>
      Option.match(pick(args), { onNone: () => missing, onSome: (tool) => tool.prepare(args) }),
    apply: (args, expected, author) =>
      Option.match(pick(args), {
        onNone: () => missing,
        onSome: (tool) => tool.apply(args, expected, author),
      }),
    fromRecords: (args, expected, changes) =>
      Option.match(pick(args), {
        onNone: () => missing,
        onSome: (tool) => tool.fromRecords(args, expected, changes),
      }),
  };
};

// ─── Ask ─────────────────────────────────────────────────────────────────────

/** An ask as the dispatcher hands it over: the tool, its decoded input, who asks, and its digests. */
export type ApprovalAskCall = {
  readonly tool: string;
  /** The endpoint input as decoded, `request_id` included. */
  readonly args: { readonly request_id?: string | undefined };
  readonly caller: AgentChangeVia;
  readonly requestId: string | undefined;
  /** The `request_id` digest (`requestDigest`): the tool and every argument but the id. */
  readonly requestDigest: string;
  /** The dedupe digest: the same hash, `reason` left out too, so the same change asked for another reason is one request. */
  readonly digest: string;
  /** A fresh attempt for the `request_id` claim. */
  readonly attempt: string;
};

/** What the asking parts need: the Registry's Approvals and claims, the writes the cores read through, and `background`. */
export type ApprovalAskServices = {
  readonly approvals: ApprovalsRegistry;
  readonly writes: EndpointWrites;
  readonly background: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  readonly origin?: string | undefined;
};

/** The arguments a request keeps: the input as decoded, without the caller's `request_id`. */
const keptArgs = (args: { readonly request_id?: string | undefined }): Schema.Json =>
  // SAFETY: `args` is an endpoint input as its schema decoded it: JSON.
  Record.remove(args as Readonly<Record<string, Schema.Json>>, "request_id");

/** A time as an answer says it. */
const iso = (at: number): string => new Date(at).toISOString();

/** The url of request `approval`'s card: at `origin` when known. */
const cardUrl = (approval: StoredApproval, origin: string | undefined): string =>
  `${origin ?? ""}${approvalPath(approval.scope, approval.section, approval.id)}`;

/** The `pending` answer of an ask: the request made (`fresh`), or the one that waits already. */
const pendingAnswer = (
  approval: StoredApproval,
  fresh: boolean,
  scope: { readonly id: string; readonly name: string },
  origin: string | undefined,
): HarnessAnswer => {
  const url = cardUrl(approval, origin);
  const what = `${approval.card.change}, ${approval.card.target}`;

  return {
    text: fresh
      ? `Asked the owner to approve: ${what}. Nothing is changed until they approve it in cloudpid at ${url}; the request (approval_id ${approval.id}) expires ${iso(approval.expiresAt)} if they do not answer.`
      : `A request for this change waits for the owner already (approval_id ${approval.id}): nothing was asked again. ${what}; they answer it in cloudpid at ${url}, and it expires ${iso(approval.expiresAt)}.`,
    structured: {
      status: "pending",
      approval_id: approval.id,
      url,
      expires_at: iso(approval.expiresAt),
      scope,
    },
  };
};

/** What an `unchanged` core answer reads of its structured value: the Scope and the fields that have the value. */
const UnchangedKeys = Schema.Struct({
  scope: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
  unchanged: Schema.String.pipe(Schema.Array, Schema.optionalKey),
});

/** The `unchanged` answer of an ask: the core's words, and what the endpoint's output keeps of its value. */
const unchangedAnswer = (
  unchanged: { readonly text: string; readonly structured: unknown },
  scope: { readonly id: string; readonly name: string },
): HarnessAnswer => {
  const keys = Option.getOrElse(
    Schema.decodeUnknownOption(UnchangedKeys)(unchanged.structured),
    () => ({}),
  );

  const structured: Types.Mutable<Record<string, Schema.Json>> = {
    status: "unchanged",
    scope: "scope" in keys && keys.scope !== undefined ? keys.scope : scope,
  };

  if ("unchanged" in keys && keys.unchanged !== undefined) structured["unchanged"] = keys.unchanged;

  return { text: unchanged.text, structured };
};

/** The failure of an ask that could not be finished: nothing is known to be asked. */
const notAsked = apiFailure(
  "unavailable",
  "cloudpid could not ask the owner just now: try again shortly (with the same request_id, a retry answers the request if it was made).",
);

/** A core's refusal of an ask: its code, or `invalid_argument` for one that is only words (the core refused the call). */
const askRefused = (error: CoreError): ApiResult<never> =>
  apiFailure(error.code ?? "invalid_argument", error.message);

/**
 * Ask for `call`'s change (see the module's rules): `prepare`, then the Registry's request, the push of a new one, and the
 * settle of the caller's `request_id` with the `pending` answer, before it is sent. A repeat of a `request_id` the earlier
 * call settled answers what it answered; one it claimed and did not settle asks again, which answers its request.
 */
export const askApproval =
  (services: ApprovalAskServices) =>
  (call: ApprovalAskCall): Effect.Effect<ApiResult<HarnessAnswer>> =>
    Effect.gen(function* () {
      const { tool, args, caller, requestId } = call;
      const source: AuthorSource = { kind: "endpoint", via: caller };
      const found = approvalTools(services.writes, source)[tool];

      if (found === undefined) {
        return apiFailure("unsupported", `The server does not serve ${tool}: it is not offered.`);
      }

      const earlier =
        requestId === undefined ? null : yield* services.approvals.changeRequest({ id: requestId });

      if (requestId !== undefined && earlier !== null) {
        if (earlier.tool !== tool || earlier.digest !== call.requestDigest) {
          return apiFailure(
            "invalid_argument",
            `The request_id ${JSON.stringify(requestId)} was used by an earlier call with other arguments: use a new request_id for a new change.`,
          );
        }

        if (earlier.answer !== null) return apiOk(earlier.answer);
      }

      const kept = keptArgs(args);
      const prepared = yield* found.prepare(kept).pipe(Effect.result);

      if (Result.isFailure(prepared)) return askRefused(prepared.failure);

      const { card, expected, unchanged, scope } = prepared.success;

      // A repeat of a call that asked asks again (its request is answered); otherwise a target set already asks nothing.
      if (unchanged !== undefined && earlier === null) {
        return apiOk(unchangedAnswer(unchanged, scope));
      }

      const claim: ChangeClaim | undefined =
        requestId === undefined
          ? undefined
          : { id: requestId, tool, digest: call.requestDigest, attempt: call.attempt };

      const asked = yield* services.approvals.requestApproval({
        tool,
        scope: scope.id,
        section: found.section,
        args: kept,
        card,
        expected,
        digest: call.digest,
        via: caller,
        request: claim,
      });

      switch (asked.status) {
        case "refused":
          return apiFailure("invalid_argument", asked.message);
        case "too_many":
          return apiFailure(
            "too_many_approvals",
            `${asked.limit} of your requests wait for the owner or are being applied, as many as may: follow them with approval_wait, or take one back with approval_withdraw, then ask again.`,
          );
        case "asked": {
          const answer = pendingAnswer(asked.approval, asked.fresh, scope, services.origin);

          if (asked.fresh) {
            yield* services.background(
              services.approvals.notifyApproval({ id: asked.approval.id }).pipe(Effect.asVoid),
            );
          }

          if (claim !== undefined) {
            yield* services.approvals
              .settleChangeRequest({ id: claim.id, attempt: claim.attempt, answer })
              .pipe(Effect.ignore);
          }

          return apiOk(answer);
        }
      }
    }).pipe(Effect.catchCause(() => Effect.succeed(notAsked)));

// ─── Apply ───────────────────────────────────────────────────────────────────

/** What applying needs: the Registry's Approvals and claims, the writes, the upkeep a record-built answer runs again. */
export type ApprovalRunnerDeps = {
  readonly approvals: ApprovalsRegistry;
  readonly writes: EndpointWrites;
  readonly upkeep: (changes: ReadonlyArray<UpkeepChange>) => Effect.Effect<void>;
  readonly background: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  /** A run's lease token: a fresh UUID; a test names its own. */
  readonly newToken?: (() => string) | undefined;
};

/** The claim an approved request's write records: `approval:<id>`, its attempt the request's own id (L18). */
export const approvalClaim = (approval: StoredApproval): ChangeClaim => ({
  id: `${APPROVAL_REQUEST_PREFIX}${approval.id}`,
  tool: approval.tool,
  digest: approval.digest,
  attempt: approval.id,
});

/** The apply of approved requests, and the resume of those no run is applying. */
export const approvalRunner = ({
  approvals,
  writes,
  upkeep,
  background,
  newToken = () => crypto.randomUUID(),
}: ApprovalRunnerDeps) => {
  /**
   * Apply approved request `id` (see the module's rules), answering it as it stands after: settled, or still approved
   * when another run holds it, or when this one was cut (the next resumes it). Null for a request not kept.
   */
  const apply = (id: string): Effect.Effect<StoredApproval | null> =>
    Effect.gen(function* () {
      const token = newToken();
      const claimed = yield* approvals.claimApproval({ id, token });

      if (claimed === null) return null;

      if (!claimed.leased) return claimed.approval;

      const approval = claimed.approval;
      const claim = approvalClaim(approval);

      const finish = (
        ended:
          | { readonly status: "finished"; readonly result: ChangeAnswer }
          | { readonly status: Exclude<ApprovalEnd, "finished">; readonly reason: string },
      ) => approvals.finishApproval({ id, token, ...ended });

      /** Settle the claim with `answer`, then the request: a repeat of the resume finds the answer. */
      const finished = (answer: HarnessAnswer) =>
        approvals
          .settleChangeRequest({ id: claim.id, attempt: claim.attempt, answer })
          .pipe(Effect.ignore, Effect.andThen(finish({ status: "finished", result: answer })));

      const tool = approvalTools(writes, {
        kind: "endpoint",
        via: approval.via,
        request: claim,
      })[approval.tool];

      if (tool === undefined) {
        return yield* finish({
          status: "refused",
          reason: `cloudpid no longer applies ${approval.tool}, so nothing was changed.`,
        });
      }

      const recorded = yield* approvals.changeRequest({ id: claim.id });

      // Answered: the run that made the change settled its claim and was cut before the request.
      if (recorded !== null && recorded.answer !== null) {
        return yield* finish({ status: "finished", result: recorded.answer });
      }

      // Claimed with no answer: the write committed and its run was cut. Its changes stand: the answer is built from them,
      // and the upkeep the run may not have run is run again (it is idempotent).
      if (recorded !== null) {
        const built = yield* tool
          .fromRecords(approval.args, approval.expected, recorded.changes)
          .pipe(Effect.orElseSucceed(() => notKept(approval.tool)));

        yield* background(upkeep(recorded.changes));

        return yield* finished(built);
      }

      const outcome = yield* tool
        .apply(approval.args, approval.expected, {
          tool: approval.tool,
          reason: approval.card.reason,
        })
        .pipe(Effect.result);

      // A refusal of the write (the Environment gone, an `expected` it cannot read): nothing was changed.
      if (Result.isFailure(outcome)) {
        return yield* finish({ status: "refused", reason: outcome.failure.message });
      }

      const ended = outcome.success;

      if (ended.status !== "finished") return yield* finish(ended);

      return yield* ended.recorded
        ? finished(ended.answer)
        : finish({ status: "finished", result: ended.answer });
    }).pipe(
      // A run that failed for no reason it can say (a Registry call cut) leaves the request approved: its lease lapses,
      // and the next run picks it up from the claim.
      Effect.catchCause((cause) =>
        Effect.logWarning("Applying an approved request was cut; it is resumed later", cause).pipe(
          Effect.andThen(approvals.approval({ id })),
          Effect.orElseSucceed(() => null),
        ),
      ),
    );

  /**
   * Resume the approved requests no run is applying (L4: behind the owner's `listApprovals`), each in `background`. A long
   * apply is resumed by the owner's Try again or visit only; none is long before S3b.
   */
  const resumeStale: Effect.Effect<void> = approvals.staleApprovals().pipe(
    Effect.flatMap((stale) =>
      Effect.forEach(stale, (approval) => background(apply(approval.id).pipe(Effect.asVoid)), {
        discard: true,
      }),
    ),
    Effect.catchCause((cause) => Effect.logWarning("Resuming approved requests failed", cause)),
  );

  return { apply, resumeStale };
};

export type ApprovalRunner = ReturnType<typeof approvalRunner>;

// ─── Follow ──────────────────────────────────────────────────────────────────

/** Why a request was withdrawn, as the caller reads it. */
const WITHDRAWN: Readonly<Record<string, string>> = {
  withdrawn: "Withdrawn with approval_withdraw.",
  superseded: "Replaced by a newer request for the same change with another value.",
  environment_deleted: "Its Environment was deleted.",
};

/** Request `approval` as `approval_wait` and `approval_withdraw` answer it. */
export const approvalState = (approval: StoredApproval): ApprovalState => {
  const state: Types.Mutable<ApprovalState> = {
    approval_id: approval.id,
    tool: approval.tool,
    status: approval.status,
    finished: approvalSettled(approval.status),
    expires_at: iso(approval.expiresAt),
  };

  const reason =
    approval.withdrawal === null
      ? approval.reason
      : (WITHDRAWN[approval.withdrawal] ?? approval.reason);

  if (reason !== null && reason !== undefined) state.reason = reason;

  if (approval.result !== null) {
    // SAFETY: a kept answer's structured value is JSON (`ChangeAnswer`).
    state.result = {
      text: approval.result.text,
      structured: approval.result.structured as Schema.Json,
    };
  }

  return state;
};

const notFound = (id: string) =>
  apiFailure(
    "not_found",
    `No request ${JSON.stringify(id)} is kept: it was never asked, or it ended more than 24 hours ago.`,
  );

/** What following a request needs: the Registry's Approvals, and the runner that applies an approved one. */
export type ApprovalFollowServices = {
  readonly approvals: ApprovalsRegistry;
  readonly runner: ApprovalRunner;
};

/** The seconds a wait waits: `timeout_s` clamped to 0–300 (`MAX_APPROVAL_WAIT_S`), 45 when not given. */
export const waitSeconds = (timeout?: number): number =>
  timeout === undefined || !Number.isFinite(timeout)
    ? DEFAULT_APPROVAL_WAIT_S
    : Math.min(Math.max(timeout, 0), MAX_APPROVAL_WAIT_S);

/** Whether a run applies `approval` now: approved, not long, and no run holds it. */
const toApply = (approval: StoredApproval, now: number): boolean =>
  approval.status === "approved" &&
  !approval.long &&
  (approval.leaseUntil === null || approval.leaseUntil <= now);

/**
 * `approval_wait`: request `id`, read at once and returned when it is settled, or waited for until it changes or
 * `timeout_s` passes (0 reads once). An approved one no run is applying is applied by the wait. A wait cut short (a
 * deploy) answers the request as read once after, `interrupted`. At most `MAX_APPROVAL_WAITS` per caller (`auth`).
 */
export const approvalWait =
  ({ approvals, runner }: ApprovalFollowServices) =>
  (
    request: { readonly approval_id: string; readonly timeout_s?: number | undefined },
    caller: AgentChangeVia,
  ): Effect.Effect<ApiResult<ApprovalState>> =>
    Effect.gen(function* () {
      const id = request.approval_id;
      const deadline = (yield* Clock.currentTimeMillis) + waitSeconds(request.timeout_s) * 1000;
      let current = yield* approvals.approval({ id });

      // At most a few turns: apply, wait for a change, apply what the change made approved.
      for (let turn = 0; turn < 4 && current !== null; turn += 1) {
        const now = yield* Clock.currentTimeMillis;

        if (toApply(current, now)) {
          current = yield* runner.apply(id);
          continue;
        }

        if (approvalSettled(current.status) || now >= deadline) break;

        const waited = yield* approvals
          .waitApproval({ id, seen: current.status, auth: caller.auth, deadline })
          .pipe(Effect.result);

        // Cut (a deploy): read once again, and say so.
        if (Result.isFailure(waited)) {
          const after = yield* approvals.approval({ id });

          return after === null
            ? notFound(id)
            : apiOk({ ...approvalState(after), interrupted: true as const });
        }

        if (waited.success === null) return notFound(id);

        if (waited.success.status === "too_many_waits") {
          return apiFailure(
            "too_many_waits",
            "8 of your approval_waits run already, as many as may at once: wait for one to end.",
          );
        }

        current = waited.success.approval;
      }

      return current === null ? notFound(id) : apiOk(approvalState(current));
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(
          apiFailure(
            "unavailable",
            "cloudpid could not read the request just now: try again shortly.",
          ),
        ),
      ),
    );

/**
 * `approval_withdraw`: request `id` taken back while it waits; one settled already answered as it is; one the owner
 * approved refused, since its change is applied (or being applied).
 */
export const approvalWithdraw =
  ({ approvals }: Pick<ApprovalFollowServices, "approvals">) =>
  (request: { readonly approval_id: string }): Effect.Effect<ApiResult<ApprovalState>> =>
    Effect.gen(function* () {
      const id = request.approval_id;
      const after = yield* approvals.withdrawApproval({ id });

      if (after === null) return notFound(id);

      if (after.status === "approved" || after.status === "finished") {
        return apiFailure(
          "invalid_argument",
          `The owner approved request ${id} already, so it can no longer be withdrawn: approval_wait says how its change went.`,
        );
      }

      return apiOk(approvalState(after));
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(
          apiFailure(
            "unavailable",
            "cloudpid could not withdraw the request just now: try again shortly.",
          ),
        ),
      ),
    );
