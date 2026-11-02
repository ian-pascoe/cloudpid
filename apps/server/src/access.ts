// docs/architecture/mcp-sign-in.md → The client document and the callback outside Access (The Access guard). The main
// Worker does not trust that Access ran in front of it: it verifies `Cf-Access-Jwt-Assertion` itself, on every route,
// and fails closed.
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off missingPipeableSignature:off globalDate:off -- WebCrypto and `fetch` are Promise APIs, over native arrays.

import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ACCESS_TEAM_DOMAIN, OWNER_EMAIL } from "./deployment.ts";

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
  | "not_local";

/** The guard's answer for one request. */
export type Verdict =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: Refusal };

const refuse = (reason: Refusal): Verdict => ({ admitted: false, reason });

const OWNER: Verdict = { admitted: true };

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
  // Present on a service token's assertion and on none of the owner's; only its presence is read.
  common_name: Schema.optionalKey(Schema.Unknown),
});

const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header));
const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Claims));

const Jwks = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kid: Schema.String,
      kty: Schema.Literal("RSA"),
      n: Schema.String,
      e: Schema.String,
    }),
  ),
});

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
  /** The audience of the main application, as the deploy put it in the Worker's vars. */
  readonly audience: string;
  readonly keys: TeamKeyLookup;
  /** Unix seconds. */
  readonly now: number;
};

/**
 * Classifies `assertion`, a `Cf-Access-Jwt-Assertion` value: the owner (an assertion of the team's, unexpired, for the
 * main application, whose `email` is {@link OWNER_EMAIL} and that has no `common_name`), or why not. Never trusts the
 * claims before the signature has been checked, and reads no identity from anywhere else (`ctx.access.getIdentity()`
 * answers `undefined` for a service token).
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

  const { iss, aud, exp, nbf, email, common_name } = claims.value;

  if (iss !== `https://${ACCESS_TEAM_DOMAIN}`) return refuse("wrong_issuer");

  if (exp === undefined || exp <= expected.now) return refuse("expired");

  if (nbf !== undefined && nbf > expected.now + NOT_BEFORE_LEEWAY_SECONDS) {
    return refuse("not_yet_valid");
  }

  const audiences = aud === undefined ? [] : Arr.ensure(aud);

  if (!audiences.includes(expected.audience)) return refuse("wrong_audience");

  // Before the email: a service token has neither an email nor the owner's identity, and is told apart from a stranger.
  if (common_name !== undefined) return refuse("common_name");

  if (email !== OWNER_EMAIL) return refuse("not_owner");

  return OWNER;
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

  for (const jwk of decoded.value.keys) {
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        KEY_ALGORITHM,
        false,
        ["verify"],
      ),
    );
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
  let reading: Promise<void> | undefined;

  const read = () => {
    attemptedAt = clock();
    reading ??= load()
      .then(importTeamKeys)
      .then(
        (keys) => {
          kept = keys;
          keptAt = clock();
        },
        () => undefined,
      )
      .finally(() => {
        reading = undefined;
      });

    return reading;
  };

  const fresh = () => keptAt !== undefined && clock() - keptAt < KEYS_MAX_AGE_MS;

  return async (kid) => {
    const key = fresh() ? kept.get(kid) : undefined;

    if (key !== undefined) return key;

    // A read already under way answers this one too.
    if (reading !== undefined) {
      await reading;

      return fresh() ? kept.get(kid) : undefined;
    }

    const cooldown = fresh() ? UNKNOWN_KEY_COOLDOWN_MS : FAILED_READ_COOLDOWN_MS;

    if (attemptedAt !== undefined && clock() - attemptedAt < cooldown) return undefined;

    await read();

    return fresh() ? kept.get(kid) : undefined;
  };
};

/** The hosts `alchemy dev` serves the Worker on. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

const isLoopbackHost = (host: string): boolean => {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
};

/** What the guard reads of a request. */
export type GuardedRequest = {
  readonly assertion: string | undefined;
  /** Every host the request names: its `Host` header and the host of its URL, where it has one. */
  readonly hosts: ReadonlyArray<string>;
  /** Unix seconds. */
  readonly now: number;
};

/** What the guard reads of the Worker's deployment. */
export type AccessGuard = {
  /** The main application's audience; undefined on `alchemy dev`, and on a deployed Worker that was not given it. */
  readonly audience: string | undefined;
  /** The Worker was built by `alchemy dev` ({@link LOCAL_MODE_VAR}), where there is no Access. */
  readonly localMode: boolean;
  readonly keys: TeamKeyLookup;
};

/**
 * Whether `request` is the owner's. Under `alchemy dev` (local mode) a request counts as the owner only when every host
 * it names is loopback; anywhere else the assertion decides, and a Worker without its audience admits nothing.
 */
export const admit = async (request: GuardedRequest, guard: AccessGuard): Promise<Verdict> => {
  if (guard.localMode) {
    const loopback = request.hosts.length > 0 && Arr.every(request.hosts, isLoopbackHost);

    return loopback ? OWNER : refuse("not_local");
  }

  if (guard.audience === undefined || guard.audience === "") return refuse("not_configured");

  return classifyAssertion(request.assertion, {
    audience: guard.audience,
    keys: guard.keys,
    now: request.now,
  });
};

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
 * Runs `handler` for the owner's requests only; every other request gets a bare 403 and `handler` never sees it. A
 * `fetch` through a service binding carries no assertion, so it is refused here (internal callers use RPC entrypoints).
 */
export const guardAccess =
  (guard: AccessGuard) =>
  <E, R>(
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  > =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

      const verdict = yield* Effect.promise(() =>
        admit(
          { assertion: request.headers[ACCESS_ASSERTION_HEADER], hosts: hostsOf(request), now },
          guard,
        ),
      );

      if (!verdict.admitted) {
        yield* Effect.logWarning("Access guard refused a request").pipe(
          Effect.annotateLogs({ reason: verdict.reason }),
        );

        return forbidden;
      }

      return yield* handler;
    });
