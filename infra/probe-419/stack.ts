// Throwaway probe for #419 (Verify the MCP endpoint behind Access managed OAuth on a deployed stage). Not part of
// cloudpid; never merged.
//
// `bun alchemy deploy --config probe-419/stack.ts --stage probe` from `infra/`, with CLOUDFLARE_API_TOKEN set to a token
// scoped exactly like `cloudpid-ci-deploy` (infra/github.ts), so a successful deploy shows whether the CI deploy token
// covers managed OAuth and the service token. State is local. Destroy with `alchemy destroy` and the same flags.
// `probe-419/node_modules` holds symlinks to `agents`, `@modelcontextprotocol/*` and `zod` from the Bun store
// (gitignored).
//
// Two shapes, each on a custom domain of `ianpascoe.dev` (as `prod`) and on `workers.dev` (as `dev_$USER`, `pr-<n>`):
//
// - Shape A, "worker-dest": one shared Access application, managed OAuth on, enrolled by the Worker as its `worker`
//   destination (the `access` prop), with the owner-email Allow and the service token's Service Auth policy. Answers
//   "does managed OAuth work on a Worker-destination application".
// - Shape B, "path-app": the Worker keeps today's dedicated owner-email application (`deployment(stage)`), and a second
//   application covers only `<host>/mcp` (public destinations), with managed OAuth on, the owner-email Allow and the
//   service token's Service Auth policy (#393 D18). Answers "can `/mcp` have an application of its own".

import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const OWNER_EMAIL = "ian.g.pascoe@gmail.com";
const DOMAIN_A = "mcp-probe-a.ianpascoe.dev";
const DOMAIN_B = "mcp-probe-b.ianpascoe.dev";
const NAME_A = "cloudpid-probe-419-a";
const NAME_B = "cloudpid-probe-419-b";
const WORKERS_DEV = "ian-g-pascoe.workers.dev";

const oauthConfiguration = {
  enabled: true,
  grant: { accessTokenLifetime: "5m", sessionDuration: "336h" },
  dynamicClientRegistration: { enabled: true, allowAnyOnLocalhost: true, allowAnyOnLoopback: true },
};

export default Alchemy.Stack(
  "cloudpid-mcp-endpoint-probe",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    // #393 D18: `cloudpid-local-agent`, a year long, authorized by its own id (never `anyValidServiceToken`). Made by
    // hand with the admin key: `cloudpid-ci-deploy`'s permissions can't create a service token (`Access.ServiceToken`
    // fails `auth.forbidden`; it needs "Access: Service Tokens Write").
    const token = {
      serviceTokenId: yield* Config.String("PROBE_SERVICE_TOKEN_ID"),
      clientId: yield* Config.String("PROBE_SERVICE_TOKEN_CLIENT_ID"),
    };

    const policies = [
      { decision: "allow" as const, include: [{ email: OWNER_EMAIL }] },
      { decision: "non_identity" as const, include: [{ serviceToken: token.serviceTokenId }] },
    ];

    // Shape A: a shared application with managed OAuth, enrolled as the Worker's destination.
    const appA = yield* Cloudflare.Access.Application("McpWorkerDest", {
      type: "self_hosted",
      name: "cloudpid probe-419 A (worker destination, managed OAuth)",
      policies,
      oauthConfiguration,
    });

    const workerA = yield* Cloudflare.Worker("ProbeA", {
      name: NAME_A,
      main: new URL("./probe.ts", import.meta.url).href,
      compatibility: { date: "2026-08-31", flags: ["nodejs_compat"] },
      domain: DOMAIN_A,
      workersDev: true,
      access: appA,
      observability: { enabled: true },
      env: {
        ROLE: "A worker-dest",
        SERVICE_TOKEN_CLIENT_ID: token.clientId,
        STORE: Cloudflare.DurableObject("Store"),
      },
    });

    // Shape B: today's dedicated owner-email application on the Worker...
    const workerB = yield* Cloudflare.Worker("ProbeB", {
      name: NAME_B,
      main: new URL("./probe.ts", import.meta.url).href,
      compatibility: { date: "2026-08-31", flags: ["nodejs_compat"] },
      domain: DOMAIN_B,
      workersDev: true,
      access: { policies: [{ decision: "allow" as const, include: [{ email: OWNER_EMAIL }] }] },
      observability: { enabled: true },
      env: {
        ROLE: "B path-app",
        SERVICE_TOKEN_CLIENT_ID: token.clientId,
        STORE: Cloudflare.DurableObject("Store"),
      },
    });

    // ...and an application of its own for `/mcp`.
    const appB = yield* Cloudflare.Access.Application("McpPath", {
      type: "self_hosted",
      name: "cloudpid probe-419 B (/mcp path, managed OAuth)",
      destinations: [
        { type: "public", uri: `${DOMAIN_B}/mcp` },
        { type: "public", uri: `${NAME_B}.${WORKERS_DEV}/mcp` },
      ],
      policies,
      oauthConfiguration,
    });

    return {
      a: { domain: `https://${DOMAIN_A}`, workersDev: workerA.url, aud: appA.aud },
      b: { domain: `https://${DOMAIN_B}`, workersDev: workerB.url, mcpAud: appB.aud },
      serviceTokenClientId: token.clientId,
      serviceTokenId: token.serviceTokenId,
    };
  }),
);
