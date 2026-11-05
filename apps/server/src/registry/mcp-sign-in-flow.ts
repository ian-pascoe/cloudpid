// Starting and completing an MCP sign-in, in the Registry (`docs/architecture/mcp-sign-in.md` → Client registration, Starting
// and completing a sign-in, Telemetry and redaction; ADR-0035): `startMcpSignIn` resolves the entry, discovers the
// authorization server, picks the client by the ladder (a configured `clientId`, the client document, DCR, a problem),
// binds it, makes the PKCE verifier and the 256-bit `state` and keeps one pending row; `confirmMcpSignIn` answers the issuer
// interstitial; `completeMcpSignIn` takes the pending row first, checks the path, `error` and `iss` (RFC 9207), exchanges the
// code through `guardedFetch`, seals the tokens and writes the sign-in.
//
// Safety rests on the single-use `state` (only its hash is kept), the verifier only the Registry holds (sealed), the exact
// redirect path, the `iss` check and the issuer pin. Nothing here logs, and no answer, span attribute or error holds a
// token, code, verifier, `state`, secret or authorization URL: an answer's `message` is what the owner is told, cut to 300
// characters, and a span says the OAuth error code and the status only. The Registry never calls a host: a completed
// sign-in raises the sign-ins revision, which the hosts pull at `windowOpened`.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off globalJsonInEffect:off
import { type McpResolvedServer, type McpSignInKey, mcpClientNameFor } from "@cloudpid/config";
import type { KeptVault, SealedValue, SecretVaultError } from "@cloudpid/extensions/secrets/core";
import {
  type AuthorizationServerMetadata,
  clientSecretExpiresAt,
  discoverOAuthServerInfo,
  exchangeAuthorizationCode,
  expiresWithin,
  type IssuerPin,
  isPinned,
  issuerPinProblem,
  type OAuthClientMetadata,
  type OAuthFetch,
  OAuthError,
  OAuthRegistrationError,
  parseWwwAuthenticate,
  registerClient,
  sameIssuer,
  selectResource,
} from "@cloudpid/mcp/oauth";
import {
  MCP_SIGN_IN_GLOBAL,
  type McpSignInCompleteAnswer,
  type McpSignInCompleteInput,
  type McpSignInConfirmAnswer,
  type McpSignInConfirmInput,
  type McpSignInEnvironment,
  type McpSignInFailure,
  MCP_SIGN_IN_FAILURES,
  McpSignInSecretRef,
  type McpSignInStartAnswer,
  type McpSignInStartInput,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { authorizationUrl, pkceChallenge, randomToken } from "../mcp/sign-in-client.ts";
import { isOwnHost } from "../mcp/own-hosts.ts";
import { callbackUrl, clientDocumentUrl, dcrRedirectUri } from "../mcp/sign-in-origin.ts";
import {
  clip,
  MAX_SIGN_IN_ERROR_LENGTH,
  mergeScopes,
  type SignInUse,
  signInTargetOf,
  signInUseOf,
  told,
} from "./mcp-sign-in-registry.ts";
import {
  openValue,
  PENDING_TABLE,
  REGISTRATIONS_TABLE,
  sealTokens,
  sealValue,
} from "./mcp-sign-in-seal.ts";
import {
  type McpPendingSignIn,
  type McpRegistration,
  type McpSignIns,
  type McpSignInClient,
  PENDING_SIGN_IN_TTL_MS,
  registrationKey,
  stateHash,
} from "./mcp-sign-ins.ts";
import { mcpLayersOf } from "./settings.ts";
import { resolvedMcpServers } from "./mcp-set.ts";
import { environmentResolvedServers, type ResolvedServersStore } from "./mcp-registry.ts";
import { type McpValueSources, resolveOauthSecret } from "./mcp-values.ts";
import type { RegistryStore } from "./store.ts";

/** The store as a start and a callback read it: the servers' sets, and the Environments that use a sign-in. */
export type FlowStore = ResolvedServersStore & Pick<RegistryStore, "listEnvironments">;

type DiscoverOptions = Types.Mutable<NonNullable<Parameters<typeof discoverOAuthServerInfo>[1]>>;

type RegisterOptions = Types.Mutable<Parameters<typeof registerClient>[1]>;

type ExchangeOptions = Types.Mutable<Parameters<typeof exchangeAuthorizationCode>[1]>;

/** What a start and a callback read and write. */
export type FlowDeps = {
  readonly store: FlowStore;
  readonly signIns: McpSignIns;
  /** The `mcp-oauth` vault: it fails while `SECRETS_ENCRYPTION_KEY` is malformed, and starts are then refused. */
  readonly vault: Effect.Effect<KeptVault, SecretVaultError>;
  /** Every OAuth request: `guardedOAuthFetch` in the Registry, a fake in a test. */
  readonly fetch: OAuthFetch;
  /** The Secrets (when `resolvesSecrets`) and Variables an entry's `${NAME}` reads in `environment` (an id, or `all`). */
  readonly sources: (
    environment: string,
    resolvesSecrets: boolean,
  ) => Effect.Effect<McpValueSources, SecretVaultError>;
};

/** The code of an authorization server error, as a page may show it: a plain token of at most 64 characters. */
export const errorCodeOf = (text: string): string =>
  /^[\w.:-]{1,64}$/.test(text) ? text : "error";

/** Why a start or a callback went no further: the owner is told `message`, which never holds a secret. */
export class FlowProblem extends Schema.TaggedError<
  FlowProblem,
  { readonly brand: unique symbol }
>()("FlowProblem", { message: Schema.String, code: Schema.optional(Schema.String) }) {}

/** What went wrong in `error`, for the owner: an OAuth error's code and description, or a registration's status and body. */
const describe = (error: Error): string => {
  if (error instanceof OAuthRegistrationError) {
    return `HTTP ${error.status}: ${clip(error.body, MAX_SIGN_IN_ERROR_LENGTH)}`;
  }

  if (error instanceof OAuthError) {
    return error.message === error.code ? error.code : `${error.code} (${error.message})`;
  }

  return error.message;
};

export const attempt = <A>(what: string, run: () => Promise<A>): Effect.Effect<A, FlowProblem> =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      FlowProblem.make({
        message: told(`${what}: ${error instanceof Error ? describe(error) : "it failed"}`),
        // An authorization server's own error code (`invalid_grant`, …): the page and the span name it.
        code: error instanceof OAuthError ? errorCodeOf(error.code) : undefined,
      }),
  });

