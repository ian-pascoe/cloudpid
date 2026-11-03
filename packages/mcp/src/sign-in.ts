/**
 * The Registry's MCP sign-in edge, as `McpHost` calls it (`docs/architecture/mcp-sign-in.md` → Tokens reach the host
 * object): `mcpAccessToken`, `reportMcpAuth` and the revision of the sign-ins. Plain data over Durable Object RPC, and
 * never the SDK. Re-exported by `./types`.
 *
 * Every edge only gains (`docs/architecture/mcp.md` → Deploys): a Schema drops the keys it does not know, and a union
 * the other end may extend has a fallback member, which the reader takes as a generic failure. A token is in the
 * `ok` answer only: no other answer, report or error carries one.
 */
import * as Schema from "effect/Schema";

/** `mcpAccessToken({ environment, server, stale? })`: the host asks before it connects to an OAuth-capable HTTP server. */
export const McpAccessTokenInput = Schema.Struct({
  environment: Schema.String,
  /** The server's name as its entry in the Environment's set spells it. */
  server: Schema.String,
  /** The access token a request just carried and a server refused with a 401 that is not `insufficient_scope`. */
  stale: Schema.optionalKey(Schema.String),
});

export type McpAccessTokenInput = typeof McpAccessTokenInput.Type;

/** What a sign-in's status says beside a token that still serves: the host is told, and goes on using it. */
export const McpSignInNote = Schema.Struct({
  /** `step_up`, `rejected` or `refresh_failing`; a status this build does not know is a string. */
  status: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
});

export type McpSignInNote = typeof McpSignInNote.Type;

/**
 * The Registry's answer to `mcpAccessToken`: the token and what it is bound to, or why there is none. `status` this
 * build does not know reads as a failure (the last member).
 */
export const McpAccessTokenAnswer = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    token: Schema.String,
    /** Epoch milliseconds; absent when the server gave no lifetime. */
    expiresAt: Schema.optionalKey(Schema.Finite),
    /** The protected resource the token is bound to: it is attached to requests within it only. */
    resource: Schema.String,
    /**
     * The MCP sign-in id: new with each completed sign-in or step-up, the same through refreshes, so an MCP task's
     * follower tells "not reachable under the current sign-in" from "expired".
     */
    signIn: Schema.String,
    /** Present while the sign-in's status is not `ok` yet its token still serves. */
    note: Schema.optionalKey(McpSignInNote),
  }),
  Schema.Struct({
    status: Schema.Literals(["required", "step_up", "rejected", "refresh_failing", "unavailable"]),
    /** Why, for the owner: the last error, or what the Registry found. Never a token. */
    reason: Schema.String,
    /** The scope a step-up wants. */
    scope: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ status: Schema.String }),
]);

export type McpAccessTokenAnswer = typeof McpAccessTokenAnswer.Type;

/** What a host reports on a transition (`reportMcpAuth`'s `event`). */
export const MCP_AUTH_EVENTS = ["needs_sign_in", "step_up", "rejected", "working"] as const;

/**
 * A newer host's event is a string this build does not know, read as unknown (the last member): the Registry ignores it
 * with why, rather than failing the report at decode (`docs/architecture/mcp.md` → Deploys).
 */
export const McpAuthEvent = Schema.Union([Schema.Literals(MCP_AUTH_EVENTS), Schema.String]);

export type McpAuthEvent = typeof McpAuthEvent.Type;

/** The challenge of the 401 or 403 that made the host report. */
export const McpAuthChallenge = Schema.Struct({
  resourceMetadataUrl: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  errorDescription: Schema.optionalKey(Schema.String),
});

export type McpAuthChallenge = typeof McpAuthChallenge.Type;

/** `reportMcpAuth({ environment, server, event, challenge? })`: on transitions only. */
export const McpAuthReport = Schema.Struct({
  environment: Schema.String,
  server: Schema.String,
  event: McpAuthEvent,
  challenge: Schema.optionalKey(McpAuthChallenge),
});

export type McpAuthReport = typeof McpAuthReport.Type;

/** A Sign-in request that a `working` report resolved: the Session and the request's id. */
export const McpResolvedWaiter = Schema.Struct({
  session: Schema.String,
  request: Schema.String,
});

export type McpResolvedWaiter = typeof McpResolvedWaiter.Type;

/**
 * The Registry's answer to `reportMcpAuth`: recorded (with the open Sign-in requests a `working` report resolved), or
 * ignored with why (an event this build does not know, a server that is not in the set or does not sign in, a full
 * store). The Registry never calls out: whoever carries the answer on tells the Sessions.
 */
export const McpAuthReportAnswer = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("recorded"),
    resolved: Schema.Array(McpResolvedWaiter),
  }),
  Schema.Struct({ status: Schema.Literal("ignored"), reason: Schema.String }),
  Schema.Struct({ status: Schema.String }),
]);

export type McpAuthReportAnswer = typeof McpAuthReportAnswer.Type;
