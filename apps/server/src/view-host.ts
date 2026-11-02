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
