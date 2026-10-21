import { Server, Workspaces } from "@cloudpid/server";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "cloudpid",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const server = yield* Server;

    yield* Workspaces;

    // A pull request's preview (stage `pr-<number>`, .github/workflows/ci.yml) posts its URL on the PR, and updates
    // that one comment on each push. Outside GitHub Actions, or on a push to `main`, there is no PR and no comment, and
    // the GitHub credentials (GITHUB_TOKEN in CI) are never resolved.
    const github = yield* GitHub.GitHubEnv;

    if (github?.pr !== undefined) {
      yield* GitHub.Comment("PreviewComment", {
        owner: github.owner,
        repository: github.repository,
        issueNumber: github.pr,
        body: Output.interpolate`
          ## Preview deployed

          **URL:** ${server.url}

          Built from ${github.sha.slice(0, 7)} (stage \`pr-${github.pr}\`, behind Access). It is destroyed when the
          pull request is closed.

          ---
          _This comment updates on each push._
        `,
      });
    }

    return { url: server.url.as<string>() };
  }),
);
