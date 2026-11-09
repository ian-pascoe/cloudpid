import { expect, it } from "vitest";
import { CONTAINER_GITHUB_PERMISSIONS, GITHUB_APP_PERMISSIONS } from "./github-permissions.ts";

it("never holds repository_hooks in the Containers' GitHub permissions, which a Container's token must not carry (ADR-0049)", () => {
  expect(CONTAINER_GITHUB_PERMISSIONS).not.toHaveProperty("repository_hooks");
});

it("gives the App repository_hooks: write, which a Trigger's object asks for to make its GitHub-managed hook (ADR-0049)", () => {
  expect(GITHUB_APP_PERMISSIONS).toHaveProperty("repository_hooks", "write");
});