export const hostOf = (url: string): string => (URL.canParse(url) ? new URL(url).host : url);

/** The vault's own failure, said without a value. */
const vaultFailure = (error: SecretVaultError): FlowProblem =>
  FlowProblem.make({ message: error.message, code: "vault" });

/** The servers `environment`'s set resolves to (Global's own layers for `all`), or null when it is not registered. */
export const serversOf = (
  store: FlowStore,
  environment: string,
): ReadonlyArray<McpResolvedServer> | null =>
  environment === MCP_SIGN_IN_GLOBAL
    ? resolvedMcpServers(mcpLayersOf(store, {}, []))
    : environmentResolvedServers(store, environment);

/**
 * Whether `resolved` is an HTTP server that signs in under the key `hash` in the way `kind` says (an owner's sign-in, or
 * a client grant's, which the same key may hold the row of under another kind of entry), with `clientId` when one is
 * given. An entry of the other kind than the row's does not use it: it replaces the row (revoking an owner's tokens)
 * only when no set still uses the row as its own kind, and is otherwise told of the clash (`signInClash`).
 */
export const usesSignIn = (
  resolved: McpResolvedServer,
  hash: string,
  kind: SignInUse,
  clientId?: string,
): boolean => {
  const use = signInUseOf(signInTargetOf(resolved));

  return (
    use?.kind === kind &&
    use.hash === hash &&
    (clientId === undefined ||
      (resolved.server.type === "http" && resolved.server.oauth?.clientId === clientId))
  );
};

/** Whether some set (Global's, or an Environment's) names a server that signs in under `keyHash` as the client `clientId`. */
const bindingNamedBy =
  (store: FlowStore) =>
  (keyHash: string, clientId: string): boolean =>
    Arr.some([MCP_SIGN_IN_GLOBAL, ...Arr.map(store.listEnvironments(), ({ id }) => id)], (id) =>
      Arr.some(serversOf(store, id) ?? [], (resolved) =>
        usesSignIn(resolved, keyHash, "owner", clientId),
      ),
    );

/** The Environments whose set holds a server that uses the sign-in `hash`. */
export const environmentsUsing = (
  store: FlowStore,
  hash: string,
  kind: SignInUse,
): ReadonlyArray<McpSignInEnvironment> =>
  Arr.map(
    Arr.filter(store.listEnvironments(), ({ id }) =>
      Arr.some(serversOf(store, id) ?? [], (resolved) => usesSignIn(resolved, hash, kind)),
    ),
    ({ id, name }) => ({ id, name }),
  );

/** The entry a start names, and the sign-in it uses. */
type SignInEntry = {
  readonly resolved: McpResolvedServer;
  readonly key: McpSignInKey;
  readonly url: string;
  readonly configuredScope: string | undefined;
  readonly oauth: Extract<McpResolvedServer["server"], { readonly type: "http" }>["oauth"];
};

/** The server `name` of `environment`'s set (Global's own for `all`) as a sign-in target, or why it is none. */
export const findEntry = (
  store: FlowStore,
  environment: string,
  name: string,
): Effect.Effect<SignInEntry, FlowProblem> => {
  const servers = serversOf(store, environment);

  if (servers === null) return FlowProblem.make({ message: "The Environment is not registered" });

  const resolved = Arr.findFirst(servers, (candidate) => candidate.name === name).pipe(
    Option.getOrUndefined,
  );

  if (resolved === undefined) {
    return FlowProblem.make({ message: "The server is not in the Environment's MCP set" });
  }

  const target = signInTargetOf(resolved);

  if (target.status !== "target") return FlowProblem.make({ message: target.reason });

  if (resolved.server.type !== "http") {
    return FlowProblem.make({ message: "Only an HTTP server signs in with OAuth" });
  }

  return Effect.succeed({
    resolved,
    key: target.key,
    url: resolved.server.url,
    configuredScope: target.configuredScope,
    oauth: resolved.server.oauth,
  });
};

/** What a pending row keeps in its `client` column, besides the client: what a callback needs to finish. */
const PendingContext = Schema.Struct({
  key: Schema.Struct({
    hash: Schema.String,
    source: Schema.String,
    name: Schema.String,
    url: Schema.String,
  }),
  /** The server as its entry spells it, for Start again. */
  server: Schema.String,
  authorizationServerUrl: Schema.String,
  /** The discovery recorded on the sign-in: the authorization server's URL and the protected resource metadata. */
  discovery: Schema.String,
  client: Schema.Struct({
    id: Schema.String,
    kind: Schema.Literals(["configured", "document", "registered", "client_grant"]),
    secretRef: Schema.NullOr(McpSignInSecretRef),
    registration: Schema.NullOr(Schema.String),
  }),
});

type PendingContext = typeof PendingContext.Type;

export const decodeContext = Schema.decodeUnknownOption(Schema.fromJsonString(PendingContext));

