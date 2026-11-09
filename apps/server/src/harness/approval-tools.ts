// docs/architecture/mcp-endpoint.md → Environment and Settings tools → Approvals with no Session (ADR-0050; #685 L2,
// #688 C3): the tools whose change waits for the owner's Approval, as the endpoint asks and applies them. Each adapts a
// shared core (`@cloudpid/extensions`: `prepare`, `apply`, `render`) to the arguments the Registry keeps with a request
// (the endpoint input, as JSON): its `prepare` with the Scope it reads, its `apply` against what the owner saw, settled
// as how the write went, and the answer rebuilt from the Agent changes a write recorded before its run was cut. The asking
// (`./approval-ask.ts`) and applying (`./approval-runner.ts`) parts look a tool up by name in `approvalTools`' table,
// built once, and bind it to the caller's author source per call. Every core answers in the endpoint's words
// (`surface: "endpoint"`): the owner, no Session, and only the tools the endpoint serves.
// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off -- an id quoted in a sentence.
import {
  type Applied,
  type ApprovalCore,
  instructionsCore,
  limitOfField,
  type PlainText,
  type Prepared,
  resetLimitCore as resetSettingsLimitCore,
  type SettingsCoreServices,
  type SettingsHow,
  spendLimitCore,
  subagentDepthCore,
  subagentWorkspacesCore,
} from "@cloudpid/extensions/approval-cores";
import {
  type ChangeAuthor,
  EnvironmentsError,
  refuseGlobal,
} from "@cloudpid/extensions/environment";
import { resetLimitCore as resetSizeLimitCore } from "@cloudpid/extensions/environment-reset";
import { sizeLimitCore } from "@cloudpid/extensions/environment-size-limit";
import type { AppliedSettingsChange, SettingsView } from "@cloudpid/extensions/settings";
import type { AgentChange } from "@cloudpid/protocol";
import {
  APPROVAL_ASK_TOOLS,
  type ApprovalToolName,
  GLOBAL_ID,
  GLOBAL_NAME,
  GLOBAL_SETTINGS_SCOPE,
} from "@cloudpid/protocol/harness-tools";
import type { HarnessAnswer } from "@cloudpid/protocol/mcp-api";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { ApprovalEnd } from "../registry/approvals.ts";
import type { ChangeRequest } from "../registry/change-requests.ts";
import type { AuthorSource } from "../session/change-author.ts";
import type { EndpointWrites } from "./services.ts";

/** What a core's refusal carries: the message the caller reads, and the code that maps, if any. */
export type CoreError = {
  readonly message: string;
  readonly code?: "not_found" | "invalid_argument" | "unsupported" | "unavailable";
};

/** An Agent change a claim recorded, as the Registry's lookup gives it (`ChangeRequest["changes"]`). */
export type ClaimedChange = ChangeRequest["changes"][number];

/**
 * How an approved request's apply went: `finished` with the change's answer (`wrote`: this run's write recorded the
 * changes under the request's claim, so the claim is settled with the answer), or ended with why nothing was changed.
 */
export type ApplyOutcome =
  | { readonly status: "finished"; readonly answer: HarnessAnswer; readonly wrote: boolean }
  | { readonly status: Exclude<ApprovalEnd, "finished">; readonly reason: string };

/** Where a change is: its Scope by id and name. */
export type ScopeRef = { readonly id: string; readonly name: string };

/** What a tool's `prepare` answers: the core's, with where the change is. */
export type PreparedAsk = Prepared<unknown> & { readonly scope: ScopeRef };

/** A tool that waits for the owner's Approval, as the endpoint asks and applies it: its arguments are its endpoint input. */
export type ApprovalTool = {
  readonly tool: string;
  /** The Settings page section its card shows in. */
  readonly section: string;
  /** The core's `prepare`, with where the change is. */
  readonly prepare: (args: Schema.Json) => Effect.Effect<PreparedAsk, CoreError>;
  /** The core's `apply` against `expected` as `author`, then its `render`. */
  readonly apply: (
    args: Schema.Json,
    expected: Schema.Json | null,
    author: ChangeAuthor,
  ) => Effect.Effect<ApplyOutcome, CoreError>;
  /** The answer of a write that committed before its run was cut: `render` of the Agent changes it recorded. */
  readonly fromClaim: (
    args: Schema.Json,
    expected: Schema.Json | null,
    changes: ReadonlyArray<ClaimedChange>,
  ) => Effect.Effect<HarnessAnswer, CoreError>;
};

