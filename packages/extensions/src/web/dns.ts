// @effect-diagnostics missedPipeableOpportunity:off
// The residual SSRF risk a Worker cannot close by checking the URL: a public-looking name can resolve to a private
// address. Workers expose no resolver, so before each hop the guard asks Cloudflare's DNS-over-HTTPS endpoint what the
// name resolves to, and refuses the hop when any answer is not public.
//
// What is left: the platform's own lookup at `fetch` time is separate from this one, so a name that answers
// differently to two queries milliseconds apart (DNS rebinding with a zero TTL) can still pass. Two things bound it:
// both lookups go through Cloudflare's caching resolver, so an answer holds for its TTL, and Cloudflare's edge also
// refuses Worker subrequests to private and internal addresses (not something the guard relies on). The check fails
// closed: a lookup that cannot be made or understood refuses the hop.
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { WebToolError } from "./errors.ts";
import { WebTransport } from "./transport.ts";

export type DnsResolverService = {
  /** The addresses `hostname` resolves to, IPv4 and IPv6. Fails when it does not resolve. */
  readonly resolve: (hostname: string) => Effect.Effect<readonly string[], WebToolError>;
};

/** Resolves a hostname to the addresses a request to it would reach. */
export class DnsResolver extends Context.Service<DnsResolver, DnsResolverService>()(
  "@cloudpid/extensions/web/dns/DnsResolver",
) {}

/** Cloudflare's DNS-over-HTTPS JSON endpoint. */
export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

const A = 1;
const AAAA = 28;
const NXDOMAIN = 3;

const DohAnswer = Schema.Struct({
  Status: Schema.Finite,
  Answer: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.Finite, data: Schema.String })),
  ),
});

const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(DohAnswer));

const unresolvable = WebToolError.make({
  message: "could not verify where the host resolves (DNS lookup failed)",
});

export const DohResolverLive = Layer.effect(
  DnsResolver,
  Effect.gen(function* () {
    const transport = yield* WebTransport;

    /** The answer to one query, as record type `type`'s addresses. */
    const query = (hostname: string, type: "A" | "AAAA") =>
      transport
        .fetch({
          url: `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`,
          headers: { accept: "application/dns-json" },
        })
        .pipe(
          Effect.flatMap((response) =>
            response.ok
              ? Effect.tryPromise({ try: () => response.text(), catch: () => unresolvable })
              : Effect.fail(unresolvable),
          ),
          Effect.flatMap((text) =>
            Effect.fromOption(decodeAnswer(text)).pipe(Effect.mapError(() => unresolvable)),
          ),
          Effect.flatMap((answer) => {
            if (answer.Status === NXDOMAIN) {
              return Effect.fail(WebToolError.make({ message: "host not found" }));
            }

            return answer.Status === 0
              ? Effect.succeed(
                  Arr.flatMap(answer.Answer ?? [], (record) =>
                    record.type === (type === "A" ? A : AAAA) ? [record.data] : [],
                  ),
                )
              : Effect.fail(unresolvable);
          }),
        );

    return {
      resolve: (hostname) =>
        Effect.all([query(hostname, "A"), query(hostname, "AAAA")], { concurrency: 2 }).pipe(
          Effect.map(Arr.flatten),
          Effect.filterOrFail(Arr.isReadonlyArrayNonEmpty, () =>
            WebToolError.make({ message: "host has no address records" }),
          ),
        ),
    } satisfies DnsResolverService;
  }),
);
