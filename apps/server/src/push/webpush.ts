// @effect-diagnostics asyncFunction:off globalFetch:off globalDate:off preferEffectArray:off missingPipeableSignature:off -- WebCrypto and `fetch` are Promise APIs and these helpers are plain functions over bytes; the callers wrap them in Effect.
// Web Push from a Worker (`docs/architecture/client-and-protocol.md`): message encryption for the `aes128gcm` content coding
// (RFC 8291, with RFC 8188's record format) and VAPID (RFC 8292), both on WebCrypto, so nothing here needs Node.

import type * as Schema from "effect/Schema";

/** A browser's Web Push subscription (`PushSubscription.toJSON()`), as the Registry keeps it. */
export type PushSubscriptionKeys = {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
};

/** The application server's VAPID identity, from the deploy-time secrets. */
export type Vapid = {
  /** A `mailto:` or `https:` URL the push service can reach the operator at. */
  readonly subject: string;
  /** The uncompressed P-256 public key, base64url (65 octets). */
  readonly publicKey: string;
  /** The P-256 private scalar `d`, base64url (32 octets). */
  readonly privateKey: string;
};

const encoder = new TextEncoder();

/** The record size written in the header; a message is one record, so this bounds its size. */
const RECORD_SIZE = 4096;

/** The header: salt, record size, key ID length, and the server's 65-octet public key as the key ID. */
const HEADER_BYTES = 16 + 4 + 1 + 65;

/** AES-GCM's tag, plus the padding delimiter the single record ends with. */
const RECORD_OVERHEAD = 16 + 1;

/** The most plaintext octets one message holds: push services accept bodies of 4096 octets (RFC 8291 §4). */
export const MAX_PAYLOAD_BYTES = 4096 - HEADER_BYTES - RECORD_OVERHEAD;

export const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export const base64UrlDecode = (text: string): Uint8Array => {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));

  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

/** HKDF-SHA-256 (extract and expand) of `ikm` under `salt` and `info`, `bits` long. */
const hkdf = async (
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  bits: number,
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);

  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits),
  );
};

/** A fresh P-256 ECDH key pair, for the server's side of a message. */
export const generateEcdhKeys = async (): Promise<CryptoKeyPair> =>
  // SAFETY: generating an ECDH key gives a pair; the typings' overloads cannot tell it from a symmetric key.
  (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;

/** A public key's uncompressed point, base64url: what a subscription's `p256dh` and `VAPID_PUBLIC_KEY` are. */
export const exportPublicKey = async (key: CryptoKey): Promise<string> =>
  // SAFETY: the raw format exports an `ArrayBuffer`; the typings' overloads cannot narrow it.
  base64UrlEncode(new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer));

/** Fixed inputs of `encryptPayload`, which are random in use: only a test (RFC 8291 appendix A) supplies them. */
export type EncryptionInputs = {
  readonly salt?: Uint8Array;
  readonly serverKeys?: CryptoKeyPair;
};

/**
 * `plaintext` as a single `aes128gcm` record for the subscription whose key is `p256dh` and secret `auth` (both
 * base64url), header included: the body of a push request with `Content-Encoding: aes128gcm`.
 */
export const encryptPayload = async (
  plaintext: Uint8Array,
  subscription: { readonly p256dh: string; readonly auth: string },
  inputs: EncryptionInputs = {},
): Promise<Uint8Array> => {
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`A push payload holds at most ${MAX_PAYLOAD_BYTES} bytes`);
  }

  const receiverPublic = base64UrlDecode(subscription.p256dh);
  const authSecret = base64UrlDecode(subscription.auth);
  const salt = inputs.salt ?? crypto.getRandomValues(new Uint8Array(16));

  const serverKeys = inputs.serverKeys ?? (await generateEcdhKeys());
  const serverPublic = base64UrlDecode(await exportPublicKey(serverKeys.publicKey));

  const receiverKey = await crypto.subtle.importKey(
    "raw",
    receiverPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  // workerd and browsers read `public`; the Workers typings call it `$public`.
  const ecdh = { name: "ECDH", public: receiverKey };

  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, serverKeys.privateKey, 256));

  // RFC 8291 §3.4: the input keying material mixes the ECDH secret with the subscription's auth secret.
  const keyInfo = concat(encoder.encode("WebPush: info\0"), receiverPublic, serverPublic);
  const ikm = await hkdf(shared, authSecret, keyInfo, 256);

  const contentKey = await hkdf(ikm, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikm, salt, encoder.encode("Content-Encoding: nonce\0"), 96);

  const key = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);

  // The delimiter 0x02 marks the last (here, only) record.
  const record = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      concat(plaintext, Uint8Array.of(2)),
    ),
  );

  // RFC 8188 §2.1: salt, record size, key ID length and key ID (the server's public key).
  const header = new Uint8Array(21 + serverPublic.length);
  const view = new DataView(header.buffer);

  header.set(salt, 0);
  view.setUint32(16, RECORD_SIZE);
  view.setUint8(20, serverPublic.length);
  header.set(serverPublic, 21);

  return concat(header, record);
};

