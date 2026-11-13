// The GitHub tokens the Workspace DO mints (docs/architecture/workspace.md → Git, ADR-0025 and ADR-0049): each GitHub token
// request names the Containers' permissions, never leaving GitHub to read an absent list as all of the
// installation's. The test Worker holds a GitHub App (an RSA key made for the test, `vitest.config.ts`) for the Workspaces
// named with `GITHUB_APP_WORKSPACE`, and GitHub's API is stubbed, as the pull request tests have it (`comparison-pull.workerd.test.ts`).
// @effect-diagnostics asyncFunction:off globalDate:off preferEffectArray:off preferEffectRecord:off
import { CONTAINER_GITHUB_PERMISSIONS } from "@cloudpid/config";
import { env } from "cloudflare:workers";
import { describe, expect, inject, it } from "vite-plus/test";
import { graphqlList } from "./github-pulls.fixtures.ts";
import { GITHUB_APP_WORKSPACE, type TestWorkspace } from "./workerd.fixture.ts";

const repos = inject("comparisonRepos");

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

/** `name`'s config: its remote is `owner`'s `name` on GitHub. */
const gitConfig = (owner: string, name: string) =>
  `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/${owner}/${name}.git\n`;

let made = 0;

describe("the GitHub tokens of the Workspace DO", () => {
  it("are asked for with the Containers' permissions, for every installation it mints for", async () => {
    const stub: DurableObjectStub<TestWorkspace> = env.WORKSPACES.getByName(
      `${GITHUB_APP_WORKSPACE}${Date.now()}-${made++}`,
    );

    // Two repos, on two accounts, each with an installation of the app.
    for (const [directory, owner] of [
      ["app", "acme"],
      ["lib", "other"],
    ] as const) {
      await stub.putFiles(
        Object.entries(repos.first.files).map(([path, base64]) => [
          `/workspace/${directory}/${path}`,
          bytesOf(base64),
        ]),
      );
      await stub.putFiles([
        [
          `/workspace/${directory}/.git/config`,
          new TextEncoder().encode(gitConfig(owner, directory)),
        ],
      ]);
    }

    const token = (name: string) => ({ token: name, expires_at: "2999-01-01T00:00:00Z" });

    await stub.setGithub({
      "/app/installations?per_page=100": [
        { id: 11, account: { login: "acme" } },
        { id: 22, account: { login: "other" } },
      ],
      "/app/installations/11/access_tokens": token("ghs_acme"),
      "/app/installations/22/access_tokens": token("ghs_other"),
      "/graphql": graphqlList([]),
    });

    const { repos: listed } = await stub.comparisonSources("/workspace", true);

    expect(listed.map((repo) => repo.pulls?.status)).toEqual(["ok", "ok"]);

    const mints = (await stub.githubPosts()).filter(({ path }) => path.endsWith("/access_tokens"));

    expect(mints.map(({ path }) => path).sort()).toEqual([
      "/app/installations/11/access_tokens",
      "/app/installations/22/access_tokens",
    ]);

    for (const { body } of mints) {
      expect(JSON.parse(body ?? "null")).toEqual({ permissions: CONTAINER_GITHUB_PERMISSIONS });
    }
  });
});
