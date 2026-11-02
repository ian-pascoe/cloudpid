// Throwaway probe for #399 (Verify the App sandbox on a deployed stage). Not part of cloudpid; never merged.
//
// `bun alchemy deploy --config probe-399/stack.ts --stage probe` from `infra/`, with CLOUDFLARE_API_TOKEN set to a token
// scoped like `cloudpid-ci-deploy` plus the `ianpascoe.app` zone, so a successful deploy shows which zone permissions
// the CI deploy token needs. State is local (no Secrets Store). Destroy with `alchemy destroy` and the same flags.

import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const SANDBOX_ZONE = "ianpascoe.app";
const OWNER_EMAIL = "ian.g.pascoe@gmail.com";
const HASH_A = "5zdfpsreiskluv5bvtlks2urnj";
const HASH_B = "cdlvzzb44rouynrktjiriz5ahs";

// 35 characters, the longest stage label ADR-0031 allows: `<26>--<35>` is a 63-character DNS label.
const LONG_STAGE = "dev-ian-pascoe-very-long-stage-name";

// The server's `ui.csp` as the host passes it: a declared connect and resource domain, plus cloudpid's own hosts,
// which the sandbox must strip.
const CSP = encodeURIComponent(
  JSON.stringify({
    connectDomains: [
      "https://www.cloudflare.com",
      "https://pi.ianpascoe.dev",
      "https://x.ianpascoe.app",
    ],
    resourceDomains: ["https://www.cloudflare.com"],
  }),
);

const sandboxUrl = (hash: string, stage?: string) =>
  `https://${hash}${stage ? `--${stage}` : ""}.${SANDBOX_ZONE}/?csp=${CSP}`;

export default Alchemy.Stack(
  "cloudpid-sandbox-probe",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const serviceTokenId = yield* Config.String("PROBE_SERVICE_TOKEN_ID");

    // The same owner-email policy as `deployment(stage)`, plus a service token for automated browsers.
    const access = {
      policies: [
        { decision: "allow" as const, include: [{ email: OWNER_EMAIL }] },
        { decision: "non_identity" as const, include: [{ serviceToken: serviceTokenId }] },
      ],
    };

    const hostStage = yield* Cloudflare.Worker("ProbeHostStage", {
      main: new URL("./host.ts", import.meta.url).href,
      compatibility: { date: "2026-08-31" },
      workersDev: true,
      access,
      observability: { enabled: true },
      env: {
        ROLE: "stage",
        FRAMES: JSON.stringify([
          { name: "stage origin", url: sandboxUrl(HASH_A, "probe"), expect: "load" },
          { name: "63-char label", url: sandboxUrl(HASH_B, LONG_STAGE), expect: "load" },
          { name: "prod origin", url: sandboxUrl(HASH_A), expect: "blocked" },
          { name: "another stage's origin", url: sandboxUrl(HASH_A, "other"), expect: "blocked" },
        ]),
      },
    });

    const hostProd = yield* Cloudflare.Worker("ProbeHostProd", {
      main: new URL("./host.ts", import.meta.url).href,
      compatibility: { date: "2026-08-31" },
      domain: "sandbox-probe.ianpascoe.dev",
      workersDev: false,
      access,
      observability: { enabled: true },
      env: {
        ROLE: "prod",
        FRAMES: JSON.stringify([
          { name: "prod origin", url: sandboxUrl(HASH_A), expect: "load" },
          { name: "a stage's origin", url: sandboxUrl(HASH_A, "probe"), expect: "blocked" },
        ]),
      },
    });

    yield* Cloudflare.DNS.Record("SandboxWildcard", {
      zoneId: yield* Config.String("PROBE_SANDBOX_ZONE_ID"),
      name: `*.${SANDBOX_ZONE}`,
      type: "AAAA",
      content: "100::",
      proxied: true,
      comment: "App sandbox (ADR-0031): Worker route only, no origin. #399 probe.",
    });

    const sandbox = yield* Cloudflare.Worker("ProbeSandbox", {
      main: new URL("./sandbox.ts", import.meta.url).href,
      compatibility: { date: "2026-08-31" },
      workersDev: false,
      routes: [{ pattern: `*.${SANDBOX_ZONE}/*`, zoneName: SANDBOX_ZONE }],
      observability: { enabled: true },
      env: {
        SANDBOX_ZONE,
        // Stage label ("" for prod) → its app origin; `other` stands for a stage whose app is elsewhere.
        STAGES: Output.interpolate`{"other":"https://example.com","":"${hostProd.url}","probe":"${hostStage.url}","${LONG_STAGE}":"${hostStage.url}"}`,
      },
    });

    return { hostStage: hostStage.url, hostProd: hostProd.url, sandbox: sandbox.url };
  }),
);
