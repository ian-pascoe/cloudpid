// Starting and completing an MCP sign-in over real Durable Object SQLite and a fake network (`docs/architecture/mcp-sign-in.md`
// → Client registration, Starting and completing a sign-in; ADR-0035): the client ladder, the issuer pin and binding, the
// `state` and the PKCE pair, and every outcome of the callback. The authorization server is a table of responses; nothing
// reaches the network.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferSchemaOverJson:off schemaSync:off preferEffectRecord:off
import { sha256Hex } from "@cloudpid/config";
import { type KeptVault, openKeptVault } from "@cloudpid/extensions/secrets/core";
import { DnsResolver, WebTransport } from "@cloudpid/extensions/web";
import type { OAuthFetch } from "@cloudpid/mcp/oauth";
import {
  type McpAuthChallenge,
  McpSignInConfirmation,
  type McpSignInCompleteAnswer,
  type McpSignInCompleteInput,
  type McpSignInStartAnswer,
  type McpSignInStartInput,
} from "@cloudpid/mcp/types";
import { DEFAULT_ENVIRONMENT } from "@cloudpid/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { describe, expect, it } from "vitest";
import { ACCESS_ISSUER, mcpApplicationProps } from "../mcp-access.ts";
import { guardedOAuthFetch } from "../mcp/oauth-fetch.ts";
import { ownHostRouted } from "../mcp/own-host-transport.ts";
import { pkceChallenge } from "../mcp/sign-in-client.ts";
import {
  completeMcpSignIn,
  confirmMcpSignIn,
  type FlowDeps,
  startMcpSignIn,
} from "./mcp-sign-in-flow.ts";
import { signInTarget } from "./mcp-sign-in-registry.ts";
import {
  MCP_OAUTH_PURPOSE,
  openTokens,
  openValue,
  PENDING_TABLE,
  REGISTRATIONS_TABLE,
  sealTokens,
} from "./mcp-sign-in-seal.ts";
import {
  type McpSignIns,
  openMcpSignIns,
  PENDING_SIGN_IN_TTL_MS,
  registrationKey,
  stateHash,
} from "./mcp-sign-ins.ts";
import { writeSettings } from "./settings.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

const MASTER = "test-master-key-0123456789abcdef0123456789";
const NOW = 1_000_000;

const AS = "https://auth.example.com";
const SERVER_URL = "https://mcp.sentry.dev/mcp";
const ORIGIN = "https://cloudpid-server-pr-9.ian-g-pascoe.workers.dev";
const CODE = "authorization-code-7c2e";
const ACCESS = "access-token-77ab";
const REFRESH = "refresh-token-9f2c";
const SECRET = "client-secret-d41e";

const STAGE = { origin: ORIGIN, label: "pr-9", local: false, documentEnabled: true };

const servers = (value: Schema.Json): Schema.Json => ({ mcp: { servers: value } });

const metadata = (over: Record<string, Schema.Json> = {}) => ({
  issuer: AS,
  authorization_endpoint: `${AS}/authorize`,
  token_endpoint: `${AS}/token`,
  registration_endpoint: `${AS}/register`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  scopes_supported: ["read", "write", "offline_access"],
  ...over,
});

/** One request the fake network saw. */
type Call = {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly form: URLSearchParams;
  readonly json: unknown;
};

type Answer = Response | Schema.Json | undefined;

const isText = Schema.is(Schema.String);

const RedirectUris = Schema.Struct({ redirect_uris: Schema.Array(Schema.String) });

const ClientName = Schema.Struct({ client_name: Schema.String });

/** The URL of an answer that sends the owner's browser somewhere. */
const urlOf = (answer: { readonly status: string }): URL => {
  if ("url" in answer && isText(answer.url)) return new URL(answer.url);

  throw new Error(`No URL in an answer that says ${answer.status}`);
};

/** The message of an answer that says why not. */
const messageOf = (answer: { readonly status: string }): string => {
  if ("message" in answer && isText(answer.message)) return answer.message;

  throw new Error(`No message in an answer that says ${answer.status}`);
};

/** The `state` of the interstitial of an answer that shows it. */
const stateOfConfirmation = (answer: { readonly status: string }): string => {
  if ("confirmation" in answer) {
    return Schema.decodeUnknownSync(McpSignInConfirmation)(answer.confirmation).state;
  }

  throw new Error(`No interstitial in an answer that says ${answer.status}`);
};

/** The first redirect URI of a registration request. */
const redirectUriOf = (call: Call | undefined): string | undefined =>
  Schema.decodeUnknownSync(RedirectUris)(call?.json).redirect_uris[0];

/** The `client_name` of a registration request. */
const clientNameOf = (call: Call | undefined): string =>
  Schema.decodeUnknownSync(ClientName)(call?.json).client_name;

type Handler = (call: Call) => Answer | Promise<Answer>;

/** A table of `"METHOD url"` → answer (a Response, or JSON for a 200); every other request is a 404. */
const network = (routes: Record<string, Handler>) => {
  const calls: Array<Call> = [];

  const fetch: OAuthFetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = await new Response(init?.body ?? null).text();
    const headers = new Headers(init?.headers);

    const call: Call = {
      method,
      url: `${url.origin}${url.pathname}`,
      headers,
      form: new URLSearchParams(headers.get("content-type")?.includes("json") === true ? "" : body),
      json: headers.get("content-type")?.includes("json") === true ? JSON.parse(body) : undefined,
    };

    calls.push(call);

    const handler = routes[`${method} ${call.url}`];
    const answer = handler === undefined ? undefined : await handler(call);

    if (answer instanceof Response) return answer;

    return answer === undefined
      ? new Response("not found", { status: 404 })
      : Response.json(answer);
  };

  return { fetch, calls };
};

/** The routes of a server that discovers, registers and issues tokens as the tests need. */
const sentry = (
  over: Record<string, Handler> = {},
  asMetadata: Record<string, Schema.Json> = {},
) => ({
  "GET https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp": () => ({
    resource: SERVER_URL,
    authorization_servers: [AS],
    scopes_supported: ["read"],
  }),
  [`GET ${AS}/.well-known/oauth-authorization-server`]: () => metadata(asMetadata),
  [`POST ${AS}/register`]: (call: Call) =>
    new Response(
      JSON.stringify({ client_id: "registered-client-1", redirect_uris: [redirectUriOf(call)] }),
      { status: 201, headers: { "content-type": "application/json" } },
    ),
  [`POST ${AS}/token`]: () => ({
    access_token: ACCESS,
    token_type: "Bearer",
    refresh_token: REFRESH,
    expires_in: 3600,
  }),
  ...over,
});

/**
 * `fetch` (the table) behind the Registry's sign-in network: `guardedOAuthFetch` over `ownHostRouted`, whose reader is a
 * fake `MCP_ENGINE.fetchPublic` that records the URL in `engineAsked` and reads the table too, and whose direct transport
 * is the table; every host resolves to a public address.
 */
