/**
 * The management tools as the SDK is given them (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools →
 * The dispatcher and `describe().harness`): each tool the shared declarations (`@cloudpid/protocol/harness-tools`) know,
 * offered only when `describe().harness` lists it. `McpServer` knows a tool's name, description, schemas and annotations;
 * the main Worker's `harness` operation runs its core and answers `{text, structured}`. This wraps them as the session tools'
 * are: the text is the core's (the same words as in a Session, cut for the endpoint) with the `next` sentence added as its
 * last paragraph, and `structuredContent` is the core's flat object with the same sentence as its optional `next`. A
 * write's `request_id` travels as the request's `requestId` too, so the dispatcher handles it in one place. The two tools
 * that follow an Approval asked over the endpoint (`approval_wait`, `approval_withdraw`; → Approvals with no Session) have
 * operations of their own, and their words are written here.
 */
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferTypedSchemaDecoder:off -- an answer is read for the keys `next` needs, whatever else it holds.
import {
  APPROVAL_FOLLOW_TOOLS,
  type ApprovalFollowToolName,
  type DispatchedToolName,
  ENVIRONMENT_FIELD_WORDS,
  HARNESS_TOOLS,
  type HarnessToolName,
  isApprovalFollowTool,
  MAX_PAGE_CHARS,
} from "@cloudpid/protocol/harness-tools";
import {
  ApiResult,
  apiFailure,
  ApprovalState,
  HarnessAnswer,
  harnessServed,
} from "@cloudpid/protocol/mcp-api";
import * as Arr from "effect/Array";
import type * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type { Enabled, Tool, Wire } from "./tools.ts";

/**
 * The most characters of a management tool's text: a field page whole (`MAX_PAGE_CHARS`), plus 1,000 for the footer that
 * says where the page sits in the field and for the `next` sentence. The core cuts every other answer so that its text
 * and `next` fit `ENDPOINT_TEXT_CHARS` (`NEXT_RESERVE_CHARS` is left for `next`), so only a page comes near this.
 */
export const HARNESS_MAX_TEXT_CHARS = MAX_PAGE_CHARS + 1_000;

/** What `tools/list` titles each tool (every name is here: the type holds it to `HARNESS_TOOLS`). */
const TITLES: Readonly<Record<HarnessToolName, string>> = {
  environment_list: "List Environments to manage",
  environment_get: "Show an Environment",
  environment_variable_set: "Set an Environment variable",
  environment_variable_unset: "Unset an Environment variable",
  environment_container_resize: "Set an Environment's Container size",
  environment_idle_time_set: "Set an Environment's idle time",
  environment_setup_script_set: "Set an Environment's Setup Script",
  environment_start_script_set: "Set an Environment's Start Script",
  environment_toolchains_set: "Set an Environment's Toolchains",
  environment_ignore_set: "Set an Environment's Container-only paths",
  environment_spare_workspace_set: "Set an Environment's Spare Workspace",
  environment_secret_build: "Mark a Secret for the Build",
  environment_create: "Make an Environment",
  environment_rename: "Rename an Environment",
  environment_repo_add: "Add a repo to an Environment",
  environment_repo_remove: "Take a repo out of an Environment",
  environment_rebuild: "Rebuild an Environment",
  environment_skill_install: "Install Skills for an Environment",
  environment_skill_update: "Update an Environment's Skills",
  environment_skill_remove: "Remove an Environment's Skill",
  environment_setting_reset: "Reset an Environment's setting to Global's",
  settings_get: "Show Settings",
  settings_mcp_list: "List MCP servers",
  settings_mcp_get: "Show an MCP server",
  settings_model_set: "Set the default model",
  settings_role_set: "Set a role's model",
  settings_tool_offer: "Offer tools to every conversation",
  settings_tool_defer: "Stop offering tools to every conversation",
  settings_compaction_set: "Set compaction",
  settings_branch_summary_set: "Set the branch summary prompt",
  settings_extension_set: "Set an extension's option",
  settings_reset: "Reset a setting",
  settings_mcp_reload: "Reload an Environment's MCP servers",
  settings_mcp_disable: "Switch an MCP server off",
  settings_mcp_exposure_set: "Set an MCP server's exposure",
  settings_mcp_tool_exposure_set: "Set an MCP server's tool exposure",
  settings_mcp_remove: "Remove an MCP server",
  settings_mcp_add: "Ask to add an MCP server",
  settings_mcp_update: "Ask to change an MCP server's definition",
  settings_mcp_enable: "Ask to switch an MCP server on",
  settings_spend_limit_set: "Ask to set the spend limit",
  settings_subagent_depth_set: "Ask to set the subagent depth",
  settings_subagent_workspaces_set: "Ask to set the Subagent Workspace limit",
  settings_instructions_set: "Ask to set the Instructions",
  environment_container_size_limit_set: "Ask to set an Environment's size limit",
  environment_delete: "Ask to delete an Environment",
  environment_secret_delete: "Ask to delete a kept Secret",
  approval_wait: "Wait for the owner's Approval",
  approval_withdraw: "Withdraw a request for Approval",
};

