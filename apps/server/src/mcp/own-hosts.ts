// The hosts that are cloudpid's own (`docs/architecture/mcp-server-requests.md` → Elicitation requests → URL mode): a page
// an MCP server asks the owner to open is never on one, so a server cannot send the owner to a route such as
// `/oauth/mcp/start`. Pure, and importing only the deploy constants.
import { PRODUCTION_DOMAIN, WORKER_NAME_PREFIX, WORKERS_DEV_SUBDOMAIN } from "../deployment.ts";
import { APP_DOMAIN } from "../view-host.ts";

/**
 * Whether `host` (lowercase, ASCII, no port) is one of cloudpid's own: the production domain, any stage's app host
 * (`cloudpid-server-<label>.<subdomain>.workers.dev`) and the App sandbox's zone and every host under it. Another Worker
 * on the same `workers.dev` subdomain is not.
 */
export const isOwnHost = (host: string): boolean =>
  host === PRODUCTION_DOMAIN ||
  host === APP_DOMAIN ||
  host.endsWith(`.${APP_DOMAIN}`) ||
  (host.startsWith(WORKER_NAME_PREFIX) &&
    host.endsWith(`.${WORKERS_DEV_SUBDOMAIN}.workers.dev`) &&
    !host
      .slice(WORKER_NAME_PREFIX.length, -`.${WORKERS_DEV_SUBDOMAIN}.workers.dev`.length)
      .includes("."));
