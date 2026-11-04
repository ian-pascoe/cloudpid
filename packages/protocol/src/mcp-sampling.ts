// An MCP server's Sampling request as the owner's card shows it (`docs/architecture/mcp-server-requests.md` → Sampling
// requests, The card): the server asked for a model reply, and the card lists what it asked, the Role and model that would
// answer, and the owner's choices. The Session sends these in `mcp_sampling_requests`, the owner answers with
// `mcp_sampling_answer`, and `mcp_sampling_get` fetches a settled record when a call's card expands it. Every string is
// plain text, redacted of the Secrets the Session holds, and cut: a card never shows a server's request whole.
import { ROLE_NAMES } from "@cloudpid/config";
import * as Schema from "effect/Schema";
import { ConversationId } from "./conversation-id.ts";
import { McpElicitationSource } from "./mcp-elicitation.ts";

/** The Roles a Sampling request may run on: the model the owner has chosen for each, `small` to `xlarge`. */
export const McpSamplingRole = Schema.Literals(ROLE_NAMES);

export type McpSamplingRole = typeof McpSamplingRole.Type;

/**
 * A Role as a client reads it in what the Session pushes: a string, so a Role a later build adds does not drop the whole
 * message in an older tab. `McpSamplingRole` is what the owner's answer may name.
 */
export const McpSamplingRoleName = Schema.String;

/** One Role the owner may pick, and the model that answers on it. */
export const McpSamplingRoleOption = Schema.Struct({
  role: McpSamplingRoleName,
  model: Schema.String,
});

export type McpSamplingRoleOption = typeof McpSamplingRoleOption.Type;

/** One message of the request, as plain text: images, tool use and tool results are named, never drawn. */
export const McpSamplingMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
});

export type McpSamplingMessage = typeof McpSamplingMessage.Type;

/** A tool the server offers the model. cloudpid never runs it. */
export const McpSamplingTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
});

export type McpSamplingTool = typeof McpSamplingTool.Type;

/** What the server asked, as a card and a settled record both show it. */
const Asked = {
  /** The server's configured name, never what it calls itself. */
  server: Schema.String,
  /** The model-facing name of the tool whose call the request came in. */
  tool: Schema.String,
  /** The Role the request runs on (the owner's pick, once answered) and the model that answers on it. */
  role: Schema.optionalKey(McpSamplingRoleName),
  model: Schema.optionalKey(Schema.String),
  systemPrompt: Schema.optionalKey(Schema.String),
  /** The request's messages that the call's earlier requests did not carry, the last ones when there are many. */
  messages: Schema.Array(McpSamplingMessage),
  /** How many of those messages are left out, when some are. */
  omitted: Schema.optionalKey(Schema.Int),
  tools: Schema.Array(McpSamplingTool),
  /** What cloudpid ignored or changed in the request, one line each. */
  notes: Schema.Array(Schema.String),
};

/**
 * One waiting Sampling request (`mcp_sampling_requests`). `deadline` is the moment, in epoch milliseconds, the Session
 * refuses it for the owner, so the countdown follows the Session's clock; a request with `waits: "owner"` (a Modern
 * server's, kept for later) has none, and its `deadline` is only for a client from before `waits` (a far one).
 */
