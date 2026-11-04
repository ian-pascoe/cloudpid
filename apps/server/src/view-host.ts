// docs/architecture/mcp-apps.md → The App sandbox (Origins; The origin from the hostname alone). Pure, and importing
// only `deployment.ts`, so the main Worker (which builds a View's host) and the App sandbox Worker (which parses it)
// share it.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
import { MAX_LABEL_LENGTH, appOrigin, labelOrigin, stageLabel } from "./deployment.ts";

/** The registrable domain the App sandbox serves on, and nothing else: a View's origin is a subdomain of it. */
export const APP_DOMAIN = "ianpascoe.app";

/**
 * The id of the `ianpascoe.app` zone on the account, so the stack (the sandbox's route and record) and the CI token's
 * policy (`infra/github.ts`) look nothing up and name one zone. A zone id is not a secret.
 */
export const APP_ZONE_ID = "e4bbd85e38d5fc25694c911588c2ccc4";

/** The characters of a View's hash: lowercase RFC 4648 base32 (`a`–`z`, `2`–`7`), unpadded. */
const HASH_PATTERN = /^[a-z2-7]{26}$/;

/**
 * `<hash>.ianpascoe.app` (prod) or `<hash>--<label>.ianpascoe.app`. The label is what `stageLabel` can produce:
 * lowercase letters, digits and `-`, up to {@link MAX_LABEL_LENGTH} characters, not starting or ending with `-`. The
 * hash has a fixed length, so a label containing `--` is still unambiguous.
 */
const HOST_PATTERN = new RegExp(
  `^([a-z2-7]{26})(?:--([a-z0-9](?:[a-z0-9-]{0,${MAX_LABEL_LENGTH - 2}}[a-z0-9])?))?\\.${APP_DOMAIN.replaceAll(".", "\\.")}$`,
);

/**
 * The hostname an App View is served on: `<hash>.ianpascoe.app` on `prod`, `<hash>--<label>.ianpascoe.app` on any other
 * stage. `hash` is a View's 26-character base32 hash (the longest host label is 26 + 2 + 35 = 63 characters). Throws for
 * a `hash` that isn't one, and, as `stageLabel` does, for a non-prod stage whose label is refused.
 */
export const viewHost = (hash: string, stage: string): string => {
  if (!HASH_PATTERN.test(hash)) {
    throw new Error(
      `A View's hash is 26 lowercase base32 characters (a-z, 2-7), not ${JSON.stringify(hash)}.`,
    );
  }

  return stage === "prod" ? `${hash}.${APP_DOMAIN}` : `${hash}--${stageLabel(stage)}.${APP_DOMAIN}`;
};

/**
 * The app origin a View's hostname names: `appOrigin(stage)` of the stage that `viewHost` made it for, or `undefined`
 * when it doesn't parse (the sandbox answers 404). The origin comes from the hostname alone, never from the URL or a
 * header. A host without a label is prod's; a label is a non-prod stage's, `prod` included (`PROD` is not `prod`).
 */
export const appOriginOf = (host: string): string | undefined => {
  const match = HOST_PATTERN.exec(host.toLowerCase());

  if (match === null) return undefined;

  const label = match[2];

  return label === undefined ? appOrigin("prod") : labelOrigin(label);
};

/** The port the App sandbox is served on under `alchemy dev`: a second local port, beside the main Worker's 1337. */
export const LOCAL_SANDBOX_PORT = 1338;

/** The one origin every App View has under `alchemy dev`: no hash, no label, a shared origin. */
export const LOCAL_SANDBOX_ORIGIN = `http://localhost:${LOCAL_SANDBOX_PORT}`;

/**
 * The app origins under `alchemy dev`: the main Worker's (workerd) and Vite's, the two a page is served from there. The
 * local sandbox frames only these, as the deployed one frames only the origin its hostname names.
 */
export const LOCAL_APP_ORIGINS: ReadonlyArray<string> = [
  "http://localhost:1337",
  "http://localhost:5173",
];

/** The sandbox Worker's var that puts it in local mode: set by the stack under `alchemy dev` only, never on a deployed stage. */
export const SANDBOX_LOCAL_VAR = "CLOUDPID_APP_SANDBOX_LOCAL";

/**
 * The app origin the local sandbox frames for `requested`, the origin of the page that asks (`?host=`): that one when it
 * is one of {@link LOCAL_APP_ORIGINS}, else none. A local sandbox is not asked to trust any other origin.
 */
export const localAppOriginOf = (requested: string | null): string | undefined =>
  requested !== null && LOCAL_APP_ORIGINS.includes(requested) ? requested : undefined;

/**
 * The origin an App View of `hash` is served on (docs/architecture/mcp-apps.md → The App sandbox): `https://<viewHost>`,
 * from the deploy-time `label` of a non-prod stage (undefined on `prod`), never from a request's `Host`. Under
 * `alchemy dev` (`local`) every View shares {@link LOCAL_SANDBOX_ORIGIN}. Throws for a hash or a label that does not make a
 * host the sandbox parses (`stageLabel`'s output is one). A label of `prod` is a non-prod stage's, as `appOriginOf` reads it.
 */
export const viewOrigin = (input: {
  readonly hash: string;
  readonly label: string | undefined;
  readonly local: boolean;
}): string => {
  if (input.local) return LOCAL_SANDBOX_ORIGIN;

  const host =
    input.label === undefined
      ? `${input.hash}.${APP_DOMAIN}`
      : `${input.hash}--${input.label}.${APP_DOMAIN}`;

  if (!HASH_PATTERN.test(input.hash) || appOriginOf(host) === undefined) {
    throw new Error(
      `No App View host for hash ${JSON.stringify(input.hash)} and label ${JSON.stringify(input.label)}.`,
    );
  }

  return `https://${host}`;
};
