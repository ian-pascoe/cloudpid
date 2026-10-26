// @effect-diagnostics asyncFunction:off
// Whether an Agent change asks for a new Build (docs/spec.md → Agent changes): the Build upkeep after it asks for one
// when the Build the Environment wants is of another key.
import { type ContainerSettings, DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import { describe, expect, it } from "vitest";
import { wantsNewBuild } from "./agent-changes.ts";

const repos = [{ name: "app", url: "https://github.com/o/app.git" }];

const settings = (overrides: Partial<ContainerSettings>): ContainerSettings => ({
  ...DEFAULT_CONTAINER_SETTINGS,
  ...overrides,
});

describe("wantsNewBuild", () => {
  it("is true when a variable of an Environment with a Build changes", async () => {
    expect(
      await wantsNewBuild(repos, settings({}), settings({ variables: { API_URL: "https://x" } })),
    ).toBe(true);
  });

  it("is false for what a Build does not use, such as the idle time", async () => {
    expect(await wantsNewBuild(repos, settings({}), settings({ idleMinutes: 30 }))).toBe(false);
  });

  it("is false for an Environment that has no Build: no Repo, Setup Script or Toolchains", async () => {
    expect(await wantsNewBuild([], settings({}), settings({ variables: { A: "1" } }))).toBe(false);
  });

  it("is true for the Setup Script, the Toolchains and the Container-only paths, which a Build is made with", async () => {
    expect(
      await wantsNewBuild(repos, settings({}), settings({ setupScript: "apt-get update" })),
    ).toBe(true);
    expect(
      await wantsNewBuild(repos, settings({}), settings({ toolchains: '[tools]\nnode = "22"\n' })),
    ).toBe(true);
    expect(await wantsNewBuild(repos, settings({}), settings({ ignore: ["/data"] }))).toBe(true);
  });

  it("is false for the Start Script and the size, which a Build does not use", async () => {
    expect(await wantsNewBuild(repos, settings({}), settings({ startScript: "up" }))).toBe(false);
    expect(await wantsNewBuild(repos, settings({}), settings({ instance: "cpu-2" }))).toBe(false);
  });

  it("is true when the change makes an Environment want a Build at all", async () => {
    expect(
      await wantsNewBuild([], settings({}), settings({ setupScript: "apt-get install -y jq" })),
    ).toBe(true);
  });
});
