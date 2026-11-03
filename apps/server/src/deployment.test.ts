import { describe, expect, it } from "vitest";
import {
  ACCESS_AUDIENCE_VAR,
  LOCAL_MODE_VAR,
  MCP_CLIENT_DOCUMENT_VAR,
  OWNER_EMAIL,
  PRODUCTION_DOMAIN,
  WORKERS_DEV_SUBDOMAIN,
  appOrigin,
  checkedAppOrigin,
  deployment,
  guardVars,
  stageLabel,
} from "./deployment.ts";

/** What a deployed stage passes: it is not planned by `alchemy dev`. */
const LIVE = { dev: false };

describe("deployment", () => {
  it("serves prod on its custom domain only, not workers.dev, and keeps its alchemy name", () => {
    const config = deployment("prod", LIVE);

    expect(config).toMatchObject({ domain: PRODUCTION_DOMAIN, workersDev: false });
    expect(config).not.toHaveProperty("name");
  });

  it.each([
    ["dev_ian", "cloudpid-server-dev-ian"],
    ["dev_ci", "cloudpid-server-dev-ci"],
    ["pr-7", "cloudpid-server-pr-7"],
    ["pr-430", "cloudpid-server-pr-430"],
    ["Feature_X", "cloudpid-server-feature-x"],
    ["a--b", "cloudpid-server-a--b"],
  ])("serves %s on workers.dev as %s, with no custom domain", (stage, name) => {
    const config = deployment(stage, LIVE);

    expect(config).toMatchObject({ name, workersDev: true });
    expect(config).not.toHaveProperty("domain");
  });

  it.each([
    ["dev_Ian", "dev-ian"],
    ["pr-7", "pr-7"],
  ])("labels %s as %s, for the Worker's label var", (stage, label) => {
    expect(deployment(stage, LIVE).label).toBe(label);
    expect(stageLabel(stage)).toBe(label);
  });

  it("gives prod no label, so its Worker gets no label var and its Views no suffix", () => {
    expect(deployment("prod", LIVE).label).toBeUndefined();
  });

  it("accepts a label of exactly 35 characters", () => {
    const stage = `pr-${"a".repeat(32)}`;

    expect(stage).toHaveLength(35);
    expect(deployment(stage, LIVE).name).toBe(`cloudpid-server-${stage}`);
  });

  it.each([
    ["empty", ""],
    ["longer than 35 characters", `pr-${"a".repeat(33)}`],
    ["leading '-'", "-pr-7"],
    ["trailing '-'", "pr-7-"],
    ["leading '_', which becomes '-'", "_dev"],
    ["trailing '_', which becomes '-'", "dev_"],
    ["a '.'", "pr.7"],
    ["a '/'", "feature/x"],
    ["a space", "pr 7"],
    ["a non-ASCII letter", "pr-é"],
  ])("refuses a stage that is %s, never truncating it", (_, stage) => {
    expect(() => deployment(stage, LIVE)).toThrow(/stage/i);
    expect(() => stageLabel(stage)).toThrow(/stage/i);
    expect(() => appOrigin(stage)).toThrow(/stage/i);
  });

  it.each(["prod", "dev_ian"])("gates %s behind Access for the owner email only", (stage) => {
    const { access } = deployment(stage, LIVE);

    expect(access.policies).toEqual([{ decision: "allow", include: [{ email: OWNER_EMAIL }] }]);
  });
});