const decode = Schema.decodeUnknownExit(ApiResult(HarnessAnswer));

/** What `next` reads of a page, whichever tool answers it: where it is and where the next begins. */
const PageKeys = {
  id: Schema.optionalKey(Schema.String),
  field: Schema.optionalKey(Schema.String),
  next_offset: Schema.optionalKey(Schema.Int),
};

const ScopeKey = Schema.Struct({ id: Schema.String });

const InstructionsKey = Schema.Struct({ text_truncated: Schema.Boolean });

/**
 * A tool's `next` sentence: the keys of its answer it reads (only those, so an answer with more or less is still read),
 * and what follows from them, over the tools that are served.
 */
const nextOf =
  <S extends Schema.Decoder<unknown>>(
    keys: S,
    sentence: (value: S["Type"], enabled: Enabled) => string | undefined,
  ) =>
  (structured: Wire, enabled: Enabled): string | undefined =>
    Option.getOrUndefined(
      Option.flatMap(Schema.decodeUnknownOption(keys)(structured), (value) =>
        Option.fromNullishOr(sentence(value, enabled)),
      ),
    );

/** The call for the page after one that was cut: the same field, from where the page ended. */
const nextPage = (
  tool: string,
  key: "id" | "scope",
  page: { readonly id?: string; readonly field?: string; readonly next_offset?: number },
): string | undefined =>
  page.id === undefined || page.field === undefined || page.next_offset === undefined
    ? undefined
    : `Call ${tool} with ${key}="${page.id}", field="${page.field}" and offset=${String(page.next_offset)} for the next page.`;

/**
 * What follows a change: `environment_get` shows the Scope as it is now, which a replayed answer (built from the records,
 * with no Build state) sends the caller to.
 */
const afterChange = nextOf(
  Schema.Struct({
    scope: Schema.optionalKey(ScopeKey),
    changes: Schema.Unknown.pipe(Schema.Array, Schema.optionalKey),
    replayed: Schema.optionalKey(Schema.Boolean),
  }),
  (value, enabled) =>
    enabled.has("environment_get") &&
    value.scope !== undefined &&
    (value.replayed === true || (value.changes?.length ?? 0) > 0)
      ? `Call environment_get with id="${value.scope.id}" to see the settings and the Build as they are now.`
      : undefined,
);

/** What follows a change to the Settings: `settings_get` shows the Scope as it is now, as for a replayed answer. */
const afterSettingsChange = nextOf(
  Schema.Struct({
    scope: Schema.optionalKey(ScopeKey),
    changes: Schema.Unknown.pipe(Schema.Array, Schema.optionalKey),
    replayed: Schema.optionalKey(Schema.Boolean),
  }),
  (value, enabled) =>
    enabled.has("settings_get") &&
    value.scope !== undefined &&
    (value.replayed === true || (value.changes?.length ?? 0) > 0)
      ? `Call settings_get with scope="${value.scope.id}" to see the settings as they are now.`
      : undefined,
);

/** What follows a change to an MCP server, or a reload: `settings_mcp_list` shows the Scope's servers as they are now. */
const afterServersChange = nextOf(
  Schema.Struct({
    scope: Schema.optionalKey(ScopeKey),
    changes: Schema.Unknown.pipe(Schema.Array, Schema.optionalKey),
    replayed: Schema.optionalKey(Schema.Boolean),
  }),
  (value, enabled) =>
    enabled.has("settings_mcp_list") &&
    value.scope !== undefined &&
    (value.replayed === true || value.changes === undefined || value.changes.length > 0)
      ? `Call settings_mcp_list with scope="${value.scope.id}" to see the servers as they are now.`
      : undefined,
);