/**
 * The tools, by name, each bound to the author source of the call that asks or of the request that applies: every tool
 * whose change waits for the owner's Approval has one.
 */
export type ApprovalToolTable = {
  readonly [Name in ApprovalToolName]: (source: AuthorSource) => ApprovalTool;
};

/** The refusal of arguments a tool cannot read (a request kept by a build with another schema). */
const unreadable = (tool: string): CoreError => ({
  message: `The request's arguments are not ones ${tool} reads now, so nothing was changed: ask again.`,
  code: "invalid_argument",
});

/** The answer of an applied request whose recorded changes are no longer kept: the read tools show the target now. */
export const notKept = (tool: string): HarnessAnswer => ({
  text: `The owner approved, and ${tool}'s change was made; its record is no longer kept, so settings_get or environment_get shows the target as it is now.`,
  structured: { replayed: true },
});

/** A change a claim recorded, as an Agent change: made over the endpoint, approved, by `tool` with `reason`. */
const agentChangeOf = (tool: string, reason: string, change: ClaimedChange): AgentChange => ({
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

/**
 * How a write went, by its result's status (a Settings' or an Environment's write, whose `missing` is refused): the target
 * has the change (`wrote`: this write made it, rather than finding it made), or the request ends without it.
 */
type WriteOutcome =
  | { readonly made: true; readonly wrote: boolean }
  | { readonly made: false; readonly end: Exclude<ApprovalEnd, "finished"> };

const writeOutcome = (result: { readonly status: string }): WriteOutcome => {
  switch (result.status) {
    case "changed":
      return { made: true, wrote: true };
    case "unchanged":
      return { made: true, wrote: false };
    case "changed-since":
      return { made: false, end: "changed_since" };
    default:
      return { made: false, end: "refused" };
  }
};

/**
 * The tool over `core`: `decode` reads its arguments (the endpoint input, as the dispatcher decoded and the Registry
 * kept it), `how` is what its `render` is told, and `rebuilt` rebuilds what `apply` would have answered from the Agent
 * changes a committed write recorded.
 */
const approvalTool = <
  Args extends { readonly reason: string },
  Known,
  Res extends { readonly status: string },
  E extends CoreError,
  How,
>({
  core,
  section,
  decode,
  scopeRef,
  how,
  rebuilt,
}: {
  readonly core: ApprovalCore<Args, Known, Res, E, How>;
  readonly section: string;
  readonly decode: (args: Schema.Json) => Option.Option<NoInfer<Args>>;
  /** Where the change is, from what `prepare` read of the target. */
  readonly scopeRef: (target: NoInfer<Known>) => ScopeRef;
  readonly how: (args: NoInfer<Args>) => How;
  /**
   * What `apply` would have answered of the write, rebuilt from the changes it recorded (`changes`, as Agent changes, and
   * `claimed`, as the claim's lookup gives them, with their Scopes' names).
   */
  readonly rebuilt: (
    args: NoInfer<Args>,
    changes: Arr.NonEmptyReadonlyArray<AgentChange>,
    claimed: Arr.NonEmptyReadonlyArray<ClaimedChange>,
  ) => Effect.Effect<Applied<Known, Res>, E>;
}): ApprovalTool => {
  const read = (args: Schema.Json) =>
    Effect.fromOption(decode(args)).pipe(Effect.mapError(() => unreadable(core.tool)));

  /** `render`'s answer, or its refusal (for a write that was not made, the reason the request ends with), as a `Result`. */
  const renderResult = (args: Args, expected: Schema.Json | null, applied: Applied<Known, Res>) =>
    core.render(args, expected, applied, how(args)).pipe(Effect.result);

  return {
    tool: core.tool,
    section,
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
        const outcome = writeOutcome(applied.result);
        const answer = yield* renderResult(decoded, expected, applied);
        const said = Result.isFailure(answer) ? answer.failure.message : answer.success.text;

        if (!outcome.made) return { status: outcome.end, reason: said };

        // A write the target has whose words could not be made is refused: nothing says what it did.
        return Result.isSuccess(answer)
          ? { status: "finished", answer: answer.success, wrote: outcome.wrote }
          : { status: "refused", reason: said };
      }),
    fromClaim: (args, expected, changes) =>
      Effect.gen(function* () {
        const decoded = yield* read(args);

        if (!Arr.isReadonlyArrayNonEmpty(changes)) return notKept(core.tool);

        const applied = yield* rebuilt(
          decoded,
          Arr.map(changes, (change) => agentChangeOf(core.tool, decoded.reason, change)),
          changes,
        );

        const answer = yield* renderResult(decoded, expected, applied);

        return Result.getOrElse(answer, () => notKept(core.tool));
      }),
  };
};

