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

describe("the MCP endpoint's Access application", () => {
  it.each([
    ["prod", "pi.ianpascoe.dev/mcp"],
    ["pr-438", "cloudpid-server-pr-438.ian-g-pascoe.workers.dev/mcp"],
    ["dev_ian", "cloudpid-server-dev-ian.ian-g-pascoe.workers.dev/mcp"],
  ])("on %s covers %s only, by a public destination", (stage, uri) => {
    expect(mcpApplicationProps(stage).destinations).toEqual([{ type: "public", uri }]);
  });

  it("allows the owner's email and nothing else: no Service Auth policy, never any valid service token", () => {
    expect(mcpApplicationProps("prod").policies).toEqual([
      { decision: "allow", include: [{ email: OWNER_EMAIL }] },
    ]);
    expect(JSON.stringify(mcpApplicationProps("prod"))).not.toMatch(/service/i);
  });
});

describe("the Self-use redirect URI", () => {
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