export const McpSamplingRequest = Schema.Struct({
  ...Asked,
  /** What the answer names: unique within the Session. */
  id: Schema.String,
  /** The call that waits for it. */
  callId: Schema.String,
  /** The conversation whose call it is: the root agent's or a subagent's. */
  conversationId: ConversationId,
  /** Where the definition is, for the card's badge; absent when the Session does not know. */
  source: Schema.optionalKey(McpElicitationSource),
  /**
   * The title of the MCP prompt whose send waits for the answer ("getting prompt <title>"): the request was made during
   * its `prompts/get`, not a tool's call. A client from before it reads `tool`, the prompt's command.
   */
  prompt: Schema.optionalKey(Schema.String),
  /**
   * The request was made during a `tools/call` of an App View (`docs/architecture/mcp-apps.md` → Server requests from an App
   * View's calls): the card's origin line reads "<server>'s app". A client from before it reads `tool`.
   */
  app: Schema.optionalKey(Schema.Literal(true)),
  /**
   * The handle of the MCP task whose request this is ("MCP task <handle>"): the server asked it of a task that goes on
   * after its call, so no call waits for the answer. A client from before it reads `tool`, the task's tool.
   */
  task: Schema.optionalKey(Schema.String),
  /** The Role the request would run on unless the owner picks another, and its model. */
  role: McpSamplingRoleName,
  model: Schema.String,
  /** The Roles the owner may pick, those with a model the Session has. */
  roles: Schema.Array(McpSamplingRoleOption),
  /**
   * Whether the card may write the definition's `sampling` ("Always allow", "Never"): the server's definition is the owner's,
   * at Global or in the Environment, not a Repo's file, and the Session is one the Registry lists with an Environment.
   */
  writable: Schema.Boolean,
  deadline: Schema.Finite,
  /**
   * `"owner"` for a Modern server's request, which waits for the owner with no deadline (it is answered in the call's
   * resume); absent for a Legacy server's, whose call ends at `deadline`. A client from before it ignores the key. A
   * string, so a value a later build adds does not drop the whole push in an older tab (_Sockets_).
   */
  waits: Schema.optionalKey(Schema.String),
});

export type McpSamplingRequest = typeof McpSamplingRequest.Type;

/**
 * How the owner answers a Sampling request: **Allow for this call** (it covers the call's later requests), **Allow in this
 * Session** (the server, every conversation of the Session), **Always allow** (writes `sampling: "allow"` in the
 * definition), **Refuse**, **Refuse in this Session** and **Never** (writes `off`).
 */
export const McpSamplingChoice = Schema.Literals([
  "allow_call",
  "allow_session",
  "allow_always",
  "refuse",
  "refuse_session",
  "refuse_never",
]);

export type McpSamplingChoice = typeof McpSamplingChoice.Type;

/**
 * What a Session grant lets or stops a server do: sample without asking (`allow`), or be refused without asking
 * (`refuse`). A string, so an action a later build adds reads as it is in an older tab.
 */
export const McpSamplingGrantAction = Schema.String;

export type McpSamplingGrantAction = typeof McpSamplingGrantAction.Type;

/** A Session grant: the owner's choice for a server, for every conversation of the Session, until the Session ends. */
export const McpSamplingSessionGrant = Schema.Struct({
  server: Schema.String,
  action: McpSamplingGrantAction,
});

export type McpSamplingSessionGrant = typeof McpSamplingSessionGrant.Type;

/**
 * A settled Sampling request, as `mcp_sampling_get` returns it and a call's card expands it: what was asked and what came
 * of it. `by` is who decided: the server's definition (`allow`), the owner on the card or by a grant, or cloudpid's own
 * rules. A record cut to a stub (`stub`) has no messages, tools, reply or system prompt.
 */
export const McpSamplingRecordView = Schema.Struct({
  ...Asked,
  id: Schema.String,
  callId: Schema.String,
  /** `answered`, `refused`, `failed`, `waiting` or `running`; a string, so one a later build adds still reads. */
  status: Schema.String,
  /** `definition`, `owner`, `grant` or `cloudpid`; a string, as `status` is. */
  by: Schema.String,
  /** Why it was refused or failed, in cloudpid's words. */
  reason: Schema.optionalKey(Schema.String),
  /** The reply's text, cut. */
  reply: Schema.optionalKey(Schema.String),
  stopReason: Schema.optionalKey(Schema.String),
  tokens: Schema.optionalKey(Schema.Finite),
  cost: Schema.optionalKey(Schema.Finite),
  askedAt: Schema.Finite,
  settledAt: Schema.optionalKey(Schema.Finite),
  stub: Schema.optionalKey(Schema.Literal(true)),
});

export type McpSamplingRecordView = typeof McpSamplingRecordView.Type;
