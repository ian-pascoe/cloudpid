// docs/architecture/mcp-sign-in.md → The client document and the callback outside Access (The Access guard), and
// docs/architecture/mcp-endpoint.md → Access and identity (The guard). The main Worker does not trust that Access ran in
// front of it: it verifies `Cf-Access-Jwt-Assertion` itself, on every route, and fails closed. On `/mcp` it checks the
// MCP endpoint application's audience and tells the owner from the Local agent's service token; everywhere else a
// `common_name`, or `/mcp`'s audience, is refused, so neither credential opens the app.
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off missingPipeableSignature:off globalDate:off -- WebCrypto and `fetch` are Promise APIs, over native arrays.

import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ACCESS_AUDIENCE_VAR,
  ACCESS_TEAM_DOMAIN,
  LOCAL_MODE_VAR,
  OWNER_EMAIL,
} from "./deployment.ts";
import { MCP_AUDIENCE_VAR, MCP_SERVICE_TOKEN_CLIENT_ID_VAR } from "./mcp-access.ts";
import { isMcpRoute } from "./routes.ts";

/** The header Access adds to every request it admits, and a request that skipped Access lacks. */
export const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";

/** Why a request was refused. Only the Worker's log sees it; the caller gets a bare 403. */
export type Refusal =
  /** A deployed Worker without its application's audience refuses every guarded route. */
  | "not_configured"
  | "missing"
  | "malformed"
  | "unsupported_algorithm"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "expired"
  | "not_yet_valid"
  | "wrong_audience"
  | "not_owner"
  | "common_name"
  /** On `/mcp`: a `common_name` that is not the Local agent's token's, or a token assertion that is not shaped like one. */
  | "not_service_token"
  | "not_local"
  /** The check itself failed (a lookup or a verification threw): the request is refused, never a 500. */
  | "error";

/**
 * Who an admitted request is, from the assertion and never `ctx.access.getIdentity()` (which answers `undefined` for a
 * service token). The email is never kept: `clientId` is the owner's OAuth registration's opaque id (the assertion's
 * `oauth.client_id`), the audit mark of which client got in.
 */
export type Caller =
  | { readonly kind: "owner"; readonly clientId?: string }
  | { readonly kind: "service_token"; readonly clientId: string }
  /** Under `alchemy dev` (no Access), where a loopback host counts as the owner. */
  | { readonly kind: "local" };

/** The admitted request's {@link Caller}, which a route behind the guard reads. */
export class AccessCaller extends Context.Service<AccessCaller, Caller>()(
  "@cloudpid/server/access/AccessCaller",
) {}

/** The guard's answer for one request. */
export type Verdict =
  | { readonly admitted: true; readonly caller: Caller }
  | { readonly admitted: false; readonly reason: Refusal };

const refuse = (reason: Refusal): Verdict => ({ admitted: false, reason });

const admitted = (caller: Caller): Verdict => ({ admitted: true, caller });

/** Finds a team signing key by its `kid`: `undefined` when the team does not have it, or its keys cannot be read. */
export type TeamKeyLookup = (kid: string) => Promise<CryptoKey | undefined>;

const Header = Schema.Struct({
  alg: Schema.String,
  kid: Schema.optionalKey(Schema.String),
});

const Claims = Schema.Struct({
  iss: Schema.optionalKey(Schema.String),
  aud: Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.String])),
  exp: Schema.optionalKey(Schema.Finite),
  nbf: Schema.optionalKey(Schema.Finite),
  email: Schema.optionalKey(Schema.String),
  /** A service token's assertion has `""`; the owner's has the user's id. */
  sub: Schema.optionalKey(Schema.String),
  // Present on a service token's assertion and on none of the owner's.
  common_name: Schema.optionalKey(Schema.Unknown),
  // Present on an assertion minted by managed OAuth: the DCR registration's id is read, nothing else.
  oauth: Schema.optionalKey(Schema.Unknown),
});

const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header));
const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Claims));

/** A key set's entries are read one by one: a key this guard cannot use must not lock everyone out. */
const Jwks = Schema.Struct({ keys: Schema.Array(Schema.Unknown) });

const RsaKey = Schema.Struct({
  kid: Schema.String,
  kty: Schema.Literal("RSA"),
  n: Schema.String,
  e: Schema.String,
});

const decodeRsaKey = Schema.decodeUnknownOption(RsaKey);

const decodeJwks = Schema.decodeUnknownOption(Schema.fromJsonString(Jwks));