/** The fields of the authorization server metadata a callback reads, in the metadata the start recorded. */
const RecordedMetadata = Schema.StructWithRest(
  Schema.Struct({
    issuer: Schema.String,
    authorization_endpoint: Schema.String,
    token_endpoint: Schema.String,
    response_types_supported: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const decodeMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(RecordedMetadata));

/** The recorded metadata as the pi-mcp functions take it; `none` for a pending row that holds none. */
export const metadataOf = (text: string): Option.Option<AuthorizationServerMetadata> =>
  Option.map(decodeMetadata(text), (metadata) => ({
    ...metadata,
    response_types_supported: [...metadata.response_types_supported],
  }));

/** What the scope of a start is made from. */
type ScopeSources = {
  /** The wanted scope of a step-up. */
  readonly wanted: string | null;
  /** The entry's own `oauth.scope`. */
  readonly configured: string | undefined;
  /** The scope of the last challenge. */
  readonly challenged: string | undefined;
  /** What the protected resource's metadata lists. */
  readonly supportedByResource: ReadonlyArray<string> | undefined;
  readonly metadata: AuthorizationServerMetadata;
};

/** The scope requested: the entry's, the challenged and the protected resource's, with `offline_access` when the server lists it. */
const requestedScope = (sources: ScopeSources): string | undefined => {
  const base =
    sources.wanted ??
    mergeScopes(sources.configured, sources.challenged) ??
    mergeScopes(sources.supportedByResource?.join(" "));

  if (base === null) return undefined;

  const offline =
    sources.metadata.scopes_supported?.includes("offline_access") === true &&
    !base.split(" ").includes("offline_access");

  return offline ? `${base} offline_access` : base;
};

/** The https URL of `text`, or undefined. */
const httpsUrl = (text: string | undefined): URL | undefined =>
  text !== undefined && URL.canParse(text) && new URL(text).protocol === "https:"
    ? new URL(text)
    : undefined;

/**
 * The resource metadata URL an unauthenticated GET of `serverUrl` names in its 401's `WWW-Authenticate`, or undefined
 * (→ A hop to one of cloudpid's own hosts). A start asks it only for a server on one of cloudpid's own hosts (Self-use)
 * with no challenge recorded: Access serves the metadata at `/.well-known/cloudflare-access-protected-resource/…`, which
 * the well-known discovery does not try, and the root paths it does try answer Access's login there (a 302). Any other
 * answer, or a failure, leaves the well-known discovery to run as before.
 */
const probedResourceMetadataUrl = (
  fetch: OAuthFetch,
  serverUrl: URL,
): Effect.Effect<URL | undefined> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(serverUrl.toString(), {
        headers: { accept: "application/json, text/event-stream" },
      });

      await response.body?.cancel();

      if (response.status !== 401) return undefined;

      return httpsUrl(
        parseWwwAuthenticate(
          response.headers.get("www-authenticate"),
        ).resourceMetadataUrl?.toString(),
      );
    },
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined));

/** The client a start chose, with what the authorization request and the interstitial need. */
type Chosen = {
  readonly client: McpSignInClient;
  readonly redirectUri: string;
  readonly confirmation: { readonly previousIssuer: string | undefined } | undefined;
  readonly secret: McpSignInSecretRef | undefined;
};

/** What a start learned about the authorization server before it chooses a client. */
type Discovered = {
  readonly metadata: AuthorizationServerMetadata;
  readonly authorizationServerUrl: string;
  readonly pin: IssuerPin;
  /** The scope the start asks for. */
  readonly scope: string | undefined;
};

/**
 * The client for this start, by the ladder (→ Client registration): a configured `clientId`; the client document, when the
 * stage's switch is on, the entry does not say `dcr` and the server advertises `client_id_metadata_document_supported`, `none`
 * auth and the `iss` parameter; DCR; or a problem naming the redirect URI to register.
 */
