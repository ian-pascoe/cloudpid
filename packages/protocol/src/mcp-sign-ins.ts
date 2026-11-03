// What the client reads and does of the owner's MCP sign-ins (`docs/architecture/mcp-sign-in.md` → Settings, Sign-out):
// `mcpSignIns`, the list the Settings rows and the Sign-ins list are made from, and `signOutMcpSignIn`. Never a token, a
// client secret or a URL (a server's URL may hold a credential): a sign-in is named by its key's hash and says its server,
// source and URL host.
//
// Every answer union only gains (`docs/architecture/mcp.md` → Deploys): a status or a kind is a string, and a tag this
// build does not know reads as `Unavailable`, never as a decode error.
import * as Schema from "effect/Schema";
import { McpUnavailable, OtherAnswerFromWire } from "./mcp-status.ts";

/**
 * The `BroadcastChannel` the sign-in page tells its outcome on (its message is `{ outcome }`) and the Settings page listens
 * on, to ask for the list again (`docs/architecture/mcp-sign-in.md` → Starting and completing a sign-in, Learning the outcome).
 */
export const SIGN_IN_CHANNEL = "cloudpid:mcp-sign-in";

/**
 * A sign-in: its status (`ok`, `required`, `step_up`, `rejected`, `refresh_failing`; read it with `readMcpSignInStatus`),
 * the kind of its client (`configured`, `document`, `registered`, `client_grant`; null for a row that only remembers a
 * challenge) and the Environments that use it. `unused` says no Environment's set and no Global entry uses it any more.
 */
export const McpSignInView = Schema.Struct({
  /** The sign-in's key (its source, normalized name and URL), hashed: what a row of Settings is matched by. */
  hash: Schema.String,
  /** The server's normalized name. */
  server: Schema.String,
  /** `owner`, or `repo:<owner/repo>`. */
  source: Schema.String,
  /** The host of the server's URL, which alone may be shown. */
  urlHost: Schema.String,
  issuerHost: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.String),
  status: Schema.String,
  scope: Schema.NullOr(Schema.String),
  /** The scope a step-up wants. */
  wantedScope: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.Finite),
  createdAt: Schema.Finite,
  refreshedAt: Schema.NullOr(Schema.Finite),
  usedAt: Schema.Finite,
  /** The last problem (at most 300 characters) and when. */
  lastError: Schema.NullOr(Schema.String),
  lastErrorAt: Schema.NullOr(Schema.Finite),
  hasTokens: Schema.Boolean,
  /** The Environments whose set holds a server that uses it (a client grant's row: only through an entry that signs in on its own). */
  environments: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  unused: Schema.Boolean,
});

export type McpSignInView = typeof McpSignInView.Type;

/** A document-client sign-in that was started and expired without a callback: the authorization server may have refused the client. */
export const McpLapsedStart = Schema.Struct({
  /** The key of the sign-in it was for (`McpSignInView.hash`). */
  hash: Schema.String,
  issuerHost: Schema.String,
  /** When the start was made. */
  at: Schema.Finite,
});

export type McpLapsedStart = typeof McpLapsedStart.Type;

/** What the main Worker knows of the stage that the form says: the redirect URI's origin and the client name. */
export const McpSignInStageView = Schema.Struct({
  /** The stage's label; absent on `prod`. */
  label: Schema.optionalKey(Schema.String),
  /** Under `alchemy dev`. */
  local: Schema.Boolean,
  /** Whether the client document is in the ladder for new sign-ins. */
  documentEnabled: Schema.Boolean,
  /** The app origin a live stage starts sign-ins on; absent under `alchemy dev`, where the page's own origin is the one. */
  origin: Schema.optionalKey(Schema.String),
});

export type McpSignInStageView = typeof McpSignInStageView.Type;

