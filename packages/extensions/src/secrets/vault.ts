// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
// Encryption of Secret values at rest (`docs/spec.md` → Secrets): AES-256-GCM under a key derived with HKDF from the
// Worker-secret master key and the Session's ID, so a record opens only in the Session that sealed it and only while
// the deployment holds the same master key. Each record is also bound to its Secret Name and expiry as additional
// data, so a record moved to another name or given a later expiry fails to open. Secrets kept for Environments, which
// do not expire, are sealed the same way by a vault of their own (`openKeptVault`), under a key derived for its
// purpose (the Registry's records, a Workspace's copy) and bound to the record's owner and name. WebCrypto only, so it
// runs in a Worker and under Node alike.
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

/** The HKDF key material of `masterKey`, once it is long enough to be one. */
const masterMaterial = (masterKey: string): Effect.Effect<CryptoKey, SecretVaultError> =>
  Effect.gen(function* () {
    if (masterKey.length < MIN_MASTER_KEY_LENGTH) {
      return yield* SecretVaultError.make({
        message: `The Secrets encryption key must be at least ${MIN_MASTER_KEY_LENGTH} characters; generate one with \`openssl rand -base64 32\``,
      });
    }

    return yield* attempt("import the master key", () =>
      crypto.subtle.importKey("raw", encoder.encode(masterKey), "HKDF", false, ["deriveKey"]),
    );
  });

/** A key derived from `material` with `salt` and `info`. */
const derive = (
  material: CryptoKey,
  salt: string,
  info: string,
  algorithm: Parameters<SubtleCrypto["deriveKey"]>[2],
  usages: Parameters<SubtleCrypto["deriveKey"]>[4],
) =>
  attempt("derive a key", () =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: encoder.encode(salt), info: encoder.encode(info) },
      material,
      algorithm,
      false,
      usages,
    ),
  );

/** `value` encrypted under `key`, bound to `additionalData`. */
const encrypt = (key: CryptoKey, value: string, additionalData: Uint8Array) =>
  Effect.gen(function* () {
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const ciphertext = yield* attempt("encrypt a Secret", () =>
      crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, encoder.encode(value)),
    );

    return { iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
  });

/** What `encrypt` sealed, opened, or a failure when the key or the additional data differ. */
const decrypt = (
  operation: string,
  key: CryptoKey,
  sealed: { readonly iv: string; readonly ciphertext: string },
  additionalData: Uint8Array,
) =>
  attempt(operation, () =>
    crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData },
      key,
      fromBase64(sealed.ciphertext),
    ),
  ).pipe(Effect.map((plain) => decoder.decode(plain)));

/** The vault of Session `session` under `masterKey`, the deployment's Worker secret. */
export const openVault = (
  masterKey: string,
  session: string,
): Effect.Effect<SecretVault, SecretVaultError> =>
  Effect.gen(function* () {
    const material = yield* masterMaterial(masterKey);

    const aes = yield* derive(
      material,
      session,
      "cloudpid secrets v1 aes-gcm",
      { name: "AES-GCM", length: 256 },
      ["encrypt", "decrypt"],
    );

    return {
      seal: (name, value, expiresAt) =>
        Effect.map(
          encrypt(aes, value, additionalData(session, name, expiresAt)),
          (sealed): SealedSecret => ({ version: 1, name, expiresAt, ...sealed }),
        ),
      open: (sealed) =>
        decrypt(
          `open Secret ${sealed.name}`,
          aes,
          sealed,
          additionalData(session, sealed.name, sealed.expiresAt),
        ),
    } satisfies SecretVault;
  });

/** A kept Secret's value at rest (an Environment's): its ciphertext, never its value or its name. */
export const SealedValue = Schema.Struct({
  version: Schema.Literal(1),
  iv: Schema.String,
  ciphertext: Schema.String,
});

export type SealedValue = typeof SealedValue.Type;

/** What a kept Secret's ciphertext is bound to: who keeps it (a scope, a Workspace), and its Secret Name. */
export type KeptBinding = { readonly owner: string; readonly name: string };

/** One purpose's key for Secrets that do not expire: AES-GCM for values, HMAC for digests of them. */
export type KeptVault = {
  readonly seal: (
    binding: KeptBinding,
    value: string,
  ) => Effect.Effect<SealedValue, SecretVaultError>;
  /** The value sealed under `binding`; fails when the record was sealed under another binding, purpose, or key. */
  readonly open: (
    binding: KeptBinding,
    sealed: SealedValue,
  ) => Effect.Effect<string, SecretVaultError>;
  /**
   * A keyed digest of `text` (HMAC-SHA-256, hex): it changes with `text` and says nothing of it to whoever does not hold
   * the master key, so it can stand for values in a key that is stored and shown in the clear.
   */
  readonly digest: (text: string) => Effect.Effect<string, SecretVaultError>;
};

const keptAdditionalData = (purpose: string, { owner, name }: KeptBinding): Uint8Array =>
  encoder.encode(JSON.stringify({ version: 1, purpose, owner, name }));

/**
 * The vault for Secrets kept with no expiry, for `purpose` (such as `registry` or a Workspace's object), under
 * `masterKey`. A record opens only under the same purpose, owner and name, while the deployment holds the same key.
 */
export const openKeptVault = (
  masterKey: string,
  purpose: string,
): Effect.Effect<KeptVault, SecretVaultError> =>
  Effect.gen(function* () {
    const material = yield* masterMaterial(masterKey);
    const salt = `cloudpid kept secrets:${purpose}`;

    const aes = yield* derive(
      material,
      salt,
      "cloudpid kept secrets v1 aes-gcm",
      { name: "AES-GCM", length: 256 },
      ["encrypt", "decrypt"],
    );

    const hmac = yield* derive(
      material,
      salt,
      "cloudpid kept secrets v1 hmac",
      { name: "HMAC", hash: "SHA-256", length: 256 },
      ["sign"],
    );

    return {
      seal: (binding, value) =>
        Effect.map(
          encrypt(aes, value, keptAdditionalData(purpose, binding)),
          (sealed): SealedValue => ({ version: 1, ...sealed }),
        ),
      open: (binding, sealed) =>
        decrypt(`open Secret ${binding.name}`, aes, sealed, keptAdditionalData(purpose, binding)),
      digest: (text) =>
        attempt("digest Secrets", () =>
          crypto.subtle.sign("HMAC", hmac, encoder.encode(text)),
        ).pipe(
          Effect.map((signature) =>
            Array.from(new Uint8Array(signature), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join(""),
          ),
        ),
    } satisfies KeptVault;
  });