const routedFetch = (fetch: OAuthFetch, engineAsked: Array<string>): OAuthFetch => {
  const direct = Layer.succeed(WebTransport, {
    fetch: (request) =>
      Effect.promise(() => {
        const init: RequestInit = { method: request.method ?? "GET", headers: request.headers };

        if (request.body !== undefined) init.body = request.body;

        return fetch(request.url, init);
      }),
  });

  const resolver = Layer.succeed(DnsResolver, { resolve: () => Effect.succeed(["93.184.216.34"]) });

  const engine = {
    fetchPublic: async (request: {
      readonly url: string;
      readonly headers?: Record<string, string>;
    }) => {
      engineAsked.push(request.url);

      const response = await fetch(request.url, { headers: request.headers ?? {} });
      const headers: Record<string, string> = {};

      response.headers.forEach((value, name) => {
        headers[name] = value;
      });

      return { status: "fetched", code: response.status, headers, body: await response.text() };
    },
  };

  return guardedOAuthFetch(
    ownHostRouted(engine).pipe(Layer.provideMerge(Layer.mergeAll(direct, resolver))),
  );
};

type Flow = {
  readonly signIns: McpSignIns;
  readonly vault: KeptVault;
  readonly calls: Array<Call>;
  /** Every span the start, the confirmation and the callback made, with its attributes. */
  readonly spans: Array<Tracer.NativeSpan>;
  readonly setGlobal: (value: Schema.Json) => void;
  /** Record `challenge` for `name`'s sign-in, as `McpHost` reports a 401's. */
  readonly noteChallenge: (name: string, challenge: McpAuthChallenge) => void;
  /** The URLs read from `McpWorker` (`MCP_ENGINE.fetchPublic`), under `{ routed: true }`. */
  readonly engineAsked: Array<string>;
  readonly keyHash: (name: string) => string;
  readonly start: (
    over?: Partial<McpSignInStartInput>,
    now?: number,
  ) => Promise<McpSignInStartAnswer>;
  readonly confirm: (
    state: string,
    decision?: string,
    now?: number,
  ) => ReturnType<typeof confirmMcpSignIn> extends Effect.Effect<infer A> ? Promise<A> : never;
  readonly complete: (
    state: string,
    over?: Partial<McpSignInCompleteInput>,
    now?: number,
  ) => Promise<McpSignInCompleteAnswer>;
  /** Start, and take the `state` out of the redirect (and confirm first, when the issuer is to be confirmed). */
  readonly signIn: (over?: Partial<McpSignInStartInput>, now?: number) => Promise<URL>;
};

const run = <A>(
  routes: Record<string, Handler>,
  body: (flow: Flow) => Promise<A>,
  options: {
    readonly secrets?: Record<string, string>;
    /**
     * Send the flow's requests through the Registry's sign-in network (`ownHostRouted` under `guardedOAuthFetch`): a hop
     * to one of cloudpid's own hosts goes to a fake `MCP_ENGINE.fetchPublic`, every other to the table directly.
     */
    readonly routed?: boolean;
  } = {},
) =>
  runInDurableObject(
    env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
    async (_: TestRegistry, state) => {
      const store = openRegistryStore(state.storage);
      const signIns = openMcpSignIns(state.storage, store);
      const vault = await Effect.runPromise(openKeptVault(MASTER, MCP_OAUTH_PURPOSE));
      const net = network(routes);
      const engineAsked: Array<string> = [];
      const spans: Array<Tracer.NativeSpan> = [];

      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);

          spans.push(span);

          return span;
        },
      });

      const traced = <A>(effect: Effect.Effect<A>): Promise<A> =>
        Effect.runPromise(effect.pipe(Effect.provideService(Tracer.Tracer, tracer)));

      const deps: FlowDeps = {
        store,
        signIns,
        vault: Effect.succeed(vault),
        fetch: options.routed === true ? routedFetch(net.fetch, engineAsked) : net.fetch,
        sources: () => Effect.succeed({ secrets: options.secrets ?? {}, variables: {} }),
      };

      const keyHash = (name: string): string => {
        const target = signInTarget(store, DEFAULT_ENVIRONMENT, name);

        if (target.status !== "target") throw new Error(`No sign-in for ${name}`);

        return target.key.hash;
      };

      const start: Flow["start"] = (over = {}, now = NOW) =>
        traced(
          startMcpSignIn(
            deps,
            { environment: DEFAULT_ENVIRONMENT, server: "sentry", stage: STAGE, ...over },
            now,
          ),
        );

      const confirm: Flow["confirm"] = (token, decision = "continue", now = NOW) =>
        traced(confirmMcpSignIn(deps, { state: token, decision }, now));

      const complete: Flow["complete"] = (token, over = {}, now = NOW + 1000) =>
        traced(
          completeMcpSignIn(
            deps,
            { state: token, path: "/oauth/mcp/callback", code: CODE, iss: AS, ...over },
            now,
          ),
        );

      const signIn: Flow["signIn"] = async (over, now) => {
        const answer = await start(over, now);

        if (answer.status === "confirm" && "confirmation" in answer) {
          const confirmed = await confirm(answer.confirmation.state, "continue", now);

          if (confirmed.status !== "redirect" || !("url" in confirmed)) {
            throw new Error(`Not confirmed: ${confirmed.status}`);
          }

          return new URL(confirmed.url);
        }

        if (answer.status !== "redirect" || !("url" in answer)) {
          throw new Error(`Not started: ${JSON.stringify(answer)}`);
        }

        return new URL(answer.url);
      };

      return body({
        signIns,
        vault,
        calls: net.calls,
        spans,
        setGlobal: (value) => {
          writeSettings(store, servers(value), 5);
        },
        noteChallenge: (name, challenge) => {
          const target = signInTarget(store, DEFAULT_ENVIRONMENT, name);

          if (target.status !== "target") throw new Error(`No sign-in for ${name}`);

          signIns.noteChallenge(target.key, challenge, NOW);
        },
        engineAsked,
        keyHash,
        start,
        confirm,
        complete,
        signIn,
      });
    },
  );

const stateOf = (url: URL): string => url.searchParams.get("state") ?? "";

