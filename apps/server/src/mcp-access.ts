// docs/architecture/mcp-endpoint.md → Access and identity, and → The Local agent's service token: what the stack
// declares for the MCP endpoint (`/mcp`) and gives the main Worker for it. It sits beside the Worker's own owner-only
// Access application (`deployment()`, which it leaves as it is): managed OAuth is never turned on for that one, since
// there an OAuth token minted for `/mcp`, or the service token, would open `/` and `/rpc` too (#419, "shape B").
// @effect-diagnostics missingPipeableSignature:off -- plain functions of the stack's props.

import * as Effect from "effect/Effect";
import { OWNER_EMAIL, appOrigin, stageLabel } from "./deployment.ts";

/** The path of the MCP endpoint, which its Access application covers with its sub-paths. */
const MCP_PATH = "/mcp";

/**
 * The Worker var that carries the audience (`aud`) of the MCP endpoint's Access application, which is not the main
 * application's: the assertion Access sends on `/mcp` names this one. An alchemy output, set on deployed stages only.
 */
export const MCP_AUDIENCE_VAR = "CLOUDPID_MCP_ACCESS_AUD";

/**
 * The Worker var that carries the Local agent's service token's client ID (ending `.access`): the `common_name` of the
 * assertion of a request that used the token. A client ID is public; the secret never reaches the Worker.
 */
export const MCP_SERVICE_TOKEN_CLIENT_ID_VAR = "MCP_SERVICE_TOKEN_CLIENT_ID";

/**
 * The logical id of the service token in the stack (under the `Server` namespace, as `Server/LocalAgentToken`): the
 * path of its record in alchemy's state, which `infra/local-agent-token.ts` reads it from.
 */
export const LOCAL_AGENT_TOKEN_ID = "LocalAgentToken";

/** The service token's validity: the provider's own default, a year. It is not renewed by the provider. */
const LOCAL_AGENT_TOKEN_DURATION = "8760h";

/**
 * What the stage's Local agent service token is called. Access service tokens live on the account, and alchemy finds
 * one again by its name, so two stages sharing a name would share (and one's destroy would delete) the other's token:
 * `prod` has `cloudpid-local-agent`, every other stage `cloudpid-local-agent-<label>`. Throws for a stage whose label is
 * refused (`stageLabel`), `prod` aside.
 */
export const localAgentTokenName = (stage: string): string =>
  stage === "prod" ? "cloudpid-local-agent" : `cloudpid-local-agent-${stageLabel(stage)}`;

/** The `Access.ServiceToken`'s props: `cloudpid-local-agent`, a year long. */
const localAgentTokenProps = (stage: string) =>
  ({ name: localAgentTokenName(stage), duration: LOCAL_AGENT_TOKEN_DURATION }) as const;

/**
 * Managed OAuth (docs/architecture/mcp-endpoint.md → Access and identity): Access is the authorization server. Access
 * tokens last 5 minutes and the grant 14 days (both clients refresh on their own), and dynamic client registration
 * accepts the loopback and localhost redirects pi and Claude Code use.
 */
export const MCP_OAUTH_CONFIGURATION = {
  enabled: true,
  grant: { accessTokenLifetime: "5m", sessionDuration: "336h" },
  dynamicClientRegistration: { enabled: true, allowAnyOnLocalhost: true, allowAnyOnLoopback: true },
} as const;

/**
 * The host the stage's main Worker is served on: `pi.ianpascoe.dev` on `prod`, `cloudpid-server-<label>.<account
 * subdomain>.workers.dev` elsewhere. The Worker's script name has to be known when the stack is evaluated, which
 * `appOrigin` (checked on every deploy) gives.
 */
export const appHost = (stage: string): string => new URL(appOrigin(stage)).host;

/**
 * The MCP endpoint's Access application, `self_hosted` with `public` destination `<host>/mcp` (which also covers its
 * sub-paths), managed OAuth, and two policies, in this order:
 *
 * - the owner-email Allow (a browser, or a client signed in through managed OAuth);
 * - Service Auth (`non_identity`) for the Local agent's service token **by id**, never `anyValidServiceToken`.
 *
 * `tokenId` is the token's `serviceTokenId` (an alchemy output at deploy time, so generic here).
 */
export const mcpApplicationProps = <TokenId>(stage: string, tokenId: TokenId) =>
  ({
    type: "self_hosted",
    destinations: [{ type: "public", uri: `${appHost(stage)}${MCP_PATH}` }],
    policies: [
      { decision: "allow", include: [{ email: OWNER_EMAIL }] },
      { decision: "non_identity", include: [{ serviceToken: tokenId }] },
    ],
    oauthConfiguration: MCP_OAUTH_CONFIGURATION,
  }) as const;

/**
 * The stack's part for the MCP endpoint: on a deployed stage, the Local agent's service token and the endpoint's
 * Access application (`options.declare`, which gets the props above), and the Worker's two vars from their outputs.
 * `alchemy dev` has no Access, so it declares nothing and sets no var (the guard's local rule admits the owner on
 * `/mcp`); where the bundle itself runs (`runtime`) nothing is declared either, as the bundle reads the vars from its
 * environment. Nothing is enrolled in the application: it names its host and path, not the Worker.
 */
export const mcpAccessProps = <
  Token extends { readonly serviceTokenId: unknown; readonly clientId: unknown },
  Application extends { readonly aud: unknown },
  Error,
  Services,
>(options: {
  readonly stage: string;
  readonly runtime: boolean;
  /** Whether the stack is planned by `alchemy dev` (`AlchemyContext.dev`), which the caller reads once. */
  readonly dev: boolean;
  readonly declare: {
    readonly serviceToken: (
      props: ReturnType<typeof localAgentTokenProps>,
    ) => Effect.Effect<Token, Error, Services>;
    readonly application: (
      props: ReturnType<typeof mcpApplicationProps<Token["serviceTokenId"]>>,
    ) => Effect.Effect<Application, Error, Services>;
  };
}) =>
  Effect.gen(function* () {
    if (options.runtime) return { vars: {} };

    if (options.dev) return { vars: {} };

    const token = yield* options.declare.serviceToken(localAgentTokenProps(options.stage));

    const application = yield* options.declare.application(
      mcpApplicationProps(options.stage, token.serviceTokenId),
    );

    return {
      vars: {
        [MCP_AUDIENCE_VAR]: application.aud,
        [MCP_SERVICE_TOKEN_CLIENT_ID_VAR]: token.clientId,
      },
    };
  });

/** The name `MCP_CALLS` is bound under: the rate limit of the MCP endpoint's calls (`mcp-endpoint.md` → Limits and errors). */
export const MCP_CALLS_BINDING = "MCP_CALLS";

/**
 * The period of `MCP_CALLS`, in seconds: what a caller over the rate is told to wait at most. Here, not in `mcp/api.ts`,
 * so that the Worker's props (`worker.ts`) import nothing of the endpoint's.
 */
export const MCP_CALLS_PERIOD_S = 60;

/** The calls per period of `MCP_CALLS`, per identity. */
export const MCP_CALLS_LIMIT = 120;

/**
 * The `MCP_CALLS` namespace id of `stage`: a positive integer the runtime counts a key in. Counters are per namespace and
 * Workers of one account may share one, so a preview stage must not count in `prod`'s: each stage's is a hash of its name
 * (FNV-1a), moved above the small numbers a hand-written namespace would use.
 */
export const mcpCallsNamespace = (stage: string): number => {
  let hash = 0x811c9dc5;

  for (const char of stage) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }

  return 1_000_000 + (hash % 2_000_000_000);
};
