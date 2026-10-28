// The `web` extension (`docs/architecture/agent-capabilities.md` → v1): `web_search` and `web_fetch`, ported from pi-web-tools with an SSRF guard.
import { defineExtension } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DohResolverLive } from "./web/dns.ts";
import { WebFetch } from "./web/fetch.ts";
import { WebSearch } from "./web/search.ts";
import { WebTransportLive } from "./web/transport.ts";

export const extensionName = "web";

export { WebConfig, WebConfigLive } from "./web/config.ts";

export { DnsResolver } from "./web/dns.ts";

export { WebToolError } from "./web/errors.ts";

export { WebTransport } from "./web/transport.ts";

/** The network the tools use in a Worker: `fetch`, and DNS-over-HTTPS lookups for the SSRF guard. */
export const WebNetworkLive = DohResolverLive.pipe(Layer.provideMerge(WebTransportLive));

/** The `web` extension, with `web_search` and `web_fetch`. Needs the network (`WebNetworkLive`) and `WebConfig`. */
export const Web = Effect.all([WebSearch, WebFetch]).pipe(
  Effect.map(([search, fetch]) => defineExtension({ name: extensionName, tools: [search, fetch] })),
);