describe("the client ladder", () => {
  it("takes a configured clientId first, with no document and no registration", () =>
    run(sentry(), async ({ setGlobal, start, calls }) => {
      setGlobal({
        sentry: { url: SERVER_URL, oauth: { clientId: "owner-app", issuer: AS } },
      });

      const answer = await start();

      expect(answer).toMatchObject({ status: "redirect" });

      const url = urlOf(answer);

      expect(url.searchParams.get("client_id")).toBe("owner-app");
      expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/oauth/mcp/callback`);
      expect(calls.some(({ url: called }) => called.endsWith("/register"))).toBe(false);
    }));

  it("uses the client document when the stage, the entry and the server all allow it", () =>
    run(sentry(), async ({ setGlobal, signIn, calls }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      const url = await signIn();

      expect(url.origin + url.pathname).toBe(`${AS}/authorize`);
      expect(url.searchParams.get("client_id")).toBe(`${ORIGIN}/oauth/mcp/client.json`);
      expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/oauth/mcp/callback`);
      expect(calls.some(({ url: called }) => called.endsWith("/register"))).toBe(false);
    }));

  it.each<
    [string, Partial<McpSignInStartInput>, Record<string, Schema.Json>, Record<string, Schema.Json>]
  >([
    ["the stage's switch is off", { stage: { ...STAGE, documentEnabled: false } }, {}, {}],
    ["the entry says dcr", {}, { clientRegistration: "dcr" }, {}],
    [
      "the server does not advertise the document",
      {},
      {},
      { client_id_metadata_document_supported: false },
    ],
    [
      "the server has no none authentication",
      {},
      {},
      { token_endpoint_auth_methods_supported: ["client_secret_basic"] },
    ],
  ])("falls to DCR when %s", (_, over, oauth, asMetadata) =>
    run(sentry({}, asMetadata), async ({ setGlobal, signIn, calls }) => {
      setGlobal({ sentry: { url: SERVER_URL, oauth } });

      const url = await signIn(over);

      expect(url.searchParams.get("client_id")).toBe("registered-client-1");
      expect(calls.filter(({ url: called }) => called.endsWith("/register"))).toHaveLength(1);
    }),
  );

  it("registers over DCR as the stage, with the redirect URI the callback serves", () =>
    run(
      sentry({}, { authorization_response_iss_parameter_supported: true }),
      async ({ setGlobal, signIn, calls }) => {
        setGlobal({ sentry: { url: SERVER_URL, oauth: { clientRegistration: "dcr" } } });

        await signIn();

        const registration = calls.find(({ url }) => url.endsWith("/register"))?.json;

        expect(registration).toMatchObject({
          client_name: "cloudpid (pr-9)",
          redirect_uris: [`${ORIGIN}/oauth/mcp/callback`],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          application_type: "web",
        });
      },
    ));

  it("gives a server that does not advertise `iss` a redirect URI with the issuer's 12-character hash", () =>
    run(
      sentry({}, { authorization_response_iss_parameter_supported: false }),
      async ({ setGlobal, signIn }) => {
        setGlobal({ sentry: { url: SERVER_URL } });

        const url = await signIn();
        const hash = sha256Hex(AS).slice(0, 12);

        expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/oauth/mcp/callback/${hash}`);
        expect(hash).toMatch(/^[A-Za-z0-9_-]{12}$/);
      },
    ));

  it("registers `native` as the local stage's client, on the origin the sign-in started on", () =>
    run(
      sentry({}, { client_id_metadata_document_supported: false }),
      async ({ setGlobal, signIn, calls }) => {
        setGlobal({ sentry: { url: SERVER_URL } });

        const url = await signIn({
          stage: {
            origin: "http://localhost:5173",
            label: "dev-ian",
            local: true,
            documentEnabled: false,
          },
        });

        expect(calls.find(({ url: called }) => called.endsWith("/register"))?.json).toMatchObject({
          client_name: "cloudpid (dev-ian, local)",
          redirect_uris: ["http://localhost:5173/oauth/mcp/callback"],
          application_type: "native",
        });
        expect(url.searchParams.get("redirect_uri")).toBe(
          "http://localhost:5173/oauth/mcp/callback",
        );
      },
    ));

  it("keeps one registration per issuer, redirect URI and name: the two dev origins register twice", () =>
    run(
      sentry({}, { client_id_metadata_document_supported: false }),
      async ({ setGlobal, signIn, calls }) => {
        setGlobal({ sentry: { url: SERVER_URL } });

        const local = (origin: string) => ({
          stage: { origin, label: "dev-ian", local: true, documentEnabled: false },
        });

        await signIn(local("http://localhost:1337"));
        await signIn(local("http://localhost:1337"));
        await signIn(local("http://localhost:5173"));

        const registered = calls.filter(({ url }) => url.endsWith("/register"));

        expect(registered.map((call) => redirectUriOf(call))).toEqual([
          "http://localhost:1337/oauth/mcp/callback",
          "http://localhost:5173/oauth/mcp/callback",
        ]);
      },
    ));

  it("registers again within 5 minutes of the client secret's expiry (`client_secret_expires_at`)", () =>
    run(
      sentry(
        {
          [`POST ${AS}/register`]: () => ({
            client_id: "registered-client-1",
            client_secret: SECRET,
            client_secret_expires_at: NOW / 1000 + 600,
            redirect_uris: [`${ORIGIN}/oauth/mcp/callback`],
          }),
        },
        { client_id_metadata_document_supported: false },
      ),
      async ({ setGlobal, signIn, calls, signIns, vault }) => {
        setGlobal({ sentry: { url: SERVER_URL } });

        await signIn({}, NOW);

        const registered = () => calls.filter(({ url }) => url.endsWith("/register")).length;

        // 10 min before the expiry: still good.
        await signIn({}, NOW);
        expect(registered()).toBe(1);

        // 4 min before it: replaced.
        await signIn({}, NOW + 6 * 60_000);
        expect(registered()).toBe(2);

        const key = registrationKey({
          issuer: AS,
          redirectUri: `${ORIGIN}/oauth/mcp/callback`,
          clientName: "cloudpid (pr-9)",
        });

        const kept = signIns.getRegistration(key);

        expect(kept?.clientSecretExpiresAt).toBe(NOW + 600_000);
        // The secret is sealed under the registration, and not in what is recorded of it.
        expect(kept?.clientInfo).not.toContain(SECRET);

        if (kept?.sealedSecret === null || kept?.sealedSecret === undefined)
          throw new Error("No secret");

        expect(
          await Effect.runPromise(openValue(vault, REGISTRATIONS_TABLE, key, kept.sealedSecret)),
        ).toBe(SECRET);
      },
    ));

  it("names the stage on a configured clientName, and cuts the configured part, never the suffix", () =>
    run(
      sentry({}, { client_id_metadata_document_supported: false }),
      async ({ setGlobal, signIn, calls }) => {
        setGlobal({ sentry: { url: SERVER_URL, oauth: { clientName: "x".repeat(100) } } });

        await signIn();

        const name = clientNameOf(calls.find(({ url }) => url.endsWith("/register")));

        expect(Array.from(name)).toHaveLength(100);
        expect(name.endsWith(" (pr-9)")).toBe(true);
      },
    ));

  it("is a problem under clientRegistration cimd when the document cannot be used, saying why", () =>
    run(
      sentry({}, { client_id_metadata_document_supported: false }),
      async ({ setGlobal, start, calls }) => {
        setGlobal({ sentry: { url: SERVER_URL, oauth: { clientRegistration: "cimd" } } });

        const answer = await start();

        expect(answer).toMatchObject({ status: "problem" });
        expect(messageOf(answer)).toContain("client_id_metadata_document_supported");
        expect(calls.some(({ url }) => url.endsWith("/register"))).toBe(false);
      },
    ));

  it("is a problem naming the redirect URI to register when there is neither document nor registration", () =>
    run(
      sentry({}, { client_id_metadata_document_supported: false, registration_endpoint: null }),
      async ({ setGlobal, start }) => {
        setGlobal({ sentry: { url: SERVER_URL } });

        const answer = await start();

        expect(answer).toMatchObject({ status: "problem" });
        expect(messageOf(answer)).toContain(`${ORIGIN}/oauth/mcp/callback`);
        expect(messageOf(answer)).toContain("oauth.clientId");
      },
    ));

  it("shows a registration refusal's status and at most 300 characters of its body", () =>
    run(
      sentry(
        { [`POST ${AS}/register`]: () => new Response("nope ".repeat(200), { status: 403 }) },
        { client_id_metadata_document_supported: false },
      ),
      async ({ setGlobal, start }) => {
        setGlobal({ sentry: { url: SERVER_URL } });

        const answer = await start();
        const message = messageOf(answer);

        expect(answer.status).toBe("problem");
        expect(message).toContain("HTTP 403");
        expect(message).toContain("may accept only clients it knows");
        expect(Array.from(message).length).toBeLessThanOrEqual(300);
      },
    ));
});

describe("Self-use: a sign-in to the stage's own MCP endpoint", () => {
  const endpoint = `${ORIGIN}/mcp`;
  const resourceMetadata = `${ORIGIN}/.well-known/cloudflare-access-protected-resource/mcp`;
  const registrationEndpoint = `${ACCESS_ISSUER}/cdn-cgi/access/oauth/registration`;

  /** The stage's host and Access, as they answer (2026-11-05). */
  const access = {
    // The 401 of a request with no token, which names where Access serves the resource metadata.
    [`GET ${endpoint}`]: () =>
      new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": `Bearer realm="OAuth", error="invalid_token", error_description="Missing or invalid access token", resource_metadata="${resourceMetadata}"`,
        },
      }),
    [`GET ${resourceMetadata}`]: () => ({
      resource: endpoint,
      protected: true,
      authorization_servers: [ACCESS_ISSUER],
    }),
    // The well-known paths at the root are behind the main application: Access's login.
    [`GET ${ORIGIN}/.well-known/oauth-protected-resource/mcp`]: () =>
      new Response(null, {
        status: 302,
        headers: { location: `${ACCESS_ISSUER}/cdn-cgi/access/login/host` },
      }),
    [`GET ${ORIGIN}/.well-known/oauth-protected-resource`]: () =>
      new Response(null, {
        status: 302,
        headers: { location: `${ACCESS_ISSUER}/cdn-cgi/access/login/host` },
      }),
    // Access's metadata: no client document, no `iss`, and `none` among the methods.
    [`GET ${ACCESS_ISSUER}/.well-known/oauth-authorization-server`]: () => ({
      issuer: ACCESS_ISSUER,
      authorization_endpoint: `${ACCESS_ISSUER}/cdn-cgi/access/oauth/authorization`,
      token_endpoint: `${ACCESS_ISSUER}/cdn-cgi/access/oauth/token`,
      registration_endpoint: registrationEndpoint,
      revocation_endpoint: `${ACCESS_ISSUER}/cdn-cgi/access/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      code_challenge_methods_supported: ["S256"],
    }),
    [`POST ${registrationEndpoint}`]: (call: Call) =>
      new Response(
        JSON.stringify({ client_id: "access-client-1", redirect_uris: [redirectUriOf(call)] }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
  };

  /** What a Self-use sign-in must have done, whatever led it to the resource metadata. */
  const expectRegisteredAtAccess = (url: URL, calls: ReadonlyArray<Call>) => {
    const registration = calls.find(({ url: called }) => called === registrationEndpoint);

    expect(registration?.json).toMatchObject({
      redirect_uris: mcpApplicationProps(STAGE.label).oauthConfiguration.dynamicClientRegistration
        .allowedUris,
      token_endpoint_auth_method: "none",
    });
    expect(url.searchParams.get("client_id")).toBe("access-client-1");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUriOf(registration));
    expect(url.searchParams.get("resource")).toBe(endpoint);
  };

  it("reads the resource metadata the recorded 401 names from McpWorker, and registers over DCR at the URI the stage's Access application allows", () =>
    run(
      access,
      async ({ setGlobal, noteChallenge, signIn, calls, engineAsked }) => {
        setGlobal({ cloudpid: { url: endpoint } });
        noteChallenge("cloudpid", {
          resourceMetadataUrl: resourceMetadata,
          error: "invalid_token",
        });

        const url = await signIn({ server: "cloudpid" });

        // The only hop on the stage's host is read from McpWorker; Access's own host is reached from here.
        expect(engineAsked).toEqual([resourceMetadata]);
        expect(calls.map(({ url: called }) => called)).not.toContain(
          `${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
        );
        expectRegisteredAtAccess(url, calls);
      },
      { routed: true },
    ));

  it("asks the endpoint for its 401 first when no challenge is recorded, and never reads the root paths Access's login answers", () =>
    run(
      access,
      async ({ setGlobal, signIn, calls, engineAsked }) => {
        setGlobal({ cloudpid: { url: endpoint } });

        const url = await signIn({ server: "cloudpid" });

        expect(engineAsked).toEqual([endpoint, resourceMetadata]);
        expect(calls.map(({ url: called }) => called)).not.toContain(
          `${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
        );
        expectRegisteredAtAccess(url, calls);
      },
      { routed: true },
    ));

  it("asks nothing first of a server that is not on one of cloudpid's own hosts", () =>
    run(sentry(), async ({ setGlobal, signIn, calls }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      await signIn();

      expect(calls.map(({ url }) => url)).not.toContain(SERVER_URL);
    }));
});

describe("the issuer pin and binding", () => {
  it("refuses an issuer the entry does not pin, naming both", () =>
    run(sentry(), async ({ setGlobal, start }) => {
      setGlobal({
        sentry: { url: SERVER_URL, oauth: { clientId: "a", issuer: "https://other.example" } },
      });

      const answer = await start();

      expect(answer).toMatchObject({ status: "problem" });
      expect(messageOf(answer)).toContain("https://other.example");
      expect(messageOf(answer)).toContain(AS);
    }));

  it("compares a pin after trimming one trailing slash", () =>
    run(sentry(), async ({ setGlobal, start }) => {
      setGlobal({ sentry: { url: SERVER_URL, oauth: { clientId: "a", issuer: `${AS}/` } } });

      expect((await start()).status).toBe("redirect");
    }));

  it("applies the pin to a document client too", () =>
    run(sentry(), async ({ setGlobal, start }) => {
      setGlobal({ sentry: { url: SERVER_URL, oauth: { issuer: "https://other.example" } } });

      expect((await start()).status).toBe("problem");
    }));

  it("refuses an authServerMetadataUrl that is not https", () =>
    run(sentry(), async ({ setGlobal, start }) => {
      setGlobal({
        sentry: {
          url: SERVER_URL,
          oauth: { authServerMetadataUrl: "http://auth.example.com/meta" },
        },
      });

      expect((await start()).status).toBe("problem");
    }));

  it("sends an unpinned configured client's first binding through the interstitial, which shows no secret value", () =>
    run(
      sentry(),
      async ({ setGlobal, start, confirm }) => {
        setGlobal({
          sentry: {
            url: SERVER_URL,
            oauth: { clientId: "owner-app", clientSecret: "${GITHUB_MCP_CLIENT_SECRET}" },
          },
        });

        const answer = await start();

        expect(answer).toMatchObject({
          status: "confirm",
          confirmation: {
            server: "sentry",
            source: "owner",
            url: SERVER_URL,
            issuer: AS,
            clientId: "owner-app",
            secret: { scope: "secret", name: "GITHUB_MCP_CLIENT_SECRET" },
          },
        });
        expect(JSON.stringify(answer)).not.toContain(SECRET);

        // Cancel deletes the pending row: nothing to continue.
        const state = stateOfConfirmation(answer);

        expect(await confirm(state, "cancel")).toEqual({ status: "cancelled" });
        expect(await confirm(state, "continue")).toEqual({ status: "expired" });
      },
      { secrets: { GITHUB_MCP_CLIENT_SECRET: SECRET } },
    ));

  it("is a problem when the client secret's ${NAME} is not set", () =>
    run(sentry(), async ({ setGlobal, start }) => {
      setGlobal({
        sentry: { url: SERVER_URL, oauth: { clientId: "owner-app", clientSecret: "${MISSING}" } },
      });

      const answer = await start();

      expect(answer.status).toBe("problem");
      expect(messageOf(answer)).toContain("MISSING");
    }));

  it("does not redirect before Continue, and a callback with the state of an unconfirmed row saves nothing", () =>
    run(sentry(), async ({ setGlobal, start, complete, signIns, keyHash }) => {
      setGlobal({ sentry: { url: SERVER_URL, oauth: { clientId: "owner-app" } } });

      const answer = await start();
      const state = stateOfConfirmation(answer);

      expect(await complete(state)).toMatchObject({ status: "unconfirmed" });
      expect(signIns.get(keyHash("sentry"))?.hasTokens).toBe(false);
    }));

  it("continues to the authorization page with the same state, and binds the client at completion", () =>
    run(sentry(), async ({ setGlobal, start, confirm, complete, signIns, keyHash }) => {
      setGlobal({ sentry: { url: SERVER_URL, oauth: { clientId: "owner-app" } } });

      const answer = await start();
      const state = stateOfConfirmation(answer);
      const confirmed = await confirm(state);
      const url = urlOf(confirmed);

      expect(stateOf(url)).toBe(state);
      expect(url.searchParams.get("client_id")).toBe("owner-app");
      expect(signIns.getBinding(keyHash("sentry"), "owner-app")).toBeNull();

      expect(await complete(state)).toMatchObject({ status: "signed_in" });
      expect(signIns.getBinding(keyHash("sentry"), "owner-app")?.issuer).toBe(AS);
    }));

  it("sends a change of a bound client's issuer back through the interstitial, naming the old one", () =>
    run(sentry(), async ({ setGlobal, start, signIns, keyHash }) => {
      setGlobal({ sentry: { url: SERVER_URL, oauth: { clientId: "owner-app" } } });
      signIns.putBinding(
        {
          keyHash: keyHash("sentry"),
          clientId: "owner-app",
          issuer: "https://old.example",
          boundAt: 1,
        },
        () => true,
      );

      expect(await start()).toMatchObject({
        status: "confirm",
        confirmation: { issuer: AS, previousIssuer: "https://old.example" },
      });
    }));

  it("goes straight on for a bound client at the issuer it is bound to", () =>
    run(sentry(), async ({ setGlobal, start, signIns, keyHash }) => {
      setGlobal({ sentry: { url: SERVER_URL, oauth: { clientId: "owner-app" } } });
      signIns.putBinding(
        { keyHash: keyHash("sentry"), clientId: "owner-app", issuer: AS, boundAt: 1 },
        () => true,
      );

      expect((await start()).status).toBe("redirect");
    }));

  it("makes a document client's sign-in required when its server now signs in at another issuer", () =>
    run(sentry(), async ({ setGlobal, signIn, signIns, keyHash, vault }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      // A row signed in at an issuer the server no longer uses.
      const hash = keyHash("sentry");
      const sealed = await Effect.runPromise(sealTokens(vault, hash, { access_token: ACCESS }));

      if (sealed.status !== "sealed") throw new Error("too large");

      signIns.put(
        {
          key: { hash, source: "owner", name: "sentry", url: SERVER_URL },
          status: "ok",
          issuer: "https://old.example",
          metadata: "{}",
          discovery: "{}",
          resource: SERVER_URL,
          client: { id: "x", kind: "document", secretRef: null, registration: null },
          scope: null,
          expiresAt: null,
          wantedScope: null,
          stepUpCount: 0,
          sealed: sealed.sealed,
        },
        NOW,
      );

      const before = signIns.revision();

      await signIn();

      expect(signIns.get(hash)).toMatchObject({
        status: "required",
        hasTokens: false,
        lastError: `Now signs in at ${AS} (was https://old.example)`,
      });
      expect(signIns.revision()).toBeGreaterThan(before);
    }));
});

describe("state and PKCE", () => {
  it("makes a 256-bit state and an S256 challenge, and keeps only the state's hash and the sealed verifier", () =>
    run(sentry(), async ({ setGlobal, signIn, signIns, keyHash, vault }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      const url = await signIn();
      const state = stateOf(url);

      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("resource")).toBe(SERVER_URL);
      // The challenge says what the scope was: the protected resource's, and `offline_access` the server lists.
      expect(url.searchParams.get("scope")).toBe("read offline_access");
      expect(url.searchParams.has("prompt")).toBe(false);

      const hash = keyHash("sentry");
      const pending = signIns.getPending(hash, NOW);

      if (pending === null) throw new Error("No pending row");

      expect(pending.stateHash).toBe(stateHash(state));
      expect(JSON.stringify(pending)).not.toContain(state);

      // The verifier is sealed under the row, opens only there, and is what the challenge is made of.
      const verifier = await Effect.runPromise(
        openValue(vault, PENDING_TABLE, hash, pending.sealedVerifier),
      );

      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(pkceChallenge(verifier)).toBe(url.searchParams.get("code_challenge"));
      expect(JSON.stringify(pending)).not.toContain(verifier);
      expect(pending.expiresAt).toBe(NOW + PENDING_SIGN_IN_TTL_MS);
    }));

  it("makes every state and verifier new, and a newer start replaces the older: its state is then dead", () =>
    run(sentry(), async ({ setGlobal, signIn, complete }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      const first = await signIn();
      const second = await signIn();

      expect(stateOf(first)).not.toBe(stateOf(second));
      expect(first.searchParams.get("code_challenge")).not.toBe(
        second.searchParams.get("code_challenge"),
      );
      expect(await complete(stateOf(first))).toMatchObject({ status: "expired" });
      expect(await complete(stateOf(second))).toMatchObject({ status: "signed_in" });
    }));

  it("sends the code with the verifier the challenge was made of, the redirect URI and the resource", () =>
    run(sentry(), async ({ setGlobal, signIn, complete, signIns, keyHash, vault, calls }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      const url = await signIn();
      const hash = keyHash("sentry");
      const pending = signIns.getPending(hash, NOW);

      if (pending === null) throw new Error("No pending row");

      const verifier = await Effect.runPromise(
        openValue(vault, PENDING_TABLE, hash, pending.sealedVerifier),
      );

      await complete(stateOf(url));

      const token = calls.find((call) => call.url === `${AS}/token`);

      expect(token?.form.get("grant_type")).toBe("authorization_code");
      expect(token?.form.get("code")).toBe(CODE);
      expect(token?.form.get("code_verifier")).toBe(verifier);
      expect(pkceChallenge(token?.form.get("code_verifier") ?? "")).toBe(
        url.searchParams.get("code_challenge"),
      );
      expect(token?.form.get("redirect_uri")).toBe(`${ORIGIN}/oauth/mcp/callback`);
      expect(token?.form.get("resource")).toBe(SERVER_URL);
      expect(token?.form.get("client_id")).toBe(`${ORIGIN}/oauth/mcp/client.json`);
    }));
});

