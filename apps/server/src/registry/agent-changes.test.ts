// @effect-diagnostics asyncFunction:off
// Whether an Agent change asks for a new Build (docs/architecture/agent-changes.md): the Build upkeep after it asks for one
// when the Build the Environment wants is of another key.
import { type ContainerSettings, DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import { describe, expect, it } from "vitest";
import { globalChangeReach, type ReachedEnvironment, wantsNewBuild } from "./agent-changes.ts";

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

describe("globalChangeReach", () => {
  const environment = (
    id: string,
    own: Partial<ContainerSettings> = {},
    built = true,
  ): ReachedEnvironment => ({
    id,
    name: `Env ${id}`,
    repos: built ? repos : [],
    settings: settings(own),
  });

  const web = environment("0000000a");
  const api = environment("0000000b", { variables: { API_URL: "https://own" } });
  const bare = environment("0000000c", {}, false);

  it("leaves out an Environment whose own variable of the name wins, and asks a Build of one that inherits it", async () => {
    const reach = await globalChangeReach(
      [web, api],
      "API_URL",
      {},
      { API_URL: "https://all" },
      undefined,
    );

    expect(reach.overriddenIn).toEqual([{ id: "0000000b", name: "Env 0000000b" }]);
    expect(reach.newBuilds).toEqual([{ id: "0000000a", name: "Env 0000000a" }]);
  });

  it("asks no Build of an Environment that has nothing to build", async () => {
    const reach = await globalChangeReach(
      [bare],
      "API_URL",
      {},
      { API_URL: "https://all" },
      undefined,
    );

    expect(reach).toEqual({ overriddenIn: [], newBuilds: [], own: undefined });
  });

  it("asks no Build when the merged variables are what they were", async () => {
    const reach = await globalChangeReach(
      [web],
      "API_URL",
      { API_URL: "https://all" },
      { API_URL: "https://all" },
      undefined,
    );

    expect(reach.newBuilds).toEqual([]);
  });

  it("says whether the change reaches the Environment the caller names", async () => {
    const variables = { API_URL: "https://all" };

    expect((await globalChangeReach([web, api], "API_URL", {}, variables, "0000000a")).own).toBe(
      true,
    );
    expect((await globalChangeReach([web, api], "API_URL", {}, variables, "0000000b")).own).toBe(
      false,
    );
    expect(
      (await globalChangeReach([web, api], "API_URL", {}, variables, undefined)).own,
    ).toBeUndefined();
  });
});