/** What follows an ask: `approval_wait` with the request's id, for a request that waits. */
const afterAsk = nextOf(
  Schema.Struct({ status: Schema.String, approval_id: Schema.optionalKey(Schema.String) }),
  (value, enabled) =>
    enabled.has("approval_wait") && value.status === "pending" && value.approval_id !== undefined
      ? `Call approval_wait with approval_id="${value.approval_id}" to follow the owner's answer; only the owner answers, in cloudpid at the url shown.`
      : undefined,
);

/**
 * What follows a change to an MCP server that asks only when it widens: `approval_wait` when the owner was asked, else
 * `settings_mcp_list`, as for a change that was made.
 */
const afterServersAsk = (structured: Wire, enabled: Enabled): string | undefined =>
  afterAsk(structured, enabled) ?? afterServersChange(structured, enabled);

/** What follows a reset: `approval_wait` for a Limit's, which waits for the owner, else `settings_get`. */
const afterReset = (structured: Wire, enabled: Enabled): string | undefined =>
  afterAsk(structured, enabled) ?? afterSettingsChange(structured, enabled);

/**
 * What follows an Environment's change that may ask: `approval_wait` for one that waits for the owner (the reset of the size
 * limit, a Skill change at Global), else `environment_get`.
 */
const afterEnvironmentAsk = (structured: Wire, enabled: Enabled): string | undefined =>
  afterAsk(structured, enabled) ?? afterChange(structured, enabled);

const NEXTS: Readonly<
  Record<DispatchedToolName, (structured: Wire, enabled: Enabled) => string | undefined>
> = {
  settings_model_set: afterSettingsChange,
  settings_role_set: afterSettingsChange,
  settings_tool_offer: afterSettingsChange,
  settings_tool_defer: afterSettingsChange,
  settings_compaction_set: afterSettingsChange,
  settings_branch_summary_set: afterSettingsChange,
  settings_extension_set: afterSettingsChange,
  settings_reset: afterReset,
  settings_mcp_reload: afterServersChange,
  settings_mcp_disable: afterServersChange,
  settings_mcp_exposure_set: afterServersAsk,
  settings_mcp_tool_exposure_set: afterServersAsk,
  settings_mcp_remove: afterServersAsk,
  settings_mcp_add: afterAsk,
  settings_mcp_update: afterAsk,
  settings_mcp_enable: afterAsk,
  settings_spend_limit_set: afterAsk,
  settings_subagent_depth_set: afterAsk,
  settings_subagent_workspaces_set: afterAsk,
  settings_instructions_set: afterAsk,
  environment_container_size_limit_set: afterAsk,
  environment_delete: afterAsk,
  environment_secret_delete: afterAsk,
  environment_variable_set: afterChange,
  environment_variable_unset: afterChange,
  environment_container_resize: afterChange,
  environment_idle_time_set: afterChange,
  environment_setup_script_set: afterChange,
  environment_start_script_set: afterChange,
  environment_toolchains_set: afterChange,
  environment_ignore_set: afterChange,
  environment_spare_workspace_set: afterChange,
  environment_secret_build: afterChange,
  environment_create: afterChange,
  environment_rename: afterChange,
  environment_repo_add: afterChange,
  environment_repo_remove: afterChange,
  environment_rebuild: afterChange,
  environment_skill_install: afterEnvironmentAsk,
  environment_skill_update: afterEnvironmentAsk,
  environment_skill_remove: afterEnvironmentAsk,
  environment_setting_reset: afterEnvironmentAsk,
  environment_list: nextOf(
    Schema.Struct({ environments: Schema.Array(Schema.Unknown) }),
    ({ environments }, enabled) =>
      enabled.has("environment_get") && environments.length > 0
        ? "Call environment_get with an id to see one Environment's settings."
        : undefined,
  ),
  environment_get: nextOf(
    Schema.Struct({
      ...PageKeys,
      scope: Schema.optionalKey(ScopeKey),
      settings_truncated: Schema.optionalKey(Schema.Boolean),
      variables: Schema.Struct({ value_truncated: Schema.Boolean }).pipe(
        Schema.Array,
        Schema.optionalKey,
      ),
    }),
    (value) => {
      const page = nextPage("environment_get", "id", value);

      if (page !== undefined) return page;

      const cutValue = value.variables?.some((variable) => variable.value_truncated) === true;

      return value.scope !== undefined && (value.settings_truncated === true || cutValue)
        ? `Call environment_get with id="${value.scope.id}" and field (${ENVIRONMENT_FIELD_WORDS}) to read a cut text whole.`
        : undefined;
    },
  ),
  settings_get: nextOf(
    Schema.Struct({
      ...PageKeys,
      scope: Schema.optionalKey(ScopeKey),
      instructions: Schema.optionalKey(
        Schema.Struct({
          global: InstructionsKey,
          environment: Schema.NullOr(InstructionsKey),
        }),
      ),
    }),
    (value) => {
      const page = nextPage("settings_get", "scope", value);

      if (page !== undefined) return page;

      if (value.scope === undefined || value.instructions === undefined) return undefined;

      // A cut text is read through the Scope it is kept in: Global's at "*", an Environment's own at its id.
      const cut = Arr.filter(
        [
          value.instructions.global.text_truncated ? "*" : undefined,
          value.instructions.environment?.text_truncated === true ? value.scope.id : undefined,
        ],
        (scope) => scope !== undefined,
      );

      return cut.length === 0
        ? undefined
        : `Call settings_get with field="instructions" and scope ${Arr.join(
            Arr.map(cut, (scope) => `"${scope}"`),
            " or ",
          )} to read the cut Instructions whole.`;
    },
  ),
  settings_mcp_list: nextOf(
    Schema.Struct({ scope: ScopeKey, servers: Schema.Array(Schema.Unknown) }),
    (value, enabled) =>
      enabled.has("settings_mcp_get") && value.servers.length > 0
        ? `Call settings_mcp_get with scope="${value.scope.id}" and a server's name to see it in full.`
        : undefined,
  ),
  settings_mcp_get: () => undefined,
};