/** What a callback must never carry: any token, code, verifier or state. */
const leaks = (value: McpSignInCompleteAnswer, ...secrets: ReadonlyArray<string>): boolean =>
  secrets.some((secret) => JSON.stringify(value).includes(secret));

describe("completing a sign-in", () => {
  it("seals the tokens, writes the row, raises the revision and names who uses it", () =>
    run(sentry(), async ({ setGlobal, signIn, complete, signIns, keyHash, vault }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      const state = stateOf(await signIn());
      const before = signIns.revision();
      const answer = await complete(state);

      expect(answer).toMatchObject({
        status: "signed_in",
        server: "sentry",
        environments: [{ id: DEFAULT_ENVIRONMENT }],
      });
      expect(leaks(answer, ACCESS, REFRESH, CODE, state)).toBe(false);
      expect(signIns.revision()).toBeGreaterThan(before);

      const row = signIns.get(keyHash("sentry"));

      expect(row).toMatchObject({
        status: "ok",
        issuer: AS,
        resource: SERVER_URL,
        scope: "read offline_access",
        expiresAt: NOW + 1000 + 3_600_000,
        wantedScope: null,
        stepUpCount: 0,
        client: { id: `${ORIGIN}/oauth/mcp/client.json`, kind: "document", secretRef: null },
      });
      expect(JSON.stringify(row?.metadata)).toContain(AS);

      if (row?.sealed === null || row?.sealed === undefined) throw new Error("No tokens");

      expect(JSON.stringify(row.sealed)).not.toContain(ACCESS);
      expect(await Effect.runPromise(openTokens(vault, keyHash("sentry"), row.sealed))).toEqual({
        access_token: ACCESS,
        refresh_token: REFRESH,
      });
      // The pending row went first: the state is used once.
      expect(signIns.getPending(keyHash("sentry"), NOW)).toBeNull();
    }));

  it("answers a state used before as expired or already used", () =>
    run(sentry(), async ({ setGlobal, signIn, complete }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      const state = stateOf(await signIn());

      expect(await complete(state)).toMatchObject({ status: "signed_in" });
      expect(await complete(state)).toEqual({ status: "expired" });
    }));

  it("answers a state that was never made, or is 10 minutes old, as expired", () =>
    run(sentry(), async ({ setGlobal, signIn, complete, calls }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      const state = stateOf(await signIn());

      expect(await complete("A".repeat(43))).toEqual({ status: "expired" });
      expect(await complete(state, {}, NOW + PENDING_SIGN_IN_TTL_MS)).toEqual({
        status: "expired",
      });
      expect(calls.some(({ url }) => url.endsWith("/token"))).toBe(false);
    }));

  it("resolves the open Sign-in requests of the key", () =>
    run(sentry(), async ({ setGlobal, signIn, complete, signIns, keyHash }) => {
      setGlobal({ sentry: { url: SERVER_URL } });
      signIns.addWaiter({ keyHash: keyHash("sentry"), session: "s1", request: "r1" }, NOW);

      expect(await complete(stateOf(await signIn()))).toMatchObject({
        resolved: [{ session: "s1", request: "r1" }],
      });
      expect(signIns.waiters(keyHash("sentry"), NOW)).toEqual([]);
    }));

  it("reads a callback at the issuer-hash path only for a client registered at it", () =>
    run(
      sentry({}, { authorization_response_iss_parameter_supported: false }),
      async ({ setGlobal, signIn, complete }) => {
        setGlobal({ sentry: { url: SERVER_URL } });

        const url = await signIn();
        const hash = sha256Hex(AS).slice(0, 12);

        expect(url.searchParams.get("redirect_uri")).toContain(`/${hash}`);
        // No `iss` and the server does not promise one: the path is what says which server answered.
        expect(
          await complete(stateOf(url), { path: `/oauth/mcp/callback/${hash}`, iss: undefined }),
        ).toMatchObject({
          status: "signed_in",
        });
      },
    ));

  it.each([
    ["no path", "/oauth/mcp/callback/aaaaaaaaaaaa"],
    ["another path", "/oauth/mcp/other"],
  ])("saves nothing for a callback at %s than the redirect URI's", (_, path) =>
    run(sentry(), async ({ setGlobal, signIn, complete, signIns, keyHash, calls }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      const state = stateOf(await signIn());

      expect(await complete(state, { path })).toMatchObject({ status: "path_mismatch" });
      expect(signIns.get(keyHash("sentry"))?.hasTokens ?? false).toBe(false);
      expect(calls.some(({ url }) => url.endsWith("/token"))).toBe(false);
      // The state is spent whatever the callback found.
      expect(await complete(state)).toEqual({ status: "expired" });
    }),
  );

  it("says declined, naming nothing, when the owner declined at the server's page", () =>
    run(sentry(), async ({ setGlobal, signIn, complete, calls }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      expect(
        await complete(stateOf(await signIn()), { code: undefined, error: "access_denied" }),
      ).toMatchObject({ status: "declined", code: "access_denied" });
      expect(calls.some(({ url }) => url.endsWith("/token"))).toBe(false);
    }));

  it("carries an authorization server's error code and its description cut to 300 characters", () =>
    run(sentry(), async ({ setGlobal, signIn, complete }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      const answer = await complete(stateOf(await signIn()), {
        code: undefined,
        error: "invalid_scope",
        errorDescription: "<b>why</b> ".repeat(100),
      });

      expect(answer).toMatchObject({ status: "provider_error", code: "invalid_scope" });
      expect(Array.from(messageOf(answer)).length).toBeLessThanOrEqual(300);
    }));

  it("keeps the last failure on a row that has no tokens, for the Settings row and the open request", () =>
    run(sentry(), async ({ setGlobal, signIn, complete, signIns, keyHash }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      await complete(stateOf(await signIn()), {
        code: undefined,
        error: "server_error",
        errorDescription: "try later",
      });

      expect(signIns.get(keyHash("sentry"))).toMatchObject({
        status: "required",
        hasTokens: false,
        lastError: "try later",
      });
    }));

  it("refuses an `iss` that is not the issuer, saving nothing and sending no code", () =>
    run(sentry(), async ({ setGlobal, signIn, complete, signIns, keyHash, calls }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      const answer = await complete(stateOf(await signIn()), { iss: "https://evil.example" });

      expect(answer).toMatchObject({ status: "iss_mismatch" });
      expect(signIns.get(keyHash("sentry"))?.hasTokens ?? false).toBe(false);
      expect(calls.some(({ url }) => url.endsWith("/token"))).toBe(false);
    }));

  it("refuses a callback with no `iss` from a server that promised one", () =>
    run(sentry(), async ({ setGlobal, signIn, complete }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      expect(await complete(stateOf(await signIn()), { iss: undefined })).toMatchObject({
        status: "iss_mismatch",
      });
    }));

  it("says the answer was incomplete when there is no code", () =>
    run(sentry(), async ({ setGlobal, signIn, complete }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      expect(await complete(stateOf(await signIn()), { code: undefined })).toMatchObject({
        status: "missing_code",
      });
    }));

  it("leaves the old tokens as they were when the exchange fails, and says so", () =>
    run(
      sentry({
        [`POST ${AS}/token`]: () =>
          new Response(
            JSON.stringify({ error: "invalid_grant", error_description: "the code is used" }),
            {
              status: 400,
            },
          ),
      }),
      async ({ setGlobal, signIn, complete, signIns, keyHash, vault }) => {
        setGlobal({ sentry: { url: SERVER_URL } });

        const hash = keyHash("sentry");

        const sealed = await Effect.runPromise(
          sealTokens(vault, hash, { access_token: "old-access" }),
        );

        if (sealed.status !== "sealed") throw new Error("too large");

        signIns.put(
          {
            key: { hash, source: "owner", name: "sentry", url: SERVER_URL },
            status: "ok",
            issuer: AS,
            metadata: "{}",
            discovery: "{}",
            resource: SERVER_URL,
            client: { id: "x", kind: "document", secretRef: null, registration: null },
            scope: "read",
            expiresAt: null,
            wantedScope: null,
            stepUpCount: 0,
            sealed: sealed.sealed,
          },
          NOW,
        );

        const before = signIns.get(hash);
        const answer = await complete(stateOf(await signIn()));

        expect(answer).toMatchObject({ status: "exchange_failed", code: "invalid_grant" });
        expect(messageOf(answer)).toContain("the code is used");
        expect(signIns.get(hash)).toEqual({ ...before, usedAt: before?.usedAt });
        expect(signIns.get(hash)?.lastError).toBeNull();
      },
    ));

  it("drops a registration the server no longer knows (invalid_client), so the next start registers again", () =>
    run(
      sentry(
        {
          [`POST ${AS}/token`]: () =>
            new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }),
        },
        { client_id_metadata_document_supported: false },
      ),
      async ({ setGlobal, signIn, complete, calls }) => {
        setGlobal({ sentry: { url: SERVER_URL } });

        expect(await complete(stateOf(await signIn()))).toMatchObject({
          status: "exchange_failed",
          code: "invalid_client",
        });

        await signIn();

        expect(calls.filter(({ url }) => url.endsWith("/register"))).toHaveLength(2);
      },
    ));

  it("refuses a token that is not a Bearer one", () =>
    run(
      sentry({
        [`POST ${AS}/token`]: () => ({ access_token: ACCESS, token_type: "mac" }),
      }),
      async ({ setGlobal, signIn, complete }) => {
        setGlobal({ sentry: { url: SERVER_URL } });

        const answer = await complete(stateOf(await signIn()));

        expect(answer).toMatchObject({ status: "exchange_failed" });
        expect(leaks(answer, ACCESS)).toBe(false);
      },
    ));

  it("refuses an access token over 16 KiB", () =>
    run(
      sentry({
        [`POST ${AS}/token`]: () => ({
          access_token: "a".repeat(16 * 1024 + 1),
          token_type: "Bearer",
        }),
      }),
      async ({ setGlobal, signIn, complete, signIns, keyHash }) => {
        setGlobal({ sentry: { url: SERVER_URL } });

        expect(await complete(stateOf(await signIn()))).toMatchObject({
          status: "exchange_failed",
        });
        expect(signIns.get(keyHash("sentry"))?.hasTokens).toBe(false);
      },
    ));

  it("records no expiry when the server gives no lifetime, and the requested scope when it gives no scope", () =>
    run(
      sentry({
        [`POST ${AS}/token`]: () => ({ access_token: ACCESS, token_type: "bearer" }),
      }),
      async ({ setGlobal, signIn, complete, signIns, keyHash }) => {
        setGlobal({ sentry: { url: SERVER_URL } });
        await complete(stateOf(await signIn()));

        expect(signIns.get(keyHash("sentry"))).toMatchObject({
          expiresAt: null,
          scope: "read offline_access",
        });
      },
    ));

  it("sends a configured client's secret from the Secrets, by the method the server lists, and binds the client", () =>
    run(
      sentry({}, { token_endpoint_auth_methods_supported: ["client_secret_post"] }),
      async ({ setGlobal, signIn, complete, calls, signIns, keyHash }) => {
        setGlobal({
          sentry: {
            url: SERVER_URL,
            oauth: { clientId: "owner-app", clientSecret: "${APP_SECRET}", issuer: AS },
          },
        });

        const answer = await complete(stateOf(await signIn()));

        expect(answer).toMatchObject({ status: "signed_in" });
        expect(leaks(answer, SECRET)).toBe(false);

        const token = calls.find((call) => call.url === `${AS}/token`);

        expect(token?.form.get("client_id")).toBe("owner-app");
        expect(token?.form.get("client_secret")).toBe(SECRET);

        const row = signIns.get(keyHash("sentry"));

        expect(row?.client).toEqual({
          id: "owner-app",
          kind: "configured",
          secretRef: { scope: "secret", name: "APP_SECRET", environment: "default" },
          registration: null,
        });
        // A reference, never a copy.
        expect(JSON.stringify(row)).not.toContain(SECRET);
        expect(signIns.getBinding(keyHash("sentry"), "owner-app")?.issuer).toBe(AS);
      },
      { secrets: { APP_SECRET: SECRET } },
    ));

  it("fails when the entry's client changed while the owner signed in", () =>
    run(sentry(), async ({ setGlobal, signIn, complete }) => {
      setGlobal({ sentry: { url: SERVER_URL, oauth: { clientId: "owner-app", issuer: AS } } });

      const state = stateOf(await signIn());

      setGlobal({ sentry: { url: SERVER_URL, oauth: { clientId: "another-app", issuer: AS } } });

      expect(await complete(state)).toMatchObject({ status: "unavailable" });
    }));
});