/** What an Access team's signing keys sign with. */
const KEY_ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

const textDecoder = new TextDecoder();

/** The bytes of a base64url segment; `undefined` when it is not one. */
const base64UrlBytes = (segment: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) return undefined;

  const padded = segment.replaceAll("-", "+").replaceAll("_", "/");

  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));

    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
};

/** A segment's text, as the JSON it holds. */
const base64UrlText = (segment: string): string | undefined => {
  const bytes = base64UrlBytes(segment);

  return bytes === undefined ? undefined : textDecoder.decode(bytes);
};

/** How far a clock may trail the edge's before a fresh assertion counts as not yet valid. */
const NOT_BEFORE_LEEWAY_SECONDS = 30;

/** What {@link classifyAssertion} reads of the Worker's deployment. */
export type AssertionExpectations = {
  /** The audience of the application the route is behind: the main one, or on `/mcp` the MCP endpoint's. */
  readonly audience: string;
  readonly keys: TeamKeyLookup;
  /** Unix seconds. */
  readonly now: number;
  /**
   * The Local agent's service token's client id, where one is admitted (on `/mcp`). Without it a `common_name` is always
   * refused.
   */
  readonly serviceToken?: string | undefined;
};

const OauthClaim = Schema.Struct({ client_id: Schema.NonEmptyString });

const decodeOauthClaim = Schema.decodeUnknownOption(OauthClaim);

/**
 * Classifies `assertion`, a `Cf-Access-Jwt-Assertion` value: the owner (an assertion of the team's, unexpired, for the
 * application's audience, whose `email` is {@link OWNER_EMAIL} and that has no `common_name`), or, where
 * `expected.serviceToken` is set, the Local agent's service token (no `email`, `sub` empty, and a `common_name` that is
 * the token's client id), or why not. Never trusts the claims before the signature has been checked, and reads no
 * identity from anywhere else (`ctx.access.getIdentity()` answers `undefined` for a service token).
 */
export const classifyAssertion = async (
  assertion: string | undefined,
  expected: AssertionExpectations,
): Promise<Verdict> => {
  if (assertion === undefined || assertion === "") return refuse("missing");

  const [encodedHeader, encodedPayload, encodedSignature, ...rest] = assertion.split(".");

  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined ||
    rest.length > 0
  ) {
    return refuse("malformed");
  }

  const headerText = base64UrlText(encodedHeader);
  const header = headerText === undefined ? Option.none() : decodeHeader(headerText);

  if (Option.isNone(header)) return refuse("malformed");

  // Access signs with RS256. Anything else, `none` and HMAC included, is never verified.
  if (header.value.alg !== "RS256") return refuse("unsupported_algorithm");

  if (header.value.kid === undefined) return refuse("unknown_key");

  const signature = base64UrlBytes(encodedSignature);

  if (signature === undefined) return refuse("malformed");

  const key = await expected.keys(header.value.kid);

  if (key === undefined) return refuse("unknown_key");

  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const genuine = await crypto.subtle.verify(KEY_ALGORITHM, key, signature, signed);

  if (!genuine) return refuse("bad_signature");

  const payloadText = base64UrlText(encodedPayload);
  const claims = payloadText === undefined ? Option.none() : decodeClaims(payloadText);

  if (Option.isNone(claims)) return refuse("malformed");

  const { iss, aud, exp, nbf, email, sub, common_name, oauth } = claims.value;

  if (iss !== `https://${ACCESS_TEAM_DOMAIN}`) return refuse("wrong_issuer");

  if (exp === undefined || exp <= expected.now) return refuse("expired");

  if (nbf !== undefined && nbf > expected.now + NOT_BEFORE_LEEWAY_SECONDS) {
    return refuse("not_yet_valid");
  }

  const audiences = aud === undefined ? [] : Arr.ensure(aud);

  if (!audiences.includes(expected.audience)) return refuse("wrong_audience");

  // Before the email: a service token has neither an email nor the owner's identity, and is told apart from a stranger.
  if (common_name !== undefined) {
    if (expected.serviceToken === undefined) return refuse("common_name");

    const isToken =
      common_name === expected.serviceToken &&
      email === undefined &&
      (sub === undefined || sub === "");

    return isToken
      ? admitted({ kind: "service_token", clientId: expected.serviceToken })
      : refuse("not_service_token");
  }

  if (email !== OWNER_EMAIL) return refuse("not_owner");

  // The OAuth registration's id, when the assertion was minted by managed OAuth.
  const clientId = Option.getOrUndefined(
    Option.map(decodeOauthClaim(oauth), ({ client_id }) => client_id),
  );

  return admitted(clientId === undefined ? { kind: "owner" } : { kind: "owner", clientId });
};