/** What a Settings change reaches, as the endpoint says it: no Session of the caller's runs with them. */
const settingsReach = (scope: string): SettingsHow => ({
  reach:
    scope === GLOBAL_SETTINGS_SCOPE
      ? "Each Session whose Environment does not override it takes it when it next admits input; a Run going keeps what it started with."
      : "The Environment's Sessions take it when they next admit input; a Run going keeps what it started with.",
});

/** A Settings view's Scope, by id and name. */
const settingsScopeRef = (view: SettingsView): ScopeRef =>
  "name" in view ? { id: view.scope, name: view.name } : { id: GLOBAL_ID, name: GLOBAL_NAME };

/** A Settings core's arguments: at a Scope, for a reason. */
type SettingsArgs = { readonly scope: string; readonly reason: string };

/** A Settings core, as the table builds it over the Settings' services of a call. */
type SettingsCoreOf<Args extends SettingsArgs> = (
  services: SettingsCoreServices,
) => ApprovalCore<Args, SettingsView, AppliedSettingsChange, CoreError, SettingsHow>;

/**
 * A Settings core's tool over `services`: its card at `section`, and its write rebuilt from the recorded changes over the
 * Scope as it is now.
 */
const settingsToolOf = <Args extends SettingsArgs>(
  services: SettingsCoreServices,
  core: ApprovalCore<Args, SettingsView, AppliedSettingsChange, CoreError, SettingsHow>,
  section: string,
  decode: (args: Schema.Json) => Option.Option<Args>,
): ApprovalTool =>
  approvalTool({
    core,
    section,
    decode,
    scopeRef: settingsScopeRef,
    how: (args) => settingsReach(args.scope),
    rebuilt: (args, changes) =>
      Effect.map(
        services.access.get(args.scope),
        (view): Applied<SettingsView, AppliedSettingsChange> => ({
          known: view,
          result: { status: "changed", changes },
        }),
      ),
  });

/** The arguments of `settings_reset` of a Limit of the Settings. */
const SettingsResetArgs = Schema.Struct({
  scope: Schema.String,
  field: Schema.String,
  reason: Schema.String,
});

/** The arguments of `environment_setting_reset` of an Environment's size limit (`maxInstance`). */
const SizeLimitResetArgs = Schema.Struct({
  id: Schema.String,
  setting: Schema.Literal("maxInstance"),
  reason: Schema.String,
});

/**
 * `settings_reset` of a Limit: the core of the Limit the arguments' `field` names (`limitOfField`, which the dispatcher
 * routes by too). A field that is no Limit is not asked for (the dispatcher resets it at once), and its arguments are
 * refused here.
 */
const settingsLimitReset = (services: SettingsCoreServices): ApprovalTool => {
  const decode = Schema.decodeUnknownOption(SettingsResetArgs);

  // The tool of the Limit the request's arguments name.
  const pick = (args: Schema.Json): Effect.Effect<ApprovalTool, CoreError> =>
    Effect.fromOption(Option.flatMap(decode(args), ({ field }) => limitOfField(field))).pipe(
      Effect.mapError(() => unreadable("settings_reset")),
      Effect.map((limit) =>
        settingsToolOf(services, resetSettingsLimitCore(services, limit), "limits", decode),
      ),
    );

  return {
    tool: "settings_reset",
    section: "limits",
    prepare: (args) => Effect.flatMap(pick(args), (tool) => tool.prepare(args)),
    apply: (args, expected, author) =>
      Effect.flatMap(pick(args), (tool) => tool.apply(args, expected, author)),
    fromClaim: (args, expected, changes) =>
      Effect.flatMap(pick(args), (tool) => tool.fromClaim(args, expected, changes)),
  };
};

