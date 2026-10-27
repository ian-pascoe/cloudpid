---
status: accepted
---

# GitHub access through a single-installation GitHub App

cloudpid reached GitHub with a personal access token, `CLOUDPID_GITHUB_TOKEN`: one fixed string, set at deploy time, that every Container command got as `GH_TOKEN` and `GITHUB_TOKEN` and that the Workers used for GitHub's API. The agent's pushes and pull requests looked like the owner's. Nothing marked them as the agent's, and the coming GitHub triggers need a webhook source. cloudpid now acts on GitHub as its own GitHub App (GLOSSARY.md → GitHub App), and every GitHub token is minted from it on demand.

- **One app, one installation.** The app is private, registered under the owner's account as `cloudpid`, and installed there on all repositories. A private app can only be installed on the account that owns it. Every stage (`prod`, the previews, dev stages) uses the same app. The deploy-time secrets are `CLOUDPID_GITHUB_APP_ID` and `CLOUDPID_GITHUB_APP_PRIVATE_KEY`. No installation ID is stored. The Workers look the installation up (`GET /app/installations`, cached per isolate) and fail, saying why, unless there is exactly one, so an uninstall and reinstall needs no change.
- **Minting.** A Worker signs a JWT with the private key (RS256 through WebCrypto; GitHub's PKCS#1 key is wrapped as PKCS#8 in code) and exchanges it for a GitHub token for the installation. The token lasts an hour. It is cached and minted again once less than about 45 minutes are left, when something asks for it; nothing runs on a timer. A 401 drops the cached token, mints a new one and retries once.
  - The Workspace DO mints with the installation's full permissions on all its repositories, for its Container's commands (each gets the current token in its environment at its start) and for the Diff pane's GitHub calls.
  - The main Worker mints a read-only token (contents, pull requests) for the draft's Start from menu.
  - The private key never reaches a Container.
- **Masking and refusals.**
  - Output masking and the snapshot scan match every token the Workspace DO minted that has not expired, not one fixed string. The DO keeps them in its storage until they expire, since its Container, and a command holding a token, can outlive the instance that minted it. An expired token in a snapshot is harmless.
  - The Session DO never sees those tokens. Its refusal of plain values covers the private key and any string shaped like a GitHub token (`ghs_`, `ghp_`, `gho_`, `ghu_`, `ghr_`, `github_pat_`).
- **Checks and failures.** A private key that is not an RSA PEM fails the deploy or `alchemy dev` at startup; startup never calls GitHub. When minting fails at runtime, the last token is handed out until it expires; after that a Container command runs without a token, with a note on stderr saying why, and minting is tried again after a wait that doubles with each failure. The Diff pane and the draft's menu show their usual GitHub errors.
- **Permissions.** Contents, pull requests, issues and workflows: write. Actions, checks and commit statuses: read. Metadata: read.
- **Authorship.** Pushes, pull requests and comments come from `cloudpid[bot]`. Commits keep their author (`CLOUDPID_GIT_NAME`, `CLOUDPID_GIT_EMAIL`, default `cloudpid` and the owner's email).
- **Setup.** GitHub has no API that creates an app, so a local script uses the manifest flow: one confirmation in the browser creates the app. The script then waits for the owner to install it and writes the ID and key with `gh secret set` into `production` and `preview` and into `~/.config/cloudpid/dev.env`. GitHub shows the key only then, and no other copy is kept; a lost key is replaced from the app's settings, which is also how it is rotated.
- **Webhooks** are off, with no URL and no secret, until the triggers need them.

## Considered options

- **Keep the PAT as a fallback** when the app is not configured. It keeps two code paths for one owner. A PAT the agent sometimes needs instead (a fork, a gist, `gh api user`, which an app's token cannot do) can be kept as a Secret for every Environment and used explicitly, by setting `GH_TOKEN` to its `PI_SECRET_` variable for that one command.
- **An installation per repo owner**, chosen per Workspace from its Environment's Repos (`GET /repos/{owner}/{repo}/installation`). It is only needed when repos live in more than one account, and an Environment spanning two accounts still could not have one `GH_TOKEN` for both. The token module takes the installation as its own concern, so this can be added later.
- **User-to-server tokens** (the app acting as the owner). They reach every installation the owner can, but need an OAuth flow and a refresh token kept in the Registry, and the agent's actions would look like the owner's again.
- **A token file the DO rewrites** (under `/run`), read by git's credential helper, so that a process running longer than its token gets fresh ones. It breaks the rule that no file holds the token, needs an alarm while a long command runs, and `gh` would not read it.
- **Token-shaped matching for masking and the snapshot scan.** The scan reads the disk outside `/workspace`, where caches and test fixtures hold token-shaped strings, so it would refuse snapshots for nothing.
- **An app per stage**, so previews and dev stages can receive webhooks. Not needed until triggers exist; a second app can be added then.

## Consequences

- A process keeps the token it started with. Every command starts with at least about 45 minutes left, so only one that runs longer and then reaches GitHub (a long script that pushes at its end, a watcher) fails to authenticate.
- Only repos in the owner's account are reachable with credentials. Public repos elsewhere still clone.
- An app's token is not a user: `gh api user`, `gh repo fork`, `gh repo create` under the owner's account, gists and stars fail with "Resource not accessible by integration".
- Workflows: write lets the agent change CI, and so reach the `preview` environment's secrets from a branch, as a PAT with the `workflow` scope could.
- Every stage sits behind Cloudflare Access, which GitHub cannot pass: the triggers will need an Access bypass for the webhook path, and a second app (or forwarding from `prod`) to receive webhooks on previews and dev stages.
- GitHub's rate limit is the installation's, shared by every Workspace and the main Worker, as the PAT's was the owner's.
- Rollout: run the setup script and install the app, open the change (its preview needs the new secrets in `preview`), merge, and once `prod` works delete `CLOUDPID_GITHUB_TOKEN` from both environments and revoke the PAT.
