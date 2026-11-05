// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { OWNER_EMAIL, appOrigin } from "./deployment.ts";
import {
  MCP_AUDIENCE_VAR,
  MCP_OAUTH_CONFIGURATION,
  mcpAccessProps,
  mcpApplicationProps,
  mcpCallsNamespace,
  appHost,
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

  it("turns managed OAuth on: 5 minute access tokens, a 14 day grant, loopback and localhost DCR", () => {
    expect(mcpApplicationProps("prod").oauthConfiguration).toBe(MCP_OAUTH_CONFIGURATION);
    expect(MCP_OAUTH_CONFIGURATION).toEqual({
      enabled: true,
      grant: { accessTokenLifetime: "5m", sessionDuration: "336h" },
      dynamicClientRegistration: {
        enabled: true,
        allowAnyOnLocalhost: true,
        allowAnyOnLoopback: true,
      },
    });
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