/** A management tool, from its declaration. */
const harnessTool = (name: DispatchedToolName): Tool => {
  const declaration = HARNESS_TOOLS[name];

  return {
    name,
    title: TITLES[name],
    served: (description) =>
      description.operations.includes("harness") && harnessServed(description).includes(name),
    maxText: HARNESS_MAX_TEXT_CHARS,
    describe: () => declaration.endpoint.description,
    annotations: declaration.annotations,
    progress: undefined,
    span: undefined,
    input: declaration.endpoint.input,
    output: declaration.endpoint.output,
    call: (api, args, via) => {
      if (api.harness === undefined) {
        return Promise.resolve(
          apiFailure("unsupported", "The server does not support this yet: try again shortly."),
        );
      }

      // A write's `request_id`, as the caller sent it: the dispatcher reads it from the request, not the input.
      const requestId = Predicate.isReadonlyObject(args) ? args["request_id"] : undefined;

      return api.harness(
        Predicate.isString(requestId)
          ? { tool: name, input: args, requestId, via }
          : { tool: name, input: args, via },
      );
    },
    // SAFETY: the result's own type is erased here, as `Tool` says.
    read: (answered) => decode(answered) as Exit.Exit<ApiResult<Wire>, Schema.SchemaError>,
    present: (value, enabled) => {
      // SAFETY: `value` was decoded with `HarnessAnswer`.
      const { text, structured } = value as HarnessAnswer;

      // SAFETY: every management tool's structured value is a flat object (`harness-tools.test.ts` holds its schema to one).
      const flat = structured as Readonly<Record<string, Wire>>;

      const next = NEXTS[name](structured, enabled);

      return next === undefined
        ? { text, structured: flat }
        : { text: `${text}\n\n${next}`, structured: { ...flat, next } };
    },
  };
};

const decodeState = Schema.decodeUnknownExit(ApiResult(ApprovalState));

/** "2m10s" for 130 seconds. */
const elapsedWords = (seconds: number): string =>
  seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;