describe("a step-up", () => {
  it("asks for the wanted scope, keeps it and the count through its completion, and a Settings sign-in resets both", () =>
    run(sentry(), async ({ setGlobal, signIn, complete, signIns, keyHash }) => {
      setGlobal({ sentry: { url: SERVER_URL } });
      await complete(stateOf(await signIn()));

      const hash = keyHash("sentry");

      signIns.update(hash, { status: "step_up", wantedScope: "read write", stepUpCount: 2 }, NOW);

      const url = await signIn({ stepUp: true });

      expect(url.searchParams.get("scope")).toBe("read write offline_access");

      await complete(stateOf(url));
      expect(signIns.get(hash)).toMatchObject({
        status: "ok",
        wantedScope: "read write",
        stepUpCount: 2,
      });

      await complete(stateOf(await signIn()));
      expect(signIns.get(hash)).toMatchObject({ wantedScope: null, stepUpCount: 0 });
    }));
});

describe("what a start refuses", () => {
  it("says why for a server that is not in the set, does not sign in, or has no authorization server", () =>
    run(sentry(), async ({ setGlobal, start }) => {
      setGlobal({
        local: { command: "node", args: ["server.js"] },
        keyed: { url: "https://a.example/mcp", headers: { authorization: "Bearer x" } },
      });

      for (const server of ["missing", "local", "keyed"]) {
        expect(await start({ server })).toMatchObject({ status: "problem" });
      }

      expect(await start({ environment: "no-such-environment" })).toMatchObject({
        status: "problem",
      });
    }));

  it("starts the sign-in of a Global entry from `all`", () =>
    run(sentry(), async ({ setGlobal, start }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      expect((await start({ environment: "all" })).status).toBe("redirect");
    }));

  it("is a problem under a malformed SECRETS_ENCRYPTION_KEY, whatever else is true", () =>
    runInDurableObject(
      env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
      async (_: TestRegistry, state) => {
        const store = openRegistryStore(state.storage);
        const signIns = openMcpSignIns(state.storage, store);
        const net = network(sentry());

        writeSettings(store, servers({ sentry: { url: SERVER_URL } }), 5);

        const answer = await Effect.runPromise(
          startMcpSignIn(
            {
              store,
              signIns,
              vault: openKeptVault("short", MCP_OAUTH_PURPOSE),
              fetch: net.fetch,
              sources: () => Effect.succeed({ secrets: {}, variables: {} }),
            },
            { environment: DEFAULT_ENVIRONMENT, server: "sentry", stage: STAGE },
            NOW,
          ),
        );

        expect(answer.status).toBe("problem");
        expect(net.calls).toEqual([]);
      },
    ));

  it("is a problem for an authorization server that publishes no metadata", () =>
    run(
      sentry({
        [`GET ${AS}/.well-known/oauth-authorization-server`]: () =>
          new Response("", { status: 404 }),
      }),
      async ({ setGlobal, start }) => {
        setGlobal({ sentry: { url: SERVER_URL } });

        expect(await start()).toMatchObject({ status: "problem" });
      },
    ));

  it("is a problem for a server that cannot take the request: no S256, or an endpoint that is not https", () =>
    run(
      sentry({}, { code_challenge_methods_supported: ["plain"] }),
      async ({ setGlobal, start, signIns, keyHash }) => {
        setGlobal({ sentry: { url: SERVER_URL } });

        expect(await start()).toMatchObject({ status: "problem" });
        // Nothing was left behind.
        expect(signIns.getPending(keyHash("sentry"), NOW)).toBeNull();
      },
    ));
});

