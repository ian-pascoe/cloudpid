/**
 * The Registry's MCP sign-in edge, as `McpHost` calls it (`docs/architecture/mcp-sign-in.md` → Tokens reach the host
 * object): `mcpAccessToken`, `reportMcpAuth` and the revision of the sign-ins. Plain data over Durable Object RPC, and
 * never the SDK. Re-exported by `./types`.
 *
 * Every edge only gains (`docs/architecture/mcp.md` → Deploys): a Schema drops the keys it does not know, and a union
 * the other end may extend has a fallback member, which the reader takes as a generic failure. A token is in the
 * `ok` answer only: no other answer, report or error carries one.
 */
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";

/**
 * The extension a connection that signs in with OAuth Client Credentials declares, in both eras
 * (`docs/architecture/mcp.md` → Extensions; `docs/architecture/mcp-sign-in.md` → Client Credentials), and what it declares.
 */
export const MCP_CLIENT_CREDENTIALS_EXTENSION = "io.modelcontextprotocol/oauth-client-credentials";

/** The extension's capability: no settings. */
export const MCP_CLIENT_CREDENTIALS_CAPABILITY = {} as const;

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
    status: Schema.Literals([
      "required",
      "step_up",
      "rejected",
      "refresh_failing",
      "unavailable",
      // A server that signs in on its own (Client Credentials) whose token could not be had: never `required` or
      // `step_up`, which would send the owner to a sign-in there is none of.
      "failed",
    ]),
    /** Why, for the owner: the last error, or what the Registry found. Never a token or a secret. */
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

// Starting and completing a sign-in (`docs/architecture/mcp-sign-in.md` → Starting and completing a sign-in) ---------------

/** The Environment a start names when the entry is Global's own: `environment=all` of the start link. */
export const MCP_SIGN_IN_GLOBAL = "all";

/**
 * What the main Worker knows of the stage and the request, which the Registry (no environment variables of its own to
 * read) cannot: where the sign-in starts, the stage's name for client names, and whether the document is in the ladder.
 */
export const McpSignInStage = Schema.Struct({
  /** The app origin the sign-in starts on: the stage's own, or one of `alchemy dev`'s two. Never taken from a header on a live stage. */
  origin: Schema.String,
  /** The stage's label; absent on `prod`. */
  label: Schema.optional(Schema.String),
  /** Under `alchemy dev`: the client name says "local", and the DCR client is `native`. */
  local: Schema.Boolean,
  /** `MCP_CLIENT_DOCUMENT`: whether the client document is in the ladder for new sign-ins. */
  documentEnabled: Schema.Boolean,
});

export type McpSignInStage = typeof McpSignInStage.Type;

/** `startMcpSignIn`: the start link's parameters (the Worker has checked them) and the stage. */
export const McpSignInStartInput = Schema.Struct({
  /** An Environment's id, or `MCP_SIGN_IN_GLOBAL`. */
  environment: Schema.String,
  /** The server's name as its entry spells it. */
  server: Schema.String,
  stage: McpSignInStage,
  /** A step-up: no refresh, the scope the row wants. */
  stepUp: Schema.optional(Schema.Boolean),
  /** The Sign-in request that asked: its Session and request. */
  requester: Schema.optional(McpResolvedWaiter),
  /** Where Back goes: a path of the app. */
  returnPath: Schema.optional(Schema.String),
});

export type McpSignInStartInput = typeof McpSignInStartInput.Type;

/**
 * Where an entry's `oauth.clientSecret` resolves: a `{scope, name}` reference, never a copy of the value. `environment`
 * is where it resolved (an Environment's id, or `all` for Global's own); a row from before it has none, and is read at Global.
 */
export const McpSignInSecretRef = Schema.Struct({
  scope: Schema.Literals(["secret", "variable"]),
  name: Schema.String,
  environment: Schema.optional(Schema.String),
});

export type McpSignInSecretRef = typeof McpSignInSecretRef.Type;

/** What the issuer interstitial shows: never a secret's value. */
export const McpSignInConfirmation = Schema.Struct({
  /** The one-time field of Continue and Cancel: the `state` of the pending row. */
  state: Schema.String,
  server: Schema.String,
  /** `owner` or `repo:<owner/repo>`. */
  source: Schema.String,
  url: Schema.String,
  issuer: Schema.String,
  /** The issuer the client was bound to before, on a change. */
  previousIssuer: Schema.optional(Schema.String),
  clientId: Schema.String,
  /** Where the client secret resolves: a `secret` or a `variable`, and the `${NAME}`'s name. */
  secret: Schema.optional(McpSignInSecretRef),
});

export type McpSignInConfirmation = typeof McpSignInConfirmation.Type;

/** The fields every answer that ends in a page may carry, so Back and Start again are offered. */
const McpSignInRetry = Schema.Struct({
  retry: Schema.optional(Schema.Struct({ environment: Schema.String, server: Schema.String })),
  returnPath: Schema.optional(Schema.String),
});