/** What the Registry says of the sign-ins: every one, the most recently used first, and why the rows cannot be opened, if so. */
export const McpSignInsListing = Schema.TaggedStruct("SignIns", {
  /** The sign-ins revision: it rises with a sign-in, a sign-out, a rebind and a drop of tokens. */
  revision: Schema.Finite,
  /** Why the sealed tokens cannot be opened (a malformed `SECRETS_ENCRYPTION_KEY`): sign-ins are then unavailable. */
  sealing: Schema.optionalKey(Schema.String),
  signIns: Schema.Array(McpSignInView),
  lapsedStarts: Schema.Array(McpLapsedStart),
});

export type McpSignInsListing = typeof McpSignInsListing.Type;

/** `mcpSignIns`' answer: the Registry's listing and the stage the main Worker adds. */
export const McpSignInsList = Schema.Struct({
  ...McpSignInsListing.fields,
  stage: McpSignInStageView,
});

export type McpSignInsList = typeof McpSignInsList.Type;

export const McpSignInsView = Schema.Union([McpSignInsList, McpUnavailable, OtherAnswerFromWire]);

export type McpSignInsView = typeof McpSignInsView.Type;

/**
 * What `signOutMcpSignIn` did of the server's own side (RFC 7009), best effort: `revoked`, `no_endpoint` (the server
 * advertises none), `failed` (`note` says which token and why) or `not_attempted` (the tokens or the recorded metadata
 * could not be read, or there were none). A status this build does not know reads as `failed`.
 */
export const McpRevocationView = Schema.Struct({
  status: Schema.String,
  note: Schema.optionalKey(Schema.String),
});

export type McpRevocationView = typeof McpRevocationView.Type;

/** The sign-in was deleted: its registration and binding stay, the hosts that use it were told. */
export const McpSignedOut = Schema.TaggedStruct("SignedOut", {
  /** The server's normalized name, and the sign-ins revision the delete raised the counter to (what the hosts are told). */
  server: Schema.String,
  revision: Schema.Finite,
  /** The authorization server's host, which the revocation was asked of; null when none was recorded. */
  issuerHost: Schema.NullOr(Schema.String),
  revocation: McpRevocationView,
  /** The Environments that used it, whose hosts closed the server's sessions and ended its watches. */
  environments: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});

export type McpSignedOut = typeof McpSignedOut.Type;

/** There is no such sign-in (already signed out). */
export const McpNoSignIn = Schema.TaggedStruct("NoSignIn", {});

export type McpNoSignIn = typeof McpNoSignIn.Type;

/** The sign-in is a client grant that an entry still uses: it signs in on its own, and there is nothing to sign out of. */
export const McpSignOutNotApplicable = Schema.TaggedStruct("NotApplicable", {
  message: Schema.String,
});

export type McpSignOutNotApplicable = typeof McpSignOutNotApplicable.Type;

/** A new sign-in was made while the old one was being revoked: it was kept. */
export const McpSignOutChanged = Schema.TaggedStruct("Changed", { message: Schema.String });

export type McpSignOutChanged = typeof McpSignOutChanged.Type;

export const McpSignOutView = Schema.Union([
  McpSignedOut,
  McpNoSignIn,
  McpSignOutNotApplicable,
  McpSignOutChanged,
  McpUnavailable,
  OtherAnswerFromWire,
]);

export type McpSignOutView = typeof McpSignOutView.Type;

/** The statuses of a sign-in this build knows. */
export const MCP_SIGN_IN_STATUS_NAMES = [
  "ok",
  "required",
  "step_up",
  "rejected",
  "refresh_failing",
] as const;

export type McpSignInStatusName = (typeof MCP_SIGN_IN_STATUS_NAMES)[number];

const isStatus = Schema.is(Schema.Literals(MCP_SIGN_IN_STATUS_NAMES));

/** `raw`, a status as it crossed the edge, as one this build knows: `unknown` for any other. */
export const readMcpSignInStatus = (raw: string): McpSignInStatusName | "unknown" =>
  isStatus(raw) ? raw : "unknown";
