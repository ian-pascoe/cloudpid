// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { ACCESS_TEAM_DOMAIN, OWNER_EMAIL, appOrigin } from "./deployment.ts";
import {
  ACCESS_ISSUER,
  MCP_AUDIENCE_VAR,
  mcpAccessProps,
  mcpApplicationProps,
  mcpCallsNamespace,
  mcpOauthConfiguration,
  appHost,
  selfUseRedirectUri,
} from "./mcp-access.ts";

const application = { aud: "the-mcp-aud" };

const run = (options: {
  readonly stage: string;
  readonly dev: boolean;
  readonly runtime?: boolean;
}) => {
  const declareApplication = vi.fn(() => Effect.succeed(application));

  return Effect.runPromise(
    mcpAccessProps({
      stage: options.stage,
      runtime: options.runtime ?? false,
      dev: options.dev,
      declare: { application: declareApplication },
    }),
  ).then((result) => ({ result, application: declareApplication }));
};

describe("the MCP endpoint's host", () => {
  it.each([
    ["prod", "pi.ianpascoe.dev"],
    ["pr-438", "cloudpid-server-pr-438.ian-g-pascoe.workers.dev"],
    ["dev_Ian", "cloudpid-server-dev-ian.ian-g-pascoe.workers.dev"],
  ])("on %s is %s, the host of the stage's app origin", (stage, host) => {
    expect(appHost(stage)).toBe(host);
    expect(appOrigin(stage)).toBe(`https://${host}`);
  });
});

describe("the MCP endpoint's Access application", () => {
  it.each([
    ["prod", "pi.ianpascoe.dev/mcp"],
    ["pr-438", "cloudpid-server-pr-438.ian-g-pascoe.workers.dev/mcp"],
    ["dev_ian", "cloudpid-server-dev-ian.ian-g-pascoe.workers.dev/mcp"],
  ])("on %s covers %s only, by a public destination", (stage, uri) => {
    expect(mcpApplicationProps(stage).destinations).toEqual([{ type: "public", uri }]);
  });

  it("is a self-hosted application and covers no Worker (the main application's destination)", () => {
    const props = mcpApplicationProps("prod");

    expect(props.type).toBe("self_hosted");
    expect(JSON.stringify(props)).not.toContain("worker");
  });

  it("allows the owner's email and nothing else: no Service Auth policy, never any valid service token", () => {
    expect(mcpApplicationProps("prod").policies).toEqual([
      { decision: "allow", include: [{ email: OWNER_EMAIL }] },
    ]);
    expect(JSON.stringify(mcpApplicationProps("prod"))).not.toMatch(/service/i);
  });

  it.each(["prod", "pr-438", "dev_ian"])(
    "turns managed OAuth on for %s: 5 minute access tokens, a 14 day grant, loopback, localhost, Self-use and executor.sh DCR",
    (stage) => {
      expect(mcpApplicationProps(stage).oauthConfiguration).toEqual(mcpOauthConfiguration(stage));
      expect(mcpOauthConfiguration(stage)).toEqual({
        enabled: true,
        grant: { accessTokenLifetime: "5m", sessionDuration: "336h" },
        dynamicClientRegistration: {
          enabled: true,
          allowAnyOnLocalhost: true,
          allowAnyOnLoopback: true,
          allowedUris: [selfUseRedirectUri(stage), "https://executor.sh/api/oauth/callback"],
        },
      });
    },
  );
});

describe("the Self-use redirect URI", () => {
  // `sha256("https://spirit-led-software.cloudflareaccess.com")`'s first 12 hex digits, pinned so that a change of the
  // hash, the path or the issuer shows here before Access refuses the registration.
  it.each([
    ["prod", "https://pi.ianpascoe.dev/oauth/mcp/callback/59e6d22cc2cd"],
    [
      "pr-438",
      "https://cloudpid-server-pr-438.ian-g-pascoe.workers.dev/oauth/mcp/callback/59e6d22cc2cd",
    ],
    [
      "dev_Ian",
      "https://cloudpid-server-dev-ian.ian-g-pascoe.workers.dev/oauth/mcp/callback/59e6d22cc2cd",
    ],
  ])("on %s is %s", (stage, uri) => {
    expect(selfUseRedirectUri(stage)).toBe(uri);
  });

  it.each(["prod", "pr-438", "dev_ian"])(
    "on %s is the stage's callback below the first 12 hex digits of the SHA-256 of Access's issuer",
    async (stage) => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`https://${ACCESS_TEAM_DOMAIN}`),
      );

      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");

      expect(ACCESS_ISSUER).toBe(`https://${ACCESS_TEAM_DOMAIN}`);
      expect(selfUseRedirectUri(stage)).toBe(
        `${appOrigin(stage)}/oauth/mcp/callback/${hash.slice(0, 12)}`,
      );
    },
  );

  it("is an exact https URI, not a `/*` pattern, which Access would match on every sub-path", () => {
    expect(selfUseRedirectUri("prod")).toMatch(/^https:\/\/[^*]+$/);
  });
});

describe("the stack's MCP endpoint props", () => {
  it.each(["prod", "pr-438", "dev_ian"])(
    "declare the application and give %s's Worker its audience, and no service token's client id",
    async (stage) => {
      const { result, application: declared } = await run({ stage, dev: false });

      expect(result.vars).toEqual({ [MCP_AUDIENCE_VAR]: "the-mcp-aud" });
      expect(declared).toHaveBeenCalledWith(mcpApplicationProps(stage));
    },
  );

  it("declare nothing under alchemy dev, which has no Access", async () => {
    const { result, application: declared } = await run({ stage: "dev_ian", dev: true });

    expect(result.vars).toEqual({});
    expect(declared).not.toHaveBeenCalled();
  });

  it("set nothing where the bundle itself runs", async () => {
    const { result, application: declared } = await run({
      stage: "runtime",
      dev: false,
      runtime: true,
    });

    expect(result.vars).toEqual({});
    expect(declared).not.toHaveBeenCalled();
  });
});

describe("the MCP_CALLS namespace", () => {
  it("is a stable positive integer per stage, apart from every other stage's", () => {
    const ids = [
      mcpCallsNamespace("prod"),
      mcpCallsNamespace("pr-438"),
      mcpCallsNamespace("pr-439"),
      mcpCallsNamespace("dev_Ian"),
    ];

    expect(new Set(ids).size).toBe(ids.length);

    for (const id of ids) {
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(1_000_000);
    }

    expect(mcpCallsNamespace("prod")).toBe(mcpCallsNamespace("prod"));
  });
});
