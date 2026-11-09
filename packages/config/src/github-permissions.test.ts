import { expect, it } from "vitest";
import { CONTAINER_GITHUB_PERMISSIONS } from "./github-permissions.ts";

it("never holds repository_hooks in the Containers' GitHub permissions, which a Container's token must not carry (ADR-0049)", () => {
  expect(CONTAINER_GITHUB_PERMISSIONS).not.toHaveProperty("repository_hooks");
});
