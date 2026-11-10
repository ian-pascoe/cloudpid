// docs/architecture/mcp-endpoint.md → Environment and Settings tools → Approvals with no Session (ADR-0050; #685 L2,
// #688 C3): the tools whose change waits for the owner's Approval, as the endpoint asks and applies them. Each adapts a
// shared core (`@cloudpid/extensions`: `prepare`, `apply`, `render`) to the arguments the Registry keeps with a request
// (the endpoint input, as JSON): its `prepare` with the Scope it reads, its `apply` against what the owner saw, settled
// as how the write went, and the answer rebuilt from the Agent changes a write recorded before its run was cut. The asking
// (`./approval-ask.ts`) and applying (`./approval-runner.ts`) parts look a tool up by name in `approvalTools`' table,
// built once, and bind it to the caller's author source per call. Every core answers in the endpoint's words
// (`surface: "endpoint"`): the owner, no Session, and only the tools the endpoint serves. An Environment's delete is
// long (#688 C2): its apply reports each step, where the run renews its lease, and the runner leaves the request
// approved for the next run when it fails (`./approval-runner.ts`), since every step of the removal is safe to repeat.
// A Skill's install or update at Global (→ Built so far: S3b-3; #685 L18) is multi-write, one transaction per Skill: a
// run cut after some committed is applied again under the same attempt, told the changes the claim recorded before
// (`earlier`), so a Skill kept already is found unchanged and told as kept by this request.
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
import {
  type DeleteKnown,
  environmentDeleteCore,
  secretDeleteCore,
  type StepProgress,
} from "@cloudpid/extensions/environment-deletes";
import { resetLimitCore as resetSizeLimitCore } from "@cloudpid/extensions/environment-reset";
import {
  type GlobalSkillCore,
  globalSkillCores,
  type GlobalSkillOutcome,
} from "@cloudpid/extensions/environment-skill-approvals";
import { sizeLimitCore } from "@cloudpid/extensions/environment-size-limit";
import type { AppliedSettingsChange, SettingsView } from "@cloudpid/extensions/settings";
import {
  type McpApprovalCoreOf,
  type McpAsked,
  type McpAskCore,
  mcpApprovalCores,
  type McpResetArgs,
} from "@cloudpid/extensions/settings-mcp-approvals";
import { parseMcpField } from "@cloudpid/config";
import type { AgentChange, ApprovalCardContent } from "@cloudpid/protocol";
import {
  APPROVAL_ASK_TOOLS,
  type ApprovalToolName,
  GLOBAL_ID,
  GLOBAL_NAME,
  GLOBAL_SETTINGS_SCOPE,
  HARNESS_TOOLS,
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

/**
 * What a tool's `prepare` answers: the core's, with where the change is and the section its card shows in (the tool's own,
 * except for `settings_reset`, whose card is the Limits' or the MCP servers' as the field says).
 */
export type PreparedAsk = Prepared<unknown> & {
  readonly scope: ScopeRef;
  readonly section: string;
};

/** What the Registry kept of an approved request for its apply: the endpoint input, `expected`, and the card approved. */
export type AskedRequest = {
  readonly args: Schema.Json;
  readonly expected: Schema.Json | null;
  readonly card: ApprovalCardContent;
};

/** A tool that waits for the owner's Approval, as the endpoint asks and applies it: its arguments are its endpoint input. */
export type ApprovalTool = {
  readonly tool: string;
  /** The Settings page section its card shows in. */
  readonly section: string;
  /** Whether its apply is long (an Environment's delete): `approval_wait` never runs it (#688 C2). */
  readonly long: boolean;
  /**
   * Whether its apply makes several writes, each committed alone (a Skill install or update at Global): a claim with
   * changes and no answer is applied again under the same attempt, told those changes (L18), rather than rebuilt.
   */
  readonly multiWrite: boolean;
  /** The core's `prepare`, with where the change is. */
  readonly prepare: (args: Schema.Json) => Effect.Effect<PreparedAsk, CoreError>;
  /**
   * The core's `apply` of the request `asked` (against its `expected`) as `author`, then its `render`; a long one
   * reports its steps to `progress`, where the run renews its lease. A multi-write one is told the changes an earlier run
   * of the request recorded under its claim (`earlier`), which its answer and outcome count as this request's.
   */
  readonly apply: (
    asked: AskedRequest,
    author: ChangeAuthor,
    progress?: StepProgress,
    earlier?: ReadonlyArray<ClaimedChange>,
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

/** The Settings page section an MCP server's card shows in. */
const MCP_SECTION = "mcp";

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
 * How a write went, by its result's status (a Settings' or an Environment's write, whose `missing` is refused; a delete's
 * `deleted`, or `absent` for one gone already): the target has the change (`wrote`: this write made it, rather than
 * finding it made), or the request ends without it.
 */
export type WriteOutcome =
  | { readonly made: true; readonly wrote: boolean }
  | { readonly made: false; readonly end: Exclude<ApprovalEnd, "finished"> };

const writeOutcome = (result: { readonly status: string }): WriteOutcome => {
  switch (result.status) {
    case "changed":
    case "deleted":
      return { made: true, wrote: true };
    case "unchanged":
    case "absent":
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
  long = false,
  multiWrite = false,
  outcomeOf = writeOutcome,
  run,
}: {
  readonly core: ApprovalCore<Args, Known, Res, E, How>;
  readonly section: string;
  /** Whether the apply is long (`ApprovalTool.long`). */
  readonly long?: boolean;
  /** Whether the apply makes several writes, each committed alone (`ApprovalTool.multiWrite`). */
  readonly multiWrite?: boolean;
  /**
   * How the write went, from its result and the changes an earlier run recorded under the claim: by the result's status
   * (`writeOutcome`), unless the tool reads its own (a Skill write's outcome is each Skill's).
   */
  readonly outcomeOf?: (result: NoInfer<Res>, earlier: ReadonlyArray<AgentChange>) => WriteOutcome;
  /**
   * The write of a long apply in place of `core.apply`: told of its steps, and of the card approved, from which it knows
   * its target once the target is gone. It records no Agent change, so it takes no author.
   */
  readonly run?: (
    args: NoInfer<Args>,
    asked: AskedRequest,
    progress: StepProgress | undefined,
  ) => Effect.Effect<Applied<NoInfer<Known>, NoInfer<Res>>, CoreError>;
  readonly decode: (args: Schema.Json) => Option.Option<NoInfer<Args>>;
  /** Where the change is, from what `prepare` read of the target. */
  readonly scopeRef: (target: NoInfer<Known>) => ScopeRef;
  /** What `render` is told, with the changes an earlier run of the request recorded under its claim (multi-write only). */
  readonly how: (args: NoInfer<Args>, earlier: ReadonlyArray<AgentChange>) => How;
  /**
   * What `apply` would have answered of the write, rebuilt from the changes it recorded (`changes`, as Agent changes, and
   * `claimed`, as the claim's lookup gives them, with their Scopes' names).
   */
  readonly rebuilt: (
    args: NoInfer<Args>,
    changes: Arr.NonEmptyReadonlyArray<AgentChange>,
    claimed: Arr.NonEmptyReadonlyArray<ClaimedChange>,
    expected: Schema.Json | null,
  ) => Effect.Effect<Applied<Known, Res>, E>;
}): ApprovalTool => {
  const read = (args: Schema.Json) =>
    Effect.fromOption(decode(args)).pipe(Effect.mapError(() => unreadable(core.tool)));

  /** `render`'s answer, or its refusal (for a write that was not made, the reason the request ends with), as a `Result`. */
  const renderResult = (
    args: Args,
    expected: Schema.Json | null,
    applied: Applied<Known, Res>,
    earlier: ReadonlyArray<AgentChange> = [],
  ) => core.render(args, expected, applied, how(args, earlier)).pipe(Effect.result);

  return {
    tool: core.tool,
    section,
    long,
    multiWrite,
    prepare: (args) =>
      Effect.flatMap(read(args), (decoded) =>
        Effect.map(core.prepare(decoded), (prepared) => ({
          ...prepared,
          scope: scopeRef(prepared.known),
          section,
        })),
      ),
    apply: (asked, author, progress, claimed = []) =>
      Effect.gen(function* () {
        const { args, expected } = asked;
        const decoded = yield* read(args);

        const earlier = Arr.map(claimed, (change) =>
          agentChangeOf(core.tool, decoded.reason, change),
        );

        const applied = yield* run === undefined
          ? core.apply(decoded, expected, author)
          : run(decoded, asked, progress);

        const outcome = outcomeOf(applied.result, earlier);
        const answer = yield* renderResult(decoded, expected, applied, earlier);
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

        const agentChanges = Arr.map(changes, (change) =>
          agentChangeOf(core.tool, decoded.reason, change),
        );

        const applied = yield* rebuilt(decoded, agentChanges, changes, expected);

        // A multi-write tool's rebuilt write holds none of the changes: it is told them as an earlier run's.
        const answer = yield* renderResult(
          decoded,
          expected,
          applied,
          multiWrite ? agentChanges : [],
        );

        return Result.getOrElse(answer, () => notKept(core.tool));
      }),
  };
};

/** A Skill write's outcome (`GlobalSkillCore["outcome"]`) as the request's. */
const skillWriteOutcome = (outcome: GlobalSkillOutcome): WriteOutcome => {
  switch (outcome) {
    case "wrote":
      return { made: true, wrote: true };
    case "found":
      return { made: true, wrote: false };
    case "changed_since":
      return { made: false, end: "changed_since" };
    case "refused":
      return { made: false, end: "refused" };
  }
};

/** The Skills page section a Skill change at Global shows its card in. */
const SKILLS_SECTION = "skills";

/**
 * A Skill tool at Global (`@cloudpid/extensions/environment-skill-approvals`): its card on the Skills section of Global, its
 * outcome each Skill's, and an install or update multi-write, one transaction per Skill.
 */
const globalSkillToolOf = <
  Args extends { readonly reason: string },
  Res extends { readonly status: string },
>(
  core: GlobalSkillCore<Args, Res>,
  decode: (args: Schema.Json) => Option.Option<Args>,
  multiWrite: boolean,
): ApprovalTool =>
  approvalTool({
    core,
    section: SKILLS_SECTION,
    decode,
    multiWrite,
    outcomeOf: (result, earlier) => skillWriteOutcome(core.outcome(result, earlier)),
    scopeRef: (known) => known,
    how: (_args, earlier) => ({ earlier }),
    rebuilt: (args, changes) =>
      Effect.succeed({
        known: { id: GLOBAL_ID, name: GLOBAL_NAME },
        result: core.rebuilt(args, changes),
      }),
  });

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
 * Whether `settings_reset`'s `field` is a field of an MCP server's adjustment, whose reset waits for the owner's Approval when
 * it widens: the one place the routing (the dispatcher's, and the table's pick) reads it.
 */
export const resetsMcpField = (field: string): boolean => parseMcpField(field) !== null;

/**
 * An MCP server's tool that asks (`@cloudpid/extensions/settings-mcp-approvals`): its card is the MCP servers' section's, its
 * Scope the view's, and an answer rebuilt from the changes a write recorded is worded over what the Registry says of where the
 * change reaches now.
 */
const mcpToolOf = <Args extends SettingsArgs>(
  core: McpAskCore<Args>,
  decode: (args: Schema.Json) => Option.Option<Args>,
): ApprovalTool =>
  approvalTool({
    core,
    section: MCP_SECTION,
    decode,
    scopeRef: (known) => settingsScopeRef(known.input.view),
    how: () => undefined,
    rebuilt: (args, changes, _claimed, expected) =>
      Effect.map(
        core.knownFromClaim(args, expected),
        (known): Applied<McpAsked, AppliedSettingsChange> => ({
          known,
          result: { status: "changed", changes },
        }),
      ),
  });

/**
 * `settings_reset` of a Limit or of an MCP server's key: the core of the Limit the arguments' `field` names (`limitOfField`,
 * which the dispatcher routes by too), or the MCP servers' core for a field of an adjustment. A field that is neither is not
 * asked for (the dispatcher resets it at once), and its arguments are refused here.
 */
const settingsReset = (
  services: SettingsCoreServices,
  mcp: () => McpAskCore<McpResetArgs>,
): ApprovalTool => {
  const decode = Schema.decodeUnknownOption(SettingsResetArgs);

  // The tool of the Limit, or of the MCP server's key, the request's arguments name; none for a field that is neither.
  const toolOf = ({ field }: typeof SettingsResetArgs.Type): Option.Option<ApprovalTool> =>
    Option.match(limitOfField(field), {
      onSome: (limit) =>
        Option.some(
          settingsToolOf(services, resetSettingsLimitCore(services, limit), "limits", decode),
        ),
      onNone: () => (resetsMcpField(field) ? Option.some(mcpToolOf(mcp(), decode)) : Option.none()),
    });

  const pick = (args: Schema.Json): Effect.Effect<ApprovalTool, CoreError> =>
    Effect.fromOption(Option.flatMap(decode(args), toolOf)).pipe(
      Effect.mapError(() => unreadable("settings_reset")),
    );

  return {
    tool: "settings_reset",
    section: "limits",
    long: false,
    multiWrite: false,
    prepare: (args) => Effect.flatMap(pick(args), (tool) => tool.prepare(args)),
    apply: (asked, author) => Effect.flatMap(pick(asked.args), (tool) => tool.apply(asked, author)),
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

  const mcpOf = (source: AuthorSource): McpApprovalCoreOf =>
    mcpApprovalCores({
      access: writes.settingsMcp(source),
      settings: writes.settings(source),
      // The Registry checks the kept Secrets in the write itself: a text that cannot be checked is refused, as holding one.
      holdsSecret: (text) => writes.holdsSecret(text).pipe(Effect.orElseSucceed(() => true)),
      sync: writes.mcpSync,
    });

  const skillCoresOf = (source: AuthorSource) =>
    globalSkillCores({
      environments: writes.environments(source),
      holdsSecret: writes.holdsSecret,
    });

  const mcpTool =
    <Args extends SettingsArgs>(
      pick: (cores: McpApprovalCoreOf) => () => McpAskCore<Args>,
      decode: (args: Schema.Json) => Option.Option<Args>,
    ) =>
    (source: AuthorSource): ApprovalTool =>
      mcpToolOf(pick(mcpOf(source))(), decode);

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
    // `settings_reset` of a Limit or of an MCP server's key (the dispatcher hands only those here): one core per Limit, by its
    // field, or the MCP servers' core.
    settings_reset: (source) => settingsReset(settingsOf(source), mcpOf(source).settings_reset),
    // The MCP servers' tools: the definitions and switching on always ask; the others only when they widen (the dispatcher
    // makes a narrowing change at once, on `prepare`'s `immediate`).
    settings_mcp_add: mcpTool(
      (cores) => cores.settings_mcp_add,
      Schema.decodeUnknownOption(APPROVAL_ASK_TOOLS.settings_mcp_add.endpoint.input),
    ),
    settings_mcp_update: mcpTool(
      (cores) => cores.settings_mcp_update,
      Schema.decodeUnknownOption(APPROVAL_ASK_TOOLS.settings_mcp_update.endpoint.input),
    ),
    settings_mcp_enable: mcpTool(
      (cores) => cores.settings_mcp_enable,
      Schema.decodeUnknownOption(APPROVAL_ASK_TOOLS.settings_mcp_enable.endpoint.input),
    ),
    settings_mcp_exposure_set: mcpTool(
      (cores) => cores.settings_mcp_exposure_set,
      Schema.decodeUnknownOption(HARNESS_TOOLS.settings_mcp_exposure_set.endpoint.input),
    ),
    settings_mcp_tool_exposure_set: mcpTool(
      (cores) => cores.settings_mcp_tool_exposure_set,
      Schema.decodeUnknownOption(HARNESS_TOOLS.settings_mcp_tool_exposure_set.endpoint.input),
    ),
    settings_mcp_remove: mcpTool(
      (cores) => cores.settings_mcp_remove,
      Schema.decodeUnknownOption(HARNESS_TOOLS.settings_mcp_remove.endpoint.input),
    ),
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
    // A Skill's install, update and removal at Global (S3b-3): each Skill kept only while the pin the owner approved holds.
    environment_skill_install: (source) =>
      globalSkillToolOf(
        skillCoresOf(source).environment_skill_install,
        Schema.decodeUnknownOption(HARNESS_TOOLS.environment_skill_install.endpoint.input),
        true,
      ),
    environment_skill_update: (source) =>
      globalSkillToolOf(
        skillCoresOf(source).environment_skill_update,
        Schema.decodeUnknownOption(HARNESS_TOOLS.environment_skill_update.endpoint.input),
        true,
      ),
    environment_skill_remove: (source) =>
      globalSkillToolOf(
        skillCoresOf(source).environment_skill_remove,
        Schema.decodeUnknownOption(HARNESS_TOOLS.environment_skill_remove.endpoint.input),
        false,
      ),
    // An Environment's delete (#688 C2): long, so `approval_wait` never runs it; the owner's Approve runs it inline, and
    // Try again or their next visit resumes one cut off. Its failure leaves the request approved (the runner's rule for a
    // long apply), its removal safe to run again; the run renews its lease after each step. It knows the Environment by
    // the card approved, which names it once its record is gone. Its card shows on the Environment's own section, where
    // the owner deletes it.
    environment_delete: (source) => {
      const core = environmentDeleteCore({
        environments: writes.environments(source),
        removal: writes.removal(source),
        plainText,
        surface: "endpoint",
      });

      return approvalTool({
        core,
        section: "environments",
        long: true,
        decode: Schema.decodeUnknownOption(APPROVAL_ASK_TOOLS.environment_delete.endpoint.input),
        scopeRef: (known) => known.environment,
        how: () => undefined,
        run: (args, { expected, card }, progress) =>
          core.applyWith(args, expected, core.knownFromCard(args, expected, card), progress),
        // It records no Agent change, so it claims nothing: a claim never holds its changes.
        rebuilt: (args, _changes, claimed) =>
          Effect.succeed({
            known: {
              environment: { id: args.id, name: Arr.headNonEmpty(claimed).scopeName },
              footprint: null,
            } satisfies DeleteKnown,
            result: { status: "absent" as const },
          }),
      });
    },
    // A kept Secret's delete: one write, recorded under the request's claim; the Builds' upkeep runs after it, in
    // `background`. Its card shows on the Secrets section of the Scope it is kept in.
    environment_secret_delete: (source) => {
      const core = secretDeleteCore({
        environments: writes.environments(source),
        removal: writes.removal(source),
        plainText,
        surface: "endpoint",
      });

      return approvalTool({
        core,
        section: "secrets",
        decode: Schema.decodeUnknownOption(
          APPROVAL_ASK_TOOLS.environment_secret_delete.endpoint.input,
        ),
        scopeRef: (known) => known.scope,
        how: () => undefined,
        rebuilt: (args, changes, claimed) => {
          const record = Arr.headNonEmpty(claimed);
          const scope = { id: record.scope, name: record.scopeName };

          return Effect.succeed({
            known: core.knownFromClaim(args, scope),
            result: {
              status: "deleted" as const,
              environment: scope,
              change: Arr.headNonEmpty(changes),
            },
          });
        },
      });
    },
  };
};
