import { describe, expect, it } from "vitest";

import { holdsGitHubToken, maskGitHubTokens } from "./github-tokens.ts";

// A stateless installation token (`ghs_<app id>_<JWT>`, about 520 characters): GitHub's format for every new one since
// 2026-10-02. Its JWT brings dots, dashes and underscores.
const STATELESS =
  "ghs_1234567_eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJnaXRodWIiLCJpbnN0YWxsYXRpb24iOjk4NzY1fQ." +
  "aB3-_x9Q".repeat(50);

const CLASSIC = "ghs_0123456789abcdefghijklmnopqrstuvwxyz";

describe("GitHub token shapes", () => {
  it("masks a stateless installation token whole", () => {
    expect(maskGitHubTokens(`use ${STATELESS} now`)).toBe("use *** now");
    expect(holdsGitHubToken(`GH_TOKEN=${STATELESS}`)).toBe(true);
  });

  it("still masks a classic installation token", () => {
    expect(maskGitHubTokens(`use ${CLASSIC} now`)).toBe("use *** now");
  });

  it("leaves a short mention of the prefix alone", () => {
    expect(holdsGitHubToken("tokens start with ghs_ or ghp_")).toBe(false);
  });
});
