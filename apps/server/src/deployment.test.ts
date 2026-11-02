import { describe, expect, it } from "vitest";
import {
  OWNER_EMAIL,
  PRODUCTION_DOMAIN,
  WORKERS_DEV_SUBDOMAIN,
  appOrigin,
  checkedAppOrigin,
  deployment,
  stageLabel,
} from "./deployment.ts";

describe("deployment", () => {
  it("serves prod on its custom domain only, not workers.dev, and keeps its alchemy name", () => {
    const config = deployment("prod");

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
    const config = deployment(stage);

    expect(config).toMatchObject({ name, workersDev: true });
    expect(config).not.toHaveProperty("domain");
  });

  it.each([
    ["dev_Ian", "dev-ian"],
    ["pr-7", "pr-7"],
  ])("labels %s as %s, for the Worker's label var", (stage, label) => {
    expect(deployment(stage).label).toBe(label);
    expect(stageLabel(stage)).toBe(label);
  });

  it("gives prod no label, so its Worker gets no label var and its Views no suffix", () => {
    expect(deployment("prod").label).toBeUndefined();
  });

  it("accepts a label of exactly 35 characters", () => {
    const stage = `pr-${"a".repeat(32)}`;

    expect(stage).toHaveLength(35);
    expect(deployment(stage).name).toBe(`cloudpid-server-${stage}`);
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
    expect(() => deployment(stage)).toThrow(/stage/i);
    expect(() => stageLabel(stage)).toThrow(/stage/i);
    expect(() => appOrigin(stage)).toThrow(/stage/i);
  });

  it.each(["prod", "dev_ian"])("gates %s behind Access for the owner email only", (stage) => {
    const { access } = deployment(stage);

    expect(access.policies).toEqual([{ decision: "allow", include: [{ email: OWNER_EMAIL }] }]);
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
      `https://${deployment(stage).name}.${WORKERS_DEV_SUBDOMAIN}.workers.dev`,
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
