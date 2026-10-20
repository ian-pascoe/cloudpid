/**
 * CI credentials as code: the GitHub Actions environment `production` (deployments from `main` only), a scoped
 * Cloudflare API token for deploys, and the secrets and variables that hand them to .github/workflows/ci.yml.
 * Deployed once from a workstation with a profile that may create API tokens, and again to rotate the token or change
 * its permissions:
 *
 *   pnpm --filter @cloudpid/infra run ci:setup   # alchemy deploy --config github.ts --profile admin --stage ci
 *
 * Optional settings, read from the environment (never committed):
 *
 *   MODEL_PROXY_URL    the model proxy's URL (default: https://api.ai.ianpascoe.dev)
 *   GITHUB_REPOSITORY  owner/name (default: ian-pascoe/cloudpid)
 *
 * Not managed here: the `production` environment's secret MODEL_PROXY_API_KEY, a Commissary API key minted in
 * Commissary's panel and set by hand (`gh secret set MODEL_PROXY_API_KEY --env production`).
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Account-scoped "Access: Apps and Policies Write" (the catalog name is shared with a zone-scoped group). */
const ACCESS_APPS_AND_POLICIES_WRITE = { id: "1e13c5124ca64b72b1969a67e8829049" };

/** The `ianpascoe.dev` zone, which serves the `prod` stage's custom domain (apps/server/src/deployment.ts). */
const ZONE_ID = "c36c6e2b6bda856f9d4f6175059c6df4";

export default Alchemy.Stack(
  "cloudpid-github",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

    const [owner = "", repository = ""] = (yield* Config.String("GITHUB_REPOSITORY").pipe(
      Config.withDefault("ian-pascoe/cloudpid"),
    )).split("/");

    const repo = { owner, repository };

    const modelProxyUrl = yield* Config.String("MODEL_PROXY_URL").pipe(
      Config.withDefault("https://api.ai.ianpascoe.dev"),
    );

    const production = yield* GitHub.Environment("Production", {
      ...repo,
      name: "production",
      deploymentBranchPolicy: { customBranchPolicies: ["main"] },
    });

    // Everything `alchemy deploy` of alchemy.run.ts touches. Alchemy's state store needs Secrets Store Write (it
    // binds its token secret to a short-lived preview Worker on every run). Access Apps and Policies covers the
    // Worker's Access application; Zone Read, DNS Write and Workers Routes Write cover the custom domain of `prod`.
    const deployToken = yield* Cloudflare.ApiToken.AccountApiToken("DeployToken", {
      name: "cloudpid-ci-deploy",
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers Scripts Write",
            "Secrets Store Write",
            "Account Settings Read",
            ACCESS_APPS_AND_POLICIES_WRITE,
          ],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
        {
          effect: "allow",
          permissionGroups: ["Zone Read", "DNS Write", "Workers Routes Write"],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: {
              [`com.cloudflare.api.account.zone.${ZONE_ID}`]: "*",
            },
          },
        },
      ],
    });

    yield* GitHub.Secret("CloudflareApiToken", {
      ...repo,
      environment: production,
      name: "CLOUDFLARE_API_TOKEN",
      value: deployToken.value,
    });

    yield* GitHub.Variable("CloudflareAccountId", {
      ...repo,
      environment: production,
      name: "CLOUDFLARE_ACCOUNT_ID",
      value: accountId,
    });

    yield* GitHub.Variable("ModelProxyUrl", {
      ...repo,
      environment: production,
      name: "MODEL_PROXY_URL",
      value: modelProxyUrl,
    });

    return { environment: "production", zoneId: ZONE_ID };
  }),
);
