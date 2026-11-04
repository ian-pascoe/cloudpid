// @effect-diagnostics preferEffectArray:off processEnv:off -- native array methods over plain values (the bundle carries no Effect runtime); reads the owner's environment.
/**
 * Where the endpoint is and how `/cloudpid` gets in (docs/architecture/mcp-endpoint.md → The `/cloudpid` command →
 * Configuration): `CLOUDPID_URL` and the Local agent's service token, from the environment pi runs in. Never `mcp.json`.
 */
import { Refusal } from "./errors.ts";

/** The environment a command reads. */
export type Env = typeof process.env;

export interface Config {
  /** The MCP endpoint, `https://<host>/mcp`. */
  readonly url: URL;
  /** `CF-Access-Client-Id`. */
  readonly clientId: string;
  /** `CF-Access-Client-Secret`. */
  readonly clientSecret: string;
}

export const SETUP_STEPS = [
  "Set these in the environment pi runs in (fill the token from Keychain or 1Password, not a dotfile):",
  "  CLOUDPID_URL=https://<your cloudpid host>/mcp",
  "  CLOUDPID_ACCESS_CLIENT_ID=<the Local agent's client ID>",
  "  CLOUDPID_ACCESS_CLIENT_SECRET=<its secret>",
  "From a cloudpid checkout, `bun --cwd infra run local-agent-token --stage <stage>` prints the last two. The extension's README has the rest.",
].join("\n");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The endpoint's URL: https (http only on loopback, for `alchemy dev`), and `/mcp` when the URL names a host alone. */
const endpointUrl = (raw: string): URL => {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Refusal(`CLOUDPID_URL is not a URL: ${raw}\n${SETUP_STEPS}`);
  }

  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Refusal(`CLOUDPID_URL must be an https URL (${raw}).\n${SETUP_STEPS}`);
  }

  if (url.pathname === "/" || url.pathname === "") url.pathname = "/mcp";

  return url;
};

/** The settings, or a {@link Refusal} that says which are missing and how to set them. */
export const readConfig = (env: Env): Config => {
  const url = env["CLOUDPID_URL"]?.trim() ?? "";
  const clientId = env["CLOUDPID_ACCESS_CLIENT_ID"]?.trim() ?? "";
  const clientSecret = env["CLOUDPID_ACCESS_CLIENT_SECRET"]?.trim() ?? "";

  const missing = [
    ["CLOUDPID_URL", url],
    ["CLOUDPID_ACCESS_CLIENT_ID", clientId],
    ["CLOUDPID_ACCESS_CLIENT_SECRET", clientSecret],
  ].flatMap(([name = "", value = ""]) => (value === "" ? [name] : []));

  if (missing.length > 0) {
    throw new Refusal(`/cloudpid is not set up: ${missing.join(", ")} not set.\n${SETUP_STEPS}`);
  }

  return { url: endpointUrl(url), clientId, clientSecret };
};

/**
 * The commit `dist/index.js` was built from (`build.ts` defines it), for `X-Cloudpid-Client`; `dev` when pi runs the
 * source (`pi -e packages/pi-cloudpid/src/index.ts`).
 */
export const BUILD_SHA: string = process.env.PI_CLOUDPID_SHA ?? "dev";

/** The `X-Cloudpid-Client` value: the endpoint shows it as the Session's client, trimmed to 40 characters. */
export const clientName = (sha: string = BUILD_SHA): string => `pi-cloudpid/${sha.slice(0, 12)}`;
