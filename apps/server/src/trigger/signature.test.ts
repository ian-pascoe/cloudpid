// The checks are Promise-based (Web Crypto), so this test is too.
// @effect-diagnostics asyncFunction:off globalDate:off nodeBuiltinImport:off preferEffectArray:off
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  checkGitHubSignature,
  checkStandardSignature,
  STANDARD_TOLERANCE_S,
  standardSecretText,
} from "./signature.ts";

const secret = "k3Zr9mWq2-V8xT1uYhN0aBcDeFgHiJkLmNoPqRsTuVw";
const bytes = (text: string) => Uint8Array.from(new TextEncoder().encode(text));
const body = bytes('{"action":"opened","number":7}');

const github = (key: string, over: Uint8Array<ArrayBuffer> = body) =>
  `sha256=${createHmac("sha256", key).update(over).digest("hex")}`;

describe("checkGitHubSignature", () => {
  it("accepts the HMAC-SHA256 hex digest of the body, keyed with the Signing secret", async () => {
    expect(await checkGitHubSignature({ secret, body, signature: github(secret) })).toBe("valid");
  });

  it("checks the bytes received, not what they parse to", async () => {
    const spaced = bytes('{ "action": "opened", "number": 7 }');

    expect(await checkGitHubSignature({ secret, body: spaced, signature: github(secret) })).toBe(
      "invalid",
    );
    expect(
      await checkGitHubSignature({ secret, body: spaced, signature: github(secret, spaced) }),
    ).toBe("valid");
  });

  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["another algorithm", `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`],
    ["no prefix", createHmac("sha256", secret).update(body).digest("hex")],
    ["a digest that is not hex", "sha256=zz"],
    ["an odd digest", "sha256=abc"],
    ["a digest of another key", github("another-secret")],
    ["a short digest", github(secret).slice(0, -2)],
  ])("refuses %s", async (_, signature) => {
    expect(await checkGitHubSignature({ secret, body, signature })).toBe("invalid");
  });

  it("takes capital hex digits", async () => {
    const upper = `sha256=${github(secret).slice(7).toUpperCase()}`;

    expect(await checkGitHubSignature({ secret, body, signature: upper })).toBe("valid");
  });
});

describe("checkStandardSignature", () => {
  const now = Date.parse("2026-11-09T15:00:00Z");
  const seconds = String(now / 1000);

  const sign = (key: string, id: string, timestamp: string, over = body) =>
    `v1,${createHmac("sha256", key)
      .update(Buffer.concat([bytes(`${id}.${timestamp}.`), over]))
      .digest("base64")}`;

  const check = (over: Partial<Parameters<typeof checkStandardSignature>[0]> = {}) =>
    checkStandardSignature({
      secret,
      body,
      id: "msg_1",
      timestamp: seconds,
      signature: sign(secret, "msg_1", seconds),
      now,
      ...over,
    });

  it("accepts the signature of <id>.<timestamp>.<body>", async () => {
    expect(await check()).toBe("valid");
  });

  it("accepts any entry of a list, as the spec's key rotation sends", async () => {
    const signature = `v1,${Buffer.from("junk").toString("base64")} ${sign(secret, "msg_1", seconds)}`;

    expect(await check({ signature })).toBe("valid");
    expect(await check({ signature: `v2,abc ${sign(secret, "msg_1", seconds)}` })).toBe("valid");
  });

  it("makes one pass over the body however many entries the header lists", async () => {
    const entries = Array.from(
      { length: 5000 },
      (_, at) => `v1,${Buffer.from(`junk-${String(at)}`).toString("base64")}`,
    );

    const signature = [...entries, sign(secret, "msg_1", seconds)].join(" ");
    const sign$ = vi.spyOn(crypto.subtle, "sign");
    const verify = vi.spyOn(crypto.subtle, "verify");
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    try {
      expect(await check({ signature })).toBe("valid");
      expect(await check({ signature: entries.join(" ") })).toBe("invalid");
      expect(sign$).toHaveBeenCalledTimes(2);
      expect(importKey).toHaveBeenCalledTimes(2);
      expect(verify).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("is the signature a Standard Webhooks library makes from the secret as whsec_ text", async () => {
    // A library decodes `whsec_<base64>` and keys the HMAC with the bytes: here, the Signing secret's own.
    const shown = standardSecretText(secret);
    const key = Buffer.from(shown.slice("whsec_".length), "base64");
    const library = `v1,${createHmac("sha256", key).update(`msg_1.${seconds}.`).update(body).digest("base64")}`;

    expect(shown.startsWith("whsec_")).toBe(true);
    expect(await check({ signature: library })).toBe("valid");
  });

  it.each([
    ["no id", { id: null }],
    ["no timestamp", { timestamp: null }],
    ["no signature", { signature: null }],
    ["a signature of another id", { id: "msg_2" }],
    ["a signature of another key", { signature: sign("another-secret", "msg_1", seconds) }],
    ["a signature of another body", { body: bytes("{}") }],
    ["a signature that is not base64", { signature: "v1,!!!" }],
    ["an entry with no version", { signature: sign(secret, "msg_1", seconds).slice(3) }],
    [
      "an entry of another version",
      { signature: sign(secret, "msg_1", seconds).replace("v1", "v2") },
    ],
    ["an empty signature", { signature: "" }],
    ["a timestamp that is no integer", { timestamp: "1.5e9" }],
    ["a timestamp with a sign", { timestamp: "-1" }],
  ])("refuses %s", async (_, over) => {
    expect(await check(over)).toBe("invalid");
  });

  it("is stale a second past 5 minutes, either way, and valid at the edge", async () => {
    const at = (offset: number) => String(now / 1000 + offset);

    const signed = (timestamp: string) => ({
      timestamp,
      signature: sign(secret, "msg_1", timestamp),
    });

    expect(await check(signed(at(-STANDARD_TOLERANCE_S)))).toBe("valid");
    expect(await check(signed(at(STANDARD_TOLERANCE_S)))).toBe("valid");
    expect(await check(signed(at(-STANDARD_TOLERANCE_S - 1)))).toBe("stale");
    expect(await check(signed(at(STANDARD_TOLERANCE_S + 1)))).toBe("stale");
  });

  it("is stale for an old timestamp whatever its signature, so a replay never looks signed", async () => {
    const old = String(now / 1000 - 3600);

    expect(await check({ timestamp: old, signature: "v1,AAAA" })).toBe("stale");
  });
});