/** How long the team's keys are kept: Access rotates them about every six weeks and publishes the next ahead of time. */
const KEYS_MAX_AGE_MS = 60 * 60 * 1000;

/** The least time between two reads of the keys for a `kid` the team does not have, so a made-up `kid` costs one read. */
const UNKNOWN_KEY_COOLDOWN_MS = 60 * 1000;

/** The least time between two reads of keys that could not be read, so an outage is not hammered. */
const FAILED_READ_COOLDOWN_MS = 5 * 1000;

/** How long a read of the team's keys may take before it counts as failed. */
const KEYS_TIMEOUT_MS = 5000;

/** Reads the team's keys: the body of its `/cdn-cgi/access/certs`, which throws when they cannot be read. */
export type LoadTeamKeys = () => Promise<string>;

/** The team's own endpoint. */
export const loadTeamKeysFromAccess: LoadTeamKeys = async () => {
  const response = await fetch(`https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, {
    signal: AbortSignal.timeout(KEYS_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`The Access team's keys answered ${response.status}`);

  return response.text();
};

const importTeamKeys = async (body: string): Promise<Map<string, CryptoKey>> => {
  const decoded = decodeJwks(body);

  if (Option.isNone(decoded)) throw new Error("The Access team's keys are not a key set");

  const keys = new Map<string, CryptoKey>();

  for (const entry of decoded.value.keys) {
    const jwk = decodeRsaKey(entry);

    if (Option.isNone(jwk)) continue;

    try {
      keys.set(
        jwk.value.kid,
        await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk.value.n, e: jwk.value.e, alg: "RS256", ext: true },
          KEY_ALGORITHM,
          false,
          ["verify"],
        ),
      );
    } catch {
      // A key that cannot be imported finds nothing; the others still do.
    }
  }

  return keys;
};

/**
 * A {@link TeamKeyLookup} over the team's keys, kept for an hour per isolate. A `kid` the kept keys lack is looked up
 * again at most once a minute. Keys that cannot be read, or that are older than an hour and cannot be read again, find
 * nothing, so the guard refuses.
 */
export const teamKeys = (load: LoadTeamKeys, clock: () => number = Date.now): TeamKeyLookup => {
  let kept = new Map<string, CryptoKey>();
  let keptAt: number | undefined;
  let attemptedAt: number | undefined;

  // Every lookup that needs the keys reads them itself: a read is never shared, since a promise another request began
  // may not be awaited from this one in workerd ("Cannot perform I/O on behalf of a different request"). The kept keys
  // are plain values and are shared.
  const read = async () => {
    try {
      kept = await importTeamKeys(await load());
      keptAt = clock();
    } catch {
      // Nothing newer was read: the kept keys, if still young, stay.
    } finally {
      attemptedAt = clock();
    }
  };

  const fresh = () => keptAt !== undefined && clock() - keptAt < KEYS_MAX_AGE_MS;

  return async (kid) => {
    const key = fresh() ? kept.get(kid) : undefined;

    if (key !== undefined) return key;

    const cooldown = fresh() ? UNKNOWN_KEY_COOLDOWN_MS : FAILED_READ_COOLDOWN_MS;

    // Only a finished read starts the cooldown, so the lookups of a cold start (a page load makes several) all read.
    if (attemptedAt !== undefined && clock() - attemptedAt < cooldown) return undefined;

    await read();

    return fresh() ? kept.get(kid) : undefined;
  };
};

/** The hosts `alchemy dev` serves the Worker on, with an optional port and nothing else: no userinfo, path or dot. */
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

const isLoopbackHost = (host: string): boolean => LOOPBACK_HOST.test(host);

/** What the guard reads of a request. */
export type GuardedRequest = {
  readonly assertion: string | undefined;
  /** Whether the request is for the MCP endpoint (`isMcpRoute`): its audience, and the service token, apply. */
  readonly mcp?: boolean;
  /** Every host the request names: its `Host` header and the host of its URL, where it has one. */
  readonly hosts: ReadonlyArray<string>;
  /** Unix seconds. */
  readonly now: number;
};