const chooseClient = (
  deps: FlowDeps,
  vault: KeptVault,
  entry: SignInEntry,
  input: McpSignInStartInput,
  discovered: Discovered,
  now: number,
): Effect.Effect<Chosen, FlowProblem> =>
  Effect.gen(function* () {
    const { stage } = input;
    const { oauth } = entry;
    const { metadata, authorizationServerUrl, pin, scope } = discovered;
    const issuer = metadata.issuer;
    const plainCallback = callbackUrl(stage.origin);

    // 1. A configured client: the owner registered it, so it is bound to one issuer (SEP-2352).
    if (oauth?.clientId !== undefined) {
      const sources = yield* deps
        .sources(input.environment, entry.resolved.resolvesSecrets)
        .pipe(Effect.mapError(vaultFailure));

      const secret = resolveOauthSecret(entry.resolved, sources);

      if (secret.status === "missing") {
        return yield* FlowProblem.make({
          message: `The client secret \${${secret.name}} is not set as a Secret or a Variable`,
        });
      }

      const binding = deps.signIns.getBinding(entry.key.hash, oauth.clientId);
      const bound = binding !== null && sameIssuer(binding.issuer, issuer);

      return {
        client: {
          id: oauth.clientId,
          kind: "configured",
          secretRef:
            secret.status === "ok" && secret.ref !== null
              ? { ...secret.ref, environment: input.environment }
              : null,
          registration: null,
        },
        redirectUri: plainCallback,
        // An unpinned client's first binding, and any change of its issuer, is the owner's to confirm.
        confirmation: isPinned(pin) || bound ? undefined : { previousIssuer: binding?.issuer },
        secret: secret.status === "ok" && secret.ref !== null ? secret.ref : undefined,
      } satisfies Chosen;
    }

    // 2. The client document.
    const advertisesIss = metadata.authorization_response_iss_parameter_supported === true;

    const documentNeeds = [
      ...(stage.documentEnabled ? [] : ["this stage does not use the client document"]),
      ...(metadata.client_id_metadata_document_supported === true
        ? []
        : ["the server does not advertise client_id_metadata_document_supported"]),
      ...(metadata.token_endpoint_auth_methods_supported?.includes("none") === true
        ? []
        : ["the server does not advertise the none client authentication"]),
      ...(advertisesIss
        ? []
        : ["the server does not advertise authorization_response_iss_parameter_supported"]),
    ];

    const registration = oauth?.clientRegistration ?? "auto";

    if (registration !== "dcr" && documentNeeds.length === 0) {
      return {
        client: {
          id: clientDocumentUrl(stage.origin),
          kind: "document",
          secretRef: null,
          registration: null,
        },
        redirectUri: plainCallback,
        confirmation: undefined,
        secret: undefined,
      } satisfies Chosen;
    }

    if (registration === "cimd") {
      return yield* FlowProblem.make({
        message: told(
          `clientRegistration is "cimd", but ${Arr.join(documentNeeds, " and ")}. Set Client registration to auto or DCR.`,
        ),
      });
    }

    // 3. DCR, as pi-mcp does it; the redirect URI carries the issuer's hash when the server gives no `iss`.
    const redirectUri = dcrRedirectUri({ origin: stage.origin, issuer, advertisesIss });
    const endpoint = httpsUrl(metadata.registration_endpoint);

    if (endpoint === undefined) {
      return yield* FlowProblem.make({
        message: told(
          `${hostOf(issuer)} offers neither a client document nor dynamic client registration for cloudpid. Register cloudpid there as a client with the redirect URI ${redirectUri}, then set oauth.clientId (and oauth.clientSecret) on the entry.`,
        ),
      });
    }

    const clientName = mcpClientNameFor(stage, oauth?.clientName);
    const key = registrationKey({ issuer, redirectUri, clientName });
    const kept = deps.signIns.getRegistration(key);

    // A registration within 5 min of its secret's expiry is replaced at this start.
    if (kept !== null && !expiresWithin(kept.clientSecretExpiresAt ?? undefined, now)) {
      return {
        client: { id: kept.clientId, kind: "registered", secretRef: null, registration: key },
        redirectUri,
        confirmation: undefined,
        secret: undefined,
      } satisfies Chosen;
    }

    const clientMetadata: OAuthClientMetadata = {
      redirect_uris: [redirectUri],
      client_name: clientName,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Under `alchemy dev` the redirect URI is a loopback one, which a `web` client may not have.
      application_type: stage.local ? "native" : "web",
    };

    if (metadata.token_endpoint_auth_methods_supported?.includes("none") === true) {
      clientMetadata.token_endpoint_auth_method = "none";
    }

    const registrationOptions: RegisterOptions = { metadata, clientMetadata, fetch: deps.fetch };

    if (scope !== undefined) registrationOptions.scope = scope;

    const registered = yield* attempt(`${hostOf(issuer)} refused the registration`, () =>
      registerClient(authorizationServerUrl, registrationOptions),
    ).pipe(
      Effect.mapError((problem) => {
        // The hint is the part to act on: it is kept whole, and the refusal's own text gives way to it.
        const hint = ` It may accept only clients it knows: register cloudpid there with the redirect URI ${redirectUri} and set oauth.clientId.`;

        return FlowProblem.make({
          message: `${clip(problem.message, Math.max(0, MAX_SIGN_IN_ERROR_LENGTH - Array.from(hint).length - 1))}.${hint}`,
        });
      }),
    );

    const { client_secret: secret, ...information } = registered;

    const sealedSecret =
      secret === undefined
        ? null
        : yield* sealValue(vault, REGISTRATIONS_TABLE, key, secret).pipe(
            Effect.mapError(vaultFailure),
          );

    const record: McpRegistration = {
      key,
      issuer,
      redirectUri,
      clientName,
      clientId: registered.client_id,
      clientInfo: JSON.stringify(information),
      sealedSecret,
      clientSecretExpiresAt: clientSecretExpiresAt(registered) ?? null,
      registeredAt: now,
      usedAt: now,
    };

    const put = deps.signIns.putRegistration(record);

    if (put.status === "refused") return yield* FlowProblem.make({ message: put.message });

    return {
      client: { id: registered.client_id, kind: "registered", secretRef: null, registration: key },
      redirectUri,
      confirmation: undefined,
      secret: undefined,
    } satisfies Chosen;
  });

/** What the owner's browser goes to once the pending row is kept: the authorization server's page. */
const authorizationRedirect = (
  metadata: AuthorizationServerMetadata,
  pending: Pick<McpPendingSignIn, "redirectUri" | "scope" | "resource">,
  clientId: string,
  state: string,
  verifier: string,
): Effect.Effect<URL, FlowProblem> => {
  const url = authorizationUrl({
    metadata,
    clientId,
    redirectUri: pending.redirectUri,
    scope: pending.scope ?? undefined,
    state,
    codeChallenge: pkceChallenge(verifier),
    resource: pending.resource ?? undefined,
  });

  return Result.match(url, {
    onFailure: (message) => FlowProblem.make({ message }),
    onSuccess: Effect.succeed,
  });
};

/**
 * The start (→ Starting and completing a sign-in, `startMcpSignIn`): the owner's browser is sent to the authorization page, or
 * shown the issuer interstitial, or told why there is no sign-in to start. Writes the one pending row of the key, whose
 * `state` the callback will present.
 */