/**
 * The tools that ask for an Approval on the endpoint, by name, over `writes`: built once, each bound to an author source
 * when a call asks or a request applies.
 */
export const approvalTools = (writes: EndpointWrites): ApprovalToolTable => {
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

  const settingsOf = (source: AuthorSource): SettingsCoreServices => ({
    access: writes.settings(source),
    plainText,
    surface: "endpoint",
  });

  const settingsTool =
    <Args extends SettingsArgs>(
      coreOf: SettingsCoreOf<Args>,
      section: string,
      decode: (args: Schema.Json) => Option.Option<Args>,
    ) =>
    (source: AuthorSource): ApprovalTool => {
      const services = settingsOf(source);

      return settingsToolOf(services, coreOf(services), section, decode);
    };

  return {
    settings_spend_limit_set: settingsTool(
      spendLimitCore,
      "limits",
      Schema.decodeUnknownOption(APPROVAL_ASK_TOOLS.settings_spend_limit_set.endpoint.input),
    ),
    settings_subagent_depth_set: settingsTool(
      subagentDepthCore,
      "limits",
      Schema.decodeUnknownOption(APPROVAL_ASK_TOOLS.settings_subagent_depth_set.endpoint.input),
    ),
    settings_subagent_workspaces_set: settingsTool(
      subagentWorkspacesCore,
      "limits",
      Schema.decodeUnknownOption(
        APPROVAL_ASK_TOOLS.settings_subagent_workspaces_set.endpoint.input,
      ),
    ),
    settings_instructions_set: settingsTool(
      instructionsCore,
      "instructions",
      Schema.decodeUnknownOption(APPROVAL_ASK_TOOLS.settings_instructions_set.endpoint.input),
    ),
    // An Environment's size limit (`maxInstance`) is edited with the Limits on the Settings page (`LimitsForm`).
    environment_container_size_limit_set: (source) =>
      approvalTool({
        core: sizeLimitCore({
          environments: writes.environments(source),
          plainText,
          surface: "endpoint",
        }),
        section: "limits",
        decode: Schema.decodeUnknownOption(
          APPROVAL_ASK_TOOLS.environment_container_size_limit_set.endpoint.input,
        ),
        scopeRef: (target) => target.environment,
        how: () => undefined,
        rebuilt: (_args, changes, claimed) => {
          const record = Arr.headNonEmpty(claimed);
          const environment = { id: record.scope, name: record.scopeName };

          return Effect.succeed({
            known: { environment, own: false },
            result: {
              status: "changed" as const,
              environment,
              change: Arr.headNonEmpty(changes),
            },
          });
        },
      }),
    // `settings_reset` of a Limit (the dispatcher hands only those here): one core per Limit, by its field.
    settings_reset: (source) => settingsLimitReset(settingsOf(source)),
    // `environment_setting_reset` of the size limit (S2a-4 serves the tool).
    environment_setting_reset: (source) => {
      const environments = writes.environments(source);

      return approvalTool({
        core: resetSizeLimitCore({
          environments,
          refuseSecrets: (texts) =>
            Effect.forEach(texts, ({ what, text }) => plainText(text, what, "Say it without it."), {
              discard: true,
            }),
          // `*` is refused as the reset of any other setting is: Global inherits nothing.
          target: (id) =>
            Effect.gen(function* () {
              yield* refuseGlobal(id, "endpoint");

              return { environment: id, own: false };
            }),
          surface: "endpoint",
        }),
        section: "limits",
        decode: Schema.decodeUnknownOption(SizeLimitResetArgs),
        scopeRef: (target) => ({ id: target.details.id, name: target.details.name }),
        how: () => undefined,
        rebuilt: (args, changes) =>
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
      });
    },
  };
};