/** What the guard reads of the Worker's deployment. */
export type AccessGuard = {
  /** The main application's audience; undefined on `alchemy dev`, and on a deployed Worker that was not given it. */
  readonly audience: string | undefined;
  /**
   * The MCP endpoint's application: its audience, and the Local agent's service token's client id. Either missing
   * refuses what depends on it: no audience refuses `/mcp` altogether, no client id refuses the token only.
   */
  readonly mcp?: {
    readonly audience: string | undefined;
    readonly serviceToken: string | undefined;
  };
  /** The Worker was built by `alchemy dev` ({@link LOCAL_MODE_VAR}), where there is no Access. */
  readonly localMode: boolean;
  readonly keys: TeamKeyLookup;
};

/**
 * Whether `request` is the owner's, or on `/mcp` the Local agent's. Under `alchemy dev` (local mode) a request counts as
 * the owner only when every host it names is loopback; anywhere else the assertion decides, against the audience of the
 * application the route is behind, and a Worker without that audience admits nothing.
 */
export const admit = async (request: GuardedRequest, guard: AccessGuard): Promise<Verdict> => {
  if (guard.localMode) {
    const loopback = request.hosts.length > 0 && Arr.every(request.hosts, isLoopbackHost);

    return loopback ? admitted({ kind: "local" }) : refuse("not_local");
  }

  const audience = request.mcp === true ? guard.mcp?.audience : guard.audience;

  if (audience === undefined || audience === "") return refuse("not_configured");

  const serviceToken = request.mcp === true ? guard.mcp?.serviceToken : undefined;

  try {
    return await classifyAssertion(request.assertion, {
      audience,
      keys: guard.keys,
      now: request.now,
      serviceToken: serviceToken === "" ? undefined : serviceToken,
    });
  } catch {
    // A lookup or a verification that throws (a signature of the wrong length, say) is a refusal, not a 500.
    return refuse("error");
  }
};

/** What the Worker's environment holds of the guard's vars (`ACCESS_AUDIENCE_VAR`, `LOCAL_MODE_VAR`), as strings. */
export type GuardEnv = {
  readonly [ACCESS_AUDIENCE_VAR]?: string;
  readonly [LOCAL_MODE_VAR]?: string;
  readonly [MCP_AUDIENCE_VAR]?: string;
  readonly [MCP_SERVICE_TOKEN_CLIENT_ID_VAR]?: string;
};

/**
 * The guard's deployment, read from the Worker's raw environment as `CONTAINER_FUSE` is, not through `Config`: a
 * `Config` read of the local-mode var would fail on the boolean alchemy's runtime makes of `"true"`, and at plan time
 * would bind a same-named value of the deploying shell onto the Worker as a secret, putting a deployed Worker in local
 * mode.
 */
export const guardFromEnv = (
  env: GuardEnv,
): Pick<AccessGuard, "audience" | "localMode" | "mcp"> => ({
  audience: env[ACCESS_AUDIENCE_VAR],
  localMode: env[LOCAL_MODE_VAR] === "true",
  mcp: {
    audience: env[MCP_AUDIENCE_VAR],
    serviceToken: env[MCP_SERVICE_TOKEN_CLIENT_ID_VAR],
  },
});

const forbidden = HttpServerResponse.text("Forbidden", {
  status: 403,
  headers: { "cache-control": "no-store" },
});

/** The hosts a request names: `Host`, and the URL's own when it is absolute. */
const hostsOf = (request: HttpServerRequest.HttpServerRequest): ReadonlyArray<string> => {
  const header = request.headers.host;
  const named = header === undefined ? [] : [header];

  try {
    return [...named, new URL(request.url).host];
  } catch {
    return named;
  }
};

/**
 * Runs `handler` for the owner's requests (and on `/mcp` the Local agent's) only, with who they are as {@link AccessCaller};
 * every other request gets a bare 403 and `handler` never sees it. A `fetch` through a service binding carries no
 * assertion, so it is refused here (internal callers use RPC entrypoints).
 */
export const guardAccess =
  (guard: AccessGuard) =>
  <E, R>(
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    Exclude<R, AccessCaller> | HttpServerRequest.HttpServerRequest
  > =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

      const verdict = yield* Effect.promise(() =>
        admit(
          {
            assertion: request.headers[ACCESS_ASSERTION_HEADER],
            hosts: hostsOf(request),
            mcp: isMcpRoute(request),
            now,
          },
          guard,
        ),
      );

      if (!verdict.admitted) {
        yield* Effect.logWarning("Access guard refused a request").pipe(
          Effect.annotateLogs({ reason: verdict.reason }),
        );

        return forbidden;
      }

      return yield* Effect.provideService(handler, AccessCaller, verdict.caller);
    });