export const startMcpSignIn = (
  deps: FlowDeps,
  input: McpSignInStartInput,
  now: number,
): Effect.Effect<McpSignInStartAnswer> =>
  Effect.gen(function* () {
    const vault = yield* deps.vault.pipe(
      Effect.mapError((error) =>
        FlowProblem.make({ message: told(`Sign-ins are not available: ${error.message}`) }),
      ),
    );

    const entry = yield* findEntry(deps.store, input.environment, input.server);
    const row = deps.signIns.get(entry.key.hash);
    const challenge = row?.challenge ?? null;

    yield* Effect.annotateCurrentSpan({
      "mcp.server": entry.key.name,
      "mcp.source_kind": entry.key.source.startsWith("repo:") ? "repo" : "owner",
      "mcp.step_up": input.stepUp === true,
    });

    // The authorization server is discovered from the last reported challenge, else the well-known paths; a pin
    // (`authServerMetadataUrl`) is fetched instead, and is trusted as configured.
    const pinnedMetadataUrl = entry.oauth?.authServerMetadataUrl;

    if (pinnedMetadataUrl !== undefined && httpsUrl(pinnedMetadataUrl) === undefined) {
      return yield* FlowProblem.make({
        message: "oauth.authServerMetadataUrl is not an https URL",
      });
    }

    const serverUrl = new URL(entry.url);

    // A Self-use start with no challenge asks the server for one first (`probedResourceMetadataUrl`).
    const resourceMetadataUrl =
      httpsUrl(challenge?.resourceMetadataUrl) ??
      (isOwnHost(serverUrl.hostname.toLowerCase())
        ? yield* probedResourceMetadataUrl(deps.fetch, serverUrl)
        : undefined);

    const discovery: DiscoverOptions = { fetch: deps.fetch };

    if (resourceMetadataUrl !== undefined) discovery.resourceMetadataUrl = resourceMetadataUrl;

    if (pinnedMetadataUrl !== undefined) {
      discovery.authorizationServerMetadataUrl = new URL(pinnedMetadataUrl);
    }

    const info = yield* attempt("The authorization server could not be found", () =>
      discoverOAuthServerInfo(serverUrl, discovery),
    );

    const metadata = info.authorizationServerMetadata;

    if (metadata === undefined) {
      return yield* FlowProblem.make({
        message:
          "The server's authorization server published no metadata, so cloudpid cannot sign in to it",
      });
    }

    // The issuer pin (SEP-2352): `oauth.issuer` and the issuer of `authServerMetadataUrl`, which must agree.
    const pin: IssuerPin = {
      issuer: entry.oauth?.issuer,
      metadataIssuer: pinnedMetadataUrl === undefined ? undefined : metadata.issuer,
    };

    const pinProblem = issuerPinProblem(pin, metadata.issuer);

    if (pinProblem !== undefined) return yield* FlowProblem.make({ message: told(pinProblem) });

    yield* Effect.annotateCurrentSpan({ "mcp.issuer_host": hostOf(metadata.issuer) });

    const scope = requestedScope({
      wanted: input.stepUp === true ? (row?.wantedScope ?? null) : null,
      configured: entry.oauth?.scope,
      challenged: challenge?.scope,
      supportedByResource: info.resourceMetadata?.scopes_supported,
      metadata,
    });

    const resource = yield* Effect.try({
      try: () => selectResource(serverUrl, info.resourceMetadata),
      catch: (error) =>
        FlowProblem.make({
          message: told(
            error instanceof Error
              ? error.message
              : "The protected resource does not match the server",
          ),
        }),
    });

    const chosen = yield* chooseClient(
      deps,
      vault,
      entry,
      input,
      { metadata, authorizationServerUrl: info.authorizationServerUrl, pin, scope },
      now,
    );

    yield* Effect.annotateCurrentSpan({
      "mcp.client_kind": chosen.client.kind,
      "mcp.registered": chosen.client.kind === "registered",
    });

    // A document or DCR client whose server now signs in at another issuer: the old tokens are for a server it no
    // longer uses (a configured client's change is the owner's to confirm, and goes with the new sign-in).
    if (
      chosen.client.kind !== "configured" &&
      row?.hasTokens === true &&
      row.issuer !== null &&
      !sameIssuer(row.issuer, metadata.issuer)
    ) {
      deps.signIns.dropTokens(
        entry.key.hash,
        told(`Now signs in at ${metadata.issuer} (was ${row.issuer})`),
        now,
      );
    }

    const state = randomToken();
    const verifier = randomToken();

    const pendingBase = {
      redirectUri: chosen.redirectUri,
      scope: scope ?? null,
      resource: resource ?? null,
    };

    // Built before the row is kept, so a server that cannot take the request leaves nothing behind.
    const redirect = yield* authorizationRedirect(
      metadata,
      pendingBase,
      chosen.client.id,
      state,
      verifier,
    );

    const sealedVerifier = yield* sealValue(vault, PENDING_TABLE, entry.key.hash, verifier).pipe(
      Effect.mapError(vaultFailure),
    );

    const context: PendingContext = {
      key: entry.key,
      server: entry.resolved.name,
      authorizationServerUrl: info.authorizationServerUrl,
      // `undefined` leaves JSON as the key is not there.
      discovery: JSON.stringify({
        authorizationServerUrl: info.authorizationServerUrl,
        resourceMetadata: info.resourceMetadata,
        resourceMetadataUrl: resourceMetadataUrl?.href,
      }),
      client: chosen.client,
    };

    const put = deps.signIns.putPending({
      keyHash: entry.key.hash,
      stateHash: stateHash(state),
      environment: input.environment,
      redirectUri: chosen.redirectUri,
      issuer: metadata.issuer,
      metadata: JSON.stringify(metadata),
      client: JSON.stringify(context),
      sealedVerifier,
      scope: pendingBase.scope,
      resource: pendingBase.resource,
      stepUp: input.stepUp === true,
      requester: input.requester === undefined ? null : JSON.stringify(input.requester),
      returnPath: input.returnPath ?? null,
      awaitingConfirmation: chosen.confirmation !== undefined,
      lastError: null,
      createdAt: now,
      expiresAt: now + PENDING_SIGN_IN_TTL_MS,
    });

    if (put.status === "refused") return yield* FlowProblem.make({ message: put.message });

    if (chosen.confirmation === undefined) {
      return { status: "redirect", url: redirect.href } satisfies McpSignInStartAnswer;
    }

    return {
      status: "confirm",
      confirmation: {
        state,
        server: entry.resolved.name,
        source: entry.key.source,
        url: entry.url,
        issuer: metadata.issuer,
        previousIssuer: chosen.confirmation.previousIssuer,
        clientId: chosen.client.id,
        secret: chosen.secret,
      },
    } satisfies McpSignInStartAnswer;
  }).pipe(
    Effect.catchTag("FlowProblem", (problem) =>
      Effect.annotateCurrentSpan({ "mcp.oauth_error": problem.code }).pipe(
        Effect.as<McpSignInStartAnswer>({ status: "problem", message: problem.message }),
      ),
    ),
    Effect.tap((answer) => Effect.annotateCurrentSpan({ "mcp.outcome": answer.status })),
    Effect.withSpan("mcp.oauth.start"),
  );

