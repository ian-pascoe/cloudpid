// Throwaway probe for #403 (Verify MCP sign-in on a deployed stage). Not part of cloudpid; never merged.
//
// `bun alchemy deploy --config probe-403/stack.ts --stage probe` from `infra/`, with CLOUDFLARE_API_TOKEN set to a token
// scoped exactly like `cloudpid-ci-deploy` (infra/github.ts), so a successful deploy shows whether the CI deploy token
// covers the bypass application. State is local. Destroy with `alchemy destroy` and the same flags.
//
// - ProbeProd: a custom domain on `ianpascoe.dev` behind Worker-level Access, as `prod` is (`deployment(stage)`), plus
//   the ADR-0035 bypass application on its two exact paths.
// - ProbePreview: `workers.dev` behind Worker-level Access, as `dev_$USER` and `pr-<n>` are; DCR only, callback behind
//   Access.

import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const OWNER_EMAIL = "ian.g.pascoe@gmail.com";
const PROBE_DOMAIN = "mcp-oauth-probe.ianpascoe.dev";

export default Alchemy.Stack(
  "cloudpid-mcp-oauth-probe",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const serviceTokenId = yield* Config.String("PROBE_SERVICE_TOKEN_ID");

    // The owner-email policy of `deployment(stage)`, plus a service token for scripted checks.
    const access = {
      policies: [
        { decision: "allow" as const, include: [{ email: OWNER_EMAIL }] },
        { decision: "non_identity" as const, include: [{ serviceToken: serviceTokenId }] },
      ],
    };

    const prod = yield* Cloudflare.Worker("ProbeProd", {
      main: new URL("./probe.ts", import.meta.url).href,
      compatibility: { date: "2026-08-31" },
      domain: PROBE_DOMAIN,
      workersDev: false,
      access,
      observability: { enabled: true },
      env: {
        ROLE: "prod",
        HOST: `https://${PROBE_DOMAIN}`,
        STORE: Cloudflare.DurableObject("Store"),
      },
    });

    // ADR-0035: two exact public destinations, one Bypass/Everyone policy.
    const bypass = yield* Cloudflare.Access.Application("McpOAuthPublic", {
      type: "self_hosted",
      name: "cloudpid probe-403 MCP OAuth (public)",
      destinations: [
        { type: "public", uri: `${PROBE_DOMAIN}/oauth/mcp/client.json` },
        { type: "public", uri: `${PROBE_DOMAIN}/oauth/mcp/callback` },
      ],
      policies: [{ decision: "bypass", include: ["everyone"] }],
    });

    const preview = yield* Cloudflare.Worker("ProbePreview", {
      main: new URL("./probe.ts", import.meta.url).href,
      compatibility: { date: "2026-08-31" },
      workersDev: true,
      access,
      observability: { enabled: true },
      env: { ROLE: "preview", HOST: "", STORE: Cloudflare.DurableObject("Store") },
    });

    return { prod: prod.url, preview: preview.url, bypassApp: bypass.applicationId };
  }),
);
