// @effect-diagnostics asyncFunction:off strictEffectProvide:off missedPipeableOpportunity:off preferEffectArray:off
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { DnsResolver, DOH_ENDPOINT, DohResolverLive } from "./dns.ts";
import { WebToolError } from "./errors.ts";
import { fakeTransport, ok } from "./web.fixture.ts";
import { type WebRequest } from "./transport.ts";

/** A DoH JSON answer. */
const doh = (answer: { Status: number; Answer?: { type: number; data: string }[] }): Response =>
  ok(JSON.stringify(answer), "application/dns-json");

const resolve = async (
  hostname: string,
  answer: (request: WebRequest) => Response | WebToolError,
) => {
  const transport = fakeTransport(answer);

  const exit = await Effect.runPromiseExit(
    Effect.flatMap(Effect.service(DnsResolver), (resolver) => resolver.resolve(hostname)).pipe(
      Effect.provide(DohResolverLive.pipe(Layer.provide(transport.layer))),
    ),
  );

  return { exit, sent: transport.requests };
};

const failure = (exit: Exit.Exit<unknown, WebToolError>): string | undefined =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Option.map(Cause.findErrorOption(exit.cause), (error) => error.message))
    : undefined;

describe("DohResolverLive", () => {
  it("asks for A and AAAA records and gives every address, skipping CNAMEs", async () => {
    const { exit, sent } = await resolve("www.example.com", (request) =>
      request.url.endsWith("type=A")
        ? doh({
            Status: 0,
            Answer: [
              { type: 5, data: "example.com." },
              { type: 1, data: "93.184.216.34" },
            ],
          })
        : doh({
            Status: 0,
            Answer: [{ type: 28, data: "2606:2800:21f:cb07:6820:80da:af6b:8b2c" }],
          }),
    );

    expect(Exit.isSuccess(exit) && exit.value).toEqual([
      "93.184.216.34",
      "2606:2800:21f:cb07:6820:80da:af6b:8b2c",
    ]);
    expect(sent.map((request) => request.url)).toEqual([
      `${DOH_ENDPOINT}?name=www.example.com&type=A`,
      `${DOH_ENDPOINT}?name=www.example.com&type=AAAA`,
    ]);
    expect(sent[0]?.headers.accept).toBe("application/dns-json");
  });

  it("accepts a host with only IPv4 or only IPv6 records", async () => {
    const { exit } = await resolve("v4.example.com", (request) =>
      request.url.endsWith("type=A")
        ? doh({ Status: 0, Answer: [{ type: 1, data: "1.2.3.4" }] })
        : doh({ Status: 0 }),
    );

    expect(Exit.isSuccess(exit) && exit.value).toEqual(["1.2.3.4"]);
  });

  it("fails a host that does not exist", async () => {
    const { exit } = await resolve("nope.example.com", () => doh({ Status: 3 }));

    expect(failure(exit)).toBe("host not found");
  });

  it("fails a host with no address records", async () => {
    const { exit } = await resolve("empty.example.com", () => doh({ Status: 0 }));

    expect(failure(exit)).toBe("host has no address records");
  });

  it.each([
    ["a server failure", () => doh({ Status: 2 })],
    ["an HTTP error", () => new Response("", { status: 500 })],
    ["a body that is not DoH JSON", () => ok("<html>", "text/html")],
    ["a transport failure", () => WebToolError.make({ message: "network error" })],
  ])("fails closed on %s", async (_name, answer) => {
    const { exit } = await resolve("example.com", answer);

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("fails closed with a message that says the host could not be verified", async () => {
    const { exit } = await resolve("example.com", () => doh({ Status: 2 }));

    expect(failure(exit)).toBe("could not verify where the host resolves (DNS lookup failed)");
  });
});
