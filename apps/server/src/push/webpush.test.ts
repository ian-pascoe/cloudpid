// @effect-diagnostics asyncFunction:off globalFetch:off -- WebCrypto and `fetch` are Promise APIs.
import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  encryptPayload,
  exportPublicKey,
  generateEcdhKeys,
  MAX_PAYLOAD_BYTES,
  sendPush,
  type Vapid,
  vapidAuthorization,
} from "./webpush.ts";

// RFC 8291 appendix A: one message with every input and the bytes it must produce.
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  serverPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  serverPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  receiverPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  receiverPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  header:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

const ecJwk = (publicKey: string, privateKey?: string): JsonWebKey => {
  const point = base64UrlDecode(publicKey);

  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(point.slice(1, 33)),
    y: base64UrlEncode(point.slice(33, 65)),
  };

  if (privateKey !== undefined) jwk.d = privateKey;

  return jwk;
};

const importEcdh = (jwk: JsonWebKey, usages: ["deriveBits"] | []) =>
  crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, usages);

/** The `{ public, private }` ECDH key pair of a subscription, as a browser would hold it, with its `p256dh`. */
const newReceiver = async () => {
  const pair = await generateEcdhKeys();
  const p256dh = await exportPublicKey(pair.publicKey);

  return { pair, p256dh, auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) };
};

const hkdf = async (ikm: Uint8Array, salt: Uint8Array, info: string, bits: number) => {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);

  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(info) },
      key,
      bits,
    ),
  );
};

/** What a user agent does with a message (RFC 8291 §3.4), written independently of the encryption under test. */
const decrypt = async (
  body: Uint8Array,
  receiver: { readonly pair: CryptoKeyPair; readonly p256dh: string; readonly auth: string },
): Promise<string> => {
  const salt = body.slice(0, 16);
  const keyLength = body[20] ?? 0;
  const serverPublic = body.slice(21, 21 + keyLength);
  const record = body.slice(21 + keyLength);

  const serverKey = await crypto.subtle.importKey(
    "raw",
    serverPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  // workerd and Node read `public`; the Workers typings call it `$public`.
  const ecdh = { name: "ECDH", public: serverKey };

  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(ecdh, receiver.pair.privateKey, 256),
  );

  const keyInfo = new Uint8Array([
    ...new TextEncoder().encode("WebPush: info\0"),
    ...base64UrlDecode(receiver.p256dh),
    ...serverPublic,
  ]);

  const ikm = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: base64UrlDecode(receiver.auth),
      info: keyInfo,
    },
    await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]),
    256,
  );

  const key = await crypto.subtle.importKey(
    "raw",
    await hkdf(new Uint8Array(ikm), salt, "Content-Encoding: aes128gcm\0", 128),
    "AES-GCM",
    false,
    ["decrypt"],
  );

  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: await hkdf(new Uint8Array(ikm), salt, "Content-Encoding: nonce\0", 96),
      },
      key,
      record,
    ),
  );

  // The record ends with the delimiter 0x02 (the last record), after the payload.
  expect(plain.at(-1)).toBe(2);

  return new TextDecoder().decode(plain.slice(0, -1));
};

describe("encryptPayload", () => {
  it("produces the message of RFC 8291 appendix A from its inputs", async () => {
    const serverKeys: CryptoKeyPair = {
      publicKey: await importEcdh(ecJwk(RFC.serverPublic), []),
      privateKey: await importEcdh(ecJwk(RFC.serverPublic, RFC.serverPrivate), ["deriveBits"]),
    };

    const body = await encryptPayload(
      base64UrlDecode(RFC.plaintext),
      { p256dh: RFC.receiverPublic, auth: RFC.auth },
      { salt: base64UrlDecode(RFC.salt), serverKeys },
    );

    const expected = new Uint8Array([
      ...base64UrlDecode(RFC.header),
      ...base64UrlDecode(RFC.ciphertext),
    ]);

    expect(base64UrlEncode(body)).toBe(base64UrlEncode(expected));
  });

  it("is read by the subscription's own keys, with a fresh key and salt each time", async () => {
    const receiver = await newReceiver();
    const text = JSON.stringify({ title: "Fix the build", body: "Run finished" });

    const first = await encryptPayload(new TextEncoder().encode(text), receiver);
    const second = await encryptPayload(new TextEncoder().encode(text), receiver);

    expect(await decrypt(first, receiver)).toBe(text);
    expect(await decrypt(second, receiver)).toBe(text);
    expect(first).not.toEqual(second);
  });

  it("refuses a payload that would not fit one push message", async () => {
    const receiver = await newReceiver();

    await expect(
      encryptPayload(new Uint8Array(MAX_PAYLOAD_BYTES), receiver).then((body) => body.length),
    ).resolves.toBe(4096);
    await expect(encryptPayload(new Uint8Array(MAX_PAYLOAD_BYTES + 1), receiver)).rejects.toThrow(
      "at most",
    );
  });
});

