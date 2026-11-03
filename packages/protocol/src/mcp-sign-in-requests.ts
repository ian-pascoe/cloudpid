// A Sign-in request as its card shows it (`docs/architecture/mcp-sign-in.md` → Sign-in requests): the agent asked the owner
// to sign in to an MCP server. The Session sends these in `mcp_sign_in_requests` and the owner answers a decline with
// `mcp_sign_in_answer`; the sign-in itself happens at `/oauth/mcp/start`, which the card links to. Nothing here is a URL
// beyond a host, a code, a token or a secret.
import * as Schema from "effect/Schema";
import { ConversationId } from "./conversation-id.ts";
import { McpElicitationSource } from "./mcp-elicitation.ts";

/** The longest reason the agent gives, in characters: what the card shows and the Notification carries. */
export const MAX_SIGN_IN_REASON = 300;

/**
 * One open Sign-in request. Every string is plain text; `reason` is the agent's own words and the card marks it so.
 * `why` is what stands in the way: `required`, `step_up`, `rejected` or `refresh_failing` (a string, so a state a later
 * build adds still reads).
 */
export const McpSignInRequest = Schema.Struct({
  /** What an answer names, and what the start link carries: unique within the Session. */
  id: Schema.String,
  /** The root conversation whose agent asked. */
  conversationId: ConversationId,
  /** The server's configured name, never what it calls itself. */
  server: Schema.String,
  /** The Environment whose set the server is in: the start link names it. */
  environment: Schema.String,
  /** Where the definition is, for the card's badge. */
  source: Schema.optionalKey(McpElicitationSource),
  /** The host of the server's URL. */
  urlHost: Schema.String,
  /** The host of the authorization server, when it is known before the sign-in starts. */
  issuerHost: Schema.optionalKey(Schema.String),
  /** Why the agent asks: the agent's words. */
  reason: Schema.String,
  why: Schema.String,
  /** The scopes a step-up asks for. */
  scopes: Schema.Array(Schema.String),
  /** The sign-in's last problem, when it has one. */
  problem: Schema.optionalKey(Schema.String),
  /** Epoch milliseconds the request was made. */
  askedAt: Schema.Finite,
});

export type McpSignInRequest = typeof McpSignInRequest.Type;
