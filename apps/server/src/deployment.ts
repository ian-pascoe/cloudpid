// docs/architecture/mcp-apps.md → The App sandbox (Stage labels and app origins). This file has no imports: the main
// Worker's stack and the App sandbox Worker both read it.
// @effect-diagnostics missingPipeableSignature:off -- `deployment` is a plain function of the stage and its options.

/** The one person allowed through Access: the owner of this single-user deployment. */
export const OWNER_EMAIL = "ian.g.pascoe@gmail.com";

/** The Access team (`<team>.cloudflareaccess.com`): the issuer of every assertion, and where its signing keys are. */
export const ACCESS_TEAM_DOMAIN = "spirit-led-software.cloudflareaccess.com";

/**
 * The Worker var that carries the audience (`aud`) of the Worker's own Access application: an alchemy output, set on
 * deployed stages only. A deployed Worker without it refuses every guarded route.
 */
export const ACCESS_AUDIENCE_VAR = "CLOUDPID_ACCESS_AUD";

/**
 * The Worker var that puts the Worker in local mode, where a loopback host counts as the owner. Only {@link guardVars}
 * sets it, and only for `alchemy dev` (no Access); neither {@link deployment} nor a deployed stage's vars carry it.
 */
export const LOCAL_MODE_VAR = "CLOUDPID_LOCAL_MODE";

/**
 * The Worker var of the client document's switch (docs/architecture/mcp-sign-in.md → The client document and the callback
 * outside Access): `"true"` where the stage serves the document and the sign-in ladder may use it, `"false"` where it does
 * not. Only {@link deployment} sets it. It removes the document from the ladder for new sign-ins only; the route keeps
 * serving.
 */
export const MCP_CLIENT_DOCUMENT_VAR = "MCP_CLIENT_DOCUMENT";

/**
 * The Worker var that carries the stage's {@link appOrigin}, where the client document, the DCR redirect URI and the
 * sign-in pages take the origin from (docs/architecture/mcp-sign-in.md → The client document and the callback outside
 * Access): set on live deployed stages only, never taken from a request's `Host`. `alchemy dev` has none: it has two
 * origins, taken from `Host` against a fixed set (`mcp/sign-in-origin.ts`).
 */
export const APP_ORIGIN_VAR = "CLOUDPID_APP_ORIGIN";

/** The custom domain of the `prod` stage, on the `ianpascoe.dev` zone of the same account. */
export const PRODUCTION_DOMAIN = "pi.ianpascoe.dev";

/**
 * The account's `workers.dev` subdomain (`<script>.<subdomain>.workers.dev`). Alchemy reads it from the API, which a
 * pure function cannot; if the account's is ever renamed, `checkedAppOrigin` fails every non-prod deploy until a pull
 * request changes this constant.
 */
export const WORKERS_DEV_SUBDOMAIN = "ian-g-pascoe";

/** The Worker var that carries a non-prod stage's {@link stageLabel}; unset on `prod`, whose Views have no label. */
export const STAGE_LABEL_VAR = "CLOUDPID_STAGE_LABEL";

/** What a non-prod stage's main Worker is called, before its label. */
export const WORKER_NAME_PREFIX = "cloudpid-server-";

/** The longest label: with {@link WORKER_NAME_PREFIX} the name fits a DNS label (63 characters) with room to spare. */
export const MAX_LABEL_LENGTH = 35;

/** Why `label`, the label of `stage`, is refused; undefined when it is fine. */
const labelRefusal = (stage: string, label: string): string | undefined => {
  if (label === "") return "is empty";

  // On the stage, not the label: lowercasing can turn a character outside the set into one inside it ("K", the Kelvin sign).
  if (!/^[A-Za-z0-9_-]*$/.test(stage)) return "has characters outside [A-Za-z0-9_-]";

  if (label.length > MAX_LABEL_LENGTH) return `is longer than ${MAX_LABEL_LENGTH} characters`;

  if (label.startsWith("-") || label.endsWith("-")) return "starts or ends with '-'";

  return undefined;
};

/**
 * The stage lowercased with `_` → `-`: the part of a non-prod Worker's name (`cloudpid-server-<label>`) and of its app
 * origin that is the stage's own. A stage whose label is empty, longer than {@link MAX_LABEL_LENGTH} characters, starts
 * or ends with `-`, or has characters outside `[A-Za-z0-9_-]` is refused, never truncated or rewritten: an explicit
 * Worker name isn't validated by alchemy, and truncating could give two stages one Worker.
 */
export const stageLabel = (stage: string): string => {
  const label = stage.toLowerCase().replaceAll("_", "-");
  const refusal = labelRefusal(stage, label);

  if (refusal !== undefined) {
    throw new Error(
      `Stage ${JSON.stringify(stage)} cannot be deployed: its label ${JSON.stringify(label)} ${refusal}. ` +
        "Every non-prod stage names its main Worker cloudpid-server-<label>; rename the stage.",
    );
  }

  return label;
};

/**
 * The app origin of the non-prod stage whose {@link stageLabel} is `label`, which the App sandbox gets from the label in
 * a View's hostname alone. `label` must already be a valid label (`stageLabel`'s output); the sandbox's hostname parser
 * guarantees it. A label that reads "prod" is a non-prod stage's, as `PROD` is (only the exact stage `prod` is prod).
 */
export const labelOrigin = (label: string): string =>
  `https://${WORKER_NAME_PREFIX}${label}.${WORKERS_DEV_SUBDOMAIN}.workers.dev`;