/**
 * The issuer interstitial's Continue or Cancel (→ Issuer binding): the one-time field is the `state` the start put in the
 * page. Cancel deletes the pending row; Continue marks it confirmed and sends the owner to the authorization page. A row
 * that is gone or past its 10 minutes is `expired`.
 */
export const confirmMcpSignIn = (
  deps: FlowDeps,
  input: McpSignInConfirmInput,
  now: number,
): Effect.Effect<McpSignInConfirmAnswer> =>
  Effect.gen(function* () {
    if (input.decision !== "continue" && input.decision !== "cancel") {
      return { status: "problem", message: "Continue or Cancel" } satisfies McpSignInConfirmAnswer;
    }

    const vault = yield* deps.vault.pipe(Effect.mapError(vaultFailure));

    // Taken first, as a callback takes it: a row is used by one answer. Cancel leaves it deleted; Continue puts it back.
    const taken = deps.signIns.takePending(stateHash(input.state), now);

    if (taken.status !== "found") return { status: "expired" } satisfies McpSignInConfirmAnswer;

    if (input.decision === "cancel")
      return { status: "cancelled" } satisfies McpSignInConfirmAnswer;

    const { pending } = taken;
    const context = decodeContext(pending.client);
    const metadata = metadataOf(pending.metadata);

    if (Option.isNone(context) || Option.isNone(metadata)) {
      return yield* FlowProblem.make({
        message: "The pending sign-in cannot be read: start again",
      });
    }

    const verifier = yield* openValue(
      vault,
      PENDING_TABLE,
      context.value.key.hash,
      pending.sealedVerifier,
    ).pipe(Effect.mapError(vaultFailure));

    const redirect = yield* authorizationRedirect(
      metadata.value,
      pending,
      context.value.client.id,
      input.state,
      verifier,
    );

    const put = deps.signIns.putPending({ ...pending, awaitingConfirmation: false });

    if (put.status === "refused") return yield* FlowProblem.make({ message: put.message });

    return { status: "redirect", url: redirect.href } satisfies McpSignInConfirmAnswer;
  }).pipe(
    Effect.catchTag("FlowProblem", (problem) =>
      Effect.succeed<McpSignInConfirmAnswer>({ status: "problem", message: problem.message }),
    ),
  );

/** A callback that saved nothing, and why: what `recordFailure` turns into the answer for the page. */
class Refusal extends Schema.TaggedError<Refusal, { readonly brand: unique symbol }>()("Refusal", {
  status: Schema.Literals(MCP_SIGN_IN_FAILURES),
  message: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
}) {}

/** The pending row of a callback, read: what it recorded of the sign-in and of the authorization server. */
type Loaded = {
  readonly pending: McpPendingSignIn;
  readonly context: PendingContext;
  readonly metadata: AuthorizationServerMetadata;
};

/** A refusal as the answer for the page: a row that holds no tokens keeps the reason, for the Settings row and the open request. */
const recordFailure = (
  deps: FlowDeps,
  { pending, context }: Loaded,
  refusal: Refusal,
  now: number,
): McpSignInFailure => {
  const reason = refusal.message === undefined ? undefined : told(refusal.message);
  const row = deps.signIns.get(context.key.hash);

  if (reason !== undefined && (row === null || !row.hasTokens)) {
    // A refusal for want of room leaves nothing to note on.
    if (row === null) deps.signIns.noteChallenge(context.key, {}, now);

    deps.signIns.update(context.key.hash, { lastError: reason }, now);
  }

  return {
    status: refusal.status,
    code: refusal.code,
    message: reason,
    // The key's open Sign-in requests stay open and show this failure: the carrier tells their Sessions.
    waiting: Arr.map(deps.signIns.waiters(context.key.hash, now), ({ session, request }) => ({
      session,
      request,
    })),
    retry: { environment: pending.environment, server: context.server },
    returnPath: pending.returnPath ?? undefined,
  };
};

/** The code of an answer that is one this sign-in asked for (its path, no error, the right issuer), or why it is none. */
const answeredCode = (
  { pending, metadata }: Loaded,
  input: McpSignInCompleteInput,
): Effect.Effect<string, Refusal> => {
  if (pending.awaitingConfirmation) {
    return Refusal.make({
      status: "unconfirmed",
      message: "The issuer was not confirmed: start again",
    });
  }

  // The path is the redirect URI's own: a callback at another path (another issuer's hash, say) is nothing saved.
  if (!URL.canParse(pending.redirectUri) || new URL(pending.redirectUri).pathname !== input.path) {
    return Refusal.make({
      status: "path_mismatch",
      message: "The answer came to another address than the sign-in started with",
    });
  }

  if (input.error !== undefined) {
    const reported = errorCodeOf(input.error);

    return reported === "access_denied"
      ? Refusal.make({ status: "declined", code: reported })
      : Refusal.make({
          status: "provider_error",
          message: input.errorDescription ?? reported,
          code: reported,
        });
  }

  // RFC 9207: never send a code from another authorization server to this one.
  if (
    (input.iss !== undefined || metadata.authorization_response_iss_parameter_supported === true) &&
    input.iss !== metadata.issuer
  ) {
    return Refusal.make({
      status: "iss_mismatch",
      message: "The answer came from another authorization server: nothing was saved",
    });
  }

  return input.code === undefined || input.code === ""
    ? Refusal.make({ status: "missing_code", message: "The answer carried no code" })
    : Effect.succeed(input.code);
};