/**
 * The answer to `startMcpSignIn`: where to send the owner's browser, the interstitial to show, or why there is no
 * sign-in to start (`message` is for the owner, and never holds a secret). A `status` this build does not know is the last
 * member.
 */
const KnownStartAnswer = Schema.Union([
  Schema.Struct({ status: Schema.Literal("redirect"), url: Schema.String }),
  Schema.Struct({ status: Schema.Literal("confirm"), confirmation: McpSignInConfirmation }),
  Schema.Struct({ status: Schema.Literal("problem"), message: Schema.String }),
]);

export const McpSignInStartAnswer = Schema.Union([
  ...KnownStartAnswer.members,
  Schema.Struct({ status: Schema.String }),
]);

export type McpSignInStartAnswer = typeof McpSignInStartAnswer.Type;

/** The start answer as this build knows it: what it does not know is a problem with a generic message. */
export const readMcpSignInStartAnswer = (
  answer: McpSignInStartAnswer,
): typeof KnownStartAnswer.Type =>
  Schema.is(KnownStartAnswer)(answer)
    ? answer
    : {
        status: "problem",
        message: "The Registry answered with something this build does not know",
      };

/** `confirmMcpSignIn`: Continue or Cancel of the interstitial. */
export const McpSignInConfirmInput = Schema.Struct({
  state: Schema.String,
  decision: Schema.Union([Schema.Literals(["continue", "cancel"]), Schema.String]),
});

export type McpSignInConfirmInput = typeof McpSignInConfirmInput.Type;

const KnownConfirmAnswer = Schema.Union([
  Schema.Struct({ status: Schema.Literal("redirect"), url: Schema.String }),
  Schema.Struct({ status: Schema.Literal("cancelled") }),
  Schema.Struct({ status: Schema.Literal("expired") }),
  Schema.Struct({ status: Schema.Literal("problem"), message: Schema.String }),
]);

export const McpSignInConfirmAnswer = Schema.Union([
  ...KnownConfirmAnswer.members,
  Schema.Struct({ status: Schema.String }),
]);

export type McpSignInConfirmAnswer = typeof McpSignInConfirmAnswer.Type;

/** The confirm answer as this build knows it, an unknown one being a problem. */
export const readMcpSignInConfirmAnswer = (
  answer: McpSignInConfirmAnswer,
): typeof KnownConfirmAnswer.Type =>
  Schema.is(KnownConfirmAnswer)(answer)
    ? answer
    : {
        status: "problem",
        message: "The Registry answered with something this build does not know",
      };

/** `completeMcpSignIn`: what the callback received, bounded by the Worker. A secret reaches the Registry only as `code`. */
export const McpSignInCompleteInput = Schema.Struct({
  state: Schema.String,
  /** The callback's path, `/oauth/mcp/callback` or with its 12-character hash. */
  path: Schema.String,
  code: Schema.optional(Schema.String),
  iss: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  errorDescription: Schema.optional(Schema.String),
});

export type McpSignInCompleteInput = typeof McpSignInCompleteInput.Type;

/** An Environment that uses a sign-in. */
export const McpSignInEnvironment = Schema.Struct({ id: Schema.String, name: Schema.String });

export type McpSignInEnvironment = typeof McpSignInEnvironment.Type;

/** The outcomes of a callback that saved nothing (`mcp-sign-in.md` → Page outcomes). */
export const MCP_SIGN_IN_FAILURES = [
  "expired",
  "declined",
  "provider_error",
  "missing_code",
  "iss_mismatch",
  "exchange_failed",
  "path_mismatch",
  "unconfirmed",
  "unavailable",
] as const;

/**
 * The answer to `completeMcpSignIn`. `signed_in` names the Environments that use the sign-in and the Sign-in requests it
 * resolved, which whoever carries the answer on tells the Sessions (the Registry never calls out); the hosts of those
 * Environments take the change at their next pull, which the raised revision announces. Any other outcome saved nothing and
 * left the old tokens as they were; it lists the key's open Sign-in requests (`waiting`), which stay open and show the
 * failure. `code` is the authorization server's error code, `message` its description or what failed, cut to 300
 * characters. A `status` this build does not know is the last member.
 */
const KnownCompleteAnswer = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("signed_in"),
    server: Schema.String,
    environments: Schema.Array(McpSignInEnvironment),
    resolved: Schema.Array(McpResolvedWaiter),
    revision: Schema.Finite,
    ...McpSignInRetry.fields,
  }),
  Schema.Struct({
    status: Schema.Literals(MCP_SIGN_IN_FAILURES),
    code: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    /** The Sign-in requests still open for the key, which stay open and show the failure (the Session is told, not the Registry). */
    waiting: McpResolvedWaiter.pipe(Schema.Array, Schema.optional),
    ...McpSignInRetry.fields,
  }),
]);

