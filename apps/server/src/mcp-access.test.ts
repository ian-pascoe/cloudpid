// @effect-diagnostics asyncFunction:off
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { OWNER_EMAIL, appOrigin } from "./deployment.ts";
import {
  MCP_AUDIENCE_VAR,
  MCP_OAUTH_CONFIGURATION,
  MCP_SERVICE_TOKEN_CLIENT_ID_VAR,
  localAgentTokenName,
  mcpAccessProps,
  mcpApplicationProps,
  mcpHost,
} from "./mcp-access.ts";

const token = { serviceTokenId: "the-token-id", clientId: "abc123.access" };
const application = { aud: "the-mcp-aud" };

const run = (options: {
  readonly stage: string;
  readonly dev: boolean;
  readonly runtime?: boolean;
}) => {
  const serviceToken = vi.fn(() => Effect.succeed(token));
  const declareApplication = vi.fn(() => Effect.succeed(application));
  // SAFETY: `mcpAccessProps` reads only `dev` of the context.
  const context = AlchemyContext.of({ dotAlchemy: ".alchemy", dev: options.dev } as never);

  return Effect.runPromise(
    mcpAccessProps({
      stage: options.stage,
      runtime: options.runtime ?? false,
      declare: { serviceToken, application: declareApplication },
    }).pipe(Effect.provideService(AlchemyContext, context)),
  ).then((result) => ({ result, serviceToken, application: declareApplication }));
};

describe("the MCP endpoint's host", () => {
  it.each([
    ["prod", "pi.ianpascoe.dev"],
    ["pr-438", "cloudpid-server-pr-438.ian-g-pascoe.workers.dev"],
    ["dev_Ian", "cloudpid-server-dev-ian.ian-g-pascoe.workers.dev"],
  ])("on %s is %s, the host of the stage's app origin", (stage, host) => {
    expect(mcpHost(stage)).toBe(host);
    expect(appOrigin(stage)).toBe(`https://${host}`);
  });
});

describe("the Local agent's service token's name", () => {
  it("is cloudpid-local-agent on prod", () => {
    expect(localAgentTokenName("prod")).toBe("cloudpid-local-agent");
  });

  it.each([
    ["pr-438", "cloudpid-local-agent-pr-438"],
    ["dev_Ian", "cloudpid-local-agent-dev-ian"],
  ])(
    "is cloudpid-local-agent-<label> on %s, so no stage shares or destroys another's",
    (stage, name) => {
      expect(localAgentTokenName(stage)).toBe(name);
    },
  );

  it("is refused for a stage whose label is", () => {
    expect(() => localAgentTokenName("pr.7")).toThrow(/cannot be deployed/);
  });
});

describe("the MCP endpoint's Access application", () => {
  it.each([
    ["prod", "pi.ianpascoe.dev/mcp"],
    ["pr-438", "cloudpid-server-pr-438.ian-g-pascoe.workers.dev/mcp"],
    ["dev_ian", "cloudpid-server-dev-ian.ian-g-pascoe.workers.dev/mcp"],
  ])("on %s covers %s only, by a public destination", (stage, uri) => {
    expect(mcpApplicationProps(stage, "t").destinations).toEqual([{ type: "public", uri }]);
  });

  it("is a self-hosted application and covers no Worker (the main application's destination)", () => {
    const props = mcpApplicationProps("prod", "t");

    expect(props.type).toBe("self_hosted");
    expect(JSON.stringify(props)).not.toContain("worker");
  });

  it("allows the owner, then the Local agent's token by id, and never any valid service token", () => {
    expect(mcpApplicationProps("prod", "the-token-id").policies).toEqual([
      { decision: "allow", include: [{ email: OWNER_EMAIL }] },
      { decision: "non_identity", include: [{ serviceToken: "the-token-id" }] },
    ]);
    expect(JSON.stringify(mcpApplicationProps("prod", "t"))).not.toContain("anyValidServiceToken");
  });

  it("turns managed OAuth on: 5 minute access tokens, a 14 day grant, loopback and localhost DCR", () => {
    expect(mcpApplicationProps("prod", "t").oauthConfiguration).toBe(MCP_OAUTH_CONFIGURATION);
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
    "declare the token, then its application, and give %s's Worker the application's audience and the token's client id",
    async (stage) => {
      const { result, serviceToken, application: declared } = await run({ stage, dev: false });

      expect(result.vars).toEqual({
        [MCP_AUDIENCE_VAR]: "the-mcp-aud",
        [MCP_SERVICE_TOKEN_CLIENT_ID_VAR]: "abc123.access",
      });
      expect(serviceToken).toHaveBeenCalledWith({
        name: localAgentTokenName(stage),
        duration: "8760h",
      });
      expect(declared).toHaveBeenCalledWith(mcpApplicationProps(stage, "the-token-id"));
    },
  );

  it("declare nothing under alchemy dev, which has no Access", async () => {
    const {
      result,
      serviceToken,
      application: declared,
    } = await run({ stage: "dev_ian", dev: true });

    expect(result.vars).toEqual({});
    expect(serviceToken).not.toHaveBeenCalled();
    expect(declared).not.toHaveBeenCalled();
  });

  it("set nothing where the bundle itself runs", async () => {
    const {
      result,
      serviceToken,
      application: declared,
    } = await run({
      stage: "runtime",
      dev: false,
      runtime: true,
    });

    expect(result.vars).toEqual({});
    expect(serviceToken).not.toHaveBeenCalled();
    expect(declared).not.toHaveBeenCalled();
  });
});