/** The status of the token endpoint's last answer, kept for the span. */
type TokenEndpointStatus = { status: number | undefined };

/** What the token endpoint issued. */
type IssuedTokens = Awaited<ReturnType<typeof exchangeAuthorizationCode>>;

/**
 * The code exchanged for tokens at the token endpoint, with the verifier only the Registry holds and the client's secret
 * when it has one, and the tokens sealed. The token endpoint's HTTP status goes on the span (never the code or a token).
 */
const exchangeForTokens = (
  deps: FlowDeps,
  { pending, context, metadata }: Loaded,
  code: string,
): Effect.Effect<{ readonly tokens: IssuedTokens; readonly sealed: SealedValue }, Refusal> =>
  Effect.gen(function* () {
    // Opened first: a vault that fails to open is the store's problem, not the server's.
    const opening = yield* Effect.result(
      Effect.gen(function* () {
        const vault = yield* deps.vault.pipe(Effect.mapError(vaultFailure));

        const verifier = yield* openValue(
          vault,
          PENDING_TABLE,
          context.key.hash,
          pending.sealedVerifier,
        ).pipe(Effect.mapError(vaultFailure));

        return {
          vault,
          verifier,
          information: yield* clientInformation(deps, vault, pending.environment, context),
        };
      }),
    );

    if (Result.isFailure(opening)) {
      return yield* Refusal.make({ status: "unavailable", message: opening.failure.message });
    }

    const { vault, verifier, information } = opening.success;
    const seen: TokenEndpointStatus = { status: undefined };

    const exchange: ExchangeOptions = {
      metadata,
      clientInformation: information,
      fetch: async (input, init) => {
        const response = await deps.fetch(input, init);

        seen.status = response.status;

        return response;
      },
      code,
      codeVerifier: verifier,
      redirectUrl: pending.redirectUri,
    };

    if (pending.resource !== null) exchange.resource = pending.resource;

    const exchanged = yield* Effect.result(
      attempt("The authorization server refused the code", () =>
        exchangeAuthorizationCode(context.authorizationServerUrl, exchange),
      ),
    );

    yield* Effect.annotateCurrentSpan({ "http.status_code": seen.status });

    if (Result.isFailure(exchanged)) {
      const { code: refusedCode, message } = exchanged.failure;

      // A registration the server no longer knows is dropped, so the next start registers again.
      if (refusedCode === "invalid_client" && context.client.registration !== null) {
        deps.signIns.deleteRegistration(context.client.registration);
      }

      return yield* Refusal.make({ status: "exchange_failed", message, code: refusedCode });
    }

    const tokens = exchanged.success;

    if (tokens.token_type.toLowerCase() !== "bearer") {
      return yield* Refusal.make({
        status: "exchange_failed",
        message: `The server issued a ${clip(tokens.token_type, 32)} token, not a Bearer one`,
      });
    }

    const sealing = yield* Effect.result(sealTokens(vault, context.key.hash, tokens));

    if (Result.isFailure(sealing)) {
      return yield* Refusal.make({ status: "unavailable", message: sealing.failure.message });
    }

    if (sealing.success.status === "too_large") {
      return yield* Refusal.make({
        status: "exchange_failed",
        message: `The server's ${sealing.success.token === "access_token" ? "access" : "refresh"} token is longer than 16 KiB`,
      });
    }

    return { tokens, sealed: sealing.success.sealed };
  });

/** The sign-in written for the tokens just issued, and the answer: who uses it, and which Sign-in requests it resolved. */
const saveSignIn = (
  deps: FlowDeps,
  { pending, context }: Loaded,
  issued: { readonly tokens: IssuedTokens; readonly sealed: SealedValue },
  now: number,
): Effect.Effect<McpSignInCompleteAnswer, Refusal> =>
  Effect.gen(function* () {
    const { tokens, sealed } = issued;

    // A configured client is bound to the issuer it signed in at; a rebind raises the revision, and the new sign-in
    // replaces the old issuer's tokens below.
    if (context.client.kind === "configured") {
      const bound = deps.signIns.putBinding(
        {
          keyHash: context.key.hash,
          clientId: context.client.id,
          issuer: pending.issuer,
          boundAt: now,
        },
        bindingNamedBy(deps.store),
      );

      if (bound.status === "refused") {
        return yield* Refusal.make({ status: "exchange_failed", message: bound.message });
      }
    }

    // A completed step-up keeps the wanted scope and the count, which the next challenge is compared to; a sign-in from
    // Settings writes both reset.
    const before = deps.signIns.get(context.key.hash);
    const keepStepUp = pending.stepUp && before !== null;
    const expiresIn = tokens.expires_in;

    const put = deps.signIns.put(
      {
        key: context.key,
        status: "ok",
        issuer: pending.issuer,
        metadata: pending.metadata,
        discovery: context.discovery,
        resource: pending.resource ?? context.key.url,
        client: context.client,
        scope: tokens.scope ?? pending.scope,
        expiresAt:
          expiresIn !== undefined && Number.isFinite(expiresIn) && expiresIn > 0
            ? now + expiresIn * 1000
            : null,
        wantedScope: keepStepUp ? before.wantedScope : null,
        stepUpCount: keepStepUp ? before.stepUpCount : 0,
        sealed,
      },
      now,
    );

    if (put.status === "refused") {
      return yield* Refusal.make({ status: "exchange_failed", message: put.message });
    }

    const resolved = deps.signIns.resolveWaiters(context.key.hash, now);

    return {
      status: "signed_in",
      server: context.server,
      environments: environmentsUsing(deps.store, context.key.hash, "owner"),
      resolved: Arr.map(resolved, ({ session, request }) => ({ session, request })),
      revision: deps.signIns.revision(),
      retry: { environment: pending.environment, server: context.server },
      returnPath: pending.returnPath ?? undefined,
    } satisfies McpSignInCompleteAnswer;
  });

