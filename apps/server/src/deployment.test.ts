import { describe, expect, it } from "vitest";
import {
  OWNER_EMAIL,
  PRODUCTION_DOMAIN,
  appOrigin,
  checkedAppOrigin,
  deployment,
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
  it.each([
    ["prod", false, "true"],
    ["prod", true, "false"],
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
  it.each([
    ["pr-430", "https://cloudpid-server-pr-430.ian-g-pascoe.workers.dev"],
    ["dev_ian", "https://cloudpid-server-dev-ian.ian-g-pascoe.workers.dev"],
  ])("is the workers.dev URL of the Worker named for %s", (stage, origin) => {
    expect(appOrigin(stage)).toBe(origin);
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
