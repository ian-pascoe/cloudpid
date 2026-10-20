// @effect-diagnostics missingPipeableSignature:off
// Encryption of Secret values at rest (`docs/spec.md` → Secrets): AES-256-GCM under a key derived with HKDF from the
// Worker-secret master key and the Session's ID, so a record opens only in the Session that sealed it and only while
// the deployment holds the same master key. Each record is also bound to its Secret Name and expiry as additional
// data, so a record moved to another name or given a later expiry fails to open. WebCrypto only, so it runs in a
// Worker and under Node alike.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A Secret at rest: its ciphertext, never its value. */
export const SealedSecret = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.String,
  /** Milliseconds since the epoch after which the Secret no longer resolves. */
  expiresAt: Schema.Finite,
  iv: Schema.String,
  ciphertext: Schema.String,
});

export type SealedSecret = typeof SealedSecret.Type;

/** The vault could not seal or open a Secret. */
export class SecretVaultError extends Schema.TaggedError<
  SecretVaultError,
  { readonly brand: unique symbol }
>()("SecretVaultError", { message: Schema.String }) {}

/** The shortest master key accepted: `openssl rand -base64 32` gives 44 characters. */
export const MIN_MASTER_KEY_LENGTH = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (bytes: ArrayBuffer | Uint8Array): string => {
  let binary = "";

  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);

  return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => SecretVaultError.make({ message: `Cannot ${operation}: ${String(cause)}` }),
  });

/** One Session's key: AES-GCM for values. */
export type SecretVault = {
  readonly seal: (
    name: string,
    value: string,
    expiresAt: number,
  ) => Effect.Effect<SealedSecret, SecretVaultError>;
  readonly open: (sealed: SealedSecret) => Effect.Effect<string, SecretVaultError>;
};

/** Bind the ciphertext to its Session, Secret Name, and expiry, so an edited record fails to open. */
const additionalData = (session: string, name: string, expiresAt: number): Uint8Array =>
  encoder.encode(JSON.stringify({ version: 1, session, name, expiresAt }));

/** The vault of Session `session` under `masterKey`, the deployment's Worker secret. */
export const openVault = (
  masterKey: string,
  session: string,
): Effect.Effect<SecretVault, SecretVaultError> =>
  Effect.gen(function* () {
    if (masterKey.length < MIN_MASTER_KEY_LENGTH) {
      return yield* SecretVaultError.make({
        message: `The Secrets encryption key must be at least ${MIN_MASTER_KEY_LENGTH} characters; generate one with \`openssl rand -base64 32\``,
      });
    }

    const material = yield* attempt("import the master key", () =>
      crypto.subtle.importKey("raw", encoder.encode(masterKey), "HKDF", false, ["deriveKey"]),
    );

    const derive = (
      info: string,
      algorithm: Parameters<SubtleCrypto["deriveKey"]>[2],
      usages: string[],
    ) =>
      attempt("derive a key", () =>
        crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: encoder.encode(session),
            info: encoder.encode(info),
          },
          material,
          algorithm,
          false,
          usages,
        ),
      );

    const aes = yield* derive("cloudpid secrets v1 aes-gcm", { name: "AES-GCM", length: 256 }, [
      "encrypt",
      "decrypt",
    ]);

    return {
      seal: (name, value, expiresAt) =>
        Effect.gen(function* () {
          const iv = crypto.getRandomValues(new Uint8Array(12));

          const ciphertext = yield* attempt("encrypt a Secret", () =>
            crypto.subtle.encrypt(
              { name: "AES-GCM", iv, additionalData: additionalData(session, name, expiresAt) },
              aes,
              encoder.encode(value),
            ),
          );

          return {
            version: 1,
            name,
            expiresAt,
            iv: toBase64(iv),
            ciphertext: toBase64(ciphertext),
          } satisfies SealedSecret;
        }),
      open: (sealed) =>
        attempt(`open Secret ${sealed.name}`, () =>
          crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: fromBase64(sealed.iv),
              additionalData: additionalData(session, sealed.name, sealed.expiresAt),
            },
            aes,
            fromBase64(sealed.ciphertext),
          ),
        ).pipe(Effect.map((plain) => decoder.decode(plain))),
    } satisfies SecretVault;
  });