/** What a callback whose pending row was read comes to: the sign-in saved, or the failure the page tells. */
const answerCallback = (
  deps: FlowDeps,
  input: McpSignInCompleteInput,
  loaded: Loaded,
  now: number,
): Effect.Effect<McpSignInCompleteAnswer> =>
  Effect.gen(function* () {
    const code = yield* answeredCode(loaded, input);
    const issued = yield* exchangeForTokens(deps, loaded, code);

    return yield* saveSignIn(deps, loaded, issued, now);
  }).pipe(
    Effect.catchTag("Refusal", (refusal) =>
      Effect.annotateCurrentSpan({ "mcp.oauth_error": refusal.code }).pipe(
        Effect.as<McpSignInCompleteAnswer>(recordFailure(deps, loaded, refusal, now)),
      ),
    ),
  );

/**
 * The callback (→ The callback): takes the pending row of the `state` first, then checks its path, `error` and `iss` (RFC
 * 9207), exchanges the code, seals the tokens and writes the sign-in. Whatever goes wrong saves nothing and leaves the old
 * tokens as they were; the answer names the outcome for the page. `signed_in` names the Environments that use the sign-in
 * and the Sign-in requests it resolved. The span says the outcome, the OAuth error code and the token endpoint's status.
 */
export const completeMcpSignIn = (
  deps: FlowDeps,
  input: McpSignInCompleteInput,
  now: number,
): Effect.Effect<McpSignInCompleteAnswer> =>
  Effect.gen(function* () {
    // The row goes first: a code is used once, whatever the callback finds.
    const taken = deps.signIns.takePending(stateHash(input.state), now);

    if (taken.status !== "found") return { status: "expired" } satisfies McpSignInFailure;

    const { pending } = taken;
    const context = decodeContext(pending.client);
    const metadata = metadataOf(pending.metadata);

    if (Option.isNone(context) || Option.isNone(metadata)) {
      return {
        status: "unavailable",
        message: "The pending sign-in cannot be read",
      } satisfies McpSignInFailure;
    }

    const loaded: Loaded = { pending, context: context.value, metadata: metadata.value };

    yield* Effect.annotateCurrentSpan({
      "mcp.server": loaded.context.key.name,
      "mcp.source_kind": loaded.context.key.source.startsWith("repo:") ? "repo" : "owner",
      "mcp.issuer_host": hostOf(pending.issuer),
      "mcp.client_kind": loaded.context.client.kind,
      "mcp.step_up": pending.stepUp,
    });

    return yield* answerCallback(deps, input, loaded, now);
  }).pipe(
    Effect.tap((answer) => Effect.annotateCurrentSpan({ "mcp.outcome": answer.status })),
    Effect.withSpan("mcp.oauth.callback"),
  );

/**
 * The client information a code is exchanged with, or a refresh token is sent with: its id, and its secret when it has one.
 * A problem's `code` says what kind: `vault` (the keys do not open), `gone` (the registration is gone, or the entry's
 * client is not the one the sign-in was made with: the tokens are of no use) or `secret_missing` (the entry's secret
 * resolves to nothing for now).
 */
export const clientInformation = (
  deps: Pick<FlowDeps, "store" | "signIns" | "sources">,
  vault: KeptVault,
  environment: string,
  context: Pick<PendingContext, "client" | "server">,
): Effect.Effect<{ readonly client_id: string; readonly client_secret?: string }, FlowProblem> =>
  Effect.gen(function* () {
    const { client } = context;

    if (client.kind === "document") return { client_id: client.id };

    if (client.kind === "registered") {
      const kept =
        client.registration === null ? null : deps.signIns.getRegistration(client.registration);

      if (kept === null || client.registration === null) {
        return yield* FlowProblem.make({
          message: "The client registration is gone: start again",
          code: "gone",
        });
      }

      if (kept.sealedSecret === null) return { client_id: kept.clientId };

      const secret = yield* openValue(
        vault,
        REGISTRATIONS_TABLE,
        client.registration,
        kept.sealedSecret,
      ).pipe(Effect.mapError(vaultFailure));

      return { client_id: kept.clientId, client_secret: secret };
    }

    // A configured client: the entry as it is now, so a rotated secret is the one used, and a changed entry is no sign-in.
    const entry = yield* findEntry(deps.store, environment, context.server);

    if (entry.oauth?.clientId !== client.id) {
      return yield* FlowProblem.make({
        message: "The entry's client changed while you signed in: start again",
        code: "gone",
      });
    }

    const sources = yield* deps
      .sources(environment, entry.resolved.resolvesSecrets)
      .pipe(Effect.mapError(vaultFailure));

    const secret = resolveOauthSecret(entry.resolved, sources);

    if (secret.status === "missing") {
      return yield* FlowProblem.make({
        message: `The client secret \${${secret.name}} is no longer set`,
        code: "secret_missing",
      });
    }

    return secret.status === "ok"
      ? { client_id: client.id, client_secret: secret.value }
      : { client_id: client.id };
  });
