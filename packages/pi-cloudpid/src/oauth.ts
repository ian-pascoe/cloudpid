// @effect-diagnostics preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off asyncFunction:off nodeBuiltinImport:off globalDate:off newPromise:off cryptoRandomUUID:off globalConsole:off -- native array methods over plain values (the extension carries no Effect runtime); native object methods over plain values; plain functions over values, called directly; plain Promises, as the SDK's provider interface gives them; runs on node, on the owner's machine; the time the tokens were obtained; wraps a callback API; the MCP SDK reports a failed refresh through `console.warn`, which is filtered to the owner's notice.
/**
 * `/cloudpid`'s OAuth client (docs/architecture/mcp-endpoint.md → Access and identity; The `/cloudpid` command → The
 * connection): an `OAuthClientProvider` of the SDK over the sign-in store, and the `fetch` that goes with it.
 * Access is the authorization server (discovery from the 401's `resource_metadata`, Dynamic Client Registration with a
 * loopback redirect, PKCE, rotating refresh tokens); the SDK's `auth()` runs the protocol and this keeps what it needs
 * between runs. A rotated refresh token is stored before the access token that came with it is used. Tokens are never
 * logged.
 */
import * as Predicate from "effect/Predicate";
import { randomBytes } from "node:crypto";
import {
  auth,
  extractWWWAuthenticateParams,
  type FetchLike,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { AuthEntry, AuthStore } from "./auth-store.ts";

/** The name this client registers under (DCR `client_name`). */
export const OAUTH_CLIENT_NAME = "pi-cloudpid";

/** A redirect the connection never uses: it only refreshes, and a new sign-in is `signin.ts`'s, with its own. */
export const CONNECTION_REDIRECT = "http://127.0.0.1/callback";

/** How long before an access token expires the next request refreshes it. */
export const REFRESH_MARGIN_MS = 60_000;

export interface ProviderOptions {
  readonly store: AuthStore;
  /** The endpoint's URL, the key of the entry. */
  readonly endpoint: string;
  readonly redirectUrl: string;
  /** Called with the authorization URL when the SDK wants the user agent sent there. */
  readonly onRedirect: (url: URL) => void | Promise<void>;
  /**
   * Starts from nothing, as a sign-in does: the stored entry is replaced once the new tokens are in, never before (a
   * sign-in the owner abandons leaves the working one).
   */
  readonly fresh?: boolean | undefined;
  /** The OAuth `state` of the authorization request. */
  readonly state?: string | undefined;
  readonly now?: (() => number) | undefined;
  /** Refreshes the tokens; called when the access token in use is about to expire. */
  readonly refresh?: (provider: CloudpidOAuthProvider) => Promise<void>;
  /**
   * What a connection that is not a sign-in raises instead of starting one: the SDK registers a new client (and drops
   * the stored one) when the authorization server no longer knows the client, which is for the owner to agree to, and
   * to do through `/cloudpid login`, not behind a request. A sign-in leaves this out.
   */
  readonly signInRequired?: (() => Error) | undefined;
}

/** The SDK's `OAuthClientProvider` over an {@link AuthStore}'s entry for one endpoint. */
export class CloudpidOAuthProvider implements OAuthClientProvider {
  readonly #options: ProviderOptions;
  #entry: AuthEntry = {};
  /** Whether changes reach the store: not before a `fresh` sign-in has its tokens. */
  #persistent: boolean;
  #verifier: string | undefined;

  constructor(options: ProviderOptions) {
    this.#options = options;
    this.#persistent = options.fresh !== true;
  }

  /** Reads the stored entry (a `fresh` provider starts from none). */
  async load(): Promise<void> {
    if (this.#options.fresh === true) return;

    this.#entry = (await this.#options.store.read(this.#options.endpoint)) ?? {};
  }

  /** What is held now. */
  get entry(): AuthEntry {
    return this.#entry;
  }

  /** Whether an access token is held. */
  get signedIn(): boolean {
    return this.#entry.tokens !== undefined;
  }

  /** Whether the access token is held and expires within `ms` of `now` (false for one that says nothing of its life). */
  expiresWithin(ms: number, now: number): boolean {
    const { tokens, obtainedAt } = this.#entry;

    if (tokens?.expires_in === undefined || obtainedAt === undefined) return false;

    return now >= obtainedAt + tokens.expires_in * 1000 - ms;
  }

  /** Whether a refresh token is held. */
  get refreshable(): boolean {
    return this.#entry.tokens?.refresh_token !== undefined;
  }

  get redirectUrl(): string {
    return this.#options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: OAUTH_CLIENT_NAME,
      redirect_uris: [this.#options.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // A public client: PKCE, no secret.
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.#options.state ?? randomBytes(32).toString("base64url");
  }

  clientInformation(
    context?: OAuthClientInformationContext,
  ): StoredOAuthClientInformation | undefined {
    const { client } = this.#entry;

    // `auth()` registers a client when this gives none it can use: no client, or one stamped by another authorization
    // server. Registering is the owner's to agree to, so it is refused here, before the registration request is sent.
    if (
      this.#options.signInRequired !== undefined &&
      context !== undefined &&
      (client === undefined ||
        (client.issuer !== undefined && !sameIssuer(client.issuer, context.issuer)))
    ) {
      throw this.#options.signInRequired();
    }

    return client;
  }

  saveClientInformation(client: StoredOAuthClientInformation): void {
    this.#entry = { ...this.#entry, client };
  }

  async tokens(context?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    // No context is the transport reading the bearer for a request (`auth()` always passes one): the moment to refresh.
    if (
      context === undefined &&
      this.#options.refresh !== undefined &&
      this.refreshable &&
      this.expiresWithin(REFRESH_MARGIN_MS, (this.#options.now ?? Date.now)())
    ) {
      await this.#options.refresh(this);
    }

    return this.#entry.tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    const kept = this.#entry.tokens?.refresh_token;

    this.#entry = {
      ...this.#entry,
      // A refresh that does not rotate the refresh token leaves the one held valid.
      tokens:
        tokens.refresh_token === undefined && kept !== undefined
          ? { ...tokens, refresh_token: kept }
          : tokens,
      obtainedAt: (this.#options.now ?? Date.now)(),
    };
    this.#persistent = true;

    // Stored before the SDK reads the new access token back to use it.
    await this.#persist();
  }

  redirectToAuthorization(url: URL): void | Promise<void> {
    return this.#options.onRedirect(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.#verifier = verifier;
  }

  codeVerifier(): string {
    if (this.#verifier === undefined) throw new Error("no PKCE code verifier is held");

    return this.#verifier;
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    this.#entry = { ...this.#entry, discovery };

    if (this.signedIn) await this.#persist();
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#entry.discovery;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (this.#options.signInRequired !== undefined && (scope === "client" || scope === "all")) {
      // Before anything is dropped: the stored client and discovery stay for the sign-in to find.
      throw this.#options.signInRequired();
    }

    switch (scope) {
      case "all":
        this.#entry = {};
        break;
      case "client":
        this.#entry = { ...this.#entry, client: undefined };
        break;
      case "tokens":
        this.#entry = { ...this.#entry, tokens: undefined, obtainedAt: undefined };
        break;
      case "discovery":
        this.#entry = { ...this.#entry, discovery: undefined };
        break;
      case "verifier":
        this.#verifier = undefined;

        return;
    }

    await this.#persist();
  }

  async #persist(): Promise<void> {
    if (!this.#persistent) return;

    const { client, tokens } = this.#entry;

    if (client === undefined && tokens === undefined) {
      await this.#options.store.remove(this.#options.endpoint);
    } else {
      await this.#options.store.write(this.#options.endpoint, this.#entry);
    }
  }
}

/** Whether `status` is a redirect, which is never followed. */
export const isRedirect = (status: number): boolean => status >= 300 && status < 400;

/** What a request to the endpoint without a credential tells of the sign-in it wants. */
export type SignInProbe =
  | { readonly needed: false }
  | {
      readonly needed: true;
      readonly resourceMetadataUrl: URL | undefined;
      readonly scope: string | undefined;
    };

/**
 * Asks the endpoint for something with no credential: Access answers a caller it does not know with a 401 naming
 * the `resource_metadata` to sign in against (or a redirect to its login page, which is never followed). Any other
 * answer means the endpoint wants no sign-in (`alchemy dev` has no Access).
 */
export const probeSignIn = async (
  url: URL,
  fetchFn: FetchLike,
  headers: { readonly [name: string]: string },
): Promise<SignInProbe> => {
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
    redirect: "manual",
  });

  await response.body?.cancel().catch(() => undefined);

  if (response.status === 401) {
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);

    return { needed: true, resourceMetadataUrl, scope };
  }

  if (isRedirect(response.status)) {
    return { needed: true, resourceMetadataUrl: undefined, scope: undefined };
  }

  return { needed: false };
};

/**
 * `raw`, with one change for a request that carries a bearer token: a redirect (Access sends a caller whose token it
 * no longer accepts to its login page, where it may answer a 401 instead) is not followed, and is read as a 401, so the
 * SDK refreshes the token and retries once. Nothing follows the redirect, so the token goes nowhere but the endpoint.
 */
export const bearerFetch =
  (raw: FetchLike, provider: CloudpidOAuthProvider): FetchLike =>
  async (url, init) => {
    const response = await raw(url, init);
    const bearer = new Headers(init?.headers).get("authorization")?.startsWith("Bearer ") === true;

    if (!bearer || !isRedirect(response.status)) return response;

    await response.body?.cancel().catch(() => undefined);

    const metadata = provider.entry.discovery?.resourceMetadataUrl;

    return new Response(null, {
      status: 401,
      headers: {
        "www-authenticate":
          metadata === undefined ? "Bearer" : `Bearer resource_metadata="${metadata}"`,
      },
    });
  };

/** The refresh a provider runs when the access token in use is about to expire: one at a time, whatever asks. */
export const singleFlightRefresh = (
  serverUrl: URL,
  fetchFn: FetchLike,
): ((provider: CloudpidOAuthProvider) => Promise<void>) => {
  let running: Promise<void> | undefined;

  return (provider) => {
    running ??= auth(provider, { serverUrl, fetchFn })
      .then(
        () => undefined,
        // A refresh that fails leaves the old token to be tried: the endpoint's 401 takes it from there.
        () => undefined,
      )
      .finally(() => {
        running = undefined;
      });

    return running;
  };
};

const SDK_WARNING = "[mcp-sdk] ";

/** The SDK's issuer comparison: one trailing `/` does not make another authorization server. */
const sameIssuer = (left: string, right: string): boolean =>
  left.replace(/\/$/, "") === right.replace(/\/$/, "");

const INVALIDATING =
  /^OAuth ("[^"]*") — invalidating the stored [a-z ]+ and retrying authorization\. Cause: (".*")$/;

/**
 * What of an SDK warning is said to the owner. The SDK says it is invalidating credentials before it asks the provider to,
 * and this provider declines to (a new sign-in is the owner's to agree to), so that sentence would be untrue.
 */
const warningText = (message: string): string => {
  const match = INVALIDATING.exec(message);

  if (match === null) return message;

  let cause = match[2] ?? "";

  try {
    const parsed: unknown = JSON.parse(cause);

    cause = Predicate.isString(parsed) ? parsed : cause;
  } catch {
    // Kept as the SDK wrote it.
  }

  return `the authorization server refused the stored sign-in (${(match[1] ?? "").replaceAll('"', "")}): ${cause}`;
};

const sinks = new Set<(message: string) => void>();
let consoleWarn: typeof console.warn | undefined;

/**
 * The SDK `console.warn`s (`[mcp-sdk] …`) when a refresh falls back to a new authorization or credentials are dropped,
 * which is ordinary once a grant has ended, and would be written over pi's screen. While any caller holds this, those
 * lines go to the caller's `sink` (the message, without its prefix) and everything else still reaches the console.
 * Returns the release. A sink is called with text the SDK composes from OAuth errors, never with a token.
 */
export const captureSdkWarnings = (sink: (message: string) => void): (() => void) => {
  if (sinks.size === 0) {
    const original = console.warn;

    consoleWarn = original;
    console.warn = (...args: Parameters<typeof console.warn>) => {
      const first = String(args[0]);

      if (!first.startsWith(SDK_WARNING)) {
        original(...args);

        return;
      }

      for (const each of sinks) each(warningText(first.slice(SDK_WARNING.length)));
    };
  }

  // A function of its own, so that two callers handing over the same `sink` release one each.
  const held = (message: string) => sink(message);

  sinks.add(held);

  return () => {
    sinks.delete(held);

    if (sinks.size === 0 && consoleWarn !== undefined) {
      console.warn = consoleWarn;
      consoleWarn = undefined;
    }
  };
};
