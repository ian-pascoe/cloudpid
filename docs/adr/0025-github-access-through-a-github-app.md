---
status: accepted
---

# GitHub access through a GitHub App

cloudpid reached GitHub with a personal access token, `CLOUDPID_GITHUB_TOKEN`: one fixed string, set at deploy time, that every Container command got as `GH_TOKEN` and `GITHUB_TOKEN` and that the Workers used for GitHub's API. The agent's pushes and pull requests looked like the owner's. Nothing marked them as the agent's, and the coming GitHub triggers need a webhook source. cloudpid now acts on GitHub as its own GitHub App (GLOSSARY.md → GitHub App), and every GitHub token is minted from it on demand.

- **One app, an installation per account.** The app is registered under the owner's account as `cloudpid` and is public, so that it can be installed on the owner's account and on the organizations whose repos the agent works on (such as `spiritledsoftware`), each on all repositories: a private app can only be installed on the account that owns it. Every stage (`prod`, the previews, dev stages) uses the same app. The deploy-time secrets are `CLOUDPID_GITHUB_APP_ID` and `CLOUDPID_GITHUB_APP_PRIVATE_KEY`. No installation ID is stored. The Workers list the installations (`GET /app/installations`, kept five minutes, so an account the app is installed on later is found within them) and the account that owns the app (`GET /app`), and keep one token per installation, by the account's login.
- **Which token.** A call about a repo (the Diff pane's, the draft's Start from menu) uses the token of the installation on the repo's owner, else the app owner's, which reads any public repo. A Container command gets them all: git's credential helper picks the one for the repo's owner (`useHttpPath`, from `CLOUDPID_GITHUB_TOKENS`), and `GH_TOKEN`/`GITHUB_TOKEN` are the token of the account that owns the repos the command's working directory covers, by their remotes, when they have one owner, else the token of the account that owns the app. So an Environment may hold repos of several accounts; `gh` follows the directory it runs in.
- **Minting.** A Worker signs a JWT with the private key (RS256 through WebCrypto; GitHub's PKCS#1 key is wrapped as PKCS#8 in code) and exchanges it for a GitHub token for an installation. The token lasts an hour. It is cached and minted again once less than about 45 minutes are left, when something asks for it; nothing runs on a timer. A 401 drops the cached token, mints a new one and retries once.
  - The Workspace DO mints with each installation's full permissions on all its repositories, for its Container's commands (each gets the current tokens in its environment at its start) and for the Diff pane's GitHub calls.
  - The main Worker mints read-only tokens (contents, pull requests) for the draft's Start from menu.
  - The private key never reaches a Container.
- **Masking and refusals.**
  - Output masking and the snapshot scan match every token the Workspace DO minted that has not expired, not one fixed string. The DO keeps them in its storage until they expire, since its Container, and a command holding a token, can outlive the instance that minted it. An expired token in a snapshot is harmless.
  - The Session DO never sees those tokens. Its refusal of plain values covers the private key and any string shaped like a GitHub token (`ghs_`, `ghp_`, `gho_`, `ghu_`, `ghr_`, `github_pat_`).
- **Checks and failures.** A private key that is not an RSA PEM fails the deploy or `alchemy dev` at startup; startup never calls GitHub. When minting fails at runtime, the last token of that installation is handed out until it expires; after that a Container command runs without it, with a note on stderr saying which accounts have no token and why, and minting is tried again after a wait that doubles with each failure. The Diff pane and the draft's menu show their usual GitHub errors.
- **Permissions.** Contents, pull requests, issues and workflows: write. Actions, checks and commit statuses: read. Metadata: read.
- **Authorship.** Pushes, pull requests and comments come from `cloudpid[bot]`. Commits keep their author (`CLOUDPID_GIT_NAME`, `CLOUDPID_GIT_EMAIL`, default `cloudpid` and the owner's email).
- **Setup.** GitHub has no API that creates an app, so a local script uses the manifest flow: one confirmation in the browser creates the app. The script writes the ID and key with `gh secret set` into `production` and `preview` and into `~/.config/cloudpid/dev.env`, then sends the owner to install the app on each account and checks that a token mints for each. GitHub shows the key only then, and no other copy is kept; a lost key is replaced from the app's settings, which is also how it is rotated.
- **Webhooks** are off, with no URL and no secret, until the triggers need them.

## Considered options

- **A private app with one installation**, the first version of this decision. It cannot be installed on an organization of the owner's, so repos there would be reachable only with a token of the owner's own.
- **A private app per account** (one under the owner, one under each organization). Each stays installable only where it is registered, but every account adds a key pair and two secrets to set and rotate, and a bot identity of its own.
- **An allowlist of accounts** for the public app. Anyone can install a public app, but an installation of a stranger's only gives cloudpid that stranger's repos, never the owner's; the agent works on the Repos the owner puts in Environments. Not worth a setting to keep.
- **Refusing Environments whose repos span accounts.** Simpler (one token per Workspace), but the owner works across both accounts, and git can pick per repo.
- **Keep the PAT as a fallback** when the app is not configured. It keeps two code paths for one owner. A PAT the agent sometimes needs instead (a fork, a gist, `gh api user`, which an app's token cannot do) can be kept as a Secret for every Environment and used explicitly, by setting `GH_TOKEN` to its `PI_SECRET_` variable for that one command.
- **User-to-server tokens** (the app acting as the owner). They reach every installation the owner can, but need an OAuth flow and a refresh token kept in the Registry, and the agent's actions would look like the owner's again.
- **A token file the DO rewrites** (under `/run`), read by git's credential helper, so that a process running longer than its token gets fresh ones. It breaks the rule that no file holds the token, needs an alarm while a long command runs, and `gh` would not read it.
- **Token-shaped matching for masking and the snapshot scan.** The scan reads the disk outside `/workspace`, where caches and test fixtures hold token-shaped strings, so it would refuse snapshots for nothing.
- **An app per stage**, so previews and dev stages can receive webhooks. Not needed until triggers exist; a second app can be added then.

## Consequences

- A process keeps the tokens it started with. Every command starts with at least about 45 minutes left, so only one that runs longer and then reaches GitHub (a long script that pushes at its end, a watcher) fails to authenticate.
- Only repos of the accounts the app is installed on are reachable with credentials. Public repos elsewhere still clone.
- `gh` has one token per command: run in a directory whose repos span accounts, or outside any repo, it uses the app owner's account's, and a `gh` call about another account's repo then fails or sees only what is public. Running it in that repo's directory fixes it.
- An app's token is not a user: `gh api user`, `gh repo fork`, `gh repo create` under the owner's account, gists and stars fail with "Resource not accessible by integration".
- The app is public: its page can be found, and anyone can install it on their own account (see above).
- Workflows: write lets the agent change CI, and so reach the `preview` environment's secrets from a branch, as a PAT with the `workflow` scope could.
- Every stage sits behind Cloudflare Access, which GitHub cannot pass: the triggers will need an Access bypass for the webhook path, and a second app (or forwarding from `prod`) to receive webhooks on previews and dev stages.
- GitHub's rate limit is each installation's, shared by every Workspace and the main Worker.
- Rollout: run the setup script and install the app on each account, open the change (its preview needs the new secrets in `preview`), merge, and once `prod` works delete `CLOUDPID_GITHUB_TOKEN` from both environments and revoke the PAT. An app made private by the first version of the setup is made public in its settings (Advanced → Make public), then installed on the organizations.