/**
 * The origin the stage's main Worker is served on, which the App sandbox derives from a View's hostname: `prod`'s
 * custom domain, or `https://cloudpid-server-<label>.<{@link WORKERS_DEV_SUBDOMAIN}>.workers.dev`.
 */
export const appOrigin = (stage: string): string =>
  stage === "prod" ? `https://${PRODUCTION_DOMAIN}` : labelOrigin(stageLabel(stage));

/**
 * The main Worker's resolved `url`, once it is `appOrigin(stage)`; throws otherwise, so a deploy whose Worker is
 * not where the App sandbox looks for it fails instead of leaving every View blocked.
 */
export const checkedAppOrigin = (served: {
  readonly stage: string;
  readonly url: string | undefined;
}): string => {
  const { stage, url } = served;
  const origin = appOrigin(stage);

  if (url !== origin) {
    throw new Error(
      `The main Worker of stage ${JSON.stringify(stage)} is served at ${JSON.stringify(url)}, not its app origin ${origin}. ` +
        "If the account's workers.dev subdomain was renamed, change WORKERS_DEV_SUBDOMAIN (apps/server/src/deployment.ts).",
    );
  }

  return origin;
};

/**
 * Where a stage's main Worker is named, served and who may reach it. `prod` answers on its custom domain and keeps its
 * alchemy name (in alchemy a rename replaces the script and wipes its Durable Objects); every other stage (`dev_$USER`,
 * previews) stays on `workers.dev` as `cloudpid-server-<label>`, so its origin is {@link appOrigin}. The Worker's
 * Access application covers all of its URLs, so every stage admits only {@link OWNER_EMAIL}; the Worker does not trust
 * that Access ran, and verifies the assertion itself (`access.ts`) against that application's audience, a var of the
 * Worker ({@link ACCESS_AUDIENCE_VAR}) that the stack sets from the application's output. `alchemy dev` has no Access:
 * only {@link guardVars} sets {@link LOCAL_MODE_VAR} there, and nothing this function returns carries it. `label` is the
 * {@link stageLabel} of a non-prod stage, which the Worker reads as the {@link STAGE_LABEL_VAR} var to build its
 * `<hash>--<label>` View URLs; `prod` has none (`undefined`, so no var is set and a View's host has no suffix). Throws
 * for a stage whose label is refused, `prod` aside.
 *
 * This is the Worker's own, owner-only application, and it stays that: the MCP endpoint has an application of its own
 * (`mcp-access.ts`), with `public` destination `<host>/mcp` on every deployed stage, managed OAuth, the owner's Allow and
 * Service Auth for the Local agent's service token. Its `aud` and the token's client ID are the Worker's vars
 * `CLOUDPID_MCP_ACCESS_AUD` and `MCP_SERVICE_TOKEN_CLIENT_ID`; `alchemy dev` declares neither. A third application, the
 * Bypass of ADR-0035 (`bypass-access.ts`), has two `public` destinations, `<host>/oauth/mcp/client.json` and
 * `<host>/oauth/mcp/callback`, and one Bypass/Everyone policy; it too is declared only while the Worker is live. The Worker
 * refuses every other form of those two paths itself (`sign-in-routes.ts`).
 *
 * `env` is the stage's own Worker vars. {@link APP_ORIGIN_VAR} is its {@link appOrigin} on every live deployed stage and
 * absent under `alchemy dev`. {@link MCP_CLIENT_DOCUMENT_VAR} is `"true"` on every live deployed stage (`prod`,
 * `dev_$USER`, `pr-<n>`) and `"false"` under `alchemy dev` (`options.dev`), where Access cannot front `localhost` and a
 * client document needs an https URL. It stays a switch rather than something derived from the origin: if an
 * authorization server refuses `workers.dev` clients, one line turns the document off for every non-prod stage. The
 * bypass is declared whatever it says, because the public callback serves DCR too.
 */
export const deployment = (stage: string, options: { readonly dev: boolean }) => {
  const label = stageLabel(stage);

  const access = {
    policies: [{ decision: "allow" as const, include: [{ email: OWNER_EMAIL }] }],
  };

  const env = options.dev
    ? { [MCP_CLIENT_DOCUMENT_VAR]: "false" as const }
    : { [MCP_CLIENT_DOCUMENT_VAR]: "true" as const, [APP_ORIGIN_VAR]: appOrigin(stage) };

  return stage === "prod"
    ? { label: undefined, domain: PRODUCTION_DOMAIN, workersDev: false, access, env }
    : { label, name: `${WORKER_NAME_PREFIX}${label}`, workersDev: true, access, env };
};

/**
 * The vars of the Access guard (docs/architecture/mcp-sign-in.md → The client document and the callback outside
 * Access, The Access guard). A deployed stage passes its application's `audience` (an alchemy output, so generic here);
 * `alchemy dev`, which has no Access and so no audience, passes none and gets {@link LOCAL_MODE_VAR} instead. Nothing
 * else sets the local-mode var, so a Worker is in local mode only when the stack was planned by `alchemy dev`.
 */
export const guardVars = <Audience>(
  audience: Audience | undefined,
): { readonly [ACCESS_AUDIENCE_VAR]: Audience } | { readonly [LOCAL_MODE_VAR]: "true" } =>
  audience === undefined ? { [LOCAL_MODE_VAR]: "true" } : { [ACCESS_AUDIENCE_VAR]: audience };
