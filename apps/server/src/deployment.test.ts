import { describe, expect, it } from "vitest";
import { OWNER_EMAIL, PRODUCTION_DOMAIN, deployment } from "./deployment.ts";

describe("deployment", () => {
  it("serves prod on its custom domain only, not workers.dev", () => {
    const config = deployment("prod");

    expect(config).toMatchObject({ domain: PRODUCTION_DOMAIN, workersDev: false });
  });

  it.each(["dev_ian", "dev_ci", "pr-7"])(
    "serves %s on workers.dev with no custom domain",
    (stage) => {
      const { domain, workersDev } = deployment(stage);

      expect(domain).toBeUndefined();
      expect(workersDev).toBe(true);
    },
  );

  it.each(["prod", "dev_ian"])("gates %s behind Access for the owner email only", (stage) => {
    const { access } = deployment(stage);

    expect(access.policies).toEqual([{ decision: "allow", include: [{ email: OWNER_EMAIL }] }]);
  });
});
