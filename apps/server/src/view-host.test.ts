// @effect-diagnostics preferEffectArray:off -- assertions over native arrays.
import { describe, expect, it } from "vitest";
import { appOrigin, stageLabel } from "./deployment.ts";
import {
  APP_DOMAIN,
  LOCAL_APP_ORIGINS,
  LOCAL_SANDBOX_ORIGIN,
  appOriginOf,
  localAppOriginOf,
  viewHost,
  viewOrigin,
} from "./view-host.ts";

const HASH = "5zdfpsreiskluv5bvtlks2urnj";
const OTHER_HASH = "cdlvzzb44rouynrktjiriz5ahs";

/** Stages `stageLabel` accepts, edge cases first. */
const acceptedStages = [
  "prod",
  "PROD",
  "Prod",
  "dev_ian",
  "dev_ci",
  "pr-7",
  "pr-430",
  "Feature_X",
  "a--b",
  "a",
  "7",
  "_a_",
  "x".repeat(35),
  "dev-ian-pascoe-very-long-stage-name",
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split(""),
];

/** A deterministic spread of arbitrary stages, so the accepted ones are not only the ones we thought of. */
const generatedStages = Array.from({ length: 400 }, (_, seed) => {
  const alphabet = "abcXYZ019_-";
  let state = seed + 1;
  let stage = "";

  for (let index = 0; index < (seed % 40) + 1; index++) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    stage += alphabet[state % alphabet.length];
  }

  return stage;
});

const accepted = (stage: string): boolean => {
  try {
    stageLabel(stage);

    return true;
  } catch {
    return false;
  }
};

describe("viewHost", () => {
  it("is the hash alone on prod and the hash and the label elsewhere", () => {
    expect(viewHost(HASH, "prod")).toBe(`${HASH}.${APP_DOMAIN}`);
    expect(viewHost(HASH, "pr-430")).toBe(`${HASH}--pr-430.${APP_DOMAIN}`);
    expect(viewHost(HASH, "Dev_Ian")).toBe(`${HASH}--dev-ian.${APP_DOMAIN}`);
  });

  it("is a DNS label at its longest: 26 + 2 + 35 = 63 characters", () => {
    const host = viewHost(OTHER_HASH, "x".repeat(35));

    expect(host.split(".")[0]).toHaveLength(63);
  });

  it.each([
    "",
    "a".repeat(25),
    "a".repeat(27),
    HASH.toUpperCase(),
    `${"a".repeat(25)}0`,
    `${"a".repeat(25)}1`,
  ])("refuses the hash %j", (hash) => {
    expect(() => viewHost(hash, "prod")).toThrow(/26 lowercase base32/);
  });

  it.each(["", "-a", "a-", "x".repeat(36), "a.b", "a b", "é"])("refuses the stage %j", (stage) => {
    expect(() => viewHost(HASH, stage)).toThrow(/cannot be deployed/);
  });
});

