// The two signatures a webhook delivery may carry (`docs/architecture/triggers.md` → Formats): GitHub's
// `X-Hub-Signature-256` and Standard Webhooks' `webhook-id`, `webhook-timestamp` and `webhook-signature`. Each is an
// HMAC-SHA256 over the bytes received, checked before anything is parsed, with the Trigger's Signing secret; a
// signature is compared by `crypto.subtle.verify`, which does not leak where it differs. Pure over Web Crypto, so it
// runs in Node tests as in workerd.
// @effect-diagnostics asyncFunction:off globalDate:off missingPipeableSignature:off -- Web Crypto is Promise-native.

/** How far a `standard` delivery's timestamp may be from now, either way, in seconds: the Standard Webhooks spec's 5 minutes. */
export const STANDARD_TOLERANCE_S = 5 * 60;

/** How a signature check came out: `stale` is a `standard` delivery whose timestamp is outside the window. */
export type SignatureCheck = "valid" | "invalid" | "stale";

const encoder = new TextEncoder();

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);

/** The bytes `hex` spells, or undefined when it is not an even number of hex digits. */
const fromHex = (hex: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^(?:[0-9a-f]{2})+$/iu.test(hex)) return undefined;

  const bytes = new Uint8Array(hex.length / 2);

  for (let at = 0; at < bytes.length; at++)
    bytes[at] = Number.parseInt(hex.slice(at * 2, at * 2 + 2), 16);

  return bytes;
};

/** The bytes standard base64 spells, or undefined when it is not base64. */
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(text) || text.length % 4 !== 0) return undefined;

  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
};

/** Whether `signature` is the HMAC-SHA256 of `message` under `secret`. */
const verifies = async (
  secret: string,
  signature: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>,
): Promise<boolean> => crypto.subtle.verify("HMAC", await hmacKey(secret), signature, message);

/**
 * GitHub's check: `signature` is the `X-Hub-Signature-256` header, `sha256=` and the hex HMAC-SHA256 of `body` keyed with
 * `secret`. No header, another algorithm or a malformed digest is `invalid`.
 */
export const checkGitHubSignature = async (input: {
  readonly secret: string;
  readonly body: Uint8Array<ArrayBuffer>;
  readonly signature: string | null;
}): Promise<SignatureCheck> => {
  const digest =
    input.signature?.startsWith("sha256=") === true ? input.signature.slice(7) : undefined;

  const bytes = digest === undefined ? undefined : fromHex(digest);

  if (bytes === undefined) return "invalid";

  return (await verifies(input.secret, bytes, input.body)) ? "valid" : "invalid";
};

/**
 * The Standard Webhooks check: the headers' `id`, `timestamp` (in seconds) and `signature` (space-separated `v1,<base64>`
 * entries, any of which may match), over `<id>.<timestamp>.<body>`. A missing header, a timestamp that is no integer, or
 * no matching entry is `invalid`; a timestamp more than `STANDARD_TOLERANCE_S` from `now` (ms) is `stale`, whatever the
 * signature, since a replay is refused whether or not it is signed.
 */
export const checkStandardSignature = async (input: {
  readonly secret: string;
  readonly body: Uint8Array<ArrayBuffer>;
  readonly id: string | null;
  readonly timestamp: string | null;
  readonly signature: string | null;
  readonly now: number;
}): Promise<SignatureCheck> => {
  const { id, timestamp, signature } = input;

  if (id === null || timestamp === null || signature === null) return "invalid";

  if (!/^\d{1,15}$/u.test(timestamp)) return "invalid";

  if (Math.abs(input.now / 1000 - Number(timestamp)) > STANDARD_TOLERANCE_S) return "stale";

  const message = new Uint8Array(
    await new Blob([encoder.encode(`${id}.${timestamp}.`), input.body]).arrayBuffer(),
  );

  for (const entry of signature.split(" ")) {
    const [version, encoded, ...rest] = entry.split(",");

    if (version !== "v1" || encoded === undefined || rest.length > 0) continue;

    const bytes = fromBase64(encoded);

    if (bytes !== undefined && (await verifies(input.secret, bytes, message))) return "valid";
  }

  return "invalid";
};

/**
 * A Signing secret as Standard Webhooks' libraries take it, `whsec_` and the base64 of the key: the form a `standard`
 * Trigger shows, so a sender that follows the spec signs with the same bytes this checks with.
 */
export const standardSecretText = (secret: string): string =>
  `whsec_${btoa(String.fromCharCode(...encoder.encode(secret)))}`;
