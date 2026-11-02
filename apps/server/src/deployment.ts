// docs/architecture/mcp-apps.md → The App sandbox (Stage labels and app origins). This file has no imports: the main
// Worker's stack and the App sandbox Worker both read it.

/** The one person allowed through Access: the owner of this single-user deployment. */
export const OWNER_EMAIL = "ian.g.pascoe@gmail.com";

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
const WORKER_NAME_PREFIX = "cloudpid-server-";

/** The longest label: with {@link WORKER_NAME_PREFIX} the name fits a DNS label (63 characters) with room to spare. */
const MAX_LABEL_LENGTH = 35;

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
 * The origin the stage's main Worker is served on, which the App sandbox derives from a View's hostname: `prod`'s
 * custom domain, or `https://cloudpid-server-<label>.<{@link WORKERS_DEV_SUBDOMAIN}>.workers.dev`.
 */
export const appOrigin = (stage: string): string =>
  stage === "prod"
    ? `https://${PRODUCTION_DOMAIN}`
    : `https://${WORKER_NAME_PREFIX}${stageLabel(stage)}.${WORKERS_DEV_SUBDOMAIN}.workers.dev`;

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
 * Access application covers all of its URLs, so every stage admits only {@link OWNER_EMAIL}. `label` is the
 * {@link stageLabel} of a non-prod stage, which the Worker reads as the {@link STAGE_LABEL_VAR} var to build its
 * `<hash>--<label>` View URLs; `prod` has none (`undefined`, so no var is set and a View's host has no suffix). Throws
 * for a stage whose label is refused, `prod` aside.
 */
export const deployment = (stage: string) => {
  const label = stageLabel(stage);

  const access = {
    policies: [{ decision: "allow" as const, include: [{ email: OWNER_EMAIL }] }],
  };

  return stage === "prod"
    ? { label: undefined, domain: PRODUCTION_DOMAIN, workersDev: false, access }
    : { label, name: `${WORKER_NAME_PREFIX}${label}`, workersDev: true, access };
};