/** A VAPID identity with a fresh key. */
const newVapid = async (): Promise<Vapid> => {
  // The same curve as ECDH; only the point and `d` are kept, as in the deploy-time secrets.
  const pair = await generateEcdhKeys();
  // SAFETY: the JWK format exports a `JsonWebKey`; the typings' overloads cannot narrow it.
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;

  return {
    subject: "mailto:owner@example.com",
    publicKey: await exportPublicKey(pair.publicKey),
    privateKey: jwk.d ?? "",
  };
};

describe("vapidAuthorization", () => {
  it("signs a token for the push service's origin that its public key verifies", async () => {
    const vapid = await newVapid();

    const header = await vapidAuthorization(
      "https://push.example.net/wpush/v2/abc?x=1",
      vapid,
      1_700_000_000,
    );

    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);

    expect(match?.[2]).toBe(vapid.publicKey);

    const [head, claims, signature] = (match?.[1] ?? "").split(".");

    const decode = (segment: string | undefined) =>
      JSON.parse(new TextDecoder().decode(base64UrlDecode(segment ?? "")));

    expect(decode(head)).toEqual({ typ: "JWT", alg: "ES256" });
    expect(decode(claims)).toEqual({
      aud: "https://push.example.net",
      exp: 1_700_000_000 + 12 * 60 * 60,
      sub: "mailto:owner@example.com",
    });

    const verifier = await crypto.subtle.importKey(
      "jwk",
      ecJwk(vapid.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );

    expect(base64UrlDecode(signature ?? "")).toHaveLength(64);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verifier,
        base64UrlDecode(signature ?? ""),
        new TextEncoder().encode(`${head}.${claims}`),
      ),
    ).toBe(true);
  });
});

describe("sendPush", () => {
  const respond = (status: number) => {
    const requests: Request[] = [];

    const fake = (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));

      return Promise.resolve(new Response(null, { status }));
    };

    // SAFETY: `sendPush` calls `fetch` with a URL and an init, which `fake` takes.
    return { requests, fetch: fake as typeof fetch };
  };

  it("posts an encrypted message with VAPID to the subscription's endpoint", async () => {
    const receiver = await newReceiver();
    const vapid = await newVapid();
    const { requests, fetch } = respond(201);

    const result = await sendPush(
      {
        endpoint: "https://push.example.net/wpush/v2/abc",
        keys: { p256dh: receiver.p256dh, auth: receiver.auth },
      },
      '{"title":"t"}',
      vapid,
      { fetch, now: 1_700_000_000_000 },
    );

    expect(result).toEqual({ kind: "sent" });
    expect(requests).toHaveLength(1);

    const [request] = requests;

    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://push.example.net/wpush/v2/abc");
    expect(request?.headers.get("content-encoding")).toBe("aes128gcm");
    expect(request?.headers.get("ttl")).toBe("86400");
    expect(request?.headers.get("authorization")).toMatch(/^vapid t=.+, k=.+$/);
    expect(await decrypt(new Uint8Array(await request!.arrayBuffer()), receiver)).toBe(
      '{"title":"t"}',
    );
  });

  it("reports a subscription the push service no longer knows (404, 410) as gone", async () => {
    const receiver = await newReceiver();
    const vapid = await newVapid();

    const subscription = {
      endpoint: "https://push.example.net/x",
      keys: { p256dh: receiver.p256dh, auth: receiver.auth },
    };

    for (const status of [404, 410]) {
      expect(await sendPush(subscription, "{}", vapid, { fetch: respond(status).fetch })).toEqual({
        kind: "gone",
      });
    }
  });

  it("reports any other refusal with its status, as not gone", async () => {
    const receiver = await newReceiver();
    const vapid = await newVapid();

    expect(
      await sendPush(
        {
          endpoint: "https://push.example.net/x",
          keys: { p256dh: receiver.p256dh, auth: receiver.auth },
        },
        "{}",
        vapid,
        { fetch: respond(429).fetch },
      ),
    ).toEqual({ kind: "failed", status: 429 });
  });
});
