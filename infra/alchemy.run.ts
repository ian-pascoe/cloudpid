import { AppSandbox, LocalAppSandbox } from "@cloudpid/app-sandbox";
import { Server, Workspaces } from "@cloudpid/server";
import { checkedAppOrigin } from "@cloudpid/server/deployment";
import * as Alchemy from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
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
    const stage = yield* Alchemy.Stage;
    const { dev } = yield* AlchemyContext;

    yield* Workspaces;

    // The App sandbox (`*.ianpascoe.app/*`) is deployed by `prod` only: a route pattern belongs to one Worker, and every
    // other stage frames prod's (docs/architecture/mcp-apps.md → The App sandbox). `alchemy dev` serves it from a second
    // local port instead, with no route or record, whatever the stage is called.
    if (dev) yield* LocalAppSandbox;
    else if (stage === "prod") yield* AppSandbox;

    // The App sandbox derives the stage's origin from its name (apps/server/src/deployment.ts, `appOrigin`), so a Worker
    // served anywhere else fails the deploy here, where the URL resolves, before the preview comment names it. `alchemy dev`
    // serves on localhost.
    const url = dev
      ? server.url.as<string>()
      : Output.map(server.url.as<string>(), (resolved) =>
          checkedAppOrigin({ stage, url: resolved }),
        );

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

          **URL:** ${url}

          Built from ${github.sha.slice(0, 7)} (stage \`pr-${github.pr}\`, behind Access). It is destroyed when the
          pull request is closed.

          ---
          _This comment updates on each push._
        `,
      });
    }

    return { url };
  }),
);