export const McpSignInCompleteAnswer = Schema.Union([
  ...KnownCompleteAnswer.members,
  Schema.Struct({ status: Schema.String }),
]);

export type McpSignInCompleteAnswer = typeof McpSignInCompleteAnswer.Type;

/** The members of {@link McpSignInCompleteAnswer} this build knows. */
export type McpSignInKnownCompleteAnswer = typeof KnownCompleteAnswer.Type;

/** A callback that saved nothing. */
export type McpSignInFailure = Exclude<
  McpSignInKnownCompleteAnswer,
  { readonly status: "signed_in" }
>;

/** The complete answer as this build knows it: one it does not know is `unavailable`, which saved nothing as far as it can tell. */
export const readMcpSignInCompleteAnswer = (
  answer: McpSignInCompleteAnswer,
): typeof KnownCompleteAnswer.Type =>
  Schema.is(KnownCompleteAnswer)(answer)
    ? answer
    : {
        status: "unavailable",
        message: "The Registry answered with something this build does not know",
      };

/** The scopes of a space-separated list (an OAuth `scope` value), as the Registry and the host both read one. */
export const scopesOf = (list: string | undefined): ReadonlyArray<string> =>
  Arr.filter((list ?? "").split(/\s+/), (scope) => scope !== "");

// Sign-in requests (`docs/architecture/mcp-sign-in.md` → Sign-in requests) --------------------------------------------------

/**
 * `mcpSignInAsk`: a Session's Sign-in request for `server` in `environment`'s set, under its own `request` id. Asking
 * again with the same `session` and `request` joins the waiter already kept, and re-checks the sign-in: a Session that
 * resumes after an eviction asks this way.
 */
export const McpSignInAskInput = Schema.Struct({
  environment: Schema.String,
  server: Schema.String,
  session: Schema.String,
  request: Schema.String,
});

export type McpSignInAskInput = typeof McpSignInAskInput.Type;

/** Where a server's definition is, as a card names it: `global`, `environment` or `repo` (then its `owner/repo`). */
export const McpSignInSource = Schema.Struct({
  kind: Schema.String,
  slug: Schema.optionalKey(Schema.String),
});

export type McpSignInSource = typeof McpSignInSource.Type;

/**
 * The answer to `mcpSignInAsk`. `signed_in` and `not_applicable` (a client grant, an `Authorization` header, a stdio
 * server) are immediate and keep no waiter. `step_up_failed` is a step-up that was completed three times and challenged
 * again for the same scope set. `open` is a waiter kept: `first` says it is the first open one for the sign-in's key,
 * which sends the owner the one Notification; `why` is `required`, `step_up`, `rejected` or `refresh_failing`; the rest is
 * what the card shows. `unavailable` is a server not in the set or a store that cannot answer; `full` a store at its
 * bound. A status this build does not know is the last member, read as `unavailable`.
 */
const KnownAskAnswer = Schema.Union([
  Schema.Struct({ status: Schema.Literal("signed_in") }),
  Schema.Struct({ status: Schema.Literal("not_applicable"), reason: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("step_up_failed"),
    reason: Schema.String,
    scopes: Schema.Array(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
  Schema.Struct({ status: Schema.Literal("full"), message: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("open"),
    first: Schema.Boolean,
    /** The sign-in's key hash, which tags the Notification. */
    key: Schema.String,
    why: Schema.String,
    scopes: Schema.Array(Schema.String),
    source: McpSignInSource,
    urlHost: Schema.String,
    issuerHost: Schema.optionalKey(Schema.String),
    /** The last problem the sign-in had (≤300 characters), when there is one. */
    problem: Schema.optionalKey(Schema.String),
  }),
]);

export const McpSignInAskAnswer = Schema.Union([
  ...KnownAskAnswer.members,
  Schema.Struct({ status: Schema.String }),
]);

export type McpSignInAskAnswer = typeof McpSignInAskAnswer.Type;

/** The members of {@link McpSignInAskAnswer} this build knows. */
export type McpSignInKnownAskAnswer = typeof KnownAskAnswer.Type;

/** The ask's answer as this build knows it: one it does not know is `unavailable`. */
export const readMcpSignInAskAnswer = (answer: McpSignInAskAnswer): McpSignInKnownAskAnswer =>
  Schema.is(KnownAskAnswer)(answer)
    ? answer
    : {
        status: "unavailable",
        reason: "The Registry answered with something this build does not know",
      };

/** `mcpSignInWithdraw`: the Sign-in request `request` of `session` ended (declined or withdrawn): its waiter goes. */
export const McpSignInWithdrawInput = Schema.Struct({
  session: Schema.String,
  request: Schema.String,
});

export type McpSignInWithdrawInput = typeof McpSignInWithdrawInput.Type;