/** A request as `approval_wait` and `approval_withdraw` say it, without `next`. */
export const renderApprovalState = (state: ApprovalState): string => {
  const request = `Request ${state.approval_id} (${state.tool})`;
  const because = state.reason === undefined ? "" : `: ${state.reason}`;

  const said = (() => {
    switch (state.status) {
      case "pending":
        return `${request} waits for the owner's answer; it expires ${state.expires_at} if they do not answer.`;
      case "approved":
        return state.long === true
          ? `The owner approved ${request}; cloudpid applies it while the owner has cloudpid open, and approval_wait does not run it.`
          : `The owner approved ${request}; its change is being applied.`;
      case "finished":
        return state.result?.text ?? `The owner approved ${request}, and its change was applied.`;
      case "declined":
        return `The owner declined ${request}${because}. Nothing was changed.`;
      case "changed_since":
      case "refused":
        return `The owner approved ${request}, but it was not applied${because}`;
      case "expired":
        return `${request} expired before the owner answered: nothing was changed.`;
      case "withdrawn":
        return `${request} was withdrawn${because}. Nothing was changed.`;
      default:
        return `${request} is ${state.status}${because}`;
    }
  })();

  return state.interrupted === true
    ? `${said} (The wait was cut short, so this is the request as read once after.)`
    : said;
};

/** What follows a request's state: another wait while something may still happen to it. */
const afterState = (state: ApprovalState, enabled: Enabled): string | undefined => {
  if (!enabled.has("approval_wait") || state.finished) return undefined;

  if (state.status === "pending") {
    return `Call approval_wait again with approval_id="${state.approval_id}" to keep waiting; only the owner answers, in cloudpid.`;
  }

  // A long apply (an Environment's delete) is never the wait's to run: the owner's visit or Try again finishes it.
  return state.long === true
    ? `cloudpid finishes it when the owner opens cloudpid or presses Try again on its card; call approval_wait again later with approval_id="${state.approval_id}" to see it finished.`
    : `Call approval_wait again with approval_id="${state.approval_id}" to see its change applied.`;
};

/** `approval_wait` or `approval_withdraw`, from its declaration, over its own operation. */
const approvalFollowTool = (name: ApprovalFollowToolName): Tool => {
  const declaration = APPROVAL_FOLLOW_TOOLS[name];
  const operation = name === "approval_wait" ? "approvalWait" : "approvalWithdraw";

  return {
    name,
    title: TITLES[name],
    served: (description) => description.operations.includes(operation),
    maxText: HARNESS_MAX_TEXT_CHARS,
    describe: () => declaration.endpoint.description,
    annotations: declaration.annotations,
    progress:
      name === "approval_wait"
        ? (elapsedS) => `Waiting for the owner · ${elapsedWords(elapsedS)}`
        : undefined,
    span:
      name === "approval_wait"
        ? (value) => {
            // SAFETY: `value` was decoded with `ApprovalState`.
            const state = value as ApprovalState;

            return state.interrupted === true
              ? { status: state.status, interrupted: true }
              : { status: state.status };
          }
        : undefined,
    input: declaration.endpoint.input,
    output: declaration.endpoint.output,
    call: (api, args) => {
      const run = name === "approval_wait" ? api.approvalWait : api.approvalWithdraw;

      if (run === undefined) {
        return Promise.resolve(
          apiFailure("unsupported", "The server does not support this yet: try again shortly."),
        );
      }

      // SAFETY: the SDK validated `args` against the tool's input, which the operation's request is.
      return run(args as never);
    },
    // SAFETY: the result's own type is erased here, as `Tool` says.
    read: (answered) => decodeState(answered) as Exit.Exit<ApiResult<Wire>, Schema.SchemaError>,
    present: (value, enabled) => {
      // SAFETY: `value` was decoded with `ApprovalState`.
      const state = value as ApprovalState;
      // SAFETY: a state is a flat object of JSON, as `value` is.
      const flat = value as Readonly<Record<string, Wire>>;
      const text = renderApprovalState(state);
      const next = afterState(state, enabled);

      return next === undefined
        ? { text, structured: flat }
        : { text: `${text}\n\n${next}`, structured: { ...flat, next } };
    },
  };
};

/** Every management tool `McpServer` knows, in the order `HARNESS_TOOLS` declares them. */
// SAFETY: the keys of the record are its tools' names.
export const harnessTools: ReadonlyArray<Tool> = Record.keys(HARNESS_TOOLS).map((name) =>
  isApprovalFollowTool(name) ? approvalFollowTool(name) : harnessTool(name),
);
