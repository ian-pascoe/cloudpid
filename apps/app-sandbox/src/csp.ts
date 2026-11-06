// docs/architecture/mcp-apps.md → The App sandbox (CSP). The Content-Security-Policy header of the proxy page, built from
// the server's `_meta.ui.csp`, which the page puts in the proxy's URL as `?csp=<JSON>`. The builder is `@cloudpid/protocol`'s
// (`buildCsp`, which the browser host shares for `visual_check`); what is cloudpid's own, which no list may name, is the
// stage's to say, here.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over small native arrays.
import { buildCsp as buildPolicy, type OwnHosts } from "@cloudpid/protocol/csp";
import { WORKERS_DEV_SUBDOMAIN, WORKER_NAME_PREFIX } from "@cloudpid/server/deployment";
import { APP_DOMAIN } from "@cloudpid/server/view-host";

/** cloudpid's own registrable domains, and every host under them: the app, the model proxy, other Views. */
const OWN_DOMAINS = ["ianpascoe.dev", APP_DOMAIN] as const;

/** The account's `workers.dev` host, where every non-prod stage's main Worker is `cloudpid-server-<label>`. */
const WORKERS_DEV = `${WORKERS_DEV_SUBDOMAIN}.workers.dev`;

/** Whether `host` is `domain` or a subdomain of it. */
const isUnder = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

/**
 * Whether `host`, a plain host name, is one of cloudpid's own: under `ianpascoe.dev` (prod's app origin) or
 * `ianpascoe.app` (the zone of every View), or a `workers.dev` host of the account that names a stage's main Worker
 * (`cloudpid-server-<label>`, also behind a version prefix), which is every stage's app origin. A View that could reach one
 * with the owner's Access cookie would act as the owner.
 */
const isOwnHost = (host: string): boolean =>
  OWN_DOMAINS.some((domain) => isUnder(host, domain)) ||
  (isUnder(host, WORKERS_DEV) && host.slice(0, -WORKERS_DEV.length).includes(WORKER_NAME_PREFIX));

/**
 * Whether the wildcard `*.<base>` could match a host of cloudpid's: `base` is one of them, or an ancestor domain of
 * one (`*.dev`, `*.app`, `*.workers.dev`). A wildcard is refused whole; it is never narrowed.
 */
const wildcardCoversOwnHost = (base: string): boolean =>
  isOwnHost(base) || [...OWN_DOMAINS, WORKERS_DEV].some((domain) => isUnder(domain, base));

const OWN: OwnHosts = { isOwnHost, wildcardCoversOwnHost };

/**
 * The CSP of a proxy page, never looser than what `csp` (the raw `?csp=` value, a JSON `_meta.ui.csp`) declares; see
 * `buildCsp` in `@cloudpid/protocol/csp` for what each list becomes. A domain naming cloudpid's own hosts (`ianpascoe.dev`,
 * `ianpascoe.app`, a stage's `workers.dev` Worker) is dropped from every list, and `frame-ancestors` is exactly
 * `frameAncestor`, the stage's app origin. The inner View frame inherits it through `document.write`.
 */
export const buildCsp = (csp: string | null, frameAncestor: string): string =>
  buildPolicy(csp, frameAncestor, OWN);
