import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { githubAppKeyProblem } from "./app.ts";

/** The GitHub App's private key is malformed: the Worker does not start, as when a secret is missing. */
class GitHubAppConfigError extends Schema.TaggedError<
  GitHubAppConfigError,
  { readonly brand: unique symbol }
>()("GitHubAppConfigError", { message: Schema.String }) {}

/** The GitHub App's ID and private key (ADR-0025): deploy-time secrets, bound to the Workers by `Config.Redacted`. */
export type GitHubAppSecrets = {
  readonly appId: Redacted.Redacted<string>;
  readonly privateKey: Redacted.Redacted<string>;
};

/**
 * Reads `CLOUDPID_GITHUB_APP_ID` and `CLOUDPID_GITHUB_APP_PRIVATE_KEY` (from the deploying environment, then from the
 * Worker's secrets) and checks the key when it is read, so a bad paste fails a deploy or `alchemy dev` at once. GitHub
 * is not asked.
 */
export const readGitHubAppSecrets: Effect.Effect<GitHubAppSecrets> = Config.all({
  appId: Config.Redacted("CLOUDPID_GITHUB_APP_ID"),
  privateKey: Config.Redacted("CLOUDPID_GITHUB_APP_PRIVATE_KEY"),
}).pipe(
  Effect.flatMap((secrets) =>
    Effect.promise(() => githubAppKeyProblem(secrets.privateKey.pipe(Redacted.value))).pipe(
      Effect.flatMap((problem) =>
        problem === undefined
          ? Effect.succeed(secrets)
          : Effect.fail(GitHubAppConfigError.make({ message: problem })),
      ),
    ),
  ),
  Effect.orDie,
);

/** The GitHub App's secrets, for the main Worker and its Session DOs. */
export class GitHubAppConfig extends Context.Service<GitHubAppConfig, GitHubAppSecrets>()(
  "@cloudpid/server/github/config/GitHubAppConfig",
) {}

/** `GitHubAppConfig` from the deploy's secrets, checked as `readGitHubAppSecrets` checks them. */
export const GitHubAppConfigLive = Layer.effect(GitHubAppConfig, readGitHubAppSecrets);
