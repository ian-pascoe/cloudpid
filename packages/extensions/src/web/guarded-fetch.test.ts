// The guard is an Effect, driven here through Promises like the rest of the tests that read its outcome.
// @effect-diagnostics asyncFunction:off strictEffectProvide:off preferEffectArray:off missedPipeableOpportunity:off
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { guardedFetch, MAX_REDIRECTS } from "./guarded-fetch.ts";
import { fakeResolver, fakeTransport, ok, redirect } from "./web.fixture.ts";

/** Run a guarded GET of `url` against scripted pages, and say what came back and what was sent. */
const run = async (
  url: string,
  pages: Readonly<Record<string, Response>>,
  hosts: Readonly<Record<string, readonly string[]>> = { "example.com": ["93.184.216.34"] },
) => {
  const transport = fakeTransport(
    (request) => pages[request.url] ?? new Response("", { status: 404 }),
  );

  const resolver = fakeResolver(hosts);

  const exit = await Effect.runPromiseExit(
    guardedFetch({ url, headers: {} }).pipe(
      Effect.provide(Layer.merge(transport.layer, resolver.layer)),
    ),
  );

  return {
    exit,
    sent: transport.requests.map((request) => request.url),
    lookups: resolver.lookups,
  };
};

/** The failure message of a failed exit. */
const failure = (exit: Exit.Exit<unknown, { readonly message: string }>): string | undefined =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Option.map(Cause.findErrorOption(exit.cause), (error) => error.message))
    : undefined;

describe("guardedFetch", () => {
  it("fetches a public URL", async () => {
    const { exit, sent } = await run("https://example.com/", { "https://example.com/": ok("hi") });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(sent).toEqual(["https://example.com/"]);
  });

  it.each([
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[fd00:ec2::254]/",
    "http://[::ffff:7f00:1]/",
    "http://2130706433/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://localhost:8787/",
    "http://10.0.0.5:6379/",
  ])("refuses %s without sending anything", async (url) => {
    const { exit, sent, lookups } = await run(url, {});

    expect(failure(exit)).toMatch(/^blocked: /);
    expect(sent).toEqual([]);
    expect(lookups).toEqual([]);
  });

  it("refuses a URL that is not HTTP(S)", async () => {
    const { exit, sent } = await run("file:///etc/passwd", {});

    expect(failure(exit)).toMatch(/unsupported URL scheme file:/);
    expect(sent).toEqual([]);
  });

  it("refuses a URL with credentials", async () => {
    const { exit } = await run("https://user:secret@example.com/", {});

    expect(failure(exit)).toBe("URLs with credentials are not supported");
  });

  it("refuses a public-looking name that resolves to a private address", async () => {
    const { exit, sent } = await run(
      "https://rebind.example.net/",
      {},
      { "rebind.example.net": ["93.184.216.34", "10.0.0.1"] },
    );

    expect(failure(exit)).toBe("blocked: host resolves to a private address");
    expect(sent).toEqual([]);
  });

  it("refuses a name that resolves to the metadata address over IPv6", async () => {
    const { exit } = await run(
      "https://v6.example.net/",
      {},
      { "v6.example.net": ["fd00:ec2::254"] },
    );

    expect(failure(exit)).toMatch(/^blocked: host resolves to a unique-local address/);
  });

  it("refuses a host that does not resolve", async () => {
    const { exit, sent } = await run("https://nowhere.example.net/", {});

    expect(failure(exit)).toBe("host not found");
    expect(sent).toEqual([]);
  });

  describe("redirects", () => {
    it("follows a redirect to a public URL, and answers the final page", async () => {
      const { exit, sent } = await run("https://example.com/a", {
        "https://example.com/a": redirect("/b"),
        "https://example.com/b": ok("done"),
      });

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(sent).toEqual(["https://example.com/a", "https://example.com/b"]);

      if (Exit.isSuccess(exit)) expect(exit.value.url.toString()).toBe("https://example.com/b");
    });

    it.each([
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      "http://[::1]:8080/",
      "http://0x7f.1/",
      "http://metadata.google.internal/",
      "http://[::ffff:169.254.169.254]/",
    ])("refuses a redirect to %s and never requests it", async (target) => {
      const { exit, sent } = await run("https://example.com/a", {
        "https://example.com/a": redirect(target),
      });

      expect(failure(exit)).toMatch(/^redirect blocked: /);
      expect(sent).toEqual(["https://example.com/a"]);
    });

    it("refuses a redirect, many hops in, to a name that resolves to a private address", async () => {
      const { exit, sent } = await run(
        "https://example.com/1",
        {
          "https://example.com/1": redirect("https://example.com/2", 301),
          "https://example.com/2": redirect("https://evil.example.net/x", 307),
        },
        { "example.com": ["93.184.216.34"], "evil.example.net": ["192.168.0.10"] },
      );

      expect(failure(exit)).toBe("redirect blocked: host resolves to a private address");
      expect(sent).toEqual(["https://example.com/1", "https://example.com/2"]);
    });

    it("refuses a redirect to a non-HTTP scheme", async () => {
      const { exit } = await run("https://example.com/a", {
        "https://example.com/a": redirect("ftp://example.com/file"),
      });

      expect(failure(exit)).toMatch(/unsupported URL scheme ftp:/);
    });

    it("gives up after too many redirects", async () => {
      const { exit, sent } = await run("https://example.com/loop", {
        "https://example.com/loop": redirect("/loop"),
      });

      expect(failure(exit)).toBe(`too many redirects (more than ${MAX_REDIRECTS})`);
      expect(sent).toHaveLength(MAX_REDIRECTS + 1);
    });

    it("answers a redirect without a Location as the response it is", async () => {
      const { exit } = await run("https://example.com/a", {
        "https://example.com/a": new Response("", { status: 302 }),
      });

      expect(Exit.isSuccess(exit) && exit.value.response.status).toBe(302);
    });
  });
});
