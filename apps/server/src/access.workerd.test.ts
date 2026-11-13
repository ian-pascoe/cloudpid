// @effect-diagnostics asyncFunction:off globalDate:off preferEffectArray:off
import { expect, it } from "vite-plus/test";
import { admit, teamKeys } from "./access.ts";
import { ACCESS_TEAM_DOMAIN, OWNER_EMAIL } from "./deployment.ts";

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const encode = (value: Record<string, string | number | ReadonlyArray<string>>) =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));

// workerd's WebCrypto is what the deployed guard runs on: a signed assertion verifies against a key set that was read
// over the loader, concurrent lookups each read for themselves, and a bad signature is a refusal.
it("verifies an assertion in workerd, and refuses a forged one", async () => {
  // SAFETY: RSA parameters make a key pair, which the Workers types do not tell apart from a symmetric key.
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  // SAFETY: the "jwk" format exports a JSON Web Key.

  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const jwks = JSON.stringify({ keys: [{ kid: "k", kty: "RSA", n: jwk.n, e: jwk.e }] });
  const now = Math.floor(Date.now() / 1000);

  const signed = `${encode({ alg: "RS256", kid: "k" })}.${encode({
    iss: `https://${ACCESS_TEAM_DOMAIN}`,
    aud: ["aud"],
    email: OWNER_EMAIL,
    exp: now + 600,
  })}`;

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(signed),
  );

  const guard = { audience: "aud", localMode: false, keys: teamKeys(() => Promise.resolve(jwks)) };
  const request = (assertion: string) => ({ assertion, hosts: ["x.workers.dev"], now });

  const verdicts = await Promise.all([
    admit(request(`${signed}.${base64Url(new Uint8Array(signature))}`), guard),
    admit(request(`${signed}.${base64Url(new Uint8Array(signature))}`), guard),
    admit(request(`${signed}.${base64Url(new Uint8Array(8))}`), guard),
    admit(request(`${signed}.${base64Url(new Uint8Array(0))}`), guard),
  ]);

  expect(verdicts.map((verdict) => verdict.admitted)).toEqual([true, true, false, false]);
});
