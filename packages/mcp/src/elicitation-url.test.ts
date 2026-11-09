/**
 * The pages cloudpid declines unseen, and the ones it shows (`docs/architecture/mcp-server-requests.md` → Elicitation
 * requests → URL mode; #388 D9.1, D9.2): golden lists, since a miss in either is a server sending the owner somewhere
 * it should not, or a page the owner is never shown.
 */
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { checkElicitationUrl, ELICITATION_URL_MAX, registrableDomain } from "./elicitation-url.ts";

const OWN = new Set(["pi.ianpascoe.dev", "cloudpid-server-dev.ian-g-pascoe.workers.dev"]);

const own = (host: string) =>
  OWN.has(host) || host === "ianpascoe.app" || host.endsWith(".ianpascoe.app");

const problemOf = (url: string) => {
  const checked = checkElicitationUrl(url, own);

  return Result.isFailure(checked) ? checked.failure : undefined;
};

describe("the pages declined unseen", () => {
  it.each([
    ["http://example.com/auth", "the page isn't served over HTTPS"],
    ["ftp://example.com/auth", "the page isn't served over HTTPS"],
    ["javascript:alert(1)", "the page isn't served over HTTPS"],
    ["https://user@example.com/auth", "the address has a username or password in it"],
    ["https://user:secret@example.com/", "the address has a username or password in it"],
    ["https://:secret@example.com/", "the address has a username or password in it"],
  ])("%s", (url, reason) => {
    expect(problemOf(url)).toEqual({ kind: "declined", reason });
  });

  it.each([
    "https://localhost/auth",
    "https://db.internal/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://2130706433/",
    "https://10.0.0.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://[fe80::1]/",
    "https://100.64.0.1/",
    "https://[fc00::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[64:ff9b::192.168.0.1]/",
  ])("%s is local or private", (url) => {
    expect(problemOf(url)).toEqual({
      kind: "declined",
      reason: "the page is on a local or private address",
    });
  });

  it.each(["https://pi.ianpascoe.dev/oauth/mcp/start"])(
    "%s is one of cloudpid's own hosts",
    (url) => {
      expect(problemOf(url)).toEqual({
        kind: "declined",
        reason: "the page is on one of cloudpid's own hosts",
      });
    },
  );

  it.each(["", "not a url", "https://", "https://exa mple.com/", "//example.com/"])(
    "%j is malformed",
    (url) => {
      expect(problemOf(url)).toMatchObject({ kind: "malformed" });
    },
  );

  it("is malformed over 8,192 characters, and fine at the limit", () => {
    const base = "https://example.com/?q=";

    expect(problemOf(`${base}${"a".repeat(ELICITATION_URL_MAX - base.length + 1)}`)).toEqual({
      kind: "malformed",
      reason: "the address is over 8192 characters",
    });
    expect(problemOf(`${base}${"a".repeat(ELICITATION_URL_MAX - base.length)}`)).toBeUndefined();
  });
});

describe("the pages shown", () => {
  it.each([
    "https://example.com/authorize?client=1#top",
    "https://172.15.0.1/",
    "https://172.32.0.1/",
    "https://100.63.255.255/",
    "https://100.128.0.1/",
    "https://169.253.0.1/",
    "https://[fec0::1]/",
    "https://localhost.example.com/",
    "https://my.internal.example.com/",
  ])("%s", (url) => {
    expect(problemOf(url)).toBeUndefined();
  });

  it("gives the address as the browser opens it, its host and the domain to emphasize", () => {
    const checked = checkElicitationUrl("https://Auth.Example.COM/a b?x=1", own);

    expect(Result.isSuccess(checked) ? checked.success : undefined).toEqual({
      url: "https://auth.example.com/a%20b?x=1",
      host: "auth.example.com",
      domain: "example.com",
    });
  });

  it("warns of an internationalized host, and of one that mixes scripts in a label", () => {
    const idn = checkElicitationUrl("https://münchen.example/", own);
    // Cyrillic `а` among Latin letters: `аpple.com`.
    const mixed = checkElicitationUrl("https://\u0430pple.com/", own);
    // A whole label in one other script is only internationalized.
    const cyrillic = checkElicitationUrl("https://пример.example/", own);
    const plain = checkElicitationUrl("https://apple.com/", own);

    expect(Result.isSuccess(idn) ? idn.success : undefined).toMatchObject({
      host: "xn--mnchen-3ya.example",
      warning: "idn",
    });
    expect(Result.isSuccess(mixed) ? mixed.success : undefined).toMatchObject({
      warning: "mixed_script",
    });
    expect(Result.isSuccess(cyrillic) ? cyrillic.success : undefined).toMatchObject({
      warning: "idn",
    });
    expect(Result.isSuccess(plain) ? plain.success : undefined).not.toHaveProperty("warning");
  });
});

describe("the registrable domain", () => {
  it.each([
    ["a.b.example.com", "example.com"],
    ["auth.example.co.uk", "example.co.uk"],
    // A hosting platform's customer is the page's owner, so the platform's own suffix is not the domain.
    ["www.attacker.github.io", "attacker.github.io"],
    ["localhost", "localhost"],
    ["8.8.8.8", "8.8.8.8"],
  ])("%s → %s", (host, domain) => {
    expect(registrableDomain(host)).toBe(domain);
  });
});