/** How long a VAPID token lives: RFC 8292 allows up to 24 hours, and a push service needs it only on arrival. */
const TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

const jsonSegment = (value: Schema.Json): string =>
  base64UrlEncode(encoder.encode(JSON.stringify(value)));

/** The VAPID key pair as a JWK: a P-256 point is 0x04, x and y. */
const vapidJwk = (vapid: Vapid): JsonWebKey => {
  const publicKey = base64UrlDecode(vapid.publicKey);

  return {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(publicKey.slice(1, 33)),
    y: base64UrlEncode(publicKey.slice(33, 65)),
    d: vapid.privateKey,
  };
};

/** The `Authorization` header (RFC 8292 §3) that proves to the push service at `endpoint` who is sending. */
export const vapidAuthorization = async (
  endpoint: string,
  vapid: Vapid,
  nowSeconds: number,
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "jwk",
    vapidJwk(vapid),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const unsigned = `${jsonSegment({ typ: "JWT", alg: "ES256" })}.${jsonSegment({
    aud: new URL(endpoint).origin,
    exp: nowSeconds + TOKEN_LIFETIME_SECONDS,
    sub: vapid.subject,
  })}`;

  // WebCrypto signs ECDSA as the raw r || s that JWS's ES256 asks for.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(unsigned),
  );

  return `vapid t=${unsigned}.${base64UrlEncode(new Uint8Array(signature))}, k=${vapid.publicKey}`;
};

/** The octets of base64url `text`, or undefined when it is not base64url. */
const decodeStrict = (text: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return undefined;

  return base64UrlDecode(text);
};

/**
 * Why `vapid` cannot sign pushes, or undefined when it can: the subject must be a `mailto:` or `https:` URL, the public
 * key a 65-octet uncompressed P-256 point, the private key 32 octets, and the two a pair (a token signed with one is
 * verified by the other). A bad secret otherwise shows only as a push service refusing every message.
 */
export const vapidProblem = async (vapid: Vapid): Promise<string | undefined> => {
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(vapid.subject)) {
    return "VAPID_SUBJECT must be a mailto: or https: URL";
  }

  const publicKey = decodeStrict(vapid.publicKey);

  if (publicKey?.length !== 65 || publicKey[0] !== 4) {
    return "VAPID_PUBLIC_KEY must be an uncompressed P-256 point (65 octets) in base64url";
  }

  if (decodeStrict(vapid.privateKey)?.length !== 32) {
    return "VAPID_PRIVATE_KEY must be a P-256 private key (32 octets) in base64url";
  }

  try {
    const probe = encoder.encode("vapid pair check");
    const algorithm = { name: "ECDSA", namedCurve: "P-256" };

    const signer = await crypto.subtle.importKey("jwk", vapidJwk(vapid), algorithm, false, [
      "sign",
    ]);

    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer, probe);

    const verifier = await crypto.subtle.importKey("raw", publicKey, algorithm, false, ["verify"]);

    const matches = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifier,
      signature,
      probe,
    );

    return matches
      ? undefined
      : "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not a matching key pair";
  } catch {
    return "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not a matching key pair";
  }
};

/** What became of one push. `gone` means the push service no longer knows the subscription (404 or 410). */
export type PushResult =
  | { readonly kind: "sent" }
  | { readonly kind: "gone" }
  | { readonly kind: "failed"; readonly status: number };

export type SendOptions = {
  /** How long the push service keeps an undelivered message, in seconds. */
  readonly ttl?: number;
  readonly fetch?: typeof fetch | undefined;
  /** Epoch milliseconds. */
  readonly now?: number;
  /** Abort the request after this many milliseconds. */
  readonly timeoutMs?: number;
};

/** A day: a finished run is still news to a phone that was off for a few hours. */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/** Send `payload` to `subscription`. A network failure or a timeout rejects; a refusal is a `PushResult`. */
export const sendPush = async (
  subscription: PushSubscriptionKeys,
  payload: string,
  vapid: Vapid,
  options: SendOptions = {},
): Promise<PushResult> => {
  const now = options.now ?? Date.now();

  const [body, authorization] = await Promise.all([
    encryptPayload(encoder.encode(payload), subscription.keys),
    vapidAuthorization(subscription.endpoint, vapid, Math.floor(now / 1000)),
  ]);

  const response = await (options.fetch ?? fetch)(subscription.endpoint, {
    method: "POST",
    headers: {
      authorization,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(options.ttl ?? DEFAULT_TTL_SECONDS),
      urgency: "normal",
    },
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });

  // The body is not read, but a response left unread holds its connection.
  await response.body?.cancel();

  if (response.ok) return { kind: "sent" };

  if (response.status === 404 || response.status === 410) return { kind: "gone" };

  return { kind: "failed", status: response.status };
};