describe("appOriginOf", () => {
  it("maps prod's host to the custom domain and a label to its workers.dev origin", () => {
    expect(appOriginOf(`${HASH}.ianpascoe.app`)).toBe("https://pi.ianpascoe.dev");
    expect(appOriginOf(`${HASH}--pr-430.ianpascoe.app`)).toBe(
      "https://cloudpid-server-pr-430.ian-g-pascoe.workers.dev",
    );
  });

  it("reads a label of `prod` as a non-prod stage's, as appOrigin does for `PROD`", () => {
    expect(appOriginOf(`${HASH}--prod.ianpascoe.app`)).toBe(
      "https://cloudpid-server-prod.ian-g-pascoe.workers.dev",
    );
    expect(appOrigin("PROD")).toBe("https://cloudpid-server-prod.ian-g-pascoe.workers.dev");
  });

  it("is case-insensitive in the host, like DNS", () => {
    expect(appOriginOf(`${HASH}--PR-430.IANPASCOE.APP`)).toBe(appOrigin("pr-430"));
  });

  it.each([...new Set([...acceptedStages, ...generatedStages].filter(accepted))])(
    "round-trips stage %j: appOriginOf(viewHost(hash, stage)) is appOrigin(stage)",
    (stage) => {
      expect(appOriginOf(viewHost(HASH, stage))).toBe(appOrigin(stage));
      expect(appOriginOf(viewHost(OTHER_HASH, stage))).toBe(appOrigin(stage));
    },
  );

  it("builds no host for a generated stage that stageLabel refuses", () => {
    const refused = generatedStages.filter((stage) => !accepted(stage));

    expect(refused.length).toBeGreaterThan(0);

    for (const stage of refused) {
      expect(() => viewHost(HASH, stage)).toThrow();
    }
  });

  it.each([
    ["the apex", "ianpascoe.app"],
    ["www", "www.ianpascoe.app"],
    ["a plain label", "foo.ianpascoe.app"],
    ["a hash 25 characters long", `${HASH.slice(1)}.ianpascoe.app`],
    ["a hash 27 characters long", `a${HASH}.ianpascoe.app`],
    ["a hash with a character outside base32 (0)", `${HASH.slice(1)}0.ianpascoe.app`],
    ["a hash with a character outside base32 (1)", `${HASH.slice(1)}1.ianpascoe.app`],
    ["a hash with a character outside base32 (8)", `${HASH.slice(1)}8.ianpascoe.app`],
    ["a hash with an underscore", `${HASH.slice(1)}_.ianpascoe.app`],
    ["an empty label", `${HASH}--.ianpascoe.app`],
    ["a label starting with `-`", `${HASH}---a.ianpascoe.app`],
    ["a label ending with `-`", `${HASH}--a-.ianpascoe.app`],
    ["a label of one `-`", `${HASH}---.ianpascoe.app`],
    ["a label over 35 characters", `${HASH}--${"a".repeat(36)}.ianpascoe.app`],
    ["a label with an underscore", `${HASH}--a_b.ianpascoe.app`],
    ["a single dash between hash and label", `${HASH}-a.ianpascoe.app`],
    ["a second host label", `x.${HASH}.ianpascoe.app`],
    ["a second host label after a stage", `x.${HASH}--pr-1.ianpascoe.app`],
    ["a dot in the label", `${HASH}--a.b.ianpascoe.app`],
    ["a trailing dot", `${HASH}.ianpascoe.app.`],
    ["another zone", `${HASH}.ianpascoe.dev`],
    ["another zone with the domain in front", `${HASH}.ianpascoe.app.example.com`],
    ["a lookalike zone", `${HASH}.evilianpascoe.app`],
    ["a lookalike zone with a dot", `${HASH}.ianpascoe-app`],
    ["no zone", HASH],
    ["an empty host", ""],
    ["a host with a port", `${HASH}.ianpascoe.app:443`],
    ["a path in the host", `${HASH}.ianpascoe.app/x`],
    ["a newline", `${HASH}.ianpascoe.app\n`],
    ["a space", ` ${HASH}.ianpascoe.app`],
    ["an IP address", "127.0.0.1"],
    ["localhost", "localhost"],
  ])("returns undefined for %s", (_, host) => {
    expect(appOriginOf(host)).toBeUndefined();
  });
});

describe("viewOrigin", () => {
  it("is the https origin of viewHost, from the stage's label", () => {
    expect(viewOrigin({ hash: HASH, label: undefined, local: false })).toBe(
      `https://${viewHost(HASH, "prod")}`,
    );

    expect(viewOrigin({ hash: HASH, label: stageLabel("dev_ian"), local: false })).toBe(
      `https://${viewHost(HASH, "dev_ian")}`,
    );
  });

  it("reads a label of prod as a stage's, which only a stage named PROD has", () => {
    expect(viewOrigin({ hash: HASH, label: "prod", local: false })).toBe(
      `https://${HASH}--prod.${APP_DOMAIN}`,
    );

    expect(appOriginOf(`${HASH}--prod.${APP_DOMAIN}`)).toBe(appOrigin("PROD"));
  });

  it("is the one shared origin under alchemy dev, whatever the hash", () => {
    expect(viewOrigin({ hash: HASH, label: undefined, local: true })).toBe(LOCAL_SANDBOX_ORIGIN);
    expect(viewOrigin({ hash: OTHER_HASH, label: "x", local: true })).toBe(LOCAL_SANDBOX_ORIGIN);
    expect(LOCAL_SANDBOX_ORIGIN).toBe("http://127.0.0.1:1338");
  });

  it.each([
    ["a short hash", "abc", undefined],
    ["an upper-case hash", HASH.toUpperCase(), undefined],
    ["an empty label", HASH, ""],
    ["a label with a dot", HASH, "a.b"],
    ["a label over 35 characters", HASH, "a".repeat(36)],
  ])("throws for %s", (_name, hash, label) => {
    expect(() => viewOrigin({ hash, label, local: false })).toThrow(/No App View host/);
  });
});

describe("localAppOriginOf", () => {
  it("accepts only the two local app origins, exactly", () => {
    for (const origin of LOCAL_APP_ORIGINS) expect(localAppOriginOf(origin)).toBe(origin);

    for (const other of [
      null,
      "",
      "*",
      "http://127.0.0.1:1338",
      "http://localhost:1337/",
      "https://localhost:1337",
      "http://localhost:1337 http://evil.example",
      "HTTP://LOCALHOST:1337",
    ]) {
      expect(localAppOriginOf(other)).toBeUndefined();
    }
  });
});
