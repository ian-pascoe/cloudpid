/**
 * CI credentials as code: the GitHub Actions environments `production` (deployments from `main` only) and `preview`
 * (pull request previews, any branch), a scoped Cloudflare API token for each, and the secrets and variables that hand
 * them to .github/workflows/ci.yml, and for each environment a read-only analytics token its deploys bind to the
 * Workspaces Worker (CLOUDPID_ANALYTICS_TOKEN), which reads the Containers' usage for the Session header's cost.
 * Deployed once from a workstation with a profile that may create API tokens, and again to rotate the token or change
 * its permissions:
 *
 *   bun --cwd infra run ci:setup   # alchemy deploy --config github.ts --profile admin --stage ci
 *
 * Optional settings, read from the environment (never committed):
 *
 *   MODEL_PROXY_URL    the model proxy's URL (default: https://api.ai.ianpascoe.dev)
 *   GITHUB_REPOSITORY  owner/name (default: ian-pascoe/cloudpid)
 *
 * Not managed here: the app secrets each environment's deploys bind to the Workers, set by hand on both `production` and
 * `preview` (`gh secret set <NAME> --env <environment>`; docs/development/infra.md → CI credentials): MODEL_PROXY_API_KEY (a Commissary API key
 * minted in Commissary's panel), SECRETS_ENCRYPTION_KEY (`openssl rand -base64 32`), the VAPID triple and the search
 * keys. Give `preview` its own SECRETS_ENCRYPTION_KEY and VAPID pair rather than production's. The GitHub App's
 * CLOUDPID_GITHUB_APP_ID and CLOUDPID_GITHUB_APP_PRIVATE_KEY are written into both by `github-app:setup`
 * (github-app-setup.ts).
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
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

    // Retained on destroy: deleting a GitHub environment also deletes the secrets set on it by hand
    // (MODEL_PROXY_API_KEY, SECRETS_ENCRYPTION_KEY), so rotating the deploy token must not take it down.
    const production = yield* GitHub.Environment("Production", {
      ...repo,
      name: "production",
      deploymentBranchPolicy: { customBranchPolicies: ["main"] },
    }).pipe(Alchemy.RemovalPolicy.retain());

    // Pull request previews (stage `pr-<number>`). Any branch may deploy here, so it holds its own token and its own copy
    // of the app secrets, never production's ones. The token still writes every Worker on the account (Cloudflare has no
    // narrower Workers scope), so whoever can push a branch can reach `prod`'s Workers. Retained on destroy for the same
    // reason as `production`.
    const preview = yield* GitHub.Environment("Preview", {
      ...repo,
      name: "preview",
    }).pipe(Alchemy.RemovalPolicy.retain());

    // Everything `alchemy deploy` of alchemy.run.ts touches. Alchemy's state store needs Secrets Store Write (it
    // binds its token secret to a short-lived preview Worker on every run). Access Apps and Policies covers the
    // Worker's Access application; Zone Read, DNS Write and Workers Routes Write cover the custom domain of `prod`.
    // Workers Containers Write covers the Workspace DO's Container application and the push of its image to
    // Cloudflare's registry.
    const accountPolicy: Cloudflare.ApiToken.Policy = {
      effect: "allow",
      permissionGroups: [
        "Workers Scripts Write",
        "Workers Containers Write",
        "Secrets Store Write",
        "Account Settings Read",
        ACCESS_APPS_AND_POLICIES_WRITE,
      ],
      resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
    };

    const deployToken = yield* Cloudflare.ApiToken.AccountApiToken("DeployToken", {
      name: "cloudpid-ci-deploy",
      accountId,
      policies: [
        accountPolicy,
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

    // Previews are served on `workers.dev` only (apps/server/src/deployment.ts), so their token has no zone permissions.
    const previewToken = yield* Cloudflare.ApiToken.AccountApiToken("PreviewDeployToken", {
      name: "cloudpid-ci-preview",
      accountId,
      policies: [accountPolicy],
    });

    yield* GitHub.Secret("PreviewCloudflareApiToken", {
      ...repo,
      environment: preview,
      name: "CLOUDFLARE_API_TOKEN",
      value: previewToken.value,
    });

    yield* GitHub.Variable("PreviewCloudflareAccountId", {
      ...repo,
      environment: preview,
      name: "CLOUDFLARE_ACCOUNT_ID",
      value: accountId,
    });

    yield* GitHub.Variable("PreviewModelProxyUrl", {
      ...repo,
      environment: preview,
      name: "MODEL_PROXY_URL",
      value: modelProxyUrl,
    });

    // The Workspace DO reads its Containers' usage from Cloudflare's GraphQL Analytics API with these
    // (apps/server/src/workspace/container-analytics.ts); the deploy binds the environment's as a Worker secret. Read-only,
    // but account-wide: Cloudflare has no narrower analytics scope. One per environment, so either can be revoked alone.
    const analyticsPolicy: Cloudflare.ApiToken.Policy = {
      effect: "allow",
      permissionGroups: ["Account Analytics Read"],
      resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
    };

    const analyticsToken = yield* Cloudflare.ApiToken.AccountApiToken("AnalyticsToken", {
      name: "cloudpid-container-analytics",
      accountId,
      policies: [analyticsPolicy],
    });

    yield* GitHub.Secret("CloudpidAnalyticsToken", {
      ...repo,
      environment: production,
      name: "CLOUDPID_ANALYTICS_TOKEN",
      value: analyticsToken.value,
    });

    const previewAnalyticsToken = yield* Cloudflare.ApiToken.AccountApiToken(
      "PreviewAnalyticsToken",
      {
        name: "cloudpid-container-analytics-preview",
        accountId,
        policies: [analyticsPolicy],
      },
    );

    yield* GitHub.Secret("PreviewCloudpidAnalyticsToken", {
      ...repo,
      environment: preview,
      name: "CLOUDPID_ANALYTICS_TOKEN",
      value: previewAnalyticsToken.value,
    });

    return { environments: ["production", "preview"], zoneId: ZONE_ID };
  }),
);