/** The attributes of the span named `name`, as an object. */
const attributesOf = (spans: ReadonlyArray<Tracer.NativeSpan>, name: string) =>
  Object.fromEntries(spans.find((span) => span.name === name)?.attributes ?? []);

describe("the spans", () => {
  it("say the start's outcome, and a refusal's, and never the state, the challenge or a URL", () =>
    run(sentry(), async ({ setGlobal, start, spans }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      const answer = await start();

      await start({ server: "nothing" });

      const started = spans.filter((span) => span.name === "mcp.oauth.start");

      expect(started.map((span) => Object.fromEntries(span.attributes)["mcp.outcome"])).toEqual([
        "redirect",
        "problem",
      ]);

      const url = urlOf(answer);
      const recorded = JSON.stringify(started.map((span) => [...span.attributes]));

      for (const secret of [stateOf(url), url.searchParams.get("code_challenge") ?? "", url.href]) {
        expect(secret).not.toBe("");
        expect(recorded).not.toContain(secret);
      }
    }));

  it("say the callback's outcome, the OAuth error code and the token endpoint's status", () =>
    run(
      sentry({
        [`POST ${AS}/token`]: () =>
          new Response(JSON.stringify({ error: "invalid_grant", error_description: "used" }), {
            status: 400,
          }),
      }),
      async ({ setGlobal, signIn, complete, spans }) => {
        setGlobal({ sentry: { url: SERVER_URL } });

        const state = stateOf(await signIn());

        await complete(state);

        const callback = attributesOf(spans, "mcp.oauth.callback");

        expect(callback).toMatchObject({
          "mcp.outcome": "exchange_failed",
          "mcp.oauth_error": "invalid_grant",
          "http.status_code": 400,
        });

        const recorded = JSON.stringify(callback);

        for (const secret of [state, CODE, "the code is used"]) {
          expect(recorded).not.toContain(secret);
        }
      },
    ));

  it("say a signed-in callback's outcome and the token endpoint's status", () =>
    run(sentry(), async ({ setGlobal, signIn, complete, spans }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      await complete(stateOf(await signIn()));

      expect(attributesOf(spans, "mcp.oauth.callback")).toMatchObject({
        "mcp.outcome": "signed_in",
        "http.status_code": 200,
      });
    }));
});
