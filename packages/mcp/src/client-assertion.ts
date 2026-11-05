/**
 * The client assertion of RFC 7523 §2.2 (`private_key_jwt`; `docs/architecture/mcp-sign-in.md` → Client Credentials): the
 * claims, the PKCS#8 key import (RSA of at least 2048 bits signs RS256, P-256 signs ES256) and the compact JWS. Re-exported
 * by `./oauth`; no SDK import. Nothing here returns, logs or throws a key: a problem says what to fix and never quotes it.
 */
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off preferEffectArray:off globalJsonInEffect:off
import * as Predicate from "effect/Predicate";

/** RFC 7523 §2.2's `client_assertion_type`. */
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** An assertion is valid for this long after `iat`. */
export const CLIENT_ASSERTION_LIFETIME_SECONDS = 60;

/** The smallest RSA modulus a key may have. */
export const MIN_RSA_MODULUS_BITS = 2048;

/** The algorithms an assertion is signed with. */
export type AssertionAlgorithm = "RS256" | "ES256";

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const textBase64Url = (text: string): string => toBase64Url(encoder.encode(text));

/** A 128-bit `jti`, as 32 hexadecimal digits. */
export const randomJti = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/** The claims of a client assertion, in the order they are written (`iat` and `exp` in seconds). */
export const clientAssertionClaims = (input: {
  readonly clientId: string;
  readonly audience: string;
  readonly now: number;
  readonly jti: string;
}) => {
  const iat = Math.floor(input.now / 1000);

  return {
    iss: input.clientId,
    sub: input.clientId,
    aud: input.audience,
    iat,
    exp: iat + CLIENT_ASSERTION_LIFETIME_SECONDS,
    jti: input.jti,
  };
};

/** A private key, ready to sign with. */
export type SigningKey = {
  readonly key: CryptoKey;
  readonly algorithm: AssertionAlgorithm;
};

/** A key that cannot be used, and why: what to fix, never a part of the key. */
export type KeyProblem = { readonly problem: string };

const PEM_ARMOR = /^-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----\s*$/;

const base64Bytes = (text: string): Uint8Array | undefined => {
  try {
    return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
};

const RSA_IMPORT = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const EC_IMPORT = { name: "ECDSA", namedCurve: "P-256" } as const;

/**
 * `pem`, a PKCS#8 private key (`BEGIN PRIVATE KEY`), as a key to sign with: RSA of at least 2048 bits (RS256) or P-256
 * (ES256). A PKCS#1 or SEC1 key, an encrypted key, another curve and a short RSA key are problems that say how to fix
 * the key and never quote it.
 */
export const importSigningKey = async (pem: string): Promise<SigningKey | KeyProblem> => {
  const armored = PEM_ARMOR.exec(pem.trim());

  if (armored === null) {
    return { problem: "The private key is not a PEM block (-----BEGIN PRIVATE KEY-----)" };
  }

  const label = armored[1] ?? "";

  if (label === "ENCRYPTED PRIVATE KEY") {
    return { problem: "The private key is encrypted: cloudpid needs an unencrypted PKCS#8 key" };
  }

  if (label !== "PRIVATE KEY") {
    return {
      problem: `The private key is a ${label} block: cloudpid needs PKCS#8 (-----BEGIN PRIVATE KEY-----); convert it with openssl pkcs8 -topk8 -nocrypt`,
    };
  }

  const der = base64Bytes((armored[2] ?? "").replaceAll(/\s+/g, ""));

  if (der === undefined || der.length === 0) {
    return { problem: "The private key's PEM block is not valid Base64" };
  }

  const asRsa = await crypto.subtle
    .importKey("pkcs8", der, RSA_IMPORT, false, ["sign"])
    .catch(() => undefined);

  if (asRsa !== undefined) {
    const { algorithm } = asRsa;

    const modulusLength =
      Predicate.hasProperty(algorithm, "modulusLength") &&
      Predicate.isNumber(algorithm.modulusLength)
        ? algorithm.modulusLength
        : 0;

    return modulusLength >= MIN_RSA_MODULUS_BITS
      ? { key: asRsa, algorithm: "RS256" }
      : {
          problem: `The RSA private key has ${modulusLength} bits: cloudpid needs at least ${MIN_RSA_MODULUS_BITS}`,
        };
  }

  const asEc = await crypto.subtle
    .importKey("pkcs8", der, EC_IMPORT, false, ["sign"])
    .catch(() => undefined);

  return asEc === undefined
    ? { problem: "The private key is neither an RSA key (2048 bits or more) nor a P-256 key" }
    : { key: asEc, algorithm: "ES256" };
};

/** Whether `found` is a key problem. */
export const isKeyProblem = (found: SigningKey | KeyProblem): found is KeyProblem =>
  "problem" in found;

/**
 * A signed client assertion (a JWS, compact): the header `{ alg, typ: "JWT", kid? }`, the claims of
 * {@link clientAssertionClaims}, and the signature (PKCS#1 v1.5 over SHA-256 for RS256, the fixed-length `r || s` form
 * for ES256).
 */
export const signClientAssertion = async (input: {
  readonly signing: SigningKey;
  readonly clientId: string;
  readonly audience: string;
  readonly keyId?: string | undefined;
  readonly now: number;
  readonly jti: string;
}): Promise<string> => {
  const base = { alg: input.signing.algorithm, typ: "JWT" };
  const header = input.keyId === undefined ? base : { ...base, kid: input.keyId };

  const signingInput = `${textBase64Url(JSON.stringify(header))}.${textBase64Url(
    JSON.stringify(clientAssertionClaims(input)),
  )}`;

  const signature = await crypto.subtle.sign(
    input.signing.algorithm === "RS256" ? RSA_IMPORT : { name: "ECDSA", hash: "SHA-256" },
    input.signing.key,
    encoder.encode(signingInput),
  );

  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
};

/**
 * The values of a PEM `key` that no text of ours may repeat: the block as written and its Base64 body without armor or
 * whitespace (the form it takes in a DER dump or a log that joined its lines).
 */
export const pemSecrets = (key: string): ReadonlyArray<string> => [
  key,
  key.replaceAll(/-----(BEGIN|END) [A-Z ]+-----|\s+/g, ""),
];