describe("MCP_CLIENT_DOCUMENT", () => {
  it("is the var the Worker reads the switch from", () => {
    expect(MCP_CLIENT_DOCUMENT_VAR).toBe("MCP_CLIENT_DOCUMENT");
  });

  it.each([
    ["prod", false, "true"],
    ["dev_ian", false, "true"],
    ["pr-444", false, "true"],
    ["Feature_X", false, "true"],
    ["prod", true, "false"],
    ["dev_ian", true, "false"],
    ["pr-444", true, "false"],
  ])("on %s, with alchemy dev %s, is %s", (stage, dev, flag) => {
    expect(deployment(stage, { dev }).env).toMatchObject({ MCP_CLIENT_DOCUMENT: flag });
  });

  it.each([
    ["prod", `https://${PRODUCTION_DOMAIN}`],
    ["pr-444", "https://cloudpid-server-pr-444.ian-g-pascoe.workers.dev"],
  ])("is, with the app origin, the only var %s's deployment sets", (stage, origin) => {
    expect(deployment(stage, LIVE).env).toStrictEqual({
      MCP_CLIENT_DOCUMENT: "true",
      CLOUDPID_APP_ORIGIN: origin,
    });
  });

  it.each(["prod", "dev_ian"])("leaves the app origin out under alchemy dev on %s", (stage) => {
    expect(deployment(stage, { dev: true }).env).toStrictEqual({ MCP_CLIENT_DOCUMENT: "false" });
  });
});

describe("appOrigin", () => {
  it("is prod's custom domain for prod", () => {
    expect(appOrigin("prod")).toBe(`https://${PRODUCTION_DOMAIN}`);
  });

  it.each([
    ["pr-430", "https://cloudpid-server-pr-430.ian-g-pascoe.workers.dev"],
    ["dev_ian", "https://cloudpid-server-dev-ian.ian-g-pascoe.workers.dev"],
  ])("is the workers.dev URL of the Worker named for %s", (stage, origin) => {
    expect(WORKERS_DEV_SUBDOMAIN).toBe("ian-g-pascoe");
    expect(appOrigin(stage)).toBe(origin);
  });

  it.each(["pr-430", "dev_ian"])("is the host of the Worker %s is named for", (stage) => {
    expect(appOrigin(stage)).toBe(
      `https://${deployment(stage, LIVE).name}.${WORKERS_DEV_SUBDOMAIN}.workers.dev`,
    );
  });
});

describe("checkedAppOrigin", () => {
  it("returns the URL when it is the stage's app origin", () => {
    expect(checkedAppOrigin({ stage: "pr-7", url: appOrigin("pr-7") })).toBe(appOrigin("pr-7"));
    expect(checkedAppOrigin({ stage: "prod", url: `https://${PRODUCTION_DOMAIN}` })).toBe(
      appOrigin("prod"),
    );
  });

  it.each([
    [
      "a random-suffixed physical name",
      "https://cloudpid-server-pr-7-uzlffoyzfeo3tuvx.ian-g-pascoe.workers.dev",
    ],
    ["another account's subdomain", "https://cloudpid-server-pr-7.someone-else.workers.dev"],
    ["another stage's Worker", "https://cloudpid-server-pr-8.ian-g-pascoe.workers.dev"],
    ["a trailing slash", `${appOrigin("pr-7")}/`],
    ["undefined", undefined],
  ])("fails a deploy whose URL is %s", (_, url) => {
    expect(() => checkedAppOrigin({ stage: "pr-7", url })).toThrow(/app origin/i);
  });
});

describe("the Access guard's vars", () => {
  it.each(["prod", "dev_ian", "pr-430"])(
    "are not in the deployment output of %s, live or under alchemy dev, so no deployed Worker can be in local mode",
    (stage) => {
      for (const dev of [false, true]) {
        expect(JSON.stringify(deployment(stage, { dev }))).not.toContain(LOCAL_MODE_VAR);
      }
    },
  );

  it("give a deployed stage its application's audience and never the local-mode var", () => {
    expect(guardVars("an-audience")).toEqual({ [ACCESS_AUDIENCE_VAR]: "an-audience" });
    expect(guardVars("an-audience")).not.toHaveProperty(LOCAL_MODE_VAR);
  });

  it("give alchemy dev, which has no audience, the local-mode var alone", () => {
    expect(guardVars(undefined)).toEqual({ [LOCAL_MODE_VAR]: "true" });
  });
});
