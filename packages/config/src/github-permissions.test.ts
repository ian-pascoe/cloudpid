import { describe, expect, it } from "vitest";
import { CONTAINER_GITHUB_PERMISSIONS, GITHUB_APP_PERMISSIONS } from "./github-permissions.ts";

describe("the GitHub App's permissions", () => {
  it("are the ones ADR-0025 lists", () => {
    expect(GITHUB_APP_PERMISSIONS).toEqual({
      contents: "write",
      pull_requests: "write",
      issues: "write",
      workflows: "write",
      actions: "read",
      checks: "read",
      statuses: "read",
      metadata: "read",
    });
  });
});

describe("the Containers' GitHub permissions", () => {
  // Remove this test when #682 adds `repository_hooks` to the App's list only.
  it("hold the same values as the App's until the App gains repository_hooks", () => {
    expect(CONTAINER_GITHUB_PERMISSIONS).toEqual(GITHUB_APP_PERMISSIONS);
  });

  it("never hold repository_hooks, which a Container's token must not carry (ADR-0049)", () => {
    expect(CONTAINER_GITHUB_PERMISSIONS).not.toHaveProperty("repository_hooks");
  });

  it("are a list of their own, not the App's", () => {
    expect(CONTAINER_GITHUB_PERMISSIONS).not.toBe(GITHUB_APP_PERMISSIONS);
  });
});
